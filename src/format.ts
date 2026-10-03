import type { NetworkKey } from "./config.js";
import type { TokenInfo } from "./tokeninfo.js";

/**
 * FLUX visual system — terminal / degen desk (Trojan · BONKbot · Maestro energy).
 * Product face is FLUX; legacy SmartDex name kept for continuity.
 */
export const BRAND = "FLUX";
export const BRAND_TAG = "multi-chain desk";
export const BRAND_LEGACY = "SmartDex";

export const NET_BADGE: Record<NetworkKey, string> = {
  base: "🔵 Base",
  ethereum: "⟠ ETH",
  bsc: "🟡 BSC"
};

export const SOLANA_BADGE = "◎ SOL";

/** One thin rule, defined once and reused so every card lines up. */
export const RULE = "────────────────";

/** Status pill helper for home rails. */
export const pill = (on: boolean, onLabel = "ON", offLabel = "OFF") =>
  on ? `🟢 ${onLabel}` : `🔴 ${offLabel}`;

/** Section header used on multi-block desk screens. */
export function section(title: string): string {
  return `▸ <b>${title}</b>`;
}

/** Top bar for home / systems. */
export function deskTitle(subtitle?: string): string {
  return (
    `⚡ <b>${BRAND}</b>` +
    (subtitle ? `  ·  <i>${subtitle}</i>` : `  ·  <i>${BRAND_TAG}</i>`)
  );
}

