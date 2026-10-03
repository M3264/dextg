// Buy-Spike scanner — alert-only signal source, independent of the AI scout.
// Finds FRESH tokens whose buy pressure is ACCELERATING right now: the 5-minute
// buy pace is outrunning the 1-hour average. This catches a pump as it ignites,
// not after it has run. No safety scoring, no auto-buy — pure momentum signal.

export type SpikeChain = "solana" | "base" | "bsc";

export interface BuySpike {
  chain: SpikeChain;
  token: string;
  symbol: string;
  liquidityUsd: number;
  buys5m: number;
  sells5m: number;
  buys1h: number;
  sells1h: number;
  buyRatio5m: number;
  accel: number;        // (5m buy pace * 12) / 1h buys  -> >1 means buying is speeding up
  change5m: number;
  change1h: number;
  ageMin: number;
  volume1h: number;
  marketCap?: number;
  url?: string;
  score: number;
}

export interface SpikeFilters {
  minLiquidityUsd?: number;
  maxLiquidityUsd?: number;
  maxAgeMin?: number;
  min5mTxns?: number;
  min1hBuys?: number;
  minBuyRatio5m?: number;
  minAccel?: number;
  limit?: number;
}

const CHAINS = new Set<SpikeChain>(["solana", "base", "bsc"]);
const QUERIES = [
  "solana meme", "pump fun", "raydium", "letsbonk", "base meme", "clanker",
  "bsc meme", "four meme", "ai agent", "moonshot", "virtual base", "bonk"
];

const num = (x: any): number => {
  const n = Number(x);
  return Number.isFinite(n) ? n : 0;
};

async function getJson(url: string, timeoutMs = 6000): Promise<any> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function findBuySpikes(f: SpikeFilters = {}): Promise<BuySpike[]> {
  const minLiq = f.minLiquidityUsd ?? 8_000;
  const maxLiq = f.maxLiquidityUsd ?? 5_000_000;
  const maxAge = f.maxAgeMin ?? 72 * 60;
  const min5m = f.min5mTxns ?? 4;
  const min1h = f.min1hBuys ?? 15;
  const minBr5 = f.minBuyRatio5m ?? 0.60;
  const minAccel = f.minAccel ?? 1.3;
  const limit = f.limit ?? 12;

  const pool = new Map<string, any>();

  // Fresh launch addresses from boosts/profiles (newer than search results).
  const addrs = new Set<string>();
  for (const u of [
    "https://api.dexscreener.com/token-boosts/latest/v1",
    "https://api.dexscreener.com/token-boosts/top/v1",
    "https://api.dexscreener.com/token-profiles/latest/v1"
  ]) {
    const d = await getJson(u);
    if (Array.isArray(d)) {
      for (const it of d) {
        if (CHAINS.has(it?.chainId) && it?.tokenAddress) addrs.add(`${it.chainId}|${it.tokenAddress}`);
      }
    }
  }

  // Broad degen search across chains.
  await Promise.all(QUERIES.map(async q => {
    const d = await getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
    const pairs = Array.isArray(d?.pairs) ? d.pairs : [];
    for (const p of pairs) if (CHAINS.has(p?.chainId) && p?.pairAddress) pool.set(p.pairAddress, p);
  }));

  // Pairs for the fresh launch addresses.
  await Promise.all([...addrs].map(async key => {
    const ta = key.split("|")[1];
    const d = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${ta}`);
    const pairs = Array.isArray(d?.pairs) ? d.pairs : [];
    for (const p of pairs) if (CHAINS.has(p?.chainId) && p?.pairAddress) pool.set(p.pairAddress, p);
  }));

  const now = Date.now();
  const best = new Map<string, BuySpike>();
  for (const p of pool.values()) {
    const tx = p?.txns ?? {};
    const m5 = tx.m5 ?? {};
    const h1 = tx.h1 ?? {};
    const b5 = num(m5.buys), s5 = num(m5.sells);
    const b1 = num(h1.buys), s1 = num(h1.sells);
    const liq = num(p?.liquidity?.usd);
    const pc = p?.priceChange ?? {};
    const ch5 = num(pc.m5), ch1 = num(pc.h1);
    const ageMin = p?.pairCreatedAt ? (now - p.pairCreatedAt) / 60000 : undefined;

    if (ageMin === undefined || ageMin > maxAge) continue;
    if (liq < minLiq || liq > maxLiq) continue;
    if (b5 + s5 < min5m || b1 < min1h) continue;
    const br5 = b5 / (b5 + s5);
    if (br5 < minBr5) continue;
    const accel = b1 > 0 ? (b5 * 12) / b1 : 0;
    if (accel < minAccel) continue;

    // --- Safety gates (data-driven; the live freeze/seize check happens in the
    // caller for Solana) -----------------------------------------------------
    // Honeypot heuristic: lots of buys but NOBODY has sold in an hour usually
    // means sells are blocked. Require proof that selling works.
    if (b1 >= 12 && s1 === 0) continue;
    const mc = num(p?.marketCap) || num(p?.fdv);
    // Exit-liquidity floor: MC dwarfing the pool (liq/MC < 1.5%) = you can't get
    // out without collapsing the price.
    if (mc > 0 && liq / mc < 0.015) continue;

    const token = p?.baseToken?.address;
    if (!token) continue;
    const chain = p.chainId as SpikeChain;
    const score = (b5 * br5) * (1 + Math.max(0, accel - 1) * 0.8) * (1 + Math.max(0, ch5) / 50);
    const spike: BuySpike = {
      chain, token, symbol: p?.baseToken?.symbol ?? "?",
      liquidityUsd: liq, buys5m: b5, sells5m: s5, buys1h: b1, sells1h: s1,
      buyRatio5m: br5, accel, change5m: ch5, change1h: ch1, ageMin,
      volume1h: num(p?.volume?.h1), marketCap: mc || undefined, url: p?.url, score
    };
    const k = `${chain}:${token.toLowerCase()}`;
    const ex = best.get(k);
    if (!ex || spike.score > ex.score) best.set(k, spike);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}
