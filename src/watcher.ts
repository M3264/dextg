import {
  createPublicClient,
  webSocket,
  getAddress,
  formatEther,
  formatUnits,
  type Address,
  type Hash,
  type PublicClient,
  decodeEventLog
} from "viem";
import { NETWORKS, type NetworkConfig, type NetworkKey } from "./config.js";
import { TRANSFER_EVENT } from "./abi.js";
import type { Store } from "./store.js";

export interface DetectedTrade {
  network: NetworkKey;
  wallet: Address;
  walletLabel: string;
  txHash: Hash;
  direction: "buy" | "sell";
  token: Address;
  tokenAmount: bigint;
  /** what the wallet paid (buys) or received (sells), when visible on-chain */
  quoteAmount?: { amount: number; symbol: string };
}

type TradeHandler = (trade: DetectedTrade) => Promise<void>;

/**
 * Watches ERC-20 Transfer logs that touch a tracked wallet, over a WebSocket
 * `eth_subscribe('logs', …)` filter. The node pushes only matching logs instead
 * of us refetching every full block, so RPC usage scales with the wallets'
 * activity rather than chain throughput. Each matching tx is then classified by
 * its receipt's Transfer legs, catching trades routed through any DEX,
 * aggregator, or Telegram trading bot.
 */
export class WalletWatcher {
  private clients = new Map<NetworkKey, PublicClient>();
  private unsubscribers: Array<() => void> = [];
  private running = false;
  /** tx hashes already handled, with the time seen, to drop duplicate legs. */
  private seen = new Map<string, number>();

  constructor(
    private store: Store,
    private onTrade: TradeHandler,
    private onError: (msg: string) => void
  ) {}

  client(net: NetworkKey): PublicClient {
    let c = this.clients.get(net);
    if (!c) {
      const cfg = NETWORKS[net];
      if (!cfg.wsUrl) {
        throw new Error(`${net} is not configured — set its RPC env var first`);
      }
      c = createPublicClient({
        chain: cfg.chain,
        transport: webSocket(cfg.wsUrl, { retryCount: Infinity })
      });
      this.clients.set(net, c);
    }
    return c;
  }

  start() {
    this.running = true;
    this.subscribeAll();
  }

  stop() {
    this.running = false;
    this.unsubscribers.forEach(u => {
      try { u(); } catch { /* already closed */ }
    });
    this.unsubscribers = [];
  }

  /** Re-read the wallet/network config and rebuild subscriptions. Call after
   *  wallets are added/removed/toggled or networks switched. */
  refresh() {
    if (!this.running) return;
    this.unsubscribers.forEach(u => {
      try { u(); } catch { /* already closed */ }
    });
    this.unsubscribers = [];
    this.subscribeAll();
  }

  private subscribeAll() {
    const wallets = this.store
      .walletsByChain("evm")
      .filter(w => w.enabled)
      .map(w => getAddress(w.address));
    if (wallets.length === 0) return;

    for (const cfg of Object.values(NETWORKS)) {
      if (!cfg.wsUrl) continue; // network not configured in .env
      if (!this.store.settings.networks[cfg.key]) continue;
      // Two filters: token leaving a tracked wallet (sell side) and token
      // arriving at one (buy side). Either implicates the wallet in a trade.
      this.subscribe(cfg, { from: wallets });
      this.subscribe(cfg, { to: wallets });
    }
  }

  private subscribe(cfg: NetworkConfig, args: { from?: Address[]; to?: Address[] }) {
    const unwatch = this.client(cfg.key).watchEvent({
      event: TRANSFER_EVENT,
      args,
      onLogs: logs => {
        for (const log of logs) {
          const txHash = log.transactionHash;
          const wallet = (args.from ? log.args.from : log.args.to) as Address;
          if (!txHash || !wallet) continue;
          void this.handleTx(cfg, txHash, wallet);
        }
      },
      onError: err =>
        this.onError(`[${cfg.key}] log subscription error: ${err.message}`)
    });
    this.unsubscribers.push(unwatch);
  }

  private async handleTx(cfg: NetworkConfig, txHash: Hash, wallet: Address) {
    // Both filters (and multiple Transfer legs) can surface the same tx; handle
    // each tx once. Prune entries older than 5 minutes to bound memory.
    const key = `${cfg.key}:${txHash}`;
    const now = Date.now();
    if (this.seen.has(key)) return;
    this.seen.set(key, now);
    if (this.seen.size > 500) {
      for (const [k, t] of this.seen) if (now - t > 300_000) this.seen.delete(k);
    }

    if (!this.store.isTracked(wallet)) return;
    try {
      await this.classifyTrade(cfg, txHash, wallet);
    } catch (err: any) {
      this.onError(`[${cfg.key}] failed to decode tx ${txHash}: ${err.message}`);
    }
  }

