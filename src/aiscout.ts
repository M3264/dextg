import type { Address } from "viem";
import { fetchTokenInfo, fetchTokenInfoBySlug, type TokenInfo } from "./tokeninfo.js";

export type AiScoutMode = "off" | "paper" | "live";
export type AiScoutAction = "ENTER" | "WAIT" | "AVOID";
export type AiScoutSource = "profiles" | "active" | "both";
export type AiScoutChain = "base" | "bsc" | "solana";

export interface AiScoutCandidate {
  chain: AiScoutChain;
  token: string;
  url?: string;
  info: TokenInfo;
  score: number;
  reasons: string[];
  warnings: string[];
}

export interface AiScoutDecision extends AiScoutCandidate {
  action: AiScoutAction;
  aiReason: string;
  source: "rules" | "openai";
  rulesAction?: AiScoutAction;
  aiAction?: AiScoutAction;
}

export interface AiScoutFilters {
  source?: AiScoutSource;
  minScore?: number;
  minMarketCapUsd?: number;
  maxMarketCapUsd?: number;
  minLiquidityUsd?: number;
  maxLiquidityUsd?: number;
  maxAgeMin?: number;
  requirePositiveMomentum?: boolean;
}

const SCOUT_CHAINS = ["base", "bsc", "solana"] as const satisfies readonly AiScoutChain[];
const MIN_SCORE_TO_ENTER = 80;
const CHAIN_SCORE_ADJUST: Record<AiScoutChain, number> = {
  base: 0,
  bsc: 0,
  solana: -4
};
const CHAIN_MIN_LIQUIDITY: Record<AiScoutChain, number> = {
  base: 5_000,
  bsc: 3_000,
  solana: 18_000
};
const CHAIN_MIN_ACTIVITY_1H: Record<AiScoutChain, number> = {
  base: 0,
  bsc: 8,
  solana: 30
};
const apiBase = () =>
  (process.env.AI_SCOUT_BASE_URL || process.env.FREEMODEL_BASE_URL || "https://api.openai.com")
    .replace(/\/+$/, "");

const apiKey = () =>
  process.env.AI_SCOUT_API_KEY || process.env.FREEMODEL_API_KEY || process.env.OPENAI_API_KEY;

const apiModel = () =>
  process.env.AI_SCOUT_MODEL || process.env.FREEMODEL_MODEL ||
  (process.env.FREEMODEL_API_KEY ? "claude-opus-4.8" : process.env.OPENAI_MODEL || "gpt-4.1-mini");

const aiProvider = () =>
  (process.env.AI_SCOUT_PROVIDER || (process.env.FREEMODEL_API_KEY ? "chat" : "openai")).toLowerCase();

// ---------- AI provider circuit breaker ----------
// A dead freemodel key was spamming [aiscout] chat unavailable: HTTP 401 every
// tick and burning log disk / latency. After consecutive failures we cool down
// and run rules-only until the cooldown expires.
const AI_FAIL_TRIP = 4;
const AI_COOLDOWN_MS = 10 * 60_000;
const AI_LOG_EVERY_MS = 60_000;
let aiFailStreak = 0;
let aiCooldownUntil = 0;
let aiLastError = "";
let aiLastLogAt = 0;
let aiLastOkAt = 0;

export type AiScoutHealth = {
  provider: string;
  model: string;
  hasKey: boolean;
  ok: boolean;
  coolingDown: boolean;
  cooldownLeftSec: number;
  failStreak: number;
  lastError: string;
  lastOkAt: number;
};

export function getAiScoutHealth(): AiScoutHealth {
  const now = Date.now();
  const coolingDown = now < aiCooldownUntil;
  return {
    provider: aiProvider(),
    model: apiModel(),
    hasKey: !!apiKey(),
    ok: !coolingDown && aiFailStreak === 0,
    coolingDown,
    cooldownLeftSec: coolingDown ? Math.ceil((aiCooldownUntil - now) / 1000) : 0,
    failStreak: aiFailStreak,
    lastError: aiLastError,
    lastOkAt: aiLastOkAt
  };
}

/** Force end cooldown (e.g. after user rotates API key). */
export function resetAiScoutCircuit(): void {
  aiFailStreak = 0;
  aiCooldownUntil = 0;
  aiLastError = "";
}

function noteAiOk() {
  aiFailStreak = 0;
  aiCooldownUntil = 0;
  aiLastOkAt = Date.now();
}

