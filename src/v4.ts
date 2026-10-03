import {
  parseAbi, parseAbiItem, encodeAbiParameters, encodePacked, concatHex,
  type Address, type Hex, type PublicClient
} from "viem";
import type { NetworkKey } from "./config.js";

/**
 * Uniswap V4 support. V4 replaces per-pair pool contracts with a single
 * PoolManager singleton, so swaps go through the Universal Router with
 * flash-accounted "actions" and Permit2 pulls. New Base memecoins launch here,
 * which is why the V3-only router couldn't trade them.
 *
 * Everything in this module was validated against a live Base V4 pool (pool
 * discovery, quoting, and a simulated Universal Router buy) before wiring in.
 */
export interface V4Config {
  poolManager: Address;
  quoter: Address;
  universalRouter: Address;
  permit2: Address;
}

// Only Base is enabled until the addresses are verified on other chains.
export const V4_BY_NET: Partial<Record<NetworkKey, V4Config>> = {
  base: {
    poolManager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    quoter: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
    universalRouter: "0x6ff5693b99212da76ad316178a184ab56d299b43",
    permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3"
  }
};

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

// Universal Router address constants for "the router itself" / "the caller".
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address;
const MSG_SENDER = "0x0000000000000000000000000000000000000001" as Address;

// Universal Router command ids
const V3_SWAP_EXACT_IN = 0x00, WRAP_ETH = 0x0b, UNWRAP_WETH = 0x0c, V4_SWAP = 0x10;
// V4 router action ids
const SWAP_EXACT_IN_SINGLE = 0x06, SETTLE = 0x0b, SETTLE_ALL = 0x0c, TAKE = 0x0e, TAKE_ALL = 0x0f;

// V4 amount sentinels: 0 = use the full open delta/credit; 1<<255 = full balance.
const OPEN_DELTA = 0n;
const CONTRACT_BALANCE = 1n << 255n;

export const INIT_EVENT = parseAbiItem(
  "event Initialize(bytes32 indexed id, address indexed currency0, address indexed currency1, uint24 fee, int24 tickSpacing, address hooks, uint160 sqrtPriceX96, int24 tick)"
);

export const V4_QUOTER_ABI = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)"
]);

export const UNIVERSAL_ROUTER_ABI = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"
]);

export const PERMIT2_ABI = parseAbi([
  "function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function approve(address token, address spender, uint160 amount, uint48 expiration)"
]);

const cmdBytes = (...b: number[]): Hex =>
  concatHex(b.map(x => `0x${x.toString(16).padStart(2, "0")}` as Hex));

const POOL_KEY_COMPONENTS = [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" },
  { name: "fee", type: "uint24" }, { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" }
] as const;

const EXACT_IN_SINGLE_T = {
  type: "tuple", components: [
    { name: "poolKey", type: "tuple", components: POOL_KEY_COMPONENTS },
    { name: "zeroForOne", type: "bool" }, { name: "amountIn", type: "uint128" },
    { name: "amountOutMinimum", type: "uint128" }, { name: "hookData", type: "bytes" }
  ]
} as const;

/** poolManager:poolId -> PoolKey, so discovery only scans logs once per token. */
const keyCache = new Map<string, PoolKey>();

/** First block whose timestamp >= targetSec, via binary search (free-tier safe). */
async function blockAtTime(client: PublicClient, targetSec: bigint, head: bigint): Promise<bigint> {
  let lo = 0n, hi = head;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await client.getBlock({ blockNumber: mid });
    if (b.timestamp < targetSec) lo = mid + 1n;
    else hi = mid;
  }
  return lo;
}

/**
 * Recover a pool's PoolKey from its 32-byte id. The PoolKey isn't derivable
 * from the id (it's the keccak of the key), so we find the Initialize event:
 * pinpoint the creation block by timestamp, then read a small (<=10 block)
 * window — which stays inside free-RPC getLogs limits.
 */