  private async classifyTrade(cfg: NetworkConfig, txHash: Hash, wallet: Address) {
    const receipt = await this.client(cfg.key).getTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") return;

    const me = wallet.toLowerCase();

    // Spam filter #1: only the wallet's own actions count. Airdrops, dusting
    // and third-party transferFrom all have someone else as tx sender — on
    // mainnet these vastly outnumber real trades.
    if (receipt.from.toLowerCase() !== me) return;

    const weth = cfg.weth.toLowerCase();
    const stableByAddr = new Map(
      cfg.stables.map(s => [s.address.toLowerCase(), s])
    );
    let received: { token: Address; amount: bigint } | undefined;
    let sent: { token: Address; amount: bigint } | undefined;
    // A swap always has a payment leg somewhere in the receipt: WETH moving
    // (wrap/unwrap/pool legs) or a stablecoin moving. A plain token transfer
    // or an airdrop claim has neither.
    let counterLeg = false;
    // Quote units the wallet itself paid out / took in, for the alert.
    let wethOut = 0n, wethIn = 0n;
    let stableOut = 0, stableIn = 0;
    let stableSymbol = "USD";

    for (const log of receipt.logs) {
      let decoded;
      try {
        decoded = decodeEventLog({
          abi: [TRANSFER_EVENT],
          data: log.data,
          topics: log.topics
        });
      } catch {
        continue; // not a Transfer event
      }
      const token = log.address.toLowerCase() as Address;
      const { from, to, value } = decoded.args as {
        from: Address; to: Address; value: bigint;
      };
      if (token === weth) {
        counterLeg = true;
        if (from.toLowerCase() === me) wethOut += value;
        if (to.toLowerCase() === me) wethIn += value;
        continue; // wrap/unwrap legs are not the traded token
      }
      const stable = stableByAddr.get(token);
      if (stable) {
        // Stable moving to/from the wallet is the payment side of a swap, not
        // the memecoin side — count it as the counter-leg only.
        if (to.toLowerCase() === me || from.toLowerCase() === me) {
          counterLeg = true;
          const ui = Number(formatUnits(value, stable.decimals));
          if (from.toLowerCase() === me) stableOut += ui;
          else stableIn += ui;
          stableSymbol = stable.symbol;
          continue;
        }
      }
      if (to.toLowerCase() === me) received = { token, amount: value };
      if (from.toLowerCase() === me) sent = { token, amount: value };
    }

    // Token-to-token swaps have both legs; everything else needs a payment leg.
    const isSwap = (received && sent) || counterLeg;
    if (!isSwap) return; // spam filter #2: plain transfers, mints, claims

    const label =
      this.store.wallets.find(w => w.address === me)?.label ?? "unknown";

    // Token came in and none went out -> they bought it. Token went out -> sold.
    if (received && !sent) {
      // The buy was paid with native coin (tx value, wrapped by the router),
      // WETH, or a stable — surface whichever the wallet actually parted with.
      let quoteAmount: DetectedTrade["quoteAmount"];
      const tx = await this.client(cfg.key)
        .getTransaction({ hash: txHash })
        .catch(() => undefined);
      if (tx && tx.value > 0n) {
        quoteAmount = { amount: Number(formatEther(tx.value)), symbol: cfg.nativeSymbol };
      } else if (wethOut > 0n) {
        quoteAmount = { amount: Number(formatEther(wethOut)), symbol: cfg.nativeSymbol };
      } else if (stableOut > 0) {
        quoteAmount = { amount: stableOut, symbol: stableSymbol };
      }
      await this.onTrade({
        network: cfg.key, wallet, walletLabel: label, txHash,
        direction: "buy", token: received.token, tokenAmount: received.amount,
        quoteAmount
      });
    } else if (sent) {
      // Sell proceeds: WETH or stable credited to the wallet. Native unwraps
      // are internal transfers and invisible in logs — leave undefined then.
      let quoteAmount: DetectedTrade["quoteAmount"];
      if (wethIn > 0n) {
        quoteAmount = { amount: Number(formatEther(wethIn)), symbol: cfg.nativeSymbol };
      } else if (stableIn > 0) {
        quoteAmount = { amount: stableIn, symbol: stableSymbol };
      }
      await this.onTrade({
        network: cfg.key, wallet, walletLabel: label, txHash,
        direction: "sell", token: sent.token, tokenAmount: sent.amount,
        quoteAmount
      });
    }
  }
}