function noteAiFail(reason: string) {
  aiFailStreak++;
  aiLastError = reason.slice(0, 160);
  const now = Date.now();
  if (aiFailStreak >= AI_FAIL_TRIP) {
    aiCooldownUntil = now + AI_COOLDOWN_MS;
  }
  // Rate-limit log spam: at most once per minute while failing.
  if (now - aiLastLogAt >= AI_LOG_EVERY_MS) {
    aiLastLogAt = now;
    const cool = aiCooldownUntil > now
      ? ` · rules-only for ${Math.ceil((aiCooldownUntil - now) / 1000)}s`
      : ` · streak ${aiFailStreak}/${AI_FAIL_TRIP}`;
    console.error(`[aiscout] chat unavailable: ${aiLastError}${cool}`);
  }
}

function aiCircuitOpen(): boolean {
  return Date.now() < aiCooldownUntil;
}

const asAddress = (s: string): Address | null =>
  /^0x[0-9a-fA-F]{40}$/.test(s) ? s as Address : null;

const asTokenForChain = (chain: AiScoutChain, s: string): string | null => {
  if (chain === "solana") return s.length >= 32 && s.length <= 44 ? s : null;
  return asAddress(s);
};

const tokenKey = (chain: AiScoutChain, token: string) =>
  `${chain}:${chain === "solana" ? token : token.toLowerCase()}`;