export async function poolKeyFor(
  client: PublicClient, cfg: V4Config, poolId: Hex, createdMs: number
): Promise<PoolKey | null> {
  const ck = `${cfg.poolManager}:${poolId}`;
  const cached = keyCache.get(ck);
  if (cached) return cached;

  const head = await client.getBlock();
  const guess = await blockAtTime(client, BigInt(Math.floor(createdMs / 1000)), head.number);
  const windows: [bigint, bigint][] = [
    [guess - 5n, guess + 4n],
    [guess - 15n, guess - 6n],
    [guess + 5n, guess + 14n],
    [guess - 30n, guess - 21n]
  ];
  for (const [from, to] of windows) {
    const logs = await client.getLogs({
      address: cfg.poolManager, event: INIT_EVENT, args: { id: poolId },
      fromBlock: from < 0n ? 0n : from, toBlock: to
    }).catch(() => []);
    if (logs.length) {
      const a = logs[0].args as any;
      const key: PoolKey = {
        currency0: a.currency0, currency1: a.currency1,
        fee: Number(a.fee), tickSpacing: Number(a.tickSpacing), hooks: a.hooks
      };
      keyCache.set(ck, key);
      return key;
    }
  }
  return null;
}

/** Quote an exact-in V4 swap. Returns amountOut, or null if the pool can't price it. */
export async function quoteV4(
  client: PublicClient, cfg: V4Config, key: PoolKey, zeroForOne: boolean, amountIn: bigint
): Promise<bigint | null> {
  try {
    const sim = await client.simulateContract({
      address: cfg.quoter, abi: V4_QUOTER_ABI, functionName: "quoteExactInputSingle",
      args: [{ poolKey: key, zeroForOne, exactAmount: amountIn, hookData: "0x" }]
    });
    return (sim.result as any)[0] as bigint;
  } catch {
    return null;
  }
}

export interface BuiltSwap {
  commands: Hex;
  inputs: Hex[];
  value: bigint;
  deadline: bigint;
}

/** zeroForOne for swapping `tokenIn` through `key` (currency0 -> currency1 is true). */
export const zeroForOneFor = (key: PoolKey, tokenIn: Address) =>
  key.currency0.toLowerCase() === tokenIn.toLowerCase();

/**
 * Buy with native ETH: wrap to WETH inside the router, swap WETH->token,
 * settle the WETH from the router's balance, take the token to the caller.
 */
export function buildV4Buy(
  key: PoolKey, weth: Address, amountIn: bigint, minOut: bigint, deadline: bigint
): BuiltSwap {
  const wethIsZero = key.currency0.toLowerCase() === weth.toLowerCase();
  const tokenOut = wethIsZero ? key.currency1 : key.currency0;
  const swapParam = encodeAbiParameters([EXACT_IN_SINGLE_T], [
    { poolKey: key, zeroForOne: wethIsZero, amountIn, amountOutMinimum: minOut, hookData: "0x" }
  ]);
  const settleParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "bool" }],
    [weth, amountIn, false] // payerIsUser=false: pay from the router's wrapped WETH
  );
  const takeParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [tokenOut, minOut] // TAKE_ALL token to msg.sender, revert if < minOut
  );
  const actions = cmdBytes(SWAP_EXACT_IN_SINGLE, SETTLE, TAKE_ALL);
  const v4Input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParam, settleParam, takeParam]]);
  const wrapInput = encodeAbiParameters([{ type: "address" }, { type: "uint256" }],
    [ADDRESS_THIS, amountIn]);
  return { commands: cmdBytes(WRAP_ETH, V4_SWAP), inputs: [wrapInput, v4Input], value: amountIn, deadline };
}

/**
 * Atomic USDC -> token buy in ONE transaction: swap USDC->WETH on Uniswap V3
 * (output kept in the router), then WETH->token on V4 using that exact WETH via
 * the open-delta credit, token delivered to the user. Either the whole thing
 * succeeds or it all reverts — USDC can never be stranded as WETH. The USDC is
 * pulled via Permit2 (payerIsUser=true), so Permit2 approvals must be set first.
 */