export const shortAddr = (a: string) => `${a.slice(0, 5)}…${a.slice(-4)}`;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** $36.01K / $1.94M / $7.94B style abbreviation. */
export function money(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

const SUBS = "₀₁₂₃₄₅₆₇₈₉";
const subscript = (n: number) =>
  String(n).split("").map(d => SUBS[Number(d)] ?? d).join("");

/**
 * Compact price for sub-cent tokens: 0.00000003601 -> "$0.0₆3601".
 * The ₆ subscript is the count of leading zeros after the decimal point — the
 * standard DEX convention, rendered cleanly instead of "0.0(6)".
 */
export function smallPrice(p?: number): string {
  if (!p || !Number.isFinite(p) || p <= 0) return "—";
  if (p >= 0.01) return `$${p.toPrecision(4)}`;
  const s = p.toFixed(20);
  const dec = s.split(".")[1] ?? "";
  let zeros = 0;
  while (dec[zeros] === "0") zeros++;
  const sig = dec.slice(zeros, zeros + 4);
  return `$0.0${subscript(zeros)}${sig}`;
}

/** "29m" / "3h" / "5d" since the pair was created. */
export function age(createdAtMs?: number, nowMs?: number): string {
  if (!createdAtMs || !nowMs) return "—";
  const mins = Math.max(0, Math.floor((nowMs - createdAtMs) / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  return `${Math.floor(hrs / 24)}d`;
}

/** Signed percent, one decimal: 5.2 -> "+5.2%". "" when undefined. */
export const delta = (v?: number) =>
  v === undefined ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

/** 1h trade flow: "120↑ 80↓". */
export const flow = (buys?: number, sells?: number) =>
  `${buys ?? 0}↑ ${sells ?? 0}↓`;

const pctParen = (v?: number) => (v === undefined ? "" : `  ${delta(v)}`);

/** Compact token quantity: 1234567 -> "1.23M". */
export function qty(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (abs >= 1) return n.toFixed(2);
  return n.toPrecision(3);
}

/** "0.05 ETH" / "125.40 USDC" — quote amounts with sensible precision. */
export const quoteAmt = (a: { amount: number; symbol: string }): string => {
  const digits = USD_QUOTES.has(a.symbol) ? 2 : 4;
  return `${a.amount.toFixed(digits)} ${a.symbol}`;
};

const USD_QUOTES = new Set(["USDC", "USDT", "USDbC", "DAI", "BUSD", "USD"]);

const stableUsdValue = (amount: number | undefined, symbol: string): number | undefined =>
  amount !== undefined && USD_QUOTES.has(symbol) ? amount : undefined;

/**
 * A monospace, column-aligned key/value block — the core "premium" element.
 * Labels are padded to a common width so values form a clean column. Rendered
 * inside <pre> (the only Telegram mechanism for true monospace alignment).
 */
export function statTable(rows: [string, string][]): string {
  const clean = rows.filter(([, v]) => v !== undefined && v !== "");
  if (clean.length === 0) return "";
  const w = Math.max(...clean.map(([k]) => k.length));
  const body = clean.map(([k, v]) => `${k.padEnd(w)}  ${v}`).join("\n");
  return `<pre>${esc(body)}</pre>`;
}

/** Title + metadata sub-line + rule — the shared top of every card. */
export function cardHeader(opts: {
  pill: string;
  symbol: string;
  name?: string;
  meta: (string | undefined)[];
}): string[] {
  const lines = [`${opts.pill} · <b>$${esc(opts.symbol)}</b>`];
  const metaBits = opts.meta.filter((m): m is string => !!m);
  const sub = [opts.name ? `<i>${esc(opts.name)}</i>` : "", ...metaBits]
    .filter(Boolean)
    .join("  ·  ");
  if (sub) lines.push(sub);
  lines.push(RULE);
  return lines;
}

/** Contract line + socials/links row — the shared bottom of every card. */
export function cardFooter(opts: {
  token: string;
  socials?: { label: string; url: string }[];
  links?: { label: string; url: string }[];
}): string[] {
  const lines = [`📋 <code>${esc(opts.token)}</code>`];
  const refs = [
    ...(opts.links ?? []),
    ...(opts.socials ?? []).slice(0, 4)
  ];
  if (refs.length) {
    lines.push(refs.map(r => `<a href="${esc(r.url)}">${esc(r.label)}</a>`).join("  ·  "));
  }
  return lines;
}

/** Stat rows shared by the trade alert and scanner card. */
function marketRows(i: TokenInfo): [string, string][] {
  const mc = i.marketCap ?? i.fdv;
  const rows: [string, string][] = [
    ["Price", `${smallPrice(i.priceUsd)}${pctParen(i.change5m)}`],
    ["MCap", money(mc)],
    ["Liq", money(i.liquidityUsd)],
    ["Vol 24h", money(i.volume24h)]
  ];
  if (i.buys1h !== undefined || i.sells1h !== undefined) {
    rows.push(["1h flow", `${flow(i.buys1h, i.sells1h)}${pctParen(i.change1h)}`]);
  }
  if (i.change24h !== undefined) rows.push(["24h", delta(i.change24h)]);
  return rows;
}

export interface AlertParams {
  /** display badge, e.g. NET_BADGE[net] or SOLANA_BADGE */
  badge: string;
  direction: "buy" | "sell";
  /** token contract / mint, any chain */
  token: string;
  walletLabel: string;
  /** full URL to the transaction */
  txUrl: string;
  info: TokenInfo | null;
  /** on-chain symbol fallback when DexScreener has no data */
  fallbackSymbol?: string;
  /** UI token quantity that moved */
  tokenQty?: number;
  /** USD value of the moved tokens (qty × DexScreener price) */
  usdValue?: number;
  /** exact quote the wallet paid (buys) / received (sells), when visible */
  quoteAmount?: { amount: number; symbol: string };
  /** the tracked wallet's own realized PnL on this sell, if we saw their buy */
  walletPnl?: { pnlUsd: number; pnlPct?: number };
  nowMs: number;
}

/** The rich HTML alert body shown when a tracked wallet trades. */
export function buildTradeAlert(p: AlertParams): string {
  const i = p.info;
  const sym = i?.symbol ?? p.fallbackSymbol ?? "???";
  const name = i ? i.name : shortAddr(p.token);
  const pill = p.direction === "buy" ? "🟢 BUY" : "🔴 SELL";

  const lines = cardHeader({
    pill,
    symbol: sym,
    name,
    meta: [p.badge, i ? `🌱 ${age(i.pairCreatedAt, p.nowMs)}` : undefined]
  });

  // ---- who did what, and the size that moved ----
  const usdTxt =
    p.usdValue !== undefined && p.usdValue > 0 ? ` (~${money(p.usdValue)})` : "";
  const quoteTxt = p.quoteAmount
    ? quoteAmt(p.quoteAmount)
    : p.usdValue && p.usdValue > 0
      ? money(p.usdValue)
      : "";
  const qtyTxt = p.tokenQty !== undefined ? `${qty(p.tokenQty)} $${esc(sym)}` : `$${esc(sym)}`;
  const who = `<b>${esc(p.walletLabel)}</b>`;
  if (p.direction === "buy") {
    lines.push(quoteTxt ? `${who} spent <b>${quoteTxt}</b>${usdTxt}` : `${who} bought${usdTxt}`);
    lines.push(`→ ${qtyTxt}`);
  } else {
    lines.push(`${who} sold ${qtyTxt}`);
    if (quoteTxt) lines.push(`→ <b>${quoteTxt}</b>${usdTxt}`);
  }
  if (p.walletPnl) {
    const w = p.walletPnl;
    const dot = w.pnlUsd >= 0 ? "🟢" : "🔴";
    const pctTxt = w.pnlPct !== undefined ? ` (${delta(w.pnlPct)})` : "";
    lines.push(`${dot} Their PnL: <b>${w.pnlUsd >= 0 ? "+" : "-"}${money(Math.abs(w.pnlUsd))}</b>${pctTxt}`);
  }

  if (i) {
    lines.push(statTable(marketRows(i)));
  } else {
    lines.push("");
    lines.push("⚠️ <i>No DEX data yet — brand-new, unlisted, or spam.</i>");
  }

  lines.push(...cardFooter({
    token: p.token,
    socials: i?.socials,
    links: [{ label: "🔎 View tx", url: p.txUrl }]
  }));
  return lines.join("\n");
}

/** HH:MM:SS UTC stamp, so refreshed cards visibly tick. */
const clock = (ms: number) => `${new Date(ms).toISOString().slice(11, 19)} UTC`;

export interface ScannerParams {
  badge: string;
  token: string;
  info: TokenInfo | null;
  fallbackSymbol?: string;
  /** live holding + unrealized PnL, when we hold the token */
  position?: {
    symbol: string;
    uiAmount: number;
    quoteSymbol: string;
    proceedsQuote?: number;
    costQuote?: number;
    pnlQuote?: number;
    pnlPct?: number;
  };
  nowMs: number;
  /** optional FLUX extras on the card */
  live?: boolean;
  watched?: boolean;
}

/**
 * FLUX trade ticket — denser than the old "SCAN + stat table" layout.
 * Reads like Trojan/BONK: ticker hero, price/MC inline, momentum strip, bag block.
 */
export function buildScannerCard(p: ScannerParams): string {
  const i = p.info;
  const sym = i?.symbol ?? p.fallbackSymbol ?? "???";
  const name = i?.name && i.name !== sym ? i.name : undefined;
  const ageTxt = i?.pairCreatedAt ? age(i.pairCreatedAt, p.nowMs) : undefined;
  const flags = [
    p.live ? "⏱ LIVE" : undefined,
    p.watched ? "☆" : undefined
  ].filter(Boolean).join(" ");

  // --- HERO ---
  const lines: string[] = [
    `⚡ <b>$${esc(sym)}</b>${flags ? `  ·  ${flags}` : ""}`,
  ];
  const meta = [name ? `<i>${esc(name)}</i>` : "", p.badge, ageTxt ? `🌱 ${ageTxt}` : "", i?.dexId ? esc(i.dexId) : ""]
    .filter(Boolean)
    .join("  ·  ");
  if (meta) lines.push(meta);
  lines.push(RULE);

  // --- MARKET (inline, not a boring 4-row table) ---
  if (i) {
    const mc = i.marketCap ?? i.fdv;
    const priceLine = `<b>${smallPrice(i.priceUsd)}</b>   MC <b>${money(mc)}</b>`;
    lines.push(priceLine);

    const mom = [
      i.change5m !== undefined ? `5m <b>${delta(i.change5m)}</b>` : null,
      i.change1h !== undefined ? `1h <b>${delta(i.change1h)}</b>` : null,
      i.change24h !== undefined ? `24h <b>${delta(i.change24h)}</b>` : null
    ].filter(Boolean).join("  ·  ");
    if (mom) lines.push(mom);

    const depth = [
      i.liquidityUsd !== undefined ? `Liq ${money(i.liquidityUsd)}` : null,
      i.volume24h !== undefined ? `Vol ${money(i.volume24h)}` : null,
      (i.buys1h !== undefined || i.sells1h !== undefined)
        ? `1h ${flow(i.buys1h, i.sells1h)}`
        : null
    ].filter(Boolean).join("  ·  ");
    if (depth) lines.push(`<i>${depth}</i>`);
    lines.push(`🛡 ${safetyStrip(i)}`);
  } else {
    lines.push("⚠️ <i>No DexScreener index — brand-new, unlisted, or spam.</i>");
  }

  // --- BAG ---
  if (p.position) {
    const pos = p.position;
    const valueUsd = stableUsdValue(pos.proceedsQuote, pos.quoteSymbol)
      ?? (i?.priceUsd ? pos.uiAmount * i.priceUsd : undefined);
    const d = pos.quoteSymbol === "USDC" ? 2 : 5;
    lines.push(RULE);
    const pnlBit =
      pos.pnlPct !== undefined
        ? (pos.pnlPct >= 0 ? `🟢 <b>+${pos.pnlPct.toFixed(1)}%</b>` : `🔴 <b>${pos.pnlPct.toFixed(1)}%</b>`)
        : pos.pnlQuote !== undefined
          ? (pos.pnlQuote >= 0
            ? `🟢 +${pos.pnlQuote.toFixed(d)} ${pos.quoteSymbol}`
            : `🔴 ${pos.pnlQuote.toFixed(d)} ${pos.quoteSymbol}`)
          : "";
    const valBit = valueUsd !== undefined
      ? money(valueUsd)
      : pos.proceedsQuote !== undefined
        ? `${pos.proceedsQuote.toFixed(d)} ${pos.quoteSymbol}`
        : "—";
    lines.push(
      `💼 <b>BAG</b>  ${qty(pos.uiAmount)}  ·  ${valBit}` +
      (pnlBit ? `  ·  ${pnlBit}` : "")
    );
    if (pos.costQuote !== undefined) {
      lines.push(`<i>cost ${pos.costQuote.toFixed(d)} ${pos.quoteSymbol}</i>`);
    }
  }

  // --- FOOT ---
  lines.push(RULE);
  lines.push(`<code>${esc(p.token)}</code>`);
  const socials = (i?.socials ?? []).slice(0, 3);
  if (socials.length) {
    lines.push(socials.map(s => `<a href="${esc(s.url)}">${esc(s.label)}</a>`).join("  ·  "));
  }
  lines.push(`🕒 ${clock(p.nowMs)}`);
  return lines.join("\n");
}

/** Confirmation line after our own copy trade executes. */
export function buildExecLine(opts: {
  direction: "buy" | "sell";
  symbol: string;
  detail: string;
  explorer: string;
  txHash: string;
}): string {
  const head = opts.direction === "buy" ? "✅ <b>Copied BUY</b>" : "✅ <b>Copied SELL</b>";
  return (
    `${head} · <b>$${esc(opts.symbol)}</b>\n` +
    `${esc(opts.detail)}\n` +
    `🔎 <a href="${opts.explorer}/tx/${opts.txHash}">View tx</a>`
  );
}

/** Soft safety strip from DexScreener fields only (no extra RPC). */
export function safetyStrip(i: TokenInfo | null | undefined): string {
  if (!i) return "⚠️ Unindexed — trade carefully";
  const bits: string[] = [];
  const liq = i.liquidityUsd ?? 0;
  if (liq >= 50_000) bits.push("💧 deep liq");
  else if (liq >= 10_000) bits.push("💧 ok liq");
  else if (liq > 0) bits.push("⚠️ thin liq");
  else bits.push("⚠️ no liq");

  const ageMin = i.pairCreatedAt
    ? Math.max(0, Math.floor((Date.now() - i.pairCreatedAt) / 60000))
    : undefined;
  if (ageMin !== undefined) {
    if (ageMin < 30) bits.push("🌱 fresh");
    else if (ageMin < 24 * 60) bits.push(`🌱 ${age(i.pairCreatedAt, Date.now())}`);
    else bits.push(`⏳ ${age(i.pairCreatedAt, Date.now())}`);
  }

  const buys = i.buys1h ?? 0;
  const sells = i.sells1h ?? 0;
  if (buys + sells >= 10) {
    const ratio = buys / Math.max(1, sells);
    if (ratio >= 1.4) bits.push("🔥 buy pressure");
    else if (ratio <= 0.7) bits.push("❄️ sell pressure");
  }
  return bits.join(" · ");
}

/** One-line order summary for lists. */
export function orderLine(o: {
  kind: string;
  symbol?: string;
  token: string;
  chain: string;
  amount?: number;
  sellPct?: number;
  triggerPrice?: number;
  intervalMin?: number;
  maxFills?: number;
  fills: number;
  status: string;
}): string {
  const sym = o.symbol ? `$${esc(o.symbol)}` : shortAddr(o.token);
  const chain = o.chain === "solana" ? "SOL" : o.chain;
  if (o.kind === "limit_buy") {
    return `🟢 L-BUY ${sym} · ≤${smallPrice(o.triggerPrice)} · ${o.amount ?? "?"} · <i>${chain}</i>`;
  }
  if (o.kind === "limit_sell") {
    return `🔴 L-SELL ${sym} · ≥${smallPrice(o.triggerPrice)} · ${o.sellPct ?? "?"}% · <i>${chain}</i>`;
  }
  if (o.kind === "dca_buy") {
    const max = o.maxFills && o.maxFills > 0 ? `/${o.maxFills}` : "";
    return `📅 DCA ${sym} · ${o.amount ?? "?"} / ${o.intervalMin ?? "?"}m · ${o.fills}${max} fills · <i>${chain}</i>`;
  }
  return `${o.kind} ${sym} · ${o.status}`;
}

/** Compact PnL line for home / portfolio. */
export function pnlLine(pnl: number, trades: number, wins: number, symbol: string): string {
  const dot = pnl >= 0 ? "🟢" : "🔴";
  const wr = trades > 0 ? ` · ${wins}/${trades}W` : "";
  const digits = symbol === "USDC" || symbol === "USD" ? 2 : 4;
  return `${dot} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(digits)} ${esc(symbol)}${wr}`;
}