const pct = (n?: number) => n === undefined ? "n/a" : `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;

function scoreInfo(info: TokenInfo): { score: number; reasons: string[]; warnings: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const warnings: string[] = [];
  const liq = info.liquidityUsd ?? 0;
  const vol = info.volume24h ?? 0;
  const buys = info.buys1h ?? 0;
  const sells = info.sells1h ?? 0;
  const ageMin = info.pairCreatedAt ? (Date.now() - info.pairCreatedAt) / 60000 : undefined;

  if (liq >= 35_000) { score += 22; reasons.push(`liquidity $${Math.round(liq).toLocaleString()}`); }
  else if (liq >= 12_000) { score += 12; reasons.push(`usable liquidity $${Math.round(liq).toLocaleString()}`); }
  else warnings.push(`thin liquidity $${Math.round(liq).toLocaleString()}`);

  if (vol >= liq * 0.8 && vol > 15_000) { score += 18; reasons.push("volume is high versus liquidity"); }
  else if (vol > 10_000) { score += 10; reasons.push("some 24h volume"); }
  else warnings.push("low volume");

  if (buys + sells >= 30 && buys > sells * 1.3) {
    score += 18;
    reasons.push(`1h buy pressure ${buys}/${sells}`);
  } else if (buys + sells >= 20) {
    score += 5;
    reasons.push(`1h activity ${buys + sells} swaps`);
  } else {
    warnings.push("weak 1h activity");
  }

  if ((info.change5m ?? 0) > 0.5 && (info.change1h ?? 0) > 0.5) {
    score += 12;
    reasons.push(`momentum aligned 5m ${pct(info.change5m)}, 1h ${pct(info.change1h)}`);
  } else if ((info.change1h ?? 0) > 12) {
    score += 8;
    reasons.push(`1h momentum ${pct(info.change1h)}`);
  }

  if ((info.change5m ?? 0) > 80) warnings.push(`5m move is hot ${pct(info.change5m)}`);
  if ((info.change24h ?? 0) > 300) warnings.push(`24h move is extended ${pct(info.change24h)}`);

  if (ageMin !== undefined) {
    if (ageMin >= 10 && ageMin <= 72 * 60) {
      score += 10;
      reasons.push(`fresh age ${ageMin < 60 ? `${Math.round(ageMin)}m` : `${Math.round(ageMin / 60)}h`}`);
    } else if (ageMin < 5) {
      warnings.push("too new to trust yet");
    }
  }

  if (info.marketCap && info.marketCap > 0 && liq / info.marketCap >= 0.03) {
    score += 8;
    reasons.push("liquidity/MC ratio is acceptable");
  }

  return { score: Math.min(100, score), reasons, warnings };
}

async function latestBaseTokens(): Promise<{ chain: AiScoutChain; token: string; url?: string }[]> {
  return profileTokens();
}

async function profileTokens(): Promise<{ chain: AiScoutChain; token: string; url?: string }[]> {
  const rows = await fetchDexRows("https://api.dexscreener.com/token-profiles/latest/v1");
  const seen = new Set<string>();
  const out: { chain: AiScoutChain; token: string; url?: string }[] = [];
  for (const row of rows) {
    const chain = String(row?.chainId ?? "") as AiScoutChain;
    if (!SCOUT_CHAINS.includes(chain)) continue;
    const token = asTokenForChain(chain, String(row?.tokenAddress ?? ""));
    if (!token) continue;
    const key = tokenKey(chain, token);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ chain, token, url: row?.url });
    if (out.length >= 45) break;
  }
  return out;
}

async function activeTokens(): Promise<{ chain: AiScoutChain; token: string; url?: string }[]> {
  const seen = new Set<string>();
  const out: { chain: AiScoutChain; token: string; url?: string }[] = [];
  for (const query of [
    "base meme", "clanker", "virtual base", "zora", "based",
    "bsc meme", "bnb meme", "four meme", "pancakeswap",
    "solana meme", "pump fun", "raydium", "letsbonk"
  ]) {
    const rows = await fetchDexRows(
      `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`
    );
    for (const row of rows) {
      const chain = String(row?.chainId ?? "") as AiScoutChain;
      if (!SCOUT_CHAINS.includes(chain)) continue;
      const token = asTokenForChain(chain, String(row?.baseToken?.address ?? ""));
      if (!token) continue;
      const key = tokenKey(chain, token);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ chain, token, url: row?.url });
      if (out.length >= 60) return out;
    }
  }
  return out;
}

async function fetchDexRows(url: string): Promise<any[]> {
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data: any = await res.json();
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.pairs)) return data.pairs;
    return [];
  } catch {
    return [];
  }
}

export async function findAiScoutCandidate(seenTokens: Set<string>): Promise<AiScoutCandidate | null> {
  const candidates = await findAiScoutCandidates(seenTokens, 1);
  return candidates[0] ?? null;
}

export async function findAiScoutCandidates(
  seenTokens: Set<string>,
  limit = 3,
  filters: AiScoutFilters = {}
): Promise<AiScoutCandidate[]> {
  const source = filters.source ?? "profiles";
  const profiles =
    source === "active" ? await activeTokens()
      : source === "both" ? [...await profileTokens(), ...await activeTokens()]
      : await profileTokens();
  const candidates: AiScoutCandidate[] = [];
  for (const p of profiles) {
    if (seenTokens.has(tokenKey(p.chain, p.token))) continue;
    const info = p.chain === "solana"
      ? await fetchTokenInfoBySlug("solana", p.token)
      : await fetchTokenInfo(p.chain, p.token as Address);
    if (!info) continue;
    const candidate = buildAiScoutCandidate(p.chain, p.token, info, p.url);
    if (!passesFilters(p.chain, info, candidate.score, filters)) continue;
    candidates.push(candidate);
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}

function passesFilters(chain: AiScoutChain, info: TokenInfo, score: number, f: AiScoutFilters): boolean {
  const mc = info.marketCap ?? info.fdv;
  const liq = info.liquidityUsd;
  const txns1h = (info.buys1h ?? 0) + (info.sells1h ?? 0);
  const ageMin = info.pairCreatedAt ? (Date.now() - info.pairCreatedAt) / 60000 : undefined;
  if (score < (f.minScore ?? 45)) return false;
  if (f.minMarketCapUsd && mc !== undefined && mc < f.minMarketCapUsd) return false;
  if (f.maxMarketCapUsd && mc !== undefined && mc > f.maxMarketCapUsd) return false;
  const minLiq = chain === "bsc"
    ? Math.min(f.minLiquidityUsd ?? 0, CHAIN_MIN_LIQUIDITY.bsc)
    : Math.max(f.minLiquidityUsd ?? 0, CHAIN_MIN_LIQUIDITY[chain]);
  if (minLiq && liq !== undefined && liq < minLiq) return false;
  if (f.maxLiquidityUsd && liq !== undefined && liq > f.maxLiquidityUsd) return false;
  if (f.maxAgeMin && ageMin !== undefined && ageMin > f.maxAgeMin) return false;
  if (CHAIN_MIN_ACTIVITY_1H[chain] && txns1h < CHAIN_MIN_ACTIVITY_1H[chain]) return false;
  if (chain === "solana" && (info.buys1h ?? 0) <= (info.sells1h ?? 0)) return false;
  if (f.requirePositiveMomentum && ((info.change5m ?? 0) <= 0 || (info.change1h ?? 0) <= 0)) {
    return false;
  }
  // Honeypot heuristic: real buys but ZERO sells over the hour usually means
  // selling is blocked. Require at least one successful sell as proof of exit.
  if ((info.buys1h ?? 0) >= 12 && (info.sells1h ?? 0) === 0) return false;
  // Exit-liquidity floor: a market cap that dwarfs the pool (liq/MC < 1%) means
  // you can't get out without nuking the price — classic dump setup.
  if (mc !== undefined && mc > 0 && liq !== undefined && liq / mc < 0.01) return false;
  // Strong honeypot indicator: lots of buys but essentially zero sells.
  // Requiring 2+ sells when >10 buys gives room for normal thin-sell tokens.
  if ((info.buys1h ?? 0) > 10 && (info.sells1h ?? 0) < 2) return false;
  return true;
}

export function buildAiScoutCandidate(
  chain: AiScoutChain,
  token: string,
  info: TokenInfo,
  url?: string
): AiScoutCandidate {
  const rawScored = scoreInfo(info);
  const score = Math.max(0, Math.min(100, rawScored.score + CHAIN_SCORE_ADJUST[chain]));
  const reasons = [...rawScored.reasons];
  const warnings = [...rawScored.warnings];
  if (chain === "bsc" && CHAIN_SCORE_ADJUST[chain] > 0) {
    reasons.push("BSC scout leniency: earlier degen setup allowed");
  }
  if (chain === "solana" && CHAIN_SCORE_ADJUST[chain] < 0) {
    warnings.push("Solana stricter gate: needs stronger proof");
  }
  return { chain, token, url: url ?? info.url, info, score, reasons, warnings };
}

function rulesDecision(c: AiScoutCandidate): AiScoutDecision {
  const hardWarnings = c.warnings.filter(w =>
    /thin liquidity|low volume|weak 1h|too new/i.test(w)
  );
  // BSC is the honeypot capital - no leniency; equal to or stricter than base
  const enterScore = c.chain === "solana" ? MIN_SCORE_TO_ENTER + 4
    : c.chain === "bsc" ? MIN_SCORE_TO_ENTER + 4
    : MIN_SCORE_TO_ENTER;
  const waitScore = c.chain === "solana" ? 72
    : c.chain === "bsc" ? 65
    : 60;
  const action: AiScoutAction =
    c.score >= enterScore && hardWarnings.length === 0 ? "ENTER"
      : c.score >= waitScore ? "WAIT"
      : "AVOID";
  return {
    ...c,
    action,
    aiReason: `${action}: score ${c.score}. ${[...c.reasons, ...c.warnings].slice(0, 5).join("; ")}`,
    source: "rules"
  };
}

async function openAiDecision(c: AiScoutCandidate, learningSummary?: string): Promise<AiScoutDecision | null> {
  const key = apiKey();
  if (!key) return null;
  // Circuit open → skip HTTP entirely (rules-only until cooldown ends).
  if (aiCircuitOpen()) return null;

  const system =
    "You are a tiny-budget crypto trading scout. Choose ENTER, WAIT, or AVOID. " +
    "Be conservative: avoid thin liquidity, stale volume, one-candle pumps, and conflicting signals. " +
    "Base uses normal degen-risk rules. BSC may be accepted a bit earlier if activity is real. " +
    "Solana must be stricter: require stronger liquidity, clear buy pressure, and cleaner momentum. " +
    "Use the provided local outcome summary as evidence from prior scout calls; prefer patterns that worked and penalize patterns that failed. " +
    "Return only JSON with action and reason. ENTER is allowed only for genuinely strong short-term setups.";
  const user = JSON.stringify({
    localOutcomeSummary: learningSummary,
    token: c.token,
    chain: c.chain,
    symbol: c.info.symbol,
    score: c.score,
    liquidityUsd: c.info.liquidityUsd,
    volume24h: c.info.volume24h,
    buys1h: c.info.buys1h,
    sells1h: c.info.sells1h,
    change5m: c.info.change5m,
    change1h: c.info.change1h,
    change24h: c.info.change24h,
    pairCreatedAt: c.info.pairCreatedAt,
    reasons: c.reasons,
    warnings: c.warnings
  });

  if (aiProvider() === "chat" || aiProvider() === "openai-chat") {
    try {
      const res = await fetch(`${apiBase()}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: apiModel(),
          temperature: 0,
          max_tokens: 220,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user }
          ]
        }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) {
        noteAiFail(`HTTP ${res.status}`);
        return null;
      }
      const data: any = await res.json();
      const text = String(data?.choices?.[0]?.message?.content ?? "").trim();
      if (!text) {
        noteAiFail("empty response text");
        return null;
      }
      const json = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
      const parsed = JSON.parse(json);
      if (!["ENTER", "WAIT", "AVOID"].includes(parsed.action)) {
        noteAiFail("invalid action");
        return null;
      }
      noteAiOk();
      return { ...c, action: parsed.action, aiReason: String(parsed.reason ?? ""), source: "openai" };
    } catch (err: any) {
      noteAiFail(String(err?.message ?? err).split("\n")[0]);
      return null;
    }
  }

  if (aiProvider() === "claude" || aiProvider() === "anthropic") {
    try {
      const res = await fetch(`${apiBase()}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "accept-encoding": "identity",
          "x-api-key": key,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: apiModel(),
          max_tokens: 220,
          system,
          messages: [{ role: "user", content: user }]
        }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!res.ok) {
        noteAiFail(`claude HTTP ${res.status}`);
        return null;
      }
      const data: any = await res.json();
      const text = Array.isArray(data?.content)
        ? data.content.map((x: any) => x?.text ?? "").join("").trim()
        : "";
      if (!text) {
        noteAiFail("claude empty response");
        return null;
      }
      const json = text.match(/\{[\s\S]*\}/)?.[0] ?? text;
      const parsed = JSON.parse(json);
      if (!["ENTER", "WAIT", "AVOID"].includes(parsed.action)) {
        noteAiFail("claude invalid action");
        return null;
      }
      noteAiOk();
      return { ...c, action: parsed.action, aiReason: String(parsed.reason ?? ""), source: "openai" };
    } catch (err: any) {
      noteAiFail(String(err?.message ?? err).split("\n")[0]);
      return null;
    }
  }

  const payload = {
    model: apiModel(),
    input: [
      {
        role: "system",
        content: system
      },
      {
        role: "user",
        content: user
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "ai_scout_decision",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            action: { type: "string", enum: ["ENTER", "WAIT", "AVOID"] },
            reason: { type: "string" }
          },
          required: ["action", "reason"]
        }
      }
    }
  };

  try {
    const res = await fetch(`${apiBase()}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12_000)
    });
    if (!res.ok) {
      noteAiFail(`responses HTTP ${res.status}`);
      return null;
    }
    const data: any = await res.json();
    const text =
      data?.output_text ??
      data?.output?.flatMap((o: any) => o?.content ?? [])
        ?.find((x: any) => x?.type === "output_text")?.text;
    if (!text) {
      noteAiFail("responses empty text");
      return null;
    }
    const parsed = JSON.parse(text);
    if (!["ENTER", "WAIT", "AVOID"].includes(parsed.action)) {
      noteAiFail("responses invalid action");
      return null;
    }
    noteAiOk();
    return { ...c, action: parsed.action, aiReason: String(parsed.reason ?? ""), source: "openai" };
  } catch (err: any) {
    noteAiFail(String(err?.message ?? err).split("\n")[0]);
    return null;
  }
}

