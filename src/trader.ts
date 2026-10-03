import {
  createWalletClient,
  webSocket,
  parseUnits,
  parseGwei,
  parseEther,
  formatEther,
  formatUnits,
  encodePacked,
  maxUint160,
  maxUint256,
  getAddress,
  type Address,
  type Hash,
  type Hex
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { APP, NETWORKS, availableNetworks, type NetworkKey } from "./config.js";
import {
  ERC20_ABI, SWAP_ROUTER_ABI, QUOTER_V2_ABI, V2_ROUTER_ABI, AERODROME_ROUTER_ABI, FEE_TIERS, TRANSFER_EVENT
} from "./abi.js";
import type { Store } from "./store.js";
import type { WalletWatcher } from "./watcher.js";
import { fetchTokenInfo, fetchV4Pool } from "./tokeninfo.js";
import {
  V4_BY_NET, poolKeyFor, quoteV4, buildV4Buy, buildV4Sell, buildV4BuyFromUsdc, buildV4SellToUsdc,
  UNIVERSAL_ROUTER_ABI, PERMIT2_ABI, type PoolKey
} from "./v4.js";

export interface ExecutedTrade {
  network: NetworkKey;
  direction: "buy" | "sell";
  token: Address;
  symbol: string;
  txHash: Hash;
  detail: string;
  /** realized PnL in quote units (sells only) */
  pnlQuote?: number;
  /** what pnlQuote is denominated in, e.g. "ETH" | "USDC" | "BNB" */
  quoteSymbol?: string;
  /** realized PnL as a percentage of cost basis (sells only) */
  pnlPct?: number;
}

interface QuoteAsset {
  address: Address;
  decimals: number;
  symbol: string;
  /** native coin paid via tx value (router wraps), vs ERC-20 needing approval */
  isNative: boolean;
}

/** How to execute a swap: V3 pool, multi-hop V3, V4 pool, or atomic USDC->V4. */
/** One hop in an Aerodrome route: from->to via a stable or volatile pool of `factory`. */
type AeroHop = { from: Address; to: Address; stable: boolean; factory: Address };

type Route =
  | { kind: "single"; fee: number; amountOut: bigint }
  | { kind: "path"; path: Hex; amountOut: bigint }
  | { kind: "v4"; key: PoolKey; weth: Address; amountOut: bigint }
  | { kind: "v2"; path: Address[]; amountOut: bigint }
  | { kind: "aerodrome"; routes: AeroHop[]; amountOut: bigint }
  | {
      kind: "v4usdc";
      key: PoolKey;
      weth: Address;
      usdc: Address;
      v3Fee: number;
      /** WETH expected out of the USDC->WETH leg (for the min + ETH cost basis) */
      wethExpected: bigint;
      amountOut: bigint;
    }
  | {
      kind: "v4usdcsell";
      key: PoolKey;
      weth: Address;
      usdc: Address;
      v3Fee: number;
      /** WETH expected out of the token->WETH leg (for the V4 min) */
      wethExpected: bigint;
      amountOut: bigint;
    };

export interface WalletBalance {
  network: NetworkKey;
  nativeSymbol: string;
  native: number;
  /** USDC balance, where the network has a configured USDC quote asset */
  usdc?: number;
}

export interface PositionSyncResult {
  scanned: number;
  added: number;
  updated: number;
  skippedZero: number;
  failed: number;
}

export class Trader {
  readonly account = privateKeyToAccount(APP.privateKey);
  /** token -> epoch ms of last copy buy, for the per-token cooldown */
  private lastBuy = new Map<string, number>();

  constructor(private store: Store, private watcher: WalletWatcher) {}

  private walletClient(net: NetworkKey) {
    const cfg = NETWORKS[net];
    if (!cfg.wsUrl) {
      throw new Error(`${net} is not configured — set its RPC env var first`);
    }
    return createWalletClient({
      account: this.account,
      chain: cfg.chain,
      transport: webSocket(cfg.wsUrl)
    });
  }

  private usdcQuoteAsset(net: NetworkKey): QuoteAsset | null {
    const cfg = NETWORKS[net];
    if (!cfg.usdc) return null;
    return { ...cfg.usdc, symbol: "USDC", isNative: false };
  }

  /** The asset we pay with / sell into on this network. */
  quoteAsset(net: NetworkKey): QuoteAsset {
    const cfg = NETWORKS[net];
    if (net === "base" && this.store.settings.baseQuote === "USDC") {
      const usdc = this.usdcQuoteAsset(net);
      if (usdc) return usdc;
    }
    return {
      address: cfg.weth,
      decimals: 18,
      symbol: cfg.nativeSymbol,
      isNative: true
    };
  }

  /** Returns the working fee tier and quoted output, or null if no pool answers. */
  private async quote(
    net: NetworkKey, tokenIn: Address, tokenOut: Address, amountIn: bigint
  ): Promise<{ fee: number; amountOut: bigint } | null> {
    const cfg = NETWORKS[net];
    const client = this.watcher.client(net);
    for (const fee of FEE_TIERS) {
      try {
        const { result } = await client.simulateContract({
          address: cfg.quoter,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n }]
        });
        return { fee, amountOut: result[0] };
      } catch {
        continue;
      }
    }
    return null;
  }

  /** Honeypot heuristic: the bought token must be quotable back to WETH/native. */
  private async canSell(net: NetworkKey, token: Address, amount: bigint) {
    // Retry so a transient discovery hiccup doesn't read as a honeypot.
    const r = await this.routeWithRetry(net, token, NETWORKS[net].weth, amount);
    return r !== null && r.amountOut > 0n;
  }

  /**
   * Best executable route for tokenIn -> tokenOut. Tries Uniswap V3 first
   * (direct pool, then a hop through wrapped native), and falls back to a
   * Uniswap V4 pool — where most new Base tokens actually live.
   */
  /**
   * Retry a flaky async producer until `ok(value)` holds, retrying on BOTH a
   * predicate miss (e.g. route() returning null) and a thrown error (e.g. a
   * transient RPC revert in simulateContract), with linear backoff.
   *
   * This is what makes "the manual retry that always works" automatic: pool
   * discovery and quoting hit DexScreener + free-RPC getLogs/eth_call, any of
   * which can hiccup for one call and succeed on the next.
   */
  private async attempt<T>(
    fn: () => Promise<T>, ok: (v: T) => boolean, tries = 3, baseDelayMs = 350
  ): Promise<T> {
    let lastVal: T | undefined;
    let haveVal = false;
    let lastErr: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        const v = await fn();
        lastVal = v; haveVal = true; lastErr = undefined;
        if (ok(v)) return v;
      } catch (e) {
        lastErr = e; haveVal = false;
      }
      if (i < tries - 1) await new Promise(r => setTimeout(r, baseDelayMs * (i + 1)));
    }
    if (haveVal) return lastVal as T; // exhausted but never threw: hand back the last (failing) value
    throw lastErr;                    // every attempt threw: surface the real error
  }

  /** route() with automatic retry — a transient null/RPC hiccup is retried. */
  private routeWithRetry(
    net: NetworkKey, tokenIn: Address, tokenOut: Address, amountIn: bigint
  ): Promise<Route | null> {
    return this.attempt(
      () => this.route(net, tokenIn, tokenOut, amountIn),
      r => r !== null
    );
  }

  /** All executable route candidates, sorted best quoted output first. */
  private routeOptionsWithRetry(
    net: NetworkKey, tokenIn: Address, tokenOut: Address, amountIn: bigint
  ): Promise<Route[]> {
    return this.attempt(
      () => this.routeOptions(net, tokenIn, tokenOut, amountIn),
      r => r.length > 0
    );
  }

  private async route(
    net: NetworkKey, tokenIn: Address, tokenOut: Address, amountIn: bigint
  ): Promise<Route | null> {
    const routes = await this.routeOptions(net, tokenIn, tokenOut, amountIn);
    return routes[0] ?? null;
  }

  private async routeOptions(
    net: NetworkKey, tokenIn: Address, tokenOut: Address, amountIn: bigint
  ): Promise<Route[]> {
    // Best execution: quote ALL venues and take the one with the most output.
    // (Taking "V3 first" once routed a buy through a near-empty $38 V3 pool
    // instead of a $287K V4 pool — a ~58% worse fill. Never again.)
    const candidates = await Promise.all([
      this.routeV3(net, tokenIn, tokenOut, amountIn).catch(() => null),
      this.routeV4(net, tokenIn, tokenOut, amountIn).catch(() => null),
      this.routeV4Usdc(net, tokenIn, tokenOut, amountIn).catch(() => null),
      this.routeV2(net, tokenIn, tokenOut, amountIn).catch(() => null),
      this.routeAerodrome(net, tokenIn, tokenOut, amountIn).catch(() => null)
    ]);
    const valid = candidates.filter((r): r is Route => r !== null && r.amountOut > 0n);
    if (valid.length === 0) return [];
    // All candidates produce the same output token, so amountOut is comparable.
    return valid.sort((a, b) => a.amountOut === b.amountOut ? 0 : a.amountOut > b.amountOut ? -1 : 1);
  }

  /** Uniswap V2 (or fork) route. Quotes a direct pair and a WETH hop, takes the
   *  deeper one. Covers V2-only tokens that have no V3/V4 pool at all. */
  private async routeV2(
    net: NetworkKey, tokenIn: Address, tokenOut: Address, amountIn: bigint
  ): Promise<Route | null> {
    const cfg = NETWORKS[net];
    if (!cfg.v2Router) return null;
    const weth = cfg.weth;
    const isWeth = (a: Address) => a.toLowerCase() === weth.toLowerCase();
    const client = this.watcher.client(net);

    const paths: Address[][] = [[tokenIn, tokenOut]];
    if (!isWeth(tokenIn) && !isWeth(tokenOut)) paths.push([tokenIn, weth, tokenOut]);

    let best: { path: Address[]; amountOut: bigint } | null = null;
    for (const path of paths) {
      try {
        const amounts = await client.readContract({
          address: cfg.v2Router, abi: V2_ROUTER_ABI, functionName: "getAmountsOut",
          args: [amountIn, path]
        });
        const out = amounts[amounts.length - 1];
        if (out > 0n && (!best || out > best.amountOut)) best = { path, amountOut: out };
      } catch { /* pair doesn't exist on V2 / can't price — try the next path */ }
    }
    if (!best) return null;
    return { kind: "v2", path: best.path, amountOut: best.amountOut };
  }

  /** Aerodrome (Velodrome/Solidly-style) route — where most Base memecoins live.
   *  Tries a direct pool (volatile + stable) and a WETH hop, takes the deepest.
   *  Multi-hop quotes/swaps in ONE router call, so USDC->WETH->token stays atomic. */
  private async routeAerodrome(
    net: NetworkKey, tokenIn: Address, tokenOut: Address, amountIn: bigint
  ): Promise<Route | null> {
    const cfg = NETWORKS[net];
    if (!cfg.aerodromeRouter || !cfg.aerodromeFactory) return null;
    const factory = cfg.aerodromeFactory;
    const weth = cfg.weth;
    const isWeth = (a: Address) => a.toLowerCase() === weth.toLowerCase();
    const client = this.watcher.client(net);
    const hop = (from: Address, to: Address, stable: boolean): AeroHop => ({ from, to, stable, factory });

    // Memecoins are volatile pools; we also try stable and a WETH hop.
    const candidates: AeroHop[][] = [
      [hop(tokenIn, tokenOut, false)],
      [hop(tokenIn, tokenOut, true)]
    ];
    if (!isWeth(tokenIn) && !isWeth(tokenOut)) {
      candidates.push([hop(tokenIn, weth, false), hop(weth, tokenOut, false)]);
      candidates.push([hop(tokenIn, weth, false), hop(weth, tokenOut, true)]);
    }

    let best: { routes: AeroHop[]; amountOut: bigint } | null = null;
    for (const routes of candidates) {
      try {
        const amounts = await client.readContract({
          address: cfg.aerodromeRouter, abi: AERODROME_ROUTER_ABI, functionName: "getAmountsOut",
          args: [amountIn, routes]
        });
        const out = amounts[amounts.length - 1];
        if (out > 0n && (!best || out > best.amountOut)) best = { routes, amountOut: out };
      } catch { /* no pool for this combo — try the next */ }
    }
    if (!best) return null;
    return { kind: "aerodrome", routes: best.routes, amountOut: best.amountOut };
  }

  /** Atomic USDC<->V4-token, chained through WETH on V3. Handles both directions:
   *  USDC->token (buy) and token->USDC (sell). */
  private async routeV4Usdc(
    net: NetworkKey, tokenIn: Address, tokenOut: Address, amountIn: bigint
  ): Promise<Route | null> {
    const v4 = V4_BY_NET[net];
    const cfg = NETWORKS[net];
    if (!v4 || !cfg.usdc) return null;
    const weth = cfg.weth;
    const usdc = cfg.usdc.address;
    const isUsdc = (a: Address) => a.toLowerCase() === usdc.toLowerCase();
    const isWeth = (a: Address) => a.toLowerCase() === weth.toLowerCase();
    const client = this.watcher.client(net);

    // BUY: USDC -> token. Leg1 USDC->WETH (V3), leg2 WETH->token (V4).
    if (isUsdc(tokenIn) && !isWeth(tokenOut)) {
      const leg1 = await this.quote(net, usdc, weth, amountIn);
      if (!leg1 || leg1.amountOut <= 0n) return null;
      const pool = await fetchV4Pool(cfg.dsSlug, tokenOut);
      if (!pool) return null;
      const key = await poolKeyFor(client, v4, pool.poolId, pool.createdMs);
      if (!key) return null;
      const out = await quoteV4(client, v4, key, key.currency0.toLowerCase() === weth.toLowerCase(), leg1.amountOut);
      if (!out || out <= 0n) return null;
      return { kind: "v4usdc", key, weth, usdc, v3Fee: leg1.fee, wethExpected: leg1.amountOut, amountOut: out };
    }

    // SELL: token -> USDC. Leg1 token->WETH (V4), leg2 WETH->USDC (V3).
    if (isUsdc(tokenOut) && !isWeth(tokenIn)) {
      const pool = await fetchV4Pool(cfg.dsSlug, tokenIn);
      if (!pool) return null;
      const key = await poolKeyFor(client, v4, pool.poolId, pool.createdMs);
      if (!key) return null;
      const wethOut = await quoteV4(client, v4, key, key.currency0.toLowerCase() === tokenIn.toLowerCase(), amountIn);
      if (!wethOut || wethOut <= 0n) return null;
      const leg2 = await this.quote(net, weth, usdc, wethOut);
      if (!leg2 || leg2.amountOut <= 0n) return null;
      return { kind: "v4usdcsell", key, weth, usdc, v3Fee: leg2.fee, wethExpected: wethOut, amountOut: leg2.amountOut };
    }

    return null;
  }

  private async routeV3(
    net: NetworkKey, tokenIn: Address, tokenOut: Address, amountIn: bigint
  ): Promise<Route | null> {
    const direct = await this.quote(net, tokenIn, tokenOut, amountIn);
    if (direct) return { kind: "single", ...direct };

    const weth = NETWORKS[net].weth;
    const isWeth = (a: Address) => a.toLowerCase() === weth.toLowerCase();
    if (isWeth(tokenIn) || isWeth(tokenOut)) return null; // already tried the only pool

    const legA = await this.quote(net, tokenIn, weth, amountIn);
    if (!legA) return null;
    const legB = await this.quote(net, weth, tokenOut, legA.amountOut);
    if (!legB) return null;

    const path = encodePacked(
      ["address", "uint24", "address", "uint24", "address"],
      [tokenIn, legA.fee, weth, legB.fee, tokenOut]
    );
    // Quote the whole path in one shot for an exact amountOut; the composed
    // per-leg estimate is the fallback if the path quoter call fails.
    try {
      const { result } = await this.watcher.client(net).simulateContract({
        address: NETWORKS[net].quoter,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInput",
        args: [path, amountIn]
      });
      return { kind: "path", path, amountOut: result[0] };
    } catch {
      return { kind: "path", path, amountOut: legB.amountOut };
    }
  }

  /** Uniswap V4 route. Only WETH<->token pairs are supported (one side is WETH). */
  private async routeV4(
    net: NetworkKey, tokenIn: Address, tokenOut: Address, amountIn: bigint
  ): Promise<Route | null> {
    const v4 = V4_BY_NET[net];
    if (!v4) return null;
    const weth = NETWORKS[net].weth;
    const isWeth = (a: Address) => a.toLowerCase() === weth.toLowerCase();
    if (!isWeth(tokenIn) && !isWeth(tokenOut)) return null; // V4 path trades via WETH
    const token = isWeth(tokenIn) ? tokenOut : tokenIn;

    const pool = await fetchV4Pool(NETWORKS[net].dsSlug, token);
    if (!pool) return null;
    const client = this.watcher.client(net);
    const key = await poolKeyFor(client, v4, pool.poolId, pool.createdMs);
    if (!key) return null;
    const zeroForOne = key.currency0.toLowerCase() === tokenIn.toLowerCase();
    const amountOut = await quoteV4(client, v4, key, zeroForOne, amountIn);
    if (!amountOut || amountOut <= 0n) return null;
    return { kind: "v4", key, weth, amountOut };
  }

    /** Execute a routed swap across supported DEX venues. */
  private async swap(
    net: NetworkKey, routeFound: Route,
    tokenIn: Address, tokenOut: Address,
    amountIn: bigint, minOut: bigint, value: bigint
  ): Promise<Hash> {
    const cfg = NETWORKS[net];
    const wallet = this.walletClient(net);

    if (routeFound.kind === "v4" || routeFound.kind === "v4usdc" || routeFound.kind === "v4usdcsell") {
      const v4 = V4_BY_NET[net]!;
      const client = this.watcher.client(net);
      const weth = routeFound.weth;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const slipBps = BigInt(10_000 - this.store.settings.slippageBps);

      let built;
      if (routeFound.kind === "v4usdc") {
        const wethMin = (routeFound.wethExpected * slipBps) / 10_000n;
        built = buildV4BuyFromUsdc(
          routeFound.key, weth, routeFound.usdc, routeFound.v3Fee,
          amountIn, wethMin, minOut, deadline
        );
      } else if (routeFound.kind === "v4usdcsell") {
        const wethMin = (routeFound.wethExpected * slipBps) / 10_000n;
        built = buildV4SellToUsdc(
          routeFound.key, weth, routeFound.usdc, routeFound.v3Fee,
          tokenIn, amountIn, wethMin, minOut, deadline
        );
      } else {
        const isBuy = tokenIn.toLowerCase() === weth.toLowerCase();
        built = isBuy
          ? buildV4Buy(routeFound.key, weth, amountIn, minOut, deadline)
          : buildV4Sell(routeFound.key, weth, tokenIn, amountIn, minOut, deadline);
      }

      // Safety net: dry-run the exact call so malformed calldata or a failing
      // hook reverts here instead of after broadcasting and burning gas/funds.
      // Retried because a transient RPC-side revert (stale state across nodes)
      // can reject a perfectly valid swap that succeeds on the next call — this
      // is the "sell failed… retrying works" case. A real hook/honeypot revert
      // still fails all attempts and is surfaced. The simulate never broadcasts,
      // so retrying it is free of double-spend risk.
      await this.attempt(
        () => client.simulateContract({
          address: v4.universalRouter, abi: UNIVERSAL_ROUTER_ABI, functionName: "execute",
          args: [built.commands, built.inputs, built.deadline],
          value: built.value, account: this.account.address
        }),
        () => true // only a thrown revert triggers a retry; success returns immediately
      );
      return wallet.writeContract({
        address: v4.universalRouter, abi: UNIVERSAL_ROUTER_ABI, functionName: "execute",
        args: [built.commands, built.inputs, built.deadline], value: built.value
      });
    }

    if (routeFound.kind === "v2") {
      const router = cfg.v2Router!;
      const to = this.account.address;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const isNativeOut = value === 0n && tokenOut.toLowerCase() === cfg.weth.toLowerCase();
      // value > 0 ⇒ native-ETH buy (router wraps it); otherwise an ERC-20 is
      // pulled via allowance. Fee-on-transfer variants tolerate taxed tokens.
      const call = value > 0n
        ? {
            address: router, abi: V2_ROUTER_ABI,
            functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens" as const,
            args: [minOut, routeFound.path, to, deadline] as const, value
          }
        : isNativeOut
          ? {
              address: router, abi: V2_ROUTER_ABI,
              functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens" as const,
              args: [amountIn, minOut, routeFound.path, to, deadline] as const, value: 0n
            }
        : {
            address: router, abi: V2_ROUTER_ABI,
            functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens" as const,
            args: [amountIn, minOut, routeFound.path, to, deadline] as const, value: 0n
          };
      // Same simulate-before-broadcast gate as V4, retried for transient reverts.
      await this.attempt(
        () => this.watcher.client(net).simulateContract({ ...call, account: this.account.address } as any),
        () => true
      );
      return wallet.writeContract(call as any);
    }

    if (routeFound.kind === "aerodrome") {
      const router = cfg.aerodromeRouter!;
      const to = this.account.address;
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
      const isNativeOut = value === 0n && tokenOut.toLowerCase() === cfg.weth.toLowerCase();
      // value > 0 ⇒ native-ETH buy (router wraps it); a WETH-out route ⇒ sell to
      // ETH; otherwise pull the ERC-20 via allowance. FOT variants tolerate tax.
      const call = value > 0n
        ? {
            address: router, abi: AERODROME_ROUTER_ABI,
            functionName: "swapExactETHForTokensSupportingFeeOnTransferTokens" as const,
            args: [minOut, routeFound.routes, to, deadline] as const, value
          }
        : isNativeOut
          ? {
              address: router, abi: AERODROME_ROUTER_ABI,
              functionName: "swapExactTokensForETHSupportingFeeOnTransferTokens" as const,
              args: [amountIn, minOut, routeFound.routes, to, deadline] as const, value: 0n
            }
        : {
            address: router, abi: AERODROME_ROUTER_ABI,
            functionName: "swapExactTokensForTokensSupportingFeeOnTransferTokens" as const,
            args: [amountIn, minOut, routeFound.routes, to, deadline] as const, value: 0n
          };
      // Same simulate-before-broadcast gate as every other route.
      await this.attempt(
        () => this.watcher.client(net).simulateContract({ ...call, account: this.account.address } as any),
        () => true
      );
      return wallet.writeContract(call as any);
    }

    if (routeFound.kind === "single") {
      return wallet.writeContract({
        address: cfg.swapRouter,
        abi: SWAP_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [{
          tokenIn, tokenOut, fee: routeFound.fee,
          recipient: this.account.address,
          amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n
        }],
        value
      });
    }
    return wallet.writeContract({
      address: cfg.swapRouter,
      abi: SWAP_ROUTER_ABI,
      functionName: "exactInput",
      args: [{
        path: routeFound.path,
        recipient: this.account.address,
        amountIn, amountOutMinimum: minOut
      }],
      value
    });
  }

  private routeLabel(route: Route): string {
    if (route.kind === "single") return `v3:${route.fee}`;
    if (route.kind === "path") return "v3:path";
    return route.kind;
  }

  /** Set the Permit2 approvals a V4 swap needs (ERC20 -> Permit2 -> router).
   *  Used for both V4 sells (the token) and atomic USDC->V4 buys (USDC). */
  private async ensureV4Approvals(net: NetworkKey, token: Address, amount: bigint) {
    const v4 = V4_BY_NET[net]!;
    const client = this.watcher.client(net);
    const wallet = this.walletClient(net);

    const erc20Allowance = await client.readContract({
      address: token, abi: ERC20_ABI,
      functionName: "allowance", args: [this.account.address, v4.permit2]
    });
    if (erc20Allowance < amount) {
      const tx = await wallet.writeContract({
        address: token, abi: ERC20_ABI,
        functionName: "approve", args: [v4.permit2, maxUint256]
      });
      await client.waitForTransactionReceipt({ hash: tx });
    }

    const [p2Amount, p2Expiration] = await client.readContract({
      address: v4.permit2, abi: PERMIT2_ABI,
      functionName: "allowance", args: [this.account.address, token, v4.universalRouter]
    });
    const now = Math.floor(Date.now() / 1000);
    if (p2Amount < amount || Number(p2Expiration) < now + 60) {
      const expiration = now + 60 * 60 * 24 * 30; // 30 days (uint48 -> number)
      const tx = await wallet.writeContract({
        address: v4.permit2, abi: PERMIT2_ABI,
        functionName: "approve", args: [token, v4.universalRouter, maxUint160, expiration]
      });
      await client.waitForTransactionReceipt({ hash: tx });
    }
  }

  /** Trading-wallet balances on every active network (native + USDC). */
  async balances(): Promise<WalletBalance[]> {
    const out: WalletBalance[] = [];
    for (const cfg of availableNetworks()) {
      if (!this.store.settings.networks[cfg.key]) continue;
      try {
        const client = this.watcher.client(cfg.key);
        const native = Number(formatEther(
          await client.getBalance({ address: this.account.address })
        ));
        let usdc: number | undefined;
        if (cfg.usdc) {
          const bal = await client.readContract({
            address: cfg.usdc.address, abi: ERC20_ABI,
            functionName: "balanceOf", args: [this.account.address]
          });
          usdc = Number(formatUnits(bal, cfg.usdc.decimals));
        }
        out.push({ network: cfg.key, nativeSymbol: cfg.nativeSymbol, native, usdc });
      } catch {
        /* network hiccup — leave it off the list */
      }
    }
    return out;
  }

  private async gasOk(net: NetworkKey): Promise<boolean> {
    const gasPrice = await this.watcher.client(net).getGasPrice();
    return gasPrice <= parseGwei(String(this.store.settings.gasCeilingGwei));
  }

  async tokenMeta(net: NetworkKey, token: Address) {
    const client = this.watcher.client(net);
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "???"),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: "decimals" }).catch(() => 18)
    ]);
    return { symbol: String(symbol), decimals: Number(decimals) };
  }

  /** Approve `spender` for `amount` of `token` if the current allowance is short. */
  private async ensureAllowance(
    net: NetworkKey, token: Address, spender: Address, amount: bigint
  ) {
    const client = this.watcher.client(net);
    const allowance = await client.readContract({
      address: token, abi: ERC20_ABI,
      functionName: "allowance", args: [this.account.address, spender]
    });
    if (allowance >= amount) return;
    const approveTx = await this.walletClient(net).writeContract({
      address: token, abi: ERC20_ABI,
      functionName: "approve", args: [spender, amount]
    });
    await client.waitForTransactionReceipt({ hash: approveTx });
  }

  /** ETH-equivalent of a spend, for the daily cap. Native spends pass through;
   *  USDC spends are converted via the quoter (best-effort: a failed conversion
   *  quote counts as 0 rather than blocking the trade). */
  private async ethEquivalent(
    net: NetworkKey, quote: QuoteAsset, amountIn: bigint
  ): Promise<number> {
    if (quote.isNative) return Number(formatUnits(amountIn, quote.decimals));
    const q = await this.quote(net, quote.address, NETWORKS[net].weth, amountIn);
    return q ? Number(formatEther(q.amountOut)) : 0;
  }

  /**
   * Import a token the wallet already holds on-chain into tracked positions —
   * for coins bought outside the bot or lost when tracking broke. Reads the
   * real balance and estimates a cost basis from the current sell quote (so PnL
   * starts near zero). Returns null if the wallet holds none.
   */
  async recoverPosition(net: NetworkKey, token: Address): Promise<{ symbol: string; uiAmount: number } | null> {
    const cfg = NETWORKS[net];
    const client = this.watcher.client(net);
    const balance = await client.readContract({
      address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [this.account.address]
    }).catch(() => 0n);
    if (balance === 0n) return null;

    const meta = await this.tokenMeta(net, token);
    // Estimate cost basis from what a full sell would yield in ETH right now.
    let costQuote: number | undefined;
    const r = await this.route(net, token, cfg.weth, balance).catch(() => null);
    if (r) costQuote = Number(formatEther(r.amountOut));

    this.store.upsertPosition({
      token, network: net, symbol: meta.symbol, decimals: meta.decimals,
      amount: balance.toString(),
      costQuote, quoteSymbol: cfg.nativeSymbol,
      openedAt: Date.now()
    });
    return { symbol: meta.symbol, uiAmount: Number(formatUnits(balance, meta.decimals)) };
  }

  /**
   * Discover ERC-20 tokens that recently moved in/out of the trading wallet and
   * import any nonzero balances into the local positions list. This catches
   * coins bought from BasedBot/Bitget/etc without requiring a bot-side buy.
   */
  async syncHeldPositions(net?: NetworkKey): Promise<PositionSyncResult> {
    const result: PositionSyncResult = { scanned: 0, added: 0, updated: 0, skippedZero: 0, failed: 0 };
    const nets = (net ? [NETWORKS[net]] : availableNetworks())
      .filter(cfg => this.store.settings.networks[cfg.key]);
    const me = getAddress(this.account.address);

    for (const cfg of nets) {
      const client = this.watcher.client(cfg.key);
      const latest = await client.getBlockNumber();
      const fromBlock = latest > 50_000n ? latest - 50_000n : 0n;
      const tokenSet = new Set<string>();
      const [incoming, outgoing] = await Promise.all([
        client.getLogs({ event: TRANSFER_EVENT, args: { to: me }, fromBlock, toBlock: latest }).catch(() => []),
        client.getLogs({ event: TRANSFER_EVENT, args: { from: me }, fromBlock, toBlock: latest }).catch(() => [])
      ]);
      const ignored = new Set([
        cfg.weth.toLowerCase(),
        ...cfg.stables.map(s => s.address.toLowerCase())
      ]);
      for (const log of [...incoming, ...outgoing]) {
        const token = log.address.toLowerCase();
        if (!ignored.has(token)) tokenSet.add(token);
      }

      for (const token of tokenSet) {
        result.scanned += 1;
        const existed = !!this.store.position(token as Address, cfg.key);
        try {
          const recovered = await this.recoverPosition(cfg.key, token as Address);
          if (!recovered) {
            result.skippedZero += 1;
            continue;
          }
          if (existed) result.updated += 1;
          else result.added += 1;
        } catch {
          result.failed += 1;
        }
      }
    }

    return result;
  }

  /** Live unrealized PnL for a held token, quoted token -> its quote asset.
   *  Null when we hold nothing. Mirrors what a 100% sell would actually yield. */
  async positionValue(net: NetworkKey, token: Address): Promise<{
    symbol: string;
    uiAmount: number;
    quoteSymbol: string;
    proceedsQuote?: number;
    costQuote?: number;
    pnlQuote?: number;
    pnlPct?: number;
  } | null> {
    const pos = this.store.position(token, net);
    if (!pos) return null;
    const cfg = NETWORKS[net];
    const client = this.watcher.client(net);
    const balance = await client.readContract({
      address: token, abi: ERC20_ABI,
      functionName: "balanceOf", args: [this.account.address]
    }).catch(() => 0n);
    if (balance === 0n) return null;

    const quote: QuoteAsset =
      pos.quoteSymbol === "USDC" && cfg.usdc
        ? { ...cfg.usdc, symbol: "USDC", isNative: false }
        : this.quoteAsset(net);
    const uiAmount = Number(formatUnits(balance, pos.decimals));

    let proceedsQuote: number | undefined;
    try {
      const r = await this.route(net, token, quote.address, balance);
      if (r) proceedsQuote = Number(formatUnits(r.amountOut, quote.decimals));
    } catch {
      /* no route right now — show holding without live PnL */
    }
    const costQuote =
      pos.quoteSymbol === quote.symbol ? pos.costQuote : undefined;
    const pnlQuote =
      proceedsQuote !== undefined && costQuote !== undefined
        ? proceedsQuote - costQuote
        : undefined;
    const pnlPct =
      pnlQuote !== undefined && costQuote && costQuote > 0
        ? (pnlQuote / costQuote) * 100
        : undefined;
    return { symbol: pos.symbol, uiAmount, quoteSymbol: quote.symbol, proceedsQuote, costQuote, pnlQuote, pnlPct };
  }

  async copyBuy(
    net: NetworkKey,
    token: Address,
    opts: { amount?: number; manual?: boolean; quote?: "settings" | "USDC" } = {}
  ): Promise<ExecutedTrade> {
    const s = this.store.settings;
    const cfg = NETWORKS[net];
    let quote = opts.quote === "USDC"
      ? this.usdcQuoteAsset(net) ?? this.quoteAsset(net)
      : this.quoteAsset(net);

    const defaultAmount = quote.isNative ? s.buyAmountEth : s.buyAmountUsdc;
    let spend = opts.amount ?? defaultAmount;
    if (quote.isNative) spend = Math.min(spend, s.maxBuyEth);
    let amountIn = parseUnits(String(spend), quote.decimals);
    if (amountIn <= 0n) throw new Error("buy amount is zero");
    const key = `${net}:${token.toLowerCase()}`;

    // Manual buys (from the alert button) bypass the automation guards below;
    // automated copies respect skip-if-holding and the per-token cooldown.
    if (!opts.manual) {
      if (s.skipIfHolding && this.store.position(token, net)) {
        throw new Error("already holding this token (skip-if-holding on)");
      }
      // Several tracked wallets buying the same token in a burst should trigger
      // one copy, not many.
      const last = this.lastBuy.get(key);
      if (last && Date.now() - last < s.buyCooldownSec * 1000) {
        throw new Error(`cooldown active for this token (${s.buyCooldownSec}s)`);
      }
    }

    // Resolve every route across V2/V3/V4. The best quote can be the route that
    // a launch hook rejects, so execution falls through until one route mines.
    const routes = await this.routeOptionsWithRetry(net, quote.address, token, amountIn);
    if (routes.length === 0) {
      throw new Error(
        `no supported route for ${quote.symbol} → token ` +
        `(no Uniswap V2/V3/V4 route; token may be Aerodrome-only or unsupported)`
      );
    }

    const ethEquiv = await this.ethEquivalent(net, quote, amountIn);
    if (!this.store.canSpend(ethEquiv)) {
      throw new Error(
        `daily spend cap reached (${this.store.spentToday().toFixed(4)}/${s.dailySpendCapEth} ETH-equiv)`
      );
    }

    if (!(await this.gasOk(net))) {
      throw new Error(`gas above ceiling of ${s.gasCeilingGwei} gwei, skipped`);
    }

    // Liquidity floor via DexScreener, so we don't ape into dust pools.
    if (s.minLiquidityUsd > 0) {
      const info = await fetchTokenInfo(net, token);
      if (info && info.liquidityUsd !== undefined && info.liquidityUsd < s.minLiquidityUsd) {
        throw new Error(
          `liquidity ${Math.round(info.liquidityUsd)} USD below floor of ${s.minLiquidityUsd}`
        );
      }
    }

    // Honeypot heuristic: the token must be sellable back to WETH/native.
    const bestEstimate = routes[0]!;
    if (s.honeypotCheck && !(await this.canSell(net, token, bestEstimate.amountOut))) {
      throw new Error("honeypot check failed: token cannot be sold back");
    }

    // A native/V4-from-ETH buy pays ETH as tx value, so the wallet must hold it.
    // No silent conversion — fail clean (the simulate gate below catches the rest).
    if (quote.isNative) {
      const ethBal = await this.watcher.client(net).getBalance({ address: this.account.address });
      if (ethBal <= amountIn) {
        throw new Error(
          `not enough ${quote.symbol}: the buy costs ~${formatEther(amountIn)} ${quote.symbol} ` +
          `(gas is tiny on ${net}), but the wallet holds only ${formatEther(ethBal)}. ` +
          `Top up ${this.account.address} with ${quote.symbol}, or use a USDC buy.`
        );
      }
    }

    let q: Route | null = null;
    let txHash: Hash | null = null;
    let lastErr: unknown;
    for (const route of routes) {
      try {
        // Approvals per route kind: V3 ERC-20 quote -> V3 router; V2 ERC-20
        // quote -> V2 router; atomic USDC->V4 -> Permit2 for USDC.
        if (route.kind === "v4usdc") {
          await this.ensureV4Approvals(net, quote.address, amountIn);
        } else if (route.kind === "v2") {
          if (!quote.isNative) await this.ensureAllowance(net, quote.address, cfg.v2Router!, amountIn);
        } else if (route.kind === "aerodrome") {
          if (!quote.isNative) await this.ensureAllowance(net, quote.address, cfg.aerodromeRouter!, amountIn);
        } else if (!quote.isNative && route.kind !== "v4") {
          await this.ensureAllowance(net, quote.address, cfg.swapRouter, amountIn);
        }

        const minOut = (route.amountOut * BigInt(10_000 - s.slippageBps)) / 10_000n;
        txHash = await this.swap(
          net, route, quote.address, token, amountIn, minOut,
          quote.isNative ? amountIn : 0n
        );
        q = route;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[buy ${net} ${token}] route ${this.routeLabel(route)} failed; trying fallback`);
      }
    }
    if (!q || !txHash) throw lastErr instanceof Error ? lastErr : new Error("all supported buy routes failed");

    // CRITICAL: writeContract returns on broadcast, not on mining. Wait for the
    // receipt and confirm success BEFORE claiming "bought" or recording — so a
    // tx that reverts on-chain is reported as a failure, not a false success,
    // and the balance read below reflects the mined state.
    const receipt = await this.watcher.client(net)
      .waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") {
      throw new Error("buy reverted on-chain — nothing bought (only gas spent)");
    }

    const meta = await this.tokenMeta(net, token);

    // Robust position tracking: record the ACTUAL on-chain balance after the
    // confirmed swap (not an estimate), so the bot never "forgets" a coin.
    const actualBal = await this.watcher.client(net).readContract({
      address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [this.account.address]
    });

    // Track the position in the asset it was bought with (USDC buys -> USDC,
    // native -> ETH) so sells round-trip to the same asset and PnL is consistent.
    const posQuoteSymbol = quote.symbol;
    const thisCost = spend;
    const existing = this.store.position(token, net);
    const sameQuote = existing?.quoteSymbol === posQuoteSymbol;
    const prevCost = sameQuote ? existing?.costQuote ?? 0 : 0;
    this.store.upsertPosition({
      token, network: net, symbol: meta.symbol,
      decimals: meta.decimals,
      amount: actualBal.toString(),
      costQuote: prevCost + thisCost,
      quoteSymbol: posQuoteSymbol,
      openedAt: existing?.openedAt ?? Date.now()
    });
    this.store.recordSpend(ethEquiv);
    this.lastBuy.set(key, Date.now());
    const info = await fetchTokenInfo(net, token).catch(() => null);
    this.store.recordMyTrade({
      token, network: net, direction: "buy", at: Date.now(), txHash,
      priceUsd: info?.priceUsd,
      marketCap: info?.marketCap ?? info?.fdv
    });

    const detail =
      q.kind === "v4usdc"
        ? `spent ${spend} USDC (atomic USDC→ETH→token)`
        : `spent ${spend} ${quote.symbol} via ${this.routeLabel(q)}`;
    return { network: net, direction: "buy", token, symbol: meta.symbol, txHash, detail };
  }

  async sell(net: NetworkKey, token: Address, pct: number): Promise<ExecutedTrade> {
    const cfg = NETWORKS[net];
    const client = this.watcher.client(net);
    // Sell into whatever the position was bought with, falling back to the
    // currently selected quote asset.
    const pos = this.store.position(token, net);
    const quote: QuoteAsset =
      pos?.quoteSymbol === "USDC" && cfg.usdc
        ? { ...cfg.usdc, symbol: "USDC", isNative: false }
        : { address: cfg.weth, decimals: 18, symbol: cfg.nativeSymbol, isNative: true };

    const balance = await client.readContract({
      address: token, abi: ERC20_ABI,
      functionName: "balanceOf", args: [this.account.address]
    });
    const amountIn = (balance * BigInt(pct)) / 100n;
    if (amountIn === 0n) throw new Error("nothing to sell");

    const routes = await this.routeOptionsWithRetry(net, token, quote.address, amountIn);
    if (routes.length === 0) throw new Error("no pool to sell into");

    let q: Route | null = null;
    let txHash: Hash | null = null;
    let lastErr: unknown;
    for (const route of routes) {
      try {
        // V4 sells (to ETH or USDC) pull the token via Permit2; V2/V3 need a
        // plain ERC-20 allowance to their respective router.
        if (route.kind === "v4" || route.kind === "v4usdcsell") await this.ensureV4Approvals(net, token, amountIn);
        else if (route.kind === "v2") await this.ensureAllowance(net, token, cfg.v2Router!, amountIn);
        else if (route.kind === "aerodrome") await this.ensureAllowance(net, token, cfg.aerodromeRouter!, amountIn);
        else await this.ensureAllowance(net, token, cfg.swapRouter, amountIn);

        const minOut = (route.amountOut * BigInt(10_000 - this.store.settings.slippageBps)) / 10_000n;
        txHash = await this.swap(net, route, token, quote.address, amountIn, minOut, 0n);
        q = route;
        break;
      } catch (e) {
        lastErr = e;
        console.warn(`[sell ${net} ${token}] route ${this.routeLabel(route)} failed; trying fallback`);
      }
    }
    if (!q || !txHash) throw lastErr instanceof Error ? lastErr : new Error("all supported sell routes failed");

    // Confirm the sell actually mined before touching PnL or the position.
    const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") {
      throw new Error("sell reverted on-chain — position unchanged (only gas spent)");
    }

    const meta = await this.tokenMeta(net, token);

    // Realized PnL: proceeds (quoted output) minus the slice of cost basis
    // attributable to the tokens we just sold.
    const proceeds = Number(formatUnits(q.amountOut, quote.decimals));
    const soldFraction = balance > 0n ? Number(amountIn) / Number(balance) : 0;
    const costBasis =
      pos?.costQuote && pos.quoteSymbol === quote.symbol
        ? pos.costQuote * soldFraction
        : undefined;
    const pnlQuote = costBasis !== undefined ? proceeds - costBasis : undefined;
    const pnlPct =
      costBasis && costBasis > 0 ? (pnlQuote! / costBasis) * 100 : undefined;
    if (pnlQuote !== undefined) this.store.recordMyPnl(quote.symbol, pnlQuote);
    const info = await fetchTokenInfo(net, token).catch(() => null);
    this.store.recordMyTrade({
      token, network: net, direction: "sell", at: Date.now(), txHash,
      priceUsd: info?.priceUsd,
      marketCap: info?.marketCap ?? info?.fdv
    });

    if (pct >= 100) {
      this.store.removePosition(token, net);
    } else {
      this.store.upsertPosition({
        token, network: net, symbol: meta.symbol, decimals: meta.decimals,
        amount: (balance - amountIn).toString(),
        // shrink the remaining cost basis by the fraction still held
        costQuote: pos?.costQuote ? pos.costQuote * (1 - soldFraction) : undefined,
        quoteSymbol: pos?.quoteSymbol,
        openedAt: pos?.openedAt
      });
    }

    return {
      network: net, direction: "sell", token, symbol: meta.symbol, txHash,
      detail: `sold ${pct}% for ~${proceeds.toFixed(quote.isNative ? 5 : 2)} ${quote.symbol}`,
      pnlQuote, quoteSymbol: quote.symbol, pnlPct
    };
  }
}
