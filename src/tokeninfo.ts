import type { Address } from "viem";
import { NETWORKS, type NetworkKey } from "./config.js";

export interface TokenInfo {
  name: string;
  symbol: string;
  priceUsd: number;
  /** native quote price (e.g. token price in SOL) when DexScreener provides it */
  priceNative?: number;
  marketCap?: number;
  fdv?: number;
  liquidityUsd?: number;
  volume24h?: number;
  buys1h?: number;
  sells1h?: number;
  change5m?: number;
  change1h?: number;
  change24h?: number;
  pairCreatedAt?: number;
  dexId?: string;
  url?: string;
  /** token logo, when DexScreener has one */
  imageUrl?: string;
  socials: { label: string; url: string }[];
}

/**
 * Fetch live market stats for a token from DexScreener (free, keyless).
 * Returns null if nothing is indexed yet — common for brand-new tokens, in
 * which case alerts still go out, just without the stats block.
 */
export async function fetchTokenInfo(
  net: NetworkKey,
  token: Address
): Promise<TokenInfo | null> {
  return fetchTokenInfoBySlug(NETWORKS[net].dsSlug, token);
}

/** Slug-based variant, also used for Solana mints. */
export async function fetchTokenInfoBySlug(
  slug: string,
  token: string
): Promise<TokenInfo | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${token}`,
      { cache: "no-store", signal: AbortSignal.timeout(4000) }
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const pairs: any[] = Array.isArray(data?.pairs) ? data.pairs : [];

    // DexScreener returns pairs across every chain for an address; keep ours and
    // pick the deepest-liquidity pair as the canonical quote.
    const onChain = pairs.filter(p => p?.chainId === slug);
    if (onChain.length === 0) return null;
    const p = onChain.sort(
      (a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0)
    )[0];
    return pairToInfo(p);
  } catch {
    return null;
  }
}

/** Which trading network a DexScreener chain slug maps to (if any). */
const SLUG_TO_NET: Record<string, NetworkKey> = {
  base: "base",
  ethereum: "ethereum",
  bsc: "bsc"
};

export interface ResolvedToken {
  /** DexScreener chain slug, e.g. "base" / "solana" / "arbitrum" */
  slug: string;
  /** our trading network, or null if the token lives on an unsupported chain */
  net: NetworkKey | null;
  isSolana: boolean;
  info: TokenInfo;
}

/**
 * Resolve a pasted address with no chain hint: fetch every indexed pair and
 * take the deepest-liquidity one, whatever chain it's on. Lets the user paste a
 * contract and have the bot figure out the network automatically.
 */
export async function resolveToken(token: string): Promise<ResolvedToken | null> {
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${token}`,
      { cache: "no-store", signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const pairs: any[] = Array.isArray(data?.pairs) ? data.pairs : [];
    if (pairs.length === 0) return null;
    const p = pairs
      .slice()
      .sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0))[0];
    const slug = String(p?.chainId ?? "");
    return {
      slug,
      net: SLUG_TO_NET[slug] ?? null,
      isSolana: slug === "solana",
      info: pairToInfo(p)
    };
  } catch {
    return null;
  }
}

/** Map a DexScreener pair object onto our TokenInfo shape. */
function pairToInfo(p: any): TokenInfo {
  const socials: { label: string; url: string }[] = [];
  const info = p?.info;
  if (info) {
    for (const w of info.websites ?? []) {
      if (w?.url) socials.push({ label: w.label || "Web", url: w.url });
    }
    for (const s of info.socials ?? []) {
      if (s?.url) socials.push({ label: s.type || s.platform || "Link", url: s.url });
    }
  }
  return {
    name: p?.baseToken?.name ?? "Unknown",
    symbol: p?.baseToken?.symbol ?? "???",
    priceUsd: Number(p?.priceUsd ?? 0),
    priceNative: num(p?.priceNative),
    marketCap: num(p?.marketCap),
    fdv: num(p?.fdv),
    liquidityUsd: num(p?.liquidity?.usd),
    volume24h: num(p?.volume?.h24),
    buys1h: num(p?.txns?.h1?.buys),
    sells1h: num(p?.txns?.h1?.sells),
    change5m: num(p?.priceChange?.m5),
    change1h: num(p?.priceChange?.h1),
    change24h: num(p?.priceChange?.h24),
    pairCreatedAt: num(p?.pairCreatedAt),
    dexId: p?.dexId,
    url: p?.url,
    imageUrl: info?.imageUrl || undefined,
    socials
  };
}

const num = (v: any): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export interface V4PoolMeta {
  /** 32-byte V4 pool id (DexScreener exposes it as pairAddress for v4 pairs) */
  poolId: `0x${string}`;
  /** pool creation time in ms, used to locate the Initialize event */
  createdMs: number;
}

/** token -> V4 pool meta, cached. The poolId/createdMs never change, so once
 *  discovered we skip the (sometimes flaky) DexScreener round-trip on retries. */
const v4PoolCache = new Map<string, V4PoolMeta>();

/**
 * Find a token's Uniswap V4 pool (deepest-liquidity v4 pair on the chain).
 * Returns the pool id + creation time the trader needs to recover the PoolKey.
 */
export async function fetchV4Pool(slug: string, token: string): Promise<V4PoolMeta | null> {
  const ck = `${slug}:${token.toLowerCase()}`;
  const cached = v4PoolCache.get(ck);
  if (cached) return cached;
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/tokens/${token}`,
      { cache: "no-store", signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const pairs: any[] = Array.isArray(data?.pairs) ? data.pairs : [];
    const v4 = pairs
      .filter(p => p?.chainId === slug && Array.isArray(p?.labels) && p.labels.includes("v4"))
      .sort((a, b) => (b?.liquidity?.usd ?? 0) - (a?.liquidity?.usd ?? 0))[0];
    if (!v4?.pairAddress || !v4?.pairCreatedAt) return null;
    const meta = { poolId: v4.pairAddress as `0x${string}`, createdMs: Number(v4.pairCreatedAt) };
    v4PoolCache.set(ck, meta); // only successful lookups are cached
    return meta;
  } catch {
    return null;
  }
}