export function buildV4BuyFromUsdc(
  key: PoolKey, weth: Address, usdc: Address, v3Fee: number,
  usdcIn: bigint, wethMin: bigint, tokenMin: bigint, deadline: bigint
): BuiltSwap {
  const wethIsZero = key.currency0.toLowerCase() === weth.toLowerCase();
  const tokenOut = wethIsZero ? key.currency1 : key.currency0;

  // Command 1: V3 USDC -> WETH, WETH stays in the router (ADDRESS_THIS).
  const v3Path = encodePacked(["address", "uint24", "address"], [usdc, v3Fee, weth]);
  const v3Input = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }],
    [ADDRESS_THIS, usdcIn, wethMin, v3Path, true] // payerIsUser=true: pull USDC via Permit2
  );

  // Command 2: V4 — settle the router's WETH into the pool, swap the resulting
  // credit WETH->token, take the token to the user.
  const settleParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "bool" }],
    [weth, CONTRACT_BALANCE, false] // pay WETH from the router's balance
  );
  const swapParam = encodeAbiParameters([EXACT_IN_SINGLE_T], [{
    poolKey: key, zeroForOne: wethIsZero, amountIn: OPEN_DELTA, // use the settled WETH credit
    amountOutMinimum: tokenMin, hookData: "0x"
  }]);
  const takeParam = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [tokenOut, tokenMin]);
  const actions = cmdBytes(SETTLE, SWAP_EXACT_IN_SINGLE, TAKE_ALL);
  const v4Input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [settleParam, swapParam, takeParam]]);

  return { commands: cmdBytes(V3_SWAP_EXACT_IN, V4_SWAP), inputs: [v3Input, v4Input], value: 0n, deadline };
}

/**
 * Atomic token -> USDC sell in ONE transaction: V4 token->WETH (WETH kept in
 * the router), then V3 WETH->USDC to the user. The token is pulled via Permit2.
 * Mirror of buildV4BuyFromUsdc so USDC-bought positions round-trip to USDC.
 */
export function buildV4SellToUsdc(
  key: PoolKey, weth: Address, usdc: Address, v3Fee: number,
  token: Address, tokenIn: bigint, wethMin: bigint, usdcMin: bigint, deadline: bigint
): BuiltSwap {
  const tokenIsZero = key.currency0.toLowerCase() === token.toLowerCase();

  // Command 1: V4 token -> WETH, WETH taken to the router (ADDRESS_THIS).
  const swapParam = encodeAbiParameters([EXACT_IN_SINGLE_T], [{
    poolKey: key, zeroForOne: tokenIsZero, amountIn: tokenIn,
    amountOutMinimum: wethMin, hookData: "0x"
  }]);
  const settleAllParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [token, tokenIn] // pull the token from the user via Permit2
  );
  const takeParam = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }],
    [weth, ADDRESS_THIS, OPEN_DELTA] // take all WETH to the router
  );
  const actions = cmdBytes(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE);
  const v4Input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParam, settleAllParam, takeParam]]);

  // Command 2: V3 WETH -> USDC, using the router's whole WETH balance, to user.
  const v3Path = encodePacked(["address", "uint24", "address"], [weth, v3Fee, usdc]);
  const v3Input = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bool" }],
    [MSG_SENDER, CONTRACT_BALANCE, usdcMin, v3Path, false] // payerIsUser=false: router's WETH
  );

  return { commands: cmdBytes(V4_SWAP, V3_SWAP_EXACT_IN), inputs: [v4Input, v3Input], value: 0n, deadline };
}

/**
 * Sell token->WETH and unwrap to ETH. The token is pulled from the user via
 * Permit2 (SETTLE_ALL), WETH is taken to the router, then unwrapped to the user.
 * Requires Permit2 approvals to be in place first.
 */
export function buildV4Sell(
  key: PoolKey, weth: Address, token: Address, amountIn: bigint, minOut: bigint, deadline: bigint
): BuiltSwap {
  const tokenIsZero = key.currency0.toLowerCase() === token.toLowerCase();
  const swapParam = encodeAbiParameters([EXACT_IN_SINGLE_T], [
    { poolKey: key, zeroForOne: tokenIsZero, amountIn, amountOutMinimum: minOut, hookData: "0x" }
  ]);
  const settleAllParam = encodeAbiParameters(
    [{ type: "address" }, { type: "uint256" }],
    [token, amountIn] // pull token from user via Permit2
  );
  const takeParam = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint256" }],
    [weth, ADDRESS_THIS, 0n] // take all WETH (OPEN_DELTA) to the router for unwrapping
  );
  const actions = cmdBytes(SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE);
  const v4Input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }],
    [actions, [swapParam, settleAllParam, takeParam]]);
  const unwrapInput = encodeAbiParameters([{ type: "address" }, { type: "uint256" }],
    [MSG_SENDER, minOut]);
  return { commands: cmdBytes(V4_SWAP, UNWRAP_WETH), inputs: [v4Input, unwrapInput], value: 0n, deadline };
}