// Score at/above which a rules ENTER is strong enough to act on even when the
// AI is merely cautious (WAIT, not AVOID). Tuned from local data where many
// rules=ENTER setups the AI vetoed went on to run 2x+ ($BTL, $端午节).
const SMART_VETO_CONVICTION = 82;

export async function decideAiScout(c: AiScoutCandidate, learningSummary?: string): Promise<AiScoutDecision> {
  const rules = rulesDecision(c);
  const ai = await openAiDecision(c, learningSummary);
  if (!ai) return { ...rules, rulesAction: rules.action };

  // AI AVOID is a hard safety veto — always respected, never overridden.
  if (ai.action === "AVOID") {
    return { ...ai, rulesAction: rules.action, aiAction: ai.action };
  }

  // Rules risk gate: AI wants ENTER but the rules don't — downgrade to WAIT.
  if (ai.action === "ENTER" && rules.action !== "ENTER") {
    return {
      ...ai,
      action: "WAIT",
      rulesAction: rules.action,
      aiAction: ai.action,
      aiReason: `WAIT: risk gate overrode AI enter. ${ai.aiReason}`
    };
  }

  // Smarter veto: rules say ENTER on a high-conviction setup but the AI is only
  // cautious (WAIT, not AVOID). A merely-hesitant AI should DOWNGRADE conviction,
  // not silently kill the trade — so we take the ENTER and flag the AI caution.
  if (rules.action === "ENTER" && ai.action === "WAIT" && c.score >= SMART_VETO_CONVICTION) {
    return {
      ...c,
      action: "ENTER",
      source: "openai",
      rulesAction: rules.action,
      aiAction: ai.action,
      aiReason: `ENTER: high-conviction rules setup (score ${c.score}); AI was cautious, not blocking. ${ai.aiReason}`
    };
  }

  return { ...ai, rulesAction: rules.action, aiAction: ai.action };
}
