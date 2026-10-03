import { Bot, InlineKeyboard, type Context } from "grammy";
import fs from "node:fs";
import path from "node:path";
import { isAddress, type Address } from "viem";
import { APP, NETWORKS, SOLANA, type NetworkKey } from "../config.js";
import {
  isSolanaAddress,
  type Store,
  type AiScoutRecord,
  type OpenOrder,
  type OrderChain,
  type OrderKind
} from "../store.js";
import type { Trader } from "../trader.js";
import { parseSolanaKeypair, type SolTrader } from "../soltrader.js";
import type { TokenInfo } from "../tokeninfo.js";
import { fetchTokenInfo, fetchTokenInfoBySlug, resolveToken } from "../tokeninfo.js";
import {
  NET_BADGE, SOLANA_BADGE, buildScannerCard, money, smallPrice, qty, age,
  BRAND, BRAND_LEGACY, RULE, statTable, delta, deskTitle, section, pill,
  orderLine, pnlLine as realizedPnlLine
} from "../format.js";
import { tokenChartUrl, TIMEFRAMES, isTimeframe, tfLabel, type Timeframe, type ChartMode } from "../chart.js";
import {
  buildAiScoutCandidate,
  decideAiScout,
  getAiScoutHealth,
  resetAiScoutCircuit,
  type AiScoutChain,
  type AiScoutDecision
} from "../aiscout.js";

const on = (v: boolean) => (v ? "🟢 ON" : "🔴 OFF");
const shortAddress = (addr: string) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** "just now" / "12m ago" / "3h ago" / "5d ago" */
const relTime = (ms?: number): string => {
  if (!ms) return "—";
  const m = Math.floor((Date.now() - ms) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
};

/** GMGN chain slugs */
const GMGN: Record<NetworkKey, string> = { base: "base", ethereum: "eth", bsc: "bsc" };

const USD_QUOTES = new Set(["USDC", "USDT", "USDbC", "DAI", "BUSD", "USD"]);
const stableUsdValue = (amount: number | undefined, symbol: string): number | undefined =>
  amount !== undefined && USD_QUOTES.has(symbol) ? amount : undefined;

/** Trim trailing zeros so 0.0100 -> "0.01" on buttons. */
const fmtAmt = (n: number) => String(Number(n.toFixed(8)));

const upsertEnvValue = (name: string, value: string) => {
  const file = path.join(process.cwd(), ".env");
  const line = `${name}=${value}`;
  const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const next = raw.match(new RegExp(`^${name}=`, "m"))
    ? raw.replace(new RegExp(`^${name}=.*$`, "m"), line)
    : `${raw}${raw.endsWith("\n") || raw.length === 0 ? "" : "\n"}${line}\n`;
  fs.writeFileSync(file, next);
};

export interface QuickTrade {
  /** preset buy amounts in the quote asset */
  buyAmounts: number[];
  /** label for the quote asset, e.g. "ETH" / "USDC" */
  quoteSymbol: string;
  /** preset sell percentages */
  sellPcts: number[];
}

/** Buy row: amounts only (compact Trojan/BONK density). */
function addBuyRow(
  kb: InlineKeyboard,
  net: NetworkKey,
  token: Address,
  q: QuickTrade
) {
  const buys = q.buyAmounts.slice(0, 3);
  for (const amt of buys) {
    kb.text(`🟢 ${fmtAmt(amt)}`, `mbuy:${net}:${token}:${fmtAmt(amt)}`);
  }
  kb.text("✏️", `mbuy:${net}:${token}:x`).row();
}

/** Sell row when holding. */
function addSellRow(
  kb: InlineKeyboard,
  net: NetworkKey,
  token: Address,
  sellPcts: number[]
) {
  const sells = sellPcts.slice(0, 3);
  if (!sells.length) return;
  for (const p of sells) {
    kb.text(`🔴 ${p}%`, `sell:${net}:${token}:${p}`);
  }
  kb.row();
}

/** Lay out preset buy buttons (+ a custom-amount button) then sell buttons. */
function addQuickTradeRows(
  kb: InlineKeyboard,
  net: NetworkKey,
  token: Address,
  holding: boolean,
  q: QuickTrade
) {
  addBuyRow(kb, net, token, q);
  if (holding) addSellRow(kb, net, token, q.sellPcts);
}

/**
 * Inline buttons attached to a trade alert: preset one-tap buys, custom buy,
 * quick-sell when we already hold the token, and external links + scanner.
 */
export function tradeAlertKeyboard(
  net: NetworkKey,
  token: Address,
  info: TokenInfo | null,
  holding: boolean,
  quick: QuickTrade
): InlineKeyboard {
  const kb = new InlineKeyboard();
  addQuickTradeRows(kb, net, token, holding, quick);
  const dsUrl = info?.url ?? `https://dexscreener.com/${NETWORKS[net].dsSlug}/${token}`;
  kb.url("📈 Chart", dsUrl)
    .url("🦎 GMGN", `https://gmgn.ai/${GMGN[net]}/token/${token}`).row();
  kb.text("🔎 Scanner", `scan:${net}:${token}`)
    .url("🔍 Scan", `${NETWORKS[net].explorer}/token/${token}`);
  return kb;
}

/**
 * FLUX trade-card keyboard — buy row → sell row → research → tools.
 * Mirrors BONKbot density: fat buy buttons, thin utility strip.
 */
export function scannerKeyboard(
  net: NetworkKey,
  token: Address,
  info: TokenInfo | null,
  holding: boolean,
  quick: QuickTrade,
  chartTf: Timeframe = "1h",
  chartMode: ChartMode = "price",
  liveOn = false,
  watched = false
): InlineKeyboard {
  const kb = new InlineKeyboard();
  // BUY
  addBuyRow(kb, net, token, quick);
  // SELL (only when holding)
  if (holding) addSellRow(kb, net, token, quick.sellPcts);
  // ORDERS — Trojan/BONK parity: limit + DCA from the ticket
  kb.text("🎯 Limit", `ord:ask:lbuy:${net}:${token}`)
    .text("📅 DCA", `ord:ask:dca:${net}:${token}`);
  if (holding) kb.text("🎯 TP sell", `ord:ask:lsell:${net}:${token}`);
  kb.row();
  // RESEARCH
  const dsUrl = info?.url ?? `https://dexscreener.com/${NETWORKS[net].dsSlug}/${token}`;
  kb.url("Dex", dsUrl)
    .url("GMGN", `https://gmgn.ai/${GMGN[net]}/token/${token}`)
    .url("Scan", `${NETWORKS[net].explorer}/token/${token}`)
    .text("📸", `chart:${net}:${token}:${chartTf}:${chartMode === "mc" ? "m" : "p"}`).row();
  // TOOLS — Live never hits Jupiter
  kb.text(liveOn ? "⏱ ON" : "⏱ Live", `live:${net}:${token}`)
    .text(watched ? "★ Watched" : "☆ Watch", watched ? `watch:rm:${net}:${token}` : `watch:add:${net}:${token}`)
    .text("🔄", `scan:${net}:${token}`)
    .text("🏠", "menu:main");
  return kb;
}

/** Buttons under a chart snapshot: timeframe switch, price/mc toggle, trades. */
export function chartKeyboard(
  net: NetworkKey,
  token: Address,
  info: TokenInfo | null,
  holding: boolean,
  quick: QuickTrade,
  tf: Timeframe,
  mode: ChartMode
): InlineKeyboard {
  const m = mode === "mc" ? "m" : "p";
  // Active TF gets a filled pill; others stay quiet.
  const tab = (t: Timeframe) => (t === tf ? `▸${t.toUpperCase()}` : t.toUpperCase());
  const cell = (t: Timeframe) => kb.text(tab(t), `chart:${net}:${token}:${t}:${m}`);
  const kb = new InlineKeyboard();
  cell("1m"); cell("5m"); cell("15m"); kb.row();
  cell("1h"); cell("4h"); cell("1d"); kb.row();
  kb.text(mode === "mc" ? "💲 Price" : "Ⓜ️ MCap",
    `chart:${net}:${token}:${tf}:${mode === "mc" ? "p" : "m"}`)
    .text("🔄", `chart:${net}:${token}:${tf}:${m}`)
    .text("⚡ Ticket", `scan:${net}:${token}`)
    .text("🏠", "menu:main").row();
  addQuickTradeRows(kb, net, token, holding, quick);
  const dsUrl = info?.url ?? `https://dexscreener.com/${NETWORKS[net].dsSlug}/${token}`;
  kb.url("Dex", dsUrl)
    .url("GMGN", `https://gmgn.ai/${GMGN[net]}/token/${token}`);
  return kb;
}

/** Watch-only Solana alerts get research links but no trade buttons yet. */
export function solAlertKeyboard(mint: string, info: TokenInfo | null): InlineKeyboard {
  const dsUrl = info?.url ?? `https://dexscreener.com/solana/${mint}`;
  return new InlineKeyboard()
    .url("📈 Chart", dsUrl)
    .url("🔍 Solscan", `https://solscan.io/token/${mint}`)
    .url("🦎 GMGN", `https://gmgn.ai/sol/token/${mint}`);
}

export function solScannerKeyboard(
  mint: string,
  info: TokenInfo | null,
  holding: boolean,
  chartTf: Timeframe = "1h",
  chartMode: ChartMode = "price",
  trade = false,
  buys: number[] = [0.005, 0.01],
  sells: number[] = [50, 100],
  quoteSymbol = "SOL",
  liveOn = false,
  watched = false
): InlineKeyboard {
  const dsUrl = info?.url ?? `https://dexscreener.com/solana/${mint}`;
  const kb = new InlineKeyboard();
  if (trade) {
    const row = buys.slice(0, 3);
    for (const v of row) {
      kb.text(`🟢 ${fmtAmt(v)} ${quoteSymbol === "USDC" ? "$" : "◎"}`, `solbuy:${mint}:${fmtAmt(v)}`);
    }
    kb.text("✏️", `solbuy:${mint}:x`).row();
    if (holding) {
      for (const v of sells.slice(0, 3)) {
        kb.text(`🔴 ${v}%`, `solsell:${mint}:${v}`);
      }
      kb.row();
    }
  }
  // ORDERS
  if (trade) {
    kb.text("🎯 Limit", `ord:ask:lbuy:sol:${mint}`)
      .text("📅 DCA", `ord:ask:dca:sol:${mint}`);
    if (holding) kb.text("🎯 TP sell", `ord:ask:lsell:sol:${mint}`);
    kb.row();
  }
  kb.url("Dex", dsUrl)
    .url("Solscan", `https://solscan.io/token/${mint}`)
    .url("GMGN", `https://gmgn.ai/sol/token/${mint}`)
    .text("📸", `solchart:${mint}:${chartTf}:${chartMode === "mc" ? "m" : "p"}`).row()
    .text(liveOn ? "⏱ ON" : "⏱ Live", `live:sol:${mint}`)
    .text(watched ? "★ Watched" : "☆ Watch", watched ? `watch:rm:sol:${mint}` : `watch:add:sol:${mint}`)
    .text("🔄", `solscan:${mint}`)
    .text("🏠", "menu:main");
  return kb;
}

export function solChartKeyboard(
  mint: string,
  info: TokenInfo | null,
  holding: boolean,
  trade: boolean,
  buys: number[],
  sells: number[],
  quoteSymbol: string,
  tf: Timeframe,
  mode: ChartMode
): InlineKeyboard {
  const m = mode === "mc" ? "m" : "p";
  const tab = (t: Timeframe) => (t === tf ? `▸${t.toUpperCase()}` : t.toUpperCase());
  const cell = (t: Timeframe) => kb.text(tab(t), `solchart:${mint}:${t}:${m}`);
  const kb = new InlineKeyboard();
  cell("1m"); cell("5m"); cell("15m"); kb.row();
  cell("1h"); cell("4h"); cell("1d"); kb.row();
  kb.text(mode === "mc" ? "💲 Price" : "Ⓜ️ MCap",
    `solchart:${mint}:${tf}:${mode === "mc" ? "p" : "m"}`)
    .text("🔄", `solchart:${mint}:${tf}:${m}`)
    .text("⚡ Ticket", `solscan:${mint}`)
    .text("🏠", "menu:main").row();
  if (trade) {
    const row = buys.slice(0, 3);
    for (const v of row) {
      kb.text(`🟢 ${fmtAmt(v)} ${quoteSymbol === "USDC" ? "$" : "◎"}`, `solbuy:${mint}:${fmtAmt(v)}`);
    }
    kb.text("✏️", `solbuy:${mint}:x`).row();
    if (holding) {
      for (const v of sells.slice(0, 3)) kb.text(`🔴 ${v}%`, `solsell:${mint}:${v}`);
      kb.row();
    }
  }
  const dsUrl = info?.url ?? `https://dexscreener.com/solana/${mint}`;
  kb.url("Dex", dsUrl)
    .url("Solscan", `https://solscan.io/token/${mint}`)
    .url("GMGN", `https://gmgn.ai/sol/token/${mint}`);
  return kb;
}

/** What the bot is waiting for the admin to type next. */
type Pending =
  | {
      kind: "value";
      prompt: string;
      /** returns an error string, or null on success */
      apply: (v: number) => string | null;
    }
  | {
      kind: "list";
      prompt: string;
      /** returns an error string, or null on success */
      apply: (vals: number[]) => string | null;
    }
  | { kind: "walletimport"; prompt: string }
  | { kind: "solkey"; prompt: string }
  | { kind: "custombuy"; net: NetworkKey; token: Address }
  | { kind: "solcustombuy"; mint: string }
  /** Free-text order wizard: "PRICE AMOUNT" / "PRICE PCT" / "AMOUNT INTERVAL [COUNT]" */
  | {
      kind: "orderinput";
      orderKind: OrderKind;
      chain: OrderChain;
      token: string;
      symbol?: string;
      prompt: string;
    };

interface WalletImportResult {
  added: number;
  duplicate: number;
  invalid: string[];
}

const parseWalletImport = (text: string): Array<{ address: string; label?: string }> =>
  text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const [addr, ...labelParts] = line.split(/\s+/);
      return {
        address: addr,
        label: labelParts.join(" ").trim() || undefined
      };
    });

export function createBot(store: Store, trader: Trader, solTrader?: SolTrader, token = APP.telegramToken) {
  const bot = new Bot(token);
  let pending: Pending | null = null;

  // Telegram caps messages at 4096 chars; viem revert errors are far longer.
  // Keep a short, human line and never let a giant string reach the API.
  // Walk the cause chain for a revert signature; strip any RPC URL (it carries
  // the API key) before anything is logged or shown.
  const scrub = (s: string) => s.replace(/https?:\/\/[^\s)]+/g, "<rpc>");
  const diag = (e: any): string => {
    const parts: string[] = [];
    let cur = e;
    for (let i = 0; i < 8 && cur; i++) {
      if (cur.shortMessage) parts.push(String(cur.shortMessage).split("\n")[0]);
      if (cur.signature) parts.push(`sig=${cur.signature}`);
      if (cur.data && typeof cur.data === "string") parts.push(`data=${cur.data.slice(0, 50)}`);
      cur = cur.cause;
    }
    return scrub(parts.join(" | ")) || "unknown error";
  };
  const errText = (e: any): string => {
    let reverted = false, sig = "", cur = e;
    for (let i = 0; i < 8 && cur; i++) {
      if (/revert|execution reverted/i.test(String(cur.shortMessage ?? ""))) reverted = true;
      if (cur.signature) sig = cur.signature;
      cur = cur.cause;
    }
    if (reverted) {
      return "the token's contract rejected the swap — likely an anti-snipe / whitelist / " +
        "fee-on-transfer hook on this launch. Nothing was spent." + (sig ? ` [${sig}]` : "");
    }
    let m = scrub(String(e?.shortMessage ?? e?.details ?? e?.message ?? e ?? "unknown error")).split("\n")[0];
    // "fetch failed" / "Failed to fetch" is undici's generic wrapper — the real
    // network reason (DNS, refused, reset, timeout) lives in the cause chain.
    if (/fetch failed|failed to fetch|network|terminated/i.test(m)) {
      let cur = e?.cause, code = "", detail = "";
      for (let i = 0; i < 6 && cur; i++) {
        if (cur.code) code = String(cur.code);
        if (cur.message) detail = String(cur.message).split("\n")[0];
        cur = cur.cause;
      }
      const hint = code === "ENOTFOUND" ? "can't resolve the API host (DNS) — check connectivity/RPC"
        : code === "ECONNREFUSED" ? "connection refused by the API host"
        : /timeout|UND_ERR_CONNECT_TIMEOUT/i.test(code) ? "the API host timed out — try again"
        : code === "ECONNRESET" || /terminated/i.test(detail) ? "the connection dropped mid-request — try again"
        : "";
      const extra = hint || detail || code;
      if (extra) m = `${m} (${scrub(extra)})`;
    }
    return m.length > 300 ? m.slice(0, 297) + "…" : m;
  };

  // Global safety net: a failing handler (e.g. a too-long reply) must never
  // crash the process. Log a concise line; never dump the full error object
  // (it embeds the bot token and request body).
  bot.catch(err => {
    const e: any = err.error;
    console.error(`[bot] handler error: ${e?.description ?? e?.shortMessage ?? e?.message ?? e}`);
  });

  // Only the admin can use the bot.
  bot.use(async (ctx, next) => {
    if (ctx.from?.id !== APP.adminId) return;
    await next();
  });

  // ---------- menus ----------

  /** Compact exit rails one-liner for dashboards. */
  const exitRailsLine = () => {
    const s = store.settings;
    if (!s.autoExitEnabled) return "Exits 🔴 OFF";
    const bits: string[] = ["Exits 🟢"];
    if (s.stopLossPct > 0) bits.push(`SL −${s.stopLossPct}%`);
    if (s.trailingStopPct > 0) bits.push(`Trail ${s.trailingStopPct}pts`);
    if (s.takeProfitPct > 0) bits.push(`TP +${s.takeProfitPct}%`);
    if (s.partialTpEnabled) bits.push("Ladder");
    if (bits.length === 1) bits.push("armed (no rails set)");
    return bits.join(" · ");
  };

  const aiHealthLine = () => {
    const h = getAiScoutHealth();
    if (store.settings.aiScoutMode === "off") return "AI ⚪ off";
    if (!h.hasKey) return "AI ⚪ no key · rules only";
    if (h.coolingDown) return `AI 🟠 cool ${h.cooldownLeftSec}s · rules only`;
    if (h.failStreak > 0) return `AI 🟡 fail×${h.failStreak} · ${h.lastError.slice(0, 28) || "retrying"}`;
    return `AI 🟢 ${store.settings.aiScoutMode}`;
  };

  /**
   * Home desk v2 — balances, rails, open orders, tape, clear grid.
   * Matches Trojan/BONK "one glance" desk without burying tools.
   */
  const mainHomeText = async () => {
    const s = store.settings;
    const nets = (Object.keys(NETWORKS) as NetworkKey[])
      .filter(n => s.networks[n] && NETWORKS[n].wsUrl)
      .map(n => n === "base" ? "Base" : n === "ethereum" ? "ETH" : "BSC")
      .join(" · ");
    const cash: string[] = [];
    try {
      const bals = await trader.balances().catch(() => []);
      for (const b of bals) {
        const usdc = b.usdc !== undefined ? ` · ${b.usdc.toFixed(2)} USDC` : "";
        cash.push(`${b.nativeSymbol} ${b.native.toFixed(4)}${usdc}`);
      }
      if (solTrader?.enabled) {
        const [sol, usdc] = await Promise.all([
          solTrader.solBalance().catch(() => null),
          solTrader.usdcBalance().catch(() => null)
        ]);
        cash.push(`SOL ${sol === null ? "?" : sol.toFixed(4)}${usdc !== null ? ` · ${usdc.toFixed(2)} USDC` : ""}`);
      }
    } catch { /* paint without cash */ }

    const realized = Object.entries(store.myPnl).map(([sym, r]) =>
      realizedPnlLine(r.pnl, r.trades, r.wins, sym)
    );

    const tapeLines: string[] = [];
    for (const t of store.recentMyTrades(5)) {
      const when = relTime(t.at);
      const dir = t.direction === "buy" ? "🟢" : "🔴";
      const short = t.token.length > 10 ? `${t.token.slice(0, 4)}…${t.token.slice(-4)}` : t.token;
      const px = t.priceUsd ? ` @ ${smallPrice(t.priceUsd)}` : "";
      tapeLines.push(`${dir} <b>${t.network}</b> <code>${short}</code>${px} · ${when}`);
    }

    const openOrds = store.openOrders();
    const lines = [
      deskTitle("desk"),
      RULE,
      section("RAILS"),
      `Copy ${pill(s.copyEnabled)}  ·  ${aiHealthLine()}`,
      `📡 ${nets || "no EVM"}${solTrader?.enabled ? " · ◎ SOL" : ""}`,
      `🛡 ${exitRailsLine()}`,
      `📊 ${store.positions.length} bags  ·  🎯 ${openOrds.length} orders  ·  ☆ ${store.watchlist.length} watch  ·  👛 ${store.wallets.length}`,
      ""
    ];
    if (cash.length) {
      lines.push(section("CASH"));
      lines.push(cash.map(c => `· ${c}`).join("\n"));
      lines.push("");
    }
    if (realized.length) {
      lines.push(section("REALIZED"));
      lines.push(...realized.map(r => `· ${r}`));
      lines.push("");
    }
    if (openOrds.length) {
      lines.push(section("OPEN ORDERS"));
      for (const o of openOrds.slice(0, 4)) lines.push(`· ${orderLine(o)}`);
      if (openOrds.length > 4) lines.push(`· <i>+${openOrds.length - 4} more…</i>`);
      lines.push("");
    }
    if (tapeLines.length) {
      lines.push(section("TAPE"));
      lines.push(...tapeLines);
      lines.push("");
    }
    lines.push(RULE);
    lines.push(
      `<i>Paste a contract/mint → trade ticket. ` +
      `Limit · DCA · Trail · Live refresh (Dex only, never Jupiter quotes).</i>`
    );
    return lines.join("\n");
  };

  /** Sync wrapper kept for toggle:copy paths that expect a string immediately. */
  const mainMenuTitle = () => {
    const s = store.settings;
    return (
      `${deskTitle("desk")}\n${RULE}\n` +
      `Copy ${pill(s.copyEnabled)}  ·  ${aiHealthLine()}\n` +
      `🛡 ${exitRailsLine()}\n` +
      `📊 ${store.positions.length} bags  ·  🎯 ${store.openOrders().length} orders  ·  ☆ ${store.watchlist.length}\n` +
      `${RULE}\n` +
      `<i>Refreshing balances…</i>`
    );
  };

  const settingsHubTitle =
    `⚙️ <b>Config</b>\n${RULE}\n` +
    `Sizing · Safety · Solana · Charts · AI.\n` +
    `<i>Tap a value → reply with the new number.</i>`;

  /**
   * Primary nav — trade-first grid like BONK/Trojan:
   * Bags · Orders · Defend · Portfolio, then tools.
   */
  const mainMenu = () =>
    new InlineKeyboard()
      .text(`Copy ${store.settings.copyEnabled ? "🟢" : "🔴"}`, "toggle:copy")
      .text("🛡 Defend", "menu:defend").row()
      .text("📊 Bags", "menu:positions")
      .text("🎯 Orders", "menu:orders").row()
      .text("💰 Portfolio", "menu:portfolio")
      .text("📜 History", "menu:history").row()
      .text("☆ Watch", "menu:watch")
      .text("👛 Wallets", "menu:wallets").row()
      .text("🧠 Scout", "menu:aistats")
      .text("💵 Cash", "menu:mywallet").row()
      .text("⚙️ Config", "menu:settings")
      .text("ℹ️ Systems", "menu:status").row()
      .text("❓ Help", "menu:help")
      .text("🚨 Panic", "panic:confirm");

  /** Sticky bottom nav for sub-panels. */
  const navBar = (kb: InlineKeyboard) =>
    kb
      .text("🏠 Desk", "menu:main")
      .text("📊 Bags", "menu:positions")
      .text("🎯 Orders", "menu:orders")
      .text("⚙️", "menu:settings");

  // ----- DEFEND (exit control room — Maestro/Trojan "limit + SL" home) -----
  type ExitPresetId = "degen" | "balanced" | "safe";
  const EXIT_PRESETS: Record<ExitPresetId, Partial<typeof store.settings> & { label: string; blurb: string }> = {
    degen: {
      label: "Degen",
      blurb: "Wide room for runners",
      autoExitEnabled: true,
      stopLossPct: 40,
      trailingStopPct: 45,
      takeProfitPct: 0,
      partialTpEnabled: false,
      runnerTrailPct: 70
    },
    balanced: {
      label: "Balanced",
      blurb: "Trail + ladder scale-out",
      autoExitEnabled: true,
      stopLossPct: 25,
      trailingStopPct: 25,
      takeProfitPct: 0,
      partialTpEnabled: true,
      tpLadder: [{ at: 50, sell: 25 }, { at: 120, sell: 35 }, { at: 300, sell: 50 }],
      runnerTrailPct: 60
    },
    safe: {
      label: "Safe",
      blurb: "Tight SL + bank TP",
      autoExitEnabled: true,
      stopLossPct: 12,
      trailingStopPct: 18,
      takeProfitPct: 80,
      partialTpEnabled: true,
      tpLadder: [{ at: 40, sell: 40 }, { at: 80, sell: 40 }, { at: 150, sell: 50 }],
      runnerTrailPct: 40
    }
  };

  const defendText = () => {
    const s = store.settings;
    return [
      deskTitle("defend"),
      RULE,
      section("ACTIVE RAILS"),
      statTable([
        ["Auto-exit", pill(s.autoExitEnabled)],
        ["Fixed SL", s.stopLossPct ? `−${s.stopLossPct}%` : "off"],
        ["Trail SL", s.trailingStopPct ? `${s.trailingStopPct}pts off peak` : "off"],
        ["Take-profit", s.takeProfitPct ? `+${s.takeProfitPct}%` : "off"],
        ["Ladder", s.partialTpEnabled ? "on" : "off"],
        ["Moonbag trail", s.runnerTrailPct ? `${s.runnerTrailPct}pts` : "off"]
      ]),
      "",
      section("ONE-TAP PRESETS"),
      `<i>Industry-standard arming (like Trojan multi-TP + Maestro trail). Pick a profile — fine-tune after.</i>`,
      "",
      `🔥 <b>Degen</b> — SL 40 · Trail 45 · no hard TP`,
      `⚖️ <b>Balanced</b> — SL 25 · Trail 25 · ladder scale-out`,
      `🛡 <b>Safe</b> — SL 12 · Trail 18 · TP 80 + ladder`,
      "",
      RULE,
      `<i>Trail arms only after peak ≥ trail distance (never forces a loss). Fixed SL covers that.</i>`
    ].join("\n");
  };

  const defendMenu = () => {
    const kb = new InlineKeyboard()
      .text("🔥 Degen", "preset:degen")
      .text("⚖️ Balanced", "preset:balanced")
      .text("🛡 Safe", "preset:safe").row()
      .text(`Auto-exit ${store.settings.autoExitEnabled ? "🟢" : "🔴"}`, "toggle:autoexit")
      .text(`Ladder ${store.settings.partialTpEnabled ? "🟢" : "🔴"}`, "toggle:ladder").row()
      .text(`SL ${store.settings.stopLossPct || "off"}%`, "ask:setsl")
      .text(`Trail ${store.settings.trailingStopPct || "off"}`, "ask:settrailsl").row()
      .text(`TP ${store.settings.takeProfitPct || "off"}%`, "ask:settp")
      .text(`Moon ${store.settings.runnerTrailPct || "off"}`, "ask:setrunnertrail").row()
      .text("⚙️ Full safety settings", "settings:safety").row()
      .text("🚨 Panic sell all", "panic:confirm").row();
    navBar(kb);
    return kb;
  };

  // ----- WATCHLIST -----
  const watchText = () => {
    const list = store.watchlist;
    if (!list.length) {
      return (
        `${deskTitle("watchlist")}\n${RULE}\n` +
        `No pins yet.\n\n` +
        `On any scan card tap <b>☆ Watch</b> to pin (up to 12).\n` +
        `<i>Same idea as BONKbot / Trojan quick-access tokens.</i>`
      );
    }
    const lines = [
      deskTitle("watchlist"),
      RULE,
      section(`${list.length} PINNED`),
      ""
    ];
    for (const w of list) {
      const chain = w.chain === "solana" ? "◎" : NET_BADGE[w.chain as NetworkKey]?.split(" ")[0] ?? w.chain;
      const sym = w.symbol ? `$${w.symbol}` : shortAddress(w.token);
      lines.push(`${chain} <b>${esc(sym)}</b>  <code>${shortAddress(w.token)}</code>`);
    }
    lines.push("", `<i>Tap a pin below to re-open the trade card.</i>`);
    return lines.join("\n");
  };

  const watchMenu = () => {
    const kb = new InlineKeyboard();
    for (const w of store.watchlist.slice(0, 12)) {
      const label = (w.symbol ? `$${w.symbol}` : shortAddress(w.token)).slice(0, 14);
      const open = w.chain === "solana"
        ? `solscan:${w.token}`
        : `scan:${w.chain}:${w.token}`;
      const rm = w.chain === "solana"
        ? `watch:rm:sol:${w.token}`
        : `watch:rm:${w.chain}:${w.token}`;
      kb.text(label, open).text("✕", rm).row();
    }
    kb.text("🔄 Refresh", "menu:watch");
    navBar(kb.row());
    return kb;
  };

  // ----- ORDERS (limit buy / limit sell / DCA) -----
  const ordersText = () => {
    const open = store.openOrders();
    const recent = store.orders
      .filter(o => o.status !== "open")
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 6);
    const lines = [
      deskTitle("orders"),
      RULE,
      section(`OPEN · ${open.length}`),
      ""
    ];
    if (!open.length) {
      lines.push(`No open orders.`);
      lines.push(`From any ticket: <b>🎯 Limit</b> or <b>📅 DCA</b>.`);
    } else {
      for (const o of open) {
        lines.push(`· ${orderLine(o)}`);
        if (o.lastError) lines.push(`  ⚠️ <i>${esc(o.lastError)}</i>`);
      }
    }
    if (recent.length) {
      lines.push("", section("RECENT FILLS / CANCELS"));
      for (const o of recent) {
        const st = o.status === "filled" ? "✅" : o.status === "cancelled" ? "✕" : "⚠️";
        lines.push(`${st} ${orderLine(o)}`);
      }
    }
    lines.push(
      "",
      RULE,
      `<i>Limits use DexScreener mark price (no Jupiter 429 risk). ` +
      `Limit buy: when price ≤ target. Limit sell: when price ≥ target. ` +
      `DCA: recurring buys on an interval.</i>`
    );
    return lines.join("\n");
  };

  const ordersMenu = () => {
    const kb = new InlineKeyboard();
    for (const o of store.openOrders().slice(0, 12)) {
      const tag = o.kind === "limit_buy" ? "LB" : o.kind === "limit_sell" ? "LS" : "DCA";
      const sym = (o.symbol ?? shortAddress(o.token)).slice(0, 10);
      kb.text(`${tag} ${sym}`, `ord:view:${o.id}`)
        .text("✕", `ord:cancel:${o.id}`).row();
    }
    if (store.openOrders().length > 0) {
      kb.text("🗑 Cancel all", "ord:cancelall").row();
    }
    kb.text("🔄 Refresh", "menu:orders");
    navBar(kb.row());
    return kb;
  };

  const orderDetailText = (o: OpenOrder) => {
    const kindLabel =
      o.kind === "limit_buy" ? "Limit BUY" :
      o.kind === "limit_sell" ? "Limit SELL" : "DCA BUY";
    return [
      deskTitle("order"),
      RULE,
      `<b>${kindLabel}</b> · ${o.status.toUpperCase()}`,
      `Chain: <b>${o.chain}</b>`,
      `Token: <code>${esc(o.token)}</code>`,
      o.symbol ? `Symbol: <b>$${esc(o.symbol)}</b>` : "",
      o.triggerPrice ? `Trigger: ${smallPrice(o.triggerPrice)}` : "",
      o.amount !== undefined ? `Amount: <b>${o.amount}</b>` : "",
      o.sellPct !== undefined ? `Sell: <b>${o.sellPct}%</b>` : "",
      o.intervalMin !== undefined ? `Every: <b>${o.intervalMin}m</b>` : "",
      o.maxFills ? `Max fills: <b>${o.maxFills}</b>` : "",
      `Fills: <b>${o.fills}</b>`,
      `Created: ${relTime(o.createdAt)}`,
      o.lastFillAt ? `Last fill: ${relTime(o.lastFillAt)}` : "",
      o.lastError ? `⚠️ ${esc(o.lastError)}` : ""
    ].filter(Boolean).join("\n");
  };

  const orderDetailMenu = (o: OpenOrder) => {
    const kb = new InlineKeyboard();
    const openCb = o.chain === "solana" ? `solscan:${o.token}` : `scan:${o.chain}:${o.token}`;
    kb.text("⚡ Ticket", openCb);
    if (o.status === "open") kb.text("✕ Cancel", `ord:cancel:${o.id}`);
    kb.row().text("🎯 All orders", "menu:orders");
    navBar(kb.row());
    return kb;
  };

  // ----- HISTORY (self trade tape) -----
  const historyText = () => {
    const trades = store.recentMyTrades(20);
    const lines = [deskTitle("history"), RULE, section("YOUR TAPE"), ""];
    if (!trades.length) {
      lines.push(`No trades recorded yet.`);
    } else {
      for (const t of trades) {
        const dir = t.direction === "buy" ? "🟢 BUY" : "🔴 SELL";
        const short = t.token.length > 12 ? `${t.token.slice(0, 4)}…${t.token.slice(-4)}` : t.token;
        const px = t.priceUsd ? smallPrice(t.priceUsd) : "—";
        const mc = t.marketCap ? money(t.marketCap) : "—";
        lines.push(
          `${dir} · <b>${t.network}</b> · ${relTime(t.at)}\n` +
          `  <code>${short}</code> · ${px} · MC ${mc}`
        );
      }
    }
    lines.push("", RULE, `<i>Up to 500 marks stored · copy + manual + auto-exit + orders.</i>`);
    return lines.join("\n");
  };

  const historyMenu = () => {
    const kb = new InlineKeyboard().text("🔄 Refresh", "menu:history");
    navBar(kb.row());
    return kb;
  };

  // Settings is split into focused groups so it reads as a tidy panel instead
  // of one ~40-button wall. `settingsMenu()` is the hub; each group has its own
  // screen with a "Back to settings" button. `settingsGroupMenu`/`settingsGroupTitle`
  // let toggle handlers re-render the exact group the user was on.
  type SettingsGroup = "sizing" | "safety" | "ai" | "sol" | "charts";

  const settingsMenu = () =>
    new InlineKeyboard()
      .text("💱 Trading & sizing", "settings:sizing").row()
      .text("🛡 Safety & exits", "settings:safety").row()
      .text("🧠 AI Scout", "settings:ai").row()
      .text("◎ Solana", "settings:sol").row()
      .text("📈 Charts", "settings:charts").row()
      .text("⬅️ Back", "menu:main");

  const settingsSizingMenu = () => {
    const s = store.settings;
    const bscCfg = NETWORKS.bsc;
    return new InlineKeyboard()
      .text(`Base: ${on(s.networks.base)}`, "toggle:net:base")
      .text(`Ethereum: ${on(s.networks.ethereum)}`, "toggle:net:ethereum").row()
      .text(bscCfg.wsUrl ? `BSC: ${on(s.networks.bsc)}` : "BSC: ⚪ no RPC", "toggle:net:bsc")
      .text(`Base quote: 💱 ${s.baseQuote}`, "toggle:basequote").row()
      .text(`Default buy: ${s.buyAmountEth} ETH`, "ask:setbuy")
      .text(`Default buy: ${s.buyAmountUsdc} USDC`, "ask:setbuyusdc").row()
      .text(`⚡ Buy presets ETH: ${s.buyPresetsEth.join(", ")}`, "asklist:presetseth").row()
      .text(`⚡ Buy presets USDC: ${s.buyPresetsUsdc.join(", ")}`, "asklist:presetsusdc").row()
      .text(`⚡ Sell presets: ${s.sellPresets.map(p => p + "%").join(", ")}`, "asklist:sellpresets").row()
      .text(`Max buy: ${s.maxBuyEth} ETH`, "ask:setmax")
      .text(`Slippage: ${s.slippageBps / 100}%`, "ask:setslippage").row()
      .text("⬅️ Settings", "menu:settings");
  };

  const settingsSafetyMenu = () => {
    const s = store.settings;
    return new InlineKeyboard()
      .text(`Mirror sells: ${on(s.mirrorSells)}`, "toggle:sells")
      .text(`Honeypot: ${on(s.honeypotCheck)}`, "toggle:honeypot").row()
      .text(`Skip if holding: ${on(s.skipIfHolding)}`, "toggle:skiphold").row()
      .text(`Min liq: $${s.minLiquidityUsd}`, "ask:setminliq")
      .text(`Gas cap: ${s.gasCeilingGwei} gwei`, "ask:setgas").row()
      .text(`Daily cap: ${s.dailySpendCapEth} ETH`, "ask:setcap")
      .text(`Cooldown: ${s.buyCooldownSec}s`, "ask:setcooldown").row()
      .text(`🎯 Auto-exit: ${on(s.autoExitEnabled)}`, "toggle:autoexit").row()
      .text(`🪜 Profit ladder: ${on(s.partialTpEnabled)}`, "toggle:ladder").row()
      .text(`🪜 Rungs: ${(s.tpLadder ?? []).map(t => `+${t.at}→${t.sell}%`).join(" · ") || "none"}`, "asklist:setladder").row()
      .text(`🌙 Moonbag trail: ${s.runnerTrailPct || "off"}${s.runnerTrailPct ? "%" : ""}`, "ask:setrunnertrail").row()
      .text(`🛑 Fixed SL: ${s.stopLossPct || "off"}${s.stopLossPct ? "%" : ""}`, "ask:setsl")
      .text(`📉 Trail SL: ${s.trailingStopPct || "off"}${s.trailingStopPct ? "%" : ""}`, "ask:settrailsl").row()
      .text("⬅️ Settings", "menu:settings");
  };

  const settingsAiMenu = () => {
    const s = store.settings;
    return new InlineKeyboard()
      .text(`🧠 AI Scout: ${s.aiScoutMode}`, "toggle:aiscout")
      .text(`AI source: ${s.aiScoutSource}`, "toggle:aisource").row()
      .text(`AI buy: ${s.aiScoutBuyUsdc} USDC`, "ask:setaibuy").row()
      .text(`AI daily: ${s.aiScoutDailyTrades || "off"}`, "ask:setaitrades")
      .text(`AI cooldown: ${s.aiScoutCooldownMin}m`, "ask:setaicooldown").row()
      .text(`AI score ≥ ${s.aiScoutMinScore}`, "ask:setaiscore")
      .text(`AI max MC: ${s.aiScoutMaxMarketCapUsd ? `$${s.aiScoutMaxMarketCapUsd}` : "off"}`, "ask:setaimaxmc").row()
      .text(`AI min MC: ${s.aiScoutMinMarketCapUsd ? `$${s.aiScoutMinMarketCapUsd}` : "off"}`, "ask:setaiminmc")
      .text(`AI liq: $${s.aiScoutMinLiquidityUsd}-${s.aiScoutMaxLiquidityUsd || "∞"}`, "asklist:setailiq").row()
      .text(`AI max age: ${s.aiScoutMaxAgeMin ? `${s.aiScoutMaxAgeMin}m` : "off"}`, "ask:setaiage")
      .text(`AI momentum: ${on(s.aiScoutRequirePositiveMomentum)}`, "toggle:aimomentum").row()
      .text(`AI WAIT alerts: ${on(s.aiScoutNotifyWait)}`, "toggle:aiwait")
      .text(`AI AVOID alerts: ${on(s.aiScoutNotifyAvoid)}`, "toggle:aiavoid").row()
      .text("⬅️ Settings", "menu:settings");
  };

  const settingsSolMenu = () => {
    const s = store.settings;
    return new InlineKeyboard()
      .text(`◎ SOL buy: ${s.solBuyAmount} SOL`, "ask:setsolbuy")
      .text(`◎ SOL quote: ${s.solQuote}`, "toggle:solquote").row()
      .text(`◎ SOL buy: ${s.solBuyAmountUsdc} USDC`, "ask:setsolbuyusdc")
      .text(`◎ SOL fee: ${s.solFeeMode}`, "toggle:solfee").row()
      .text(`◎ SOL presets: ${s.solBuyPresets.join(", ")}`, "asklist:solpresets")
      .text(`◎ SOL slip: ${s.solSlippageBps / 100}%`, "ask:setsolslip").row()
      .text(`◎ SOL USDC presets: ${s.solBuyPresetsUsdc.join(", ")}`, "asklist:solpresetsusdc").row()
      .text(`◎ Max SOL fee: ${s.solMaxFeeSol || "off"} SOL`, "ask:setsolmaxfee").row()
      .text("⬅️ Settings", "menu:settings");
  };

  const settingsChartsMenu = () => {
    const s = store.settings;
    return new InlineKeyboard()
      .text(`📊 Chart: ${s.chartByMarketCap ? "Ⓜ️ MCap" : "💲 Price"}`, "toggle:chartmode")
      .text(`⏱ Chart TF: ${s.chartTimeframe}`, "toggle:chartdeftf").row()
      .text("⬅️ Settings", "menu:settings");
  };

  const settingsGroupMenu = (g: SettingsGroup) =>
    g === "sizing" ? settingsSizingMenu()
    : g === "safety" ? settingsSafetyMenu()
    : g === "ai" ? settingsAiMenu()
    : g === "sol" ? settingsSolMenu()
    : settingsChartsMenu();

  const settingsGroupTitle = (g: SettingsGroup) =>
    g === "sizing" ? "💱 <b>Trading &amp; sizing</b>\nNetworks, buy size, presets, slippage."
    : g === "safety"
      ? "🛡 <b>Safety &amp; exits</b>\n" +
        `${exitRailsLine()}\n` +
        "Fixed SL caps loss · Trail SL locks profit from peak · Auto-exit must be ON to fire."
    : g === "ai" ? `🧠 <b>AI Scout</b>\n${aiHealthLine()}\nDiscovery filters and alert behaviour.`
    : g === "sol" ? "◎ <b>Solana</b>\nSOL trade sizing and fees. Jupiter uses your API key first."
    : "📈 <b>Charts</b>\nDefault chart view.";

  const renderSettingsGroup = (ctx: Context, g: SettingsGroup) =>
    render(ctx, settingsGroupTitle(g), settingsGroupMenu(g));

  const chainIcon = (c: string) => (c === "solana" ? "◎" : "⛓");

  const walletsMenu = () => {
    const kb = new InlineKeyboard();
    for (const w of store.wallets) {
      kb.text(
        `${w.enabled ? "🟢" : "⏸"} ${chainIcon(w.chain)} ${w.label}`,
        `wallet:toggle:${w.address}`
      )
        .text("🗑", `wallet:remove:${w.address}`).row();
    }
    kb.text("➕ Add: /add 0x… or Solana addr", "hint:add").row();
    kb.text("📥 Import wallets", "wallet:import").row();
    kb.text("📊 Wallet Stats", "menu:walletstats")
      .text("⬅️ Back", "menu:main");
    return kb;
  };

  const positionsText = async () => {
    if (store.positions.length === 0) {
      return (
        `${deskTitle("bags")}\n${RULE}\n` +
        "None tracked yet.\n\n" +
        "Tap <b>🔎 Sync holdings</b> to import tokens the trading wallet already holds, " +
        "or <code>/recover 0xToken</code> for a single coin."
      );
    }
    const s = store.settings;
    const lines = [
      deskTitle("bags"),
      RULE,
      `📊 <b>${store.positions.length}</b> open  ·  🛡 ${exitRailsLine()}`,
      `🎯 ${store.openOrders().length} open order(s)`,
      ""
    ];
    for (const p of store.positions) {
      const live = p.network === "solana"
        ? await solTrader?.positionValue(p.token, { jupiterFallback: false }).catch(() => null)
        : await trader.positionValue(p.network, p.token as Address).catch(() => null);
      const net = p.network === "solana" ? "◎" : NET_BADGE[p.network].split(" ")[0];
      if (!live) {
        lines.push(`${net} <b>$${esc(p.symbol)}</b> — <i>not in wallet / no live balance</i>`);
        lines.push("");
        continue;
      }
      const d = live.quoteSymbol === "USDC" ? 2 : 5;
      const value =
        stableUsdValue(live.proceedsQuote, live.quoteSymbol) !== undefined
          ? money(live.proceedsQuote)
          : live.proceedsQuote !== undefined
            ? `${live.proceedsQuote.toFixed(d)} ${live.quoteSymbol}`
            : "—";
      const pnl =
        live.pnlQuote !== undefined
          ? `${signed(live.pnlQuote, live.quoteSymbol)}` +
            (live.pnlPct !== undefined ? ` (${delta(live.pnlPct)})` : "")
          : "—";
      lines.push(`${net} <b>$${esc(live.symbol)}</b>  ·  ${qty(live.uiAmount)}  ·  ${value}`);
      lines.push(`   PnL ${pnl}`);
      if (live.costQuote !== undefined) {
        lines.push(`   Cost ${live.costQuote.toFixed(d)} ${live.quoteSymbol}`);
      }
      // Trail / SL readout: how close the auto-exit is without opening settings.
      const peak = store.getPositionPeak(p.network, p.token);
      const trailPts = s.trailingStopPct;
      if (s.autoExitEnabled && trailPts > 0 && peak !== undefined) {
        const armed = peak >= trailPts;
        const stop = peak - trailPts;
        if (armed) {
          const dist = live.pnlPct !== undefined ? live.pnlPct - stop : undefined;
          lines.push(
            `   📉 Trail <b>${stop >= 0 ? "+" : ""}${stop.toFixed(1)}%</b>` +
            ` (peak ${peak >= 0 ? "+" : ""}${peak.toFixed(1)}% · −${trailPts}pts)` +
            (dist !== undefined ? ` · room ${dist >= 0 ? "+" : ""}${dist.toFixed(1)}` : "")
          );
        } else {
          lines.push(
            `   📉 Trail arms at <b>+${trailPts}%</b>` +
            ` (peak ${peak >= 0 ? "+" : ""}${peak.toFixed(1)}%)`
          );
        }
      }
      if (s.autoExitEnabled && s.stopLossPct > 0 && live.pnlPct !== undefined) {
        const slLevel = -s.stopLossPct;
        lines.push(`   🛑 SL <b>${slLevel}%</b> · ${(live.pnlPct - slLevel).toFixed(1)}pts above`);
      }
      lines.push("");
    }
    lines.push(`<i>Tap below for scan / sell · ⏱ Live on scan cards for auto-refresh.</i>`);
    return lines.join("\n");
  };

  type LivePosition = {
    token: string;
    network: NetworkKey | "solana";
    symbol: string;
    uiAmount: number;
    quoteSymbol: string;
    proceedsQuote?: number;
    costQuote?: number;
    pnlQuote?: number;
    pnlPct?: number;
  };

  const livePosition = async (token: string, network: NetworkKey | "solana"): Promise<LivePosition | null> => {
    const live = network === "solana"
      ? await solTrader?.positionValue(token, { jupiterFallback: false }).catch(() => null)
      : await trader.positionValue(network, token as Address).catch(() => null);
    return live ? { token, network, ...live } : null;
  };

  const pnlDigits = (symbol: string) => symbol === "USDC" ? 2 : 5;

  const pnlImageUrl = (title: string, subtitle: string[], labels: string[], values: number[]) => {
    const cleanLabels = labels.length ? labels.slice(0, 8) : ["PnL"];
    const cleanValues = values.length ? values.slice(0, 8) : [0];
    const cfg = {
      type: "bar",
      data: {
        labels: cleanLabels,
        datasets: [{
          data: cleanValues,
          backgroundColor: cleanValues.map(v => v >= 0 ? "#26a69a" : "#ef5350"),
          borderRadius: 8,
          borderSkipped: false
        }]
      },
      options: {
        indexAxis: "y",
        layout: { padding: { left: 14, right: 18, top: 8, bottom: 8 } },
        plugins: {
          legend: { display: false },
          title: {
            display: true,
            align: "start",
            text: title,
            color: cleanValues.reduce((a, b) => a + b, 0) >= 0 ? "#26a69a" : "#ef5350",
            font: { size: 24, weight: "bold" },
            padding: { top: 8, bottom: 4 }
          },
          subtitle: {
            display: true,
            align: "start",
            text: subtitle,
            color: "#c9d1d9",
            font: { size: 13 },
            padding: { bottom: 14 }
          }
        },
        scales: {
          x: {
            ticks: {
              color: "#8b949e",
              callback: (v: unknown) => `${v}%`
            },
            grid: { color: "rgba(255,255,255,0.07)" }
          },
          y: {
            ticks: { color: "#e6edf3", font: { size: 12, weight: "bold" } },
            grid: { display: false }
          }
        }
      }
    };
    return "https://quickchart.io/chart?v=3&w=760&h=420&bkg=" +
      encodeURIComponent("#0d1117") +
      "&c=" + encodeURIComponent(JSON.stringify(cfg));
  };

  const pnlCardKeyboard = (p?: { token: string; network: NetworkKey | "solana" }) => {
    const kb = new InlineKeyboard();
    if (p) {
      if (p.network === "solana") {
        kb.text("🔍 Scan", `solscan:${p.token}`)
          .text("📸 Chart", `solchart:${p.token}:${chartDefaults().tf}:${chartDefaults().mode === "mc" ? "m" : "p"}`).row();
      } else {
        kb.text("🔍 Scan", `scan:${p.network}:${p.token}`)
          .text("📸 Chart", `chart:${p.network}:${p.token}:${chartDefaults().tf}:${chartDefaults().mode === "mc" ? "m" : "p"}`).row();
      }
    }
    kb.text("🔄 Refresh", p ? `pnl:${p.network}:${p.token}` : "pnl:all")
      .text("📊 Positions", "menu:positions");
    return kb;
  };

  const pnlCardText = async (target?: { token: string; network: NetworkKey | "solana" }) => {
    const now = new Date();
    const positions = target
      ? [await livePosition(target.token, target.network)].filter((p): p is LivePosition => !!p)
      : (await Promise.all(store.positions.map(p => livePosition(p.token, p.network))))
        .filter((p): p is LivePosition => !!p);

    const realized = Object.entries(store.myPnl);
    const lines: string[] = [];
    if (target) {
      const p = positions[0];
      if (!p) {
        return `<b>💰 PnL Card</b>\nNo live tracked position found for this token.\n\n🕒 ${now.toISOString().slice(11, 19)} UTC`;
      }
      const sign = (p.pnlQuote ?? 0) >= 0 ? "🟢 +" : "🔴 ";
      const value =
        stableUsdValue(p.proceedsQuote, p.quoteSymbol) !== undefined
          ? money(p.proceedsQuote)
          : p.proceedsQuote !== undefined
            ? `${p.proceedsQuote.toFixed(pnlDigits(p.quoteSymbol))} ${p.quoteSymbol}`
            : "no route";
      lines.push(`💰 <b>$${esc(p.symbol)} PnL</b> ${p.network === "solana" ? SOLANA_BADGE : NET_BADGE[p.network]}`);
      lines.push("");
      lines.push(`Holding: <b>${qty(p.uiAmount)} $${esc(p.symbol)}</b>`);
      lines.push(`Value: <b>${value}</b>`);
      if (p.costQuote !== undefined) lines.push(`Cost: ${p.costQuote.toFixed(pnlDigits(p.quoteSymbol))} ${p.quoteSymbol}`);
      if (p.pnlQuote !== undefined) {
        const pct = p.pnlPct !== undefined ? ` (${p.pnlPct >= 0 ? "+" : ""}${p.pnlPct.toFixed(1)}%)` : "";
        lines.push(`uPnL: <b>${sign}${Math.abs(p.pnlQuote).toFixed(pnlDigits(p.quoteSymbol))} ${p.quoteSymbol}</b>${pct}`);
      } else {
        lines.push("uPnL: <i>unavailable, no sell quote right now</i>");
      }
      lines.push("");
      lines.push(`<code>${esc(p.token)}</code>`);
      lines.push(`🕒 ${now.toISOString().slice(11, 19)} UTC`);
      return lines.join("\n");
    }

    lines.push("<b>💰 PnL Cards</b>");
    lines.push(`Open positions: <b>${store.positions.length}</b>`);
    if (positions.length) {
      const byQuote = new Map<string, { value: number; cost: number; pnl: number; count: number }>();
      for (const p of positions) {
        const q = p.quoteSymbol;
        const row = byQuote.get(q) ?? { value: 0, cost: 0, pnl: 0, count: 0 };
        row.count += 1;
        if (p.proceedsQuote !== undefined) row.value += p.proceedsQuote;
        if (p.costQuote !== undefined) row.cost += p.costQuote;
        if (p.pnlQuote !== undefined) row.pnl += p.pnlQuote;
        byQuote.set(q, row);
      }
      lines.push("");
      lines.push("<b>Unrealized</b>");
      for (const [q, r] of byQuote) {
        const sign = r.pnl >= 0 ? "🟢 +" : "🔴 ";
        const pct = r.cost > 0 ? ` (${r.pnl >= 0 ? "+" : ""}${((r.pnl / r.cost) * 100).toFixed(1)}%)` : "";
        lines.push(`${sign}${Math.abs(r.pnl).toFixed(pnlDigits(q))} ${q}${pct} • ${r.count} pos`);
      }
    }
    if (realized.length) {
      lines.push("");
      lines.push("<b>Realized</b>");
      for (const [q, r] of realized) {
        const sign = r.pnl >= 0 ? "🟢 +" : "🔴 ";
        lines.push(`${sign}${Math.abs(r.pnl).toFixed(pnlDigits(q))} ${q} • ${r.wins}/${r.trades} wins`);
      }
    }
    if (!positions.length && !realized.length) lines.push("\nNo PnL data yet.");
    lines.push("");
    lines.push(`🕒 ${now.toISOString().slice(11, 19)} UTC`);
    return lines.join("\n");
  };

  const pnlCardPhoto = async (target?: { token: string; network: NetworkKey | "solana" }) => {
    const text = await pnlCardText(target);
    const positions = target
      ? [await livePosition(target.token, target.network)].filter((p): p is LivePosition => !!p)
      : (await Promise.all(store.positions.map(p => livePosition(p.token, p.network))))
        .filter((p): p is LivePosition => !!p);
    if (target) {
      const p = positions[0];
      if (!p) {
        return {
          text,
          url: pnlImageUrl("PnL Card", ["No live tracked position found"], ["No position"], [0])
        };
      }
      const value =
        stableUsdValue(p.proceedsQuote, p.quoteSymbol) !== undefined
          ? money(p.proceedsQuote)
          : p.proceedsQuote !== undefined
            ? `${p.proceedsQuote.toFixed(pnlDigits(p.quoteSymbol))} ${p.quoteSymbol}`
            : "no route";
      const pnl = p.pnlQuote !== undefined
        ? `${p.pnlQuote >= 0 ? "+" : "-"}${Math.abs(p.pnlQuote).toFixed(pnlDigits(p.quoteSymbol))} ${p.quoteSymbol}`
        : "PnL unavailable";
      return {
        text,
        url: pnlImageUrl(
          `$${p.symbol} PnL`,
          [
            `${p.network.toUpperCase()}  Holding ${qty(p.uiAmount)}  Value ${value}`,
            `Cost ${p.costQuote !== undefined ? `${p.costQuote.toFixed(pnlDigits(p.quoteSymbol))} ${p.quoteSymbol}` : "unknown"}  PnL ${pnl}`
          ],
          [`$${p.symbol}`],
          [Number((p.pnlPct ?? 0).toFixed(1))]
        )
      };
    }
    const labels = positions.map(p => `$${p.symbol}`);
    const values = positions.map(p => Number((p.pnlPct ?? 0).toFixed(1)));
    const totalPnl = positions.reduce((sum, p) => sum + (p.pnlQuote ?? 0), 0);
    return {
      text,
      url: pnlImageUrl(
        "Portfolio PnL",
        [
          `${store.positions.length} tracked position(s), ${positions.length} live quote(s)`,
          `Unrealized total: ${totalPnl >= 0 ? "+" : "-"}${Math.abs(totalPnl).toFixed(2)} quote units`
        ],
        labels,
        values
      )
    };
  };

  const showPnlCard = async (ctx: Context, target?: { token: string; network: NetworkKey | "solana" }) => {
    const card = await pnlCardPhoto(target);
    const kb = pnlCardKeyboard(target);
    const msg: any = ctx.callbackQuery?.message;
    if (msg?.photo) {
      try {
        await ctx.editMessageMedia(
          { type: "photo", media: card.url, caption: card.text, parse_mode: "HTML" },
          { reply_markup: kb }
        );
        return;
      } catch {
        /* fall through */
      }
    }
    await ctx.replyWithPhoto(card.url, { caption: card.text, parse_mode: "HTML", reply_markup: kb })
      .catch(() => ctx.reply(card.text, { parse_mode: "HTML", reply_markup: kb }));
  };

  const positionsMenu = () => {
    const kb = new InlineKeyboard();
    for (const p of store.positions) {
      if (p.network === "solana") {
        kb.text(`🔍 ${p.symbol} (sol)`, `solscan:${p.token}`).row();
        kb.text("Sell 25%", `solsell:${p.token}:25`)
          .text("Sell 50%", `solsell:${p.token}:50`)
          .text("Sell 100%", `solsell:${p.token}:100`).row();
        kb.text("📸 Chart", `solchart:${p.token}:${chartDefaults().tf}:${chartDefaults().mode === "mc" ? "m" : "p"}`)
          .text("💰 PnL", `pnl:solana:${p.token}`)
          .text("🗑 Remove", `posrm:solana:${p.token}`).row();
      } else {
        kb.text(`🔍 ${p.symbol} (${p.network})`, `scan:${p.network}:${p.token}`).row();
        kb.text("Sell 25%", `sell:${p.network}:${p.token}:25`)
          .text("Sell 50%", `sell:${p.network}:${p.token}:50`)
          .text("Sell 100%", `sell:${p.network}:${p.token}:100`).row();
        kb.text("📸 Chart", `chart:${p.network}:${p.token}:${chartDefaults().tf}:${chartDefaults().mode === "mc" ? "m" : "p"}`)
          .text("💰 PnL", `pnl:${p.network}:${p.token}`)
          .text("🗑 Remove", `posrm:${p.network}:${p.token}`).row();
      }
    }
    if (store.positions.length === 0) kb.text("No open positions", "noop").row();
    kb.text("💰 PnL Cards", "pnl:all")
      .text("🔄 Refresh", "menu:positions").row()
      .text("🔎 Sync holdings", "possync:all").row();
    navBar(kb);
    return kb;
  };

  const statusText = () => {
    const s = store.settings;
    const nets = (Object.keys(NETWORKS) as NetworkKey[])
      .filter(n => s.networks[n] && NETWORKS[n].wsUrl)
      .join(", ") || "none";
    const sol = store.walletsByChain("solana").length;
    const cap = s.dailySpendCapEth;
    const h = getAiScoutHealth();
    const jup = SOLANA.jupiterApiKey ? "🟢 API key" : "🟡 free tier";
    const aiRow = !h.hasKey
      ? "no key · rules only"
      : h.coolingDown
        ? `🟠 cool ${h.cooldownLeftSec}s · ${h.lastError || "failing"}`
        : h.failStreak > 0
          ? `🟡 fail×${h.failStreak} · ${h.lastError || "…"}`
          : `🟢 ${h.provider}/${h.model}`;
    return [
      deskTitle("systems"),
      RULE,
      `Trading wallet:`,
      `<code>${trader.account.address}</code>`,
      "",
      "⚙ <b>Trading</b>",
      statTable([
        ["Copy", on(s.copyEnabled)],
        ["Exits", exitRailsLine()],
        ["Networks", nets],
        ["Base quote", s.baseQuote],
        ["Solana", `${s.solQuote} · ${s.solQuote === "USDC" ? `${s.solBuyAmountUsdc} USDC` : `${s.solBuyAmount} SOL`} · slip ${s.solSlippageBps / 100}% · ${s.solFeeMode}`],
        ["Jupiter", jup],
        ["Wallets", `${store.wallets.length}${sol ? ` (${sol} Solana)` : ""}`],
        ["Positions", String(store.positions.length)],
        ["Orders", String(store.openOrders().length)],
        ["Spent today", `${store.spentToday().toFixed(4)} / ${cap > 0 ? cap : "∞"} ETH`]
      ]),
      "",
      "🧠 <b>AI Scout</b>",
      statTable([
        ["Mode", s.aiScoutMode],
        ["Health", aiRow],
        ["Source", s.aiScoutSource],
        ["Score ≥", String(s.aiScoutMinScore)],
        ["Buy size", `$${s.aiScoutBuyUsdc}`]
      ]),
      "",
      "🛡 <b>Exit rails</b>",
      statTable([
        ["Auto-exit", on(s.autoExitEnabled)],
        ["Fixed SL", s.stopLossPct ? `−${s.stopLossPct}%` : "off"],
        ["Trail SL", s.trailingStopPct ? `${s.trailingStopPct}pts off peak` : "off"],
        ["Take-profit", s.takeProfitPct ? `+${s.takeProfitPct}%` : "off"],
        ["Ladder", s.partialTpEnabled ? "on" : "off"],
        ["Moonbag trail", s.runnerTrailPct ? `${s.runnerTrailPct}pts` : "off"]
      ]),
      "",
      `<i>Paste a mint/contract anywhere to open a scan card. ⏱ Live on cards = Dex-only refresh.</i>`
    ].join("\n");
  };

  const statusMenu = () =>
    new InlineKeyboard()
      .text("🔄 Refresh", "menu:status")
      .text("🛡 Exits", "settings:safety").row()
      .text("🧠 AI Settings", "settings:ai")
      .text("♻️ Reset AI", "sys:resetai").row()
      .text("💼 My Wallet", "menu:mywallet")
      .text("⬅️ Back", "menu:main");

  // ---------- wallet screens ----------

  const myWalletText = async () => {
    const lines = [
      `💼 <b>Trading wallet</b>`,
      `<code>${trader.account.address}</code>`,
      RULE
    ];
    const balRows: [string, string][] = [];
    const balances = await trader.balances();
    for (const b of balances) {
      const usdc = b.usdc !== undefined ? ` · ${b.usdc.toFixed(2)} USDC` : "";
      balRows.push([netName(b.network), `${b.native.toFixed(5)} ${b.nativeSymbol}${usdc}`]);
    }
    if (solTrader?.enabled) {
      const [sol, usdc] = await Promise.all([
        solTrader.solBalance().catch(() => null),
        solTrader.usdcBalance().catch(() => null)
      ]);
      balRows.push(["Solana", `${sol === null ? "?" : sol.toFixed(5)} SOL${usdc !== null ? ` · ${usdc.toFixed(2)} USDC` : ""}`]);
    }
    lines.push(balRows.length ? statTable(balRows) : "<i>No active networks — enable one in ⚙️ Settings.</i>");
    const cap = store.settings.dailySpendCapEth;
    lines.push(`📊 Open positions: <b>${store.positions.length}</b>`);
    lines.push(`💸 Spent today: ${store.spentToday().toFixed(4)} / ${cap > 0 ? cap : "∞"} ETH`);
    const pnl = Object.entries(store.myPnl);
    if (pnl.length) {
      lines.push("");
      lines.push("💰 <b>Realized copy-trade PnL</b>");
      lines.push(statTable(pnl.map(([symbol, r]): [string, string] =>
        [symbol, `${r.pnl >= 0 ? "+" : "-"}${Math.abs(r.pnl).toFixed(symbol === "USDC" ? 2 : 5)} · ${r.wins}/${r.trades} wins`]
      )));
    }
    return lines.join("\n");
  };

  const myWalletMenu = () =>
    new InlineKeyboard()
      .text("🔄 Refresh", "menu:mywallet")
      .text("📊 Positions", "menu:positions").row()
      .text("🔑 Import Sol key", "wallet:solkey").row()
      .text("⬅️ Back", "menu:main");

  const walletStatsText = () => {
    if (store.wallets.length === 0) {
      return "<b>📊 Tracked wallet stats</b>\nNo tracked wallets yet — add some with /add.";
    }
    const lines = [
      "📊 <b>Tracked wallet leaderboard</b>",
      RULE,
      "<i>Observed since tracking began — ranked by realized PnL.</i>",
      ""
    ];
    const ranked = [...store.wallets].sort(
      (a, b) =>
        (store.statsFor(b.address)?.pnlUsd ?? -Infinity) -
        (store.statsFor(a.address)?.pnlUsd ?? -Infinity)
    );
    const shown = ranked.slice(0, 25);
    shown.forEach((w, idx) => {
      const medal = idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `${idx + 1}.`;
      const head = `${medal} ${chainIcon(w.chain)} <b>${esc(w.label)}</b>${w.enabled ? "" : " ⏸"}`;
      const s = store.statsFor(w.address);
      if (!s) {
        lines.push(`${head} — <i>no trades seen yet</i>`);
        return;
      }
      const judged = s.wins + s.losses;
      const wr = judged > 0 ? ` · WR ${((s.wins / judged) * 100).toFixed(0)}%` : "";
      const sign = s.pnlUsd >= 0 ? "🟢 +$" : "🔴 -$";
      lines.push(
        `${head}\n` +
        `       ${s.buys} buys / ${s.sells} sells · PnL <b>${sign}${Math.abs(s.pnlUsd).toFixed(2)}</b>${wr} · ${relTime(s.lastAt)}`
      );
    });
    if (ranked.length > shown.length) {
      lines.push(`…and ${ranked.length - shown.length} more`);
    }
    return lines.join("\n");
  };

  const walletStatsMenu = () =>
    new InlineKeyboard()
      .text("🔄 Refresh", "menu:walletstats")
      .text("👛 Wallets", "menu:wallets").row()
      .text("⬅️ Back", "menu:main");

  // ---- Scout movement helpers + explorer (shared by /aistats and its drill-downs) ----
  const movePct = (mc?: number, base?: number) => (mc !== undefined && base) ? ((mc - base) / base) * 100 : undefined;
  const fmtMove = (v?: number) => v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`;
  // Measure from the ENTER reference (realistic buy) when present, else first-sighting.
  const refMc = (r: AiScoutRecord) => r.entryMarketCap ?? r.firstMarketCap;
  const dipOf = (r: AiScoutRecord) => movePct(r.minMarketCap, refMc(r));
  const nowOf = (r: AiScoutRecord) => movePct(r.lastMarketCap, refMc(r));

  /** One token's full path: peak ▲ / deepest dip ▼ / where it is now →, with a momentum flag. */
  const scoutLine = (r: AiScoutRecord): string => {
    const dot = r.action === "ENTER" ? "🟢" : r.action === "WAIT" ? "🟡" : "⚪";
    const now = nowOf(r), peak = r.maxMovePct;
    const mom = (now !== undefined && peak !== undefined)
      ? (now >= peak - 5 ? "🔥" : now <= peak * 0.4 ? "📉" : "↗") : "";
    return `${r.success ? "✅" : "▫️"}${dot} <b>$${esc(r.symbol)}</b> ${r.chain} s${r.score} ${mom}\n` +
      `   ▲${fmtMove(peak)}  ▼${fmtMove(dipOf(r))}  →${fmtMove(now)}  ·  ${relTime(r.lastAt)}`;
  };

  type ScoutSort = "top" | "recent";
  type ScoutChainF = "all" | "solana" | "bsc" | "base" | "eth";
  type ScoutActionF = "all" | "ENTER" | "WAIT" | "AVOID";
  const SCOUT_PAGE = 8;
  const SCOUT_CHAINS: ScoutChainF[] = ["all", "solana", "bsc", "base", "eth"];
  const SCOUT_ACTIONS: ScoutActionF[] = ["all", "ENTER", "WAIT", "AVOID"];
  const chainChip: Record<ScoutChainF, string> = { all: "🌐 All", solana: "◎ SOL", bsc: "🟡 BSC", base: "🔵 BASE", eth: "Ξ ETH" };
  const actionChip: Record<ScoutActionF, string> = { all: "All", ENTER: "🟢 ENTER", WAIT: "🟡 WAIT", AVOID: "⚪ AVOID" };
  /** Paginated drill-down list with chain + action filters and a sort toggle. */
  const scoutListView = (
    sort: ScoutSort,
    page: number,
    chain: ScoutChainF = "all",
    action: ScoutActionF = "all"
  ): { text: string; kb: InlineKeyboard } => {
    let rows = [...store.aiScoutRecords()];
    if (chain !== "all") rows = rows.filter(r => r.chain === chain);
    if (action !== "all") rows = rows.filter(r => r.action === action);
    if (sort === "top") {
      rows = rows.filter(r => r.maxMovePct !== undefined).sort((a, b) => (b.maxMovePct ?? 0) - (a.maxMovePct ?? 0));
    } else {
      rows.sort((a, b) => b.lastAt - a.lastAt);
    }
    const scope = [
      chain === "all" ? "" : chainChip[chain],
      action === "all" ? "" : actionChip[action]
    ].filter(Boolean).join(" · ");
    const title = `${sort === "top" ? "🏆 Top movers" : "📜 Recent"}${scope ? ` · ${esc(scope)}` : " · all"}`;

    const total = rows.length;
    const pages = Math.max(1, Math.ceil(total / SCOUT_PAGE));
    const p = Math.max(0, Math.min(page, pages - 1));
    const slice = rows.slice(p * SCOUT_PAGE, p * SCOUT_PAGE + SCOUT_PAGE);
    const body = slice.length ? slice.map(scoutLine).join("\n") : "<i>nothing matches this filter</i>";
    const text = `🧠 <b>${title}</b>\n${RULE}\n${body}\n${RULE}\n<i>page ${p + 1}/${pages} · ${total} logged</i>`;

    // cb = ascout:<sort>:<chain>:<action>:<page>
    const cb = (s: ScoutSort, c: ScoutChainF, a: ScoutActionF, pg: number) => `ascout:${s}:${c}:${a}:${pg}`;
    const sel = (on: boolean, label: string) => (on ? `• ${label}` : label);
    const kb = new InlineKeyboard()
      .text(sel(sort === "top", "🏆 Top"), cb("top", chain, action, 0))
      .text(sel(sort === "recent", "📜 Recent"), cb("recent", chain, action, 0)).row();
    // Chain filter row
    for (const c of SCOUT_CHAINS) kb.text(sel(chain === c, chainChip[c]), cb(sort, c, action, 0));
    kb.row();
    // Action filter row
    for (const a of SCOUT_ACTIONS) kb.text(sel(action === a, actionChip[a]), cb(sort, chain, a, 0));
    kb.row();
    if (pages > 1) {
      if (p > 0) kb.text("◀ Prev", cb(sort, chain, action, p - 1));
      if (p < pages - 1) kb.text("Next ▶", cb(sort, chain, action, p + 1));
      kb.row();
    }
    kb.text("📊 Summary", "menu:aistats").text("⬅️ Back", "menu:main");
    return { text, kb };
  };

  const aiStatsText = () => {
    const records = store.aiScoutRecords();
    if (records.length === 0) {
      return `🧠 <b>AI Scout — Performance</b>\n${RULE}\nNo scout decisions logged yet. The Scout records every ENTER/WAIT/AVOID it makes — check back once it's seen a few.`;
    }
    const now = Date.now();
    const day = records.filter(r => now - r.lastAt < 864e5);
    const st = store.settings;
    type Rec = (typeof records)[number];

    // 10-cell win-rate bar, e.g. 63% -> "██████░░░░"
    const bar = (pct: number, w = 10) => {
      const n = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
      return "█".repeat(n) + "░".repeat(w - n);
    };
    const agg = (rows: Rec[]) => {
      const n = rows.length;
      const succ = rows.filter(r => r.success).length;
      const rate = n ? (succ / n) * 100 : 0;
      const avg = n ? rows.reduce((s, r) => s + (r.maxMovePct ?? 0), 0) / n : 0;
      return { n, succ, rate, avg };
    };
    const padR = (s: unknown, w: number) => String(s).padEnd(w);
    const padL = (s: unknown, w: number) => String(s).padStart(w);
    const row = (label: string, g: { n: number; rate: number }, tail = "") =>
      `${padR(label, 7)}${padL(g.n, 3)}  ${bar(g.rate)} ${padL(Math.round(g.rate) + "%", 4)}${tail}`;

    const enters = records.filter(r => r.action === "ENTER");
    const e = agg(enters);
    const overall = agg(records);
    const bought = records.reduce((s, r) => s + (r.liveBought ?? 0), 0);

    // Movement aggregate for ENTERs (peak via agg.avg; dip below).
    const enterDips = enters.map(dipOf).filter((v): v is number => v !== undefined);
    const avgDip = enterDips.length ? enterDips.reduce((a, b) => a + b, 0) / enterDips.length : undefined;

    // By action (24h), with avg peak move appended
    const actionTbl = (["ENTER", "WAIT", "AVOID"] as const)
      .map(a => { const g = agg(day.filter(r => r.action === a)); return row(a, g, `  ${g.avg >= 0 ? "+" : ""}${g.avg.toFixed(0)}%`); })
      .join("\n");

    // ENTER quality by score bucket (all-time)
    const buckets: [string, number, number][] = [["90+", 90, 1e9], ["80-89", 80, 90], ["70-79", 70, 80], ["<70", 0, 70]];
    const scoreTbl = buckets
      .map(([lbl, lo, hi]) => { const g = agg(enters.filter(r => r.score >= lo && r.score < hi)); return g.n ? row(lbl, g) : null; })
      .filter(Boolean).join("\n");

    // ENTER by chain
    const chainTbl = [...new Set(enters.map(r => r.chain))]
      .map(c => row(c, agg(enters.filter(r => r.chain === c)))).join("\n");

    const lines = [
      `🧠 <b>AI Scout — Performance</b>`,
      RULE,
      `<i>Success = peaked +100% MC after the call.</i>`,
      ``,
      `🎯 <b>ENTER edge</b>  ${e.succ}/${e.n} (${Math.round(e.rate)}%)`,
      `📊 <b>ENTER moves</b>  ▲ peak ${fmtMove(e.avg)}  ·  ▼ dip ${fmtMove(avgDip)}`,
      `📈 <b>Logged</b>  ${overall.n} calls  ·  💰 <b>${bought}</b> bought live`,
      ``,
      `📊 <b>By action</b> · last 24h (${day.length})`,
      `<pre>${esc(actionTbl)}</pre>`
    ];
    if (scoreTbl) lines.push(`🏅 <b>ENTER by score</b> · all-time`, `<pre>${esc(scoreTbl)}</pre>`);
    if (chainTbl) lines.push(`⛓ <b>ENTER by chain</b>`, `<pre>${esc(chainTbl)}</pre>`);
    lines.push(
      RULE,
      `🛡 <b>Exits</b>  auto ${st.autoExitEnabled ? "🟢" : "🔴"} · TP ${st.takeProfitPct || "–"} · SL ${st.stopLossPct || "–"} · trail ${st.trailingStopPct || "–"} · AIrisk ${st.aiScoutRiskStopPct || "–"}`,
      `🤖 <b>Mode</b>  ${st.aiScoutMode} · $${st.aiScoutBuyUsdc}/entry · ${st.aiScoutDailyTrades || "∞"}/day · score ≥${st.aiScoutMinScore}`,
      ``,
      `🔮 <b>Learning</b>`,
      `<i>${esc(store.aiScoutLearningSummary())}</i>`,
      ``,
      `🕯 <b>Recent</b>`
    );
    for (const r of records.slice(0, 6)) lines.push(scoutLine(r));
    lines.push(``, `<i>Tap 🏆 / 🎯 / 📜 below to dive into the full history.</i>`);
    return lines.join("\n");
  };

  const aiStatsMenu = () =>
    new InlineKeyboard()
      .text("🏆 Top movers", "ascout:top:all:all:0")
      .text("🎯 ENTERs", "ascout:recent:all:ENTER:0").row()
      .text("📜 All decisions", "ascout:recent:all:all:0").row()
      .text("🔄 Refresh", "menu:aistats")
      .text("⚙️ AI Settings", "menu:settings").row()
      .text("⬅️ Back", "menu:main");

  const netName = (n: NetworkKey) => n.charAt(0).toUpperCase() + n.slice(1);
  const signed = (v: number, sym: string) =>
    `${v >= 0 ? "🟢 +" : "🔴 -"}${Math.abs(v).toFixed(sym === "USDC" ? 2 : 5)} ${sym}`;

  // A read-only roll-up: cash across chains, open-position count + unrealized,
  // realized copy PnL, and tracked-wallet count. Uses existing balance/position
  // helpers only — no new trading calls.
  const portfolioText = async () => {
    const lines = [`💰 <b>Portfolio</b> · ${BRAND}`, RULE];

    const cashRows: [string, string][] = [];
    const balances = await trader.balances().catch(() => []);
    for (const b of balances) {
      const usdc = b.usdc !== undefined ? ` · ${b.usdc.toFixed(2)} USDC` : "";
      cashRows.push([netName(b.network), `${b.native.toFixed(4)} ${b.nativeSymbol}${usdc}`]);
    }
    if (solTrader?.enabled) {
      const [sol, usdc] = await Promise.all([
        solTrader.solBalance().catch(() => null),
        solTrader.usdcBalance().catch(() => null)
      ]);
      cashRows.push(["Solana", `${sol === null ? "?" : sol.toFixed(4)} SOL${usdc !== null ? ` · ${usdc.toFixed(2)} USDC` : ""}`]);
    }
    lines.push("💵 <b>Cash</b>");
    lines.push(cashRows.length ? statTable(cashRows) : "<i>No active networks — enable one in ⚙️ Settings.</i>");

    const upnl: Record<string, number> = {};
    let valuedUsd = 0;
    for (const p of store.positions) {
      const live = p.network === "solana"
        ? await solTrader?.positionValue(p.token, { jupiterFallback: false }).catch(() => null)
        : await trader.positionValue(p.network as NetworkKey, p.token as Address).catch(() => null);
      if (!live) continue;
      if (live.pnlQuote !== undefined) upnl[live.quoteSymbol] = (upnl[live.quoteSymbol] ?? 0) + live.pnlQuote;
      const usd = stableUsdValue(live.proceedsQuote, live.quoteSymbol);
      if (usd !== undefined) valuedUsd += usd;
    }
    lines.push("");
    lines.push(`📊 <b>Open positions:</b> ${store.positions.length}${valuedUsd > 0 ? ` · ~${money(valuedUsd)} valued` : ""}`);
    const upnlBits = Object.entries(upnl).map(([sym, v]) => signed(v, sym));
    if (upnlBits.length) lines.push(`Unrealized: <b>${upnlBits.join("  ·  ")}</b>`);

    const realized = Object.entries(store.myPnl);
    if (realized.length) {
      lines.push("");
      lines.push("💰 <b>Realized (copy)</b>");
      lines.push(statTable(realized.map(([sym, r]): [string, string] =>
        [sym, `${r.pnl >= 0 ? "+" : "-"}${Math.abs(r.pnl).toFixed(sym === "USDC" ? 2 : 5)} · ${r.wins}/${r.trades} wins`]
      )));
    }

    const sol = store.walletsByChain("solana").length;
    lines.push("");
    lines.push(`👛 Tracked wallets: ${store.wallets.length}${sol ? ` (${sol} Solana)` : ""}`);
    return lines.join("\n");
  };

  const portfolioMenu = () =>
    new InlineKeyboard()
      .text("🔄 Refresh", "menu:portfolio")
      .text("📊 Positions", "menu:positions").row()
      .text("💼 My Wallet", "menu:mywallet")
      .text("💰 PnL Cards", "pnl:all").row()
      .text("⬅️ Back", "menu:main");

  const helpText = () =>
    [
      deskTitle("help"),
      `<i>formerly ${BRAND_LEGACY}</i>`,
      RULE,
      `Self-custody multi-chain desk — paste a contract, buy, trail, copy smart money.`,
      `Feel: <b>Trojan · BONKbot · Maestro</b> — dense tickets, defend, limit/DCA, watch.`,
      "",
      section("QUICK START"),
      `1️⃣ Track wallets · 📥 Import`,
      `2️⃣ <b>🛡 Defend</b> → Balanced / Safe / Degen`,
      `3️⃣ Paste mint → ticket · ☆ Watch · ⏱ Live`,
      `4️⃣ Optional: <b>🎯 Limit</b> · <b>📅 DCA</b> · arm Copy last`,
      "",
      section("MUST-KNOW"),
      `• <b>Trail SL</b> — N pts below peak (arms only after peak ≥ N)`,
      `• <b>Limit / DCA</b> — Dex mark only (never Jupiter poll)`,
      `• <b>⏱ Live</b> — 15s Dex refresh`,
      `• <b>Orders</b> — open limits & DCA from desk`,
      "",
      section("COMMANDS"),
      `<code>/scan</code> · <code>/positions</code> · <code>/orders</code> · <code>/pnl</code>`,
      `<code>/buy</code> · <code>/sell</code> · <code>/solbuy</code> · <code>/panic</code>`,
      `<code>/settrailsl 25</code> · <code>/setsl 25</code> · <code>/settp 100</code>`
    ].join("\n");

  const helpMenu = () => {
    const kb = new InlineKeyboard()
      .text("🛡 Defend", "menu:defend")
      .text("🎯 Orders", "menu:orders").row()
      .text("📊 Bags", "menu:positions")
      .text("📜 History", "menu:history").row()
      .text("☆ Watch", "menu:watch")
      .text("ℹ️ Systems", "menu:status").row();
    navBar(kb);
    return kb;
  };

  const render = async (ctx: Context, text: string, kb: InlineKeyboard) => {
    if (ctx.callbackQuery) {
      await ctx.editMessageText(text, { reply_markup: kb, parse_mode: "HTML" })
        .catch(() => {/* "message is not modified" is fine */});
    } else {
      await ctx.reply(text, { reply_markup: kb, parse_mode: "HTML" });
    }
  };

  const aiScanText = async (
    chain: AiScoutChain,
    token: string,
    info: TokenInfo | null
  ): Promise<string> => {
    if (!info) return "";
    try {
      const candidate = buildAiScoutCandidate(chain, token, info);
      const decision = await decideAiScout(candidate, store.aiScoutLearningSummary());
      const icon = decision.action === "ENTER" ? "🚨" : decision.action === "WAIT" ? "🟡" : "⚪";
      const judges =
        decision.rulesAction && decision.aiAction && decision.rulesAction !== decision.aiAction
          ? `\n🧪 rules=${decision.rulesAction} • ai=${decision.aiAction}`
          : "";
      const notes = [...decision.reasons, ...decision.warnings].slice(0, 4);
      return (
        `\n\n${icon} <b>AI Analysis: ${decision.action}</b> ` +
        `score <b>${decision.score}/100</b>${judges}\n` +
        `${esc(decision.aiReason)}\n` +
        `${notes.length ? `📌 ${notes.map(esc).join(" • ")}` : ""}`
      );
    } catch {
      return "";
    }
  };

  const aiScanLoadingText = () =>
    `\n\n🧠 <i>scoring…</i>`;

  const editScanMessage = async (
    api: typeof bot.api,
    chatId: number,
    messageId: number,
    wasPhoto: boolean,
    text: string,
    kb: InlineKeyboard
  ) => {
    const harmless = (e: any) => /not modified/i.test(String(e?.description ?? e?.message ?? e));
    try {
      if (wasPhoto) {
        await api.editMessageCaption(chatId, messageId, {
          caption: text,
          parse_mode: "HTML",
          reply_markup: kb
        });
      } else {
        await api.editMessageText(chatId, messageId, text, {
          parse_mode: "HTML",
          reply_markup: kb,
          link_preview_options: { is_disabled: true }
        });
      }
    } catch (e) {
      if (!harmless(e)) throw e;
    }
  };

  // Monotonic "generation" per card message. Each scan/refresh of a message bumps
  // it; a slow async AI update only edits if it's still the latest generation —
  // otherwise a stale AI response would clobber a freshly-refreshed card with old
  // stats (the "edit shows expired info after refresh" / data-mixing bug).
  const scanGen = new Map<string, number>();

  // ---------- Live token-view auto-refresh (DexScreener only) ----------
  // Opt-in per card. Never hits Jupiter — sells keep the full rate-limit budget.
  // Pauses while a buy/sell is in flight (criticalBusy). Auto-off after max age.
  type LiveCard = {
    chatId: number;
    messageId: number;
    wasPhoto: boolean;
    kind: "evm" | "sol";
    network?: NetworkKey;
    token: string;
    startedAt: number;
    lastAt: number;
  };
  const liveCards = new Map<string, LiveCard>();
  const LIVE_INTERVAL_MS = 15_000;
  const LIVE_MAX_AGE_MS = 8 * 60_000; // auto-stop so forgotten cards don't spin forever
  const LIVE_MAX_CARDS = 2;
  let criticalBusy = 0; // >0 while buy/sell/panic — Live ticks yield
  let liveTickBusy = false;

  const liveKey = (chatId: number, messageId: number) => `${chatId}:${messageId}`;
  const isLive = (chatId?: number, messageId?: number) =>
    !!chatId && !!messageId && liveCards.has(liveKey(chatId, messageId));

  const withCritical = async <T>(fn: () => Promise<T>): Promise<T> => {
    criticalBusy++;
    try { return await fn(); }
    finally { criticalBusy = Math.max(0, criticalBusy - 1); }
  };

  const paintLiveCard = async (card: LiveCard): Promise<void> => {
    const d = chartDefaults();
    if (card.kind === "sol") {
      const watched = store.isWatched("solana", card.token);
      const [info, position] = await Promise.all([
        fetchTokenInfoBySlug("solana", card.token),
        solTrader?.positionValue(card.token, { jupiterFallback: false }).catch(() => null) ?? Promise.resolve(null)
      ]);
      const text = buildScannerCard({
        badge: SOLANA_BADGE,
        token: card.token,
        info,
        fallbackSymbol: position?.symbol,
        position: position ?? undefined,
        nowMs: Date.now(),
        live: true,
        watched
      });
      const kb = solScannerKeyboard(
        card.token,
        info,
        !!position,
        d.tf,
        d.mode,
        !!solTrader?.enabled,
        store.settings.solQuote === "USDC" ? store.settings.solBuyPresetsUsdc : store.settings.solBuyPresets,
        store.settings.sellPresets,
        store.settings.solQuote,
        true,
        watched
      );
      await editScanMessage(bot.api, card.chatId, card.messageId, card.wasPhoto, text, kb);
      return;
    }
    const net = card.network!;
    const token = card.token as Address;
    const watched = store.isWatched(net, token);
    const [info, position] = await Promise.all([
      fetchTokenInfo(net, token),
      trader.positionValue(net, token).catch(() => null)
    ]);
    const text = buildScannerCard({
      badge: NET_BADGE[net],
      token,
      info,
      fallbackSymbol: position?.symbol,
      position: position ?? undefined,
      nowMs: Date.now(),
      live: true,
      watched
    });
    const kb = scannerKeyboard(net, token, info, !!position, quickFor(net), d.tf, d.mode, true, watched);
    await editScanMessage(bot.api, card.chatId, card.messageId, card.wasPhoto, text, kb);
  };

  setInterval(async () => {
    if (liveTickBusy || criticalBusy > 0 || liveCards.size === 0) return;
    liveTickBusy = true;
    try {
      const now = Date.now();
      for (const [key, card] of [...liveCards.entries()]) {
        if (criticalBusy > 0) break; // yield immediately if a trade starts mid-loop
        if (now - card.startedAt > LIVE_MAX_AGE_MS) {
          liveCards.delete(key);
          // Best-effort: flip button off so user sees it stopped.
          try {
            card.startedAt = now; // keep paint from re-expiring mid-render
            // paint once as non-live by temporarily removing and calling show path
            const d = chartDefaults();
            if (card.kind === "sol") {
              const [info, position] = await Promise.all([
                fetchTokenInfoBySlug("solana", card.token),
                solTrader?.positionValue(card.token, { jupiterFallback: false }).catch(() => null) ?? Promise.resolve(null)
              ]);
              const watched = store.isWatched("solana", card.token);
              const text = buildScannerCard({
                badge: SOLANA_BADGE, token: card.token, info,
                fallbackSymbol: position?.symbol, position: position ?? undefined, nowMs: Date.now(),
                live: false, watched
              }) + `\n\n⏱ <i>Live stopped after ${LIVE_MAX_AGE_MS / 60000}m</i>`;
              const kb = solScannerKeyboard(
                card.token, info, !!position, d.tf, d.mode, !!solTrader?.enabled,
                store.settings.solQuote === "USDC" ? store.settings.solBuyPresetsUsdc : store.settings.solBuyPresets,
                store.settings.sellPresets, store.settings.solQuote, false, watched
              );
              await editScanMessage(bot.api, card.chatId, card.messageId, card.wasPhoto, text, kb).catch(() => {});
            } else {
              const net = card.network!;
              const token = card.token as Address;
              const watched = store.isWatched(net, token);
              const [info, position] = await Promise.all([
                fetchTokenInfo(net, token),
                trader.positionValue(net, token).catch(() => null)
              ]);
              const text = buildScannerCard({
                badge: NET_BADGE[net], token, info,
                fallbackSymbol: position?.symbol, position: position ?? undefined, nowMs: Date.now(),
                live: false, watched
              }) + `\n\n⏱ <i>Live stopped after ${LIVE_MAX_AGE_MS / 60000}m</i>`;
              const kb = scannerKeyboard(net, token, info, !!position, quickFor(net), d.tf, d.mode, false, watched);
              await editScanMessage(bot.api, card.chatId, card.messageId, card.wasPhoto, text, kb).catch(() => {});
            }
          } catch { /* ignore */ }
          continue;
        }
        if (now - card.lastAt < LIVE_INTERVAL_MS - 500) continue;
        try {
          await paintLiveCard(card);
          card.lastAt = Date.now();
        } catch (e: any) {
          const msg = String(e?.description ?? e?.message ?? e);
          // Message deleted / too old to edit — drop live silently.
          if (/message to edit not found|message is not modified|message can't be edited|MESSAGE_ID_INVALID/i.test(msg)) {
            liveCards.delete(key);
          } else {
            console.warn(`[live] refresh failed ${key}: ${msg.slice(0, 160)}`);
          }
        }
      }
    } finally {
      liveTickBusy = false;
    }
  }, 2_000);

  const startAiScanUpdate = (
    ctx: Context,
    ref: { chatId: number; messageId: number; wasPhoto: boolean } | null,
    chain: AiScoutChain,
    token: string,
    info: TokenInfo | null,
    baseText: string,
    kb: InlineKeyboard
  ) => {
    if (!ref || !info) return;
    const key = `${ref.chatId}:${ref.messageId}`;
    const myGen = (scanGen.get(key) ?? 0) + 1;
    scanGen.set(key, myGen);
    void (async () => {
      const ai = await aiScanText(chain, token, info);
      // A newer scan/refresh has since taken over this message — drop the stale edit.
      if (scanGen.get(key) !== myGen) return;
      const next = baseText + (ai || `\n\n🧠 <b>AI Analysis</b>\nNo AI result available right now.`);
      await editScanMessage(ctx.api, ref.chatId, ref.messageId, ref.wasPhoto, next, kb).catch(() => {});
    })();
  };

  /** Quick-trade presets for a network, honoring the active quote asset. */
  const quickFor = (net: NetworkKey): QuickTrade => {
    const s = store.settings;
    const qa = trader.quoteAsset(net);
    return {
      buyAmounts: qa.isNative ? s.buyPresetsEth : s.buyPresetsUsdc,
      quoteSymbol: qa.symbol,
      sellPcts: s.sellPresets
    };
  };

  /** The user's saved default chart timeframe + price/mc mode. */
  const chartDefaults = (): { tf: Timeframe; mode: ChartMode } => {
    const s = store.settings;
    return {
      tf: isTimeframe(s.chartTimeframe) ? s.chartTimeframe : "1h",
      mode: s.chartByMarketCap ? "mc" : "price"
    };
  };

  /** Build and show (or refresh) the token-scanner card for a token. */
  const showScanner = async (
    ctx: Context, net: NetworkKey, token: Address, preInfo?: TokenInfo | null
  ) => {
    const cqMsg: any = ctx.callbackQuery?.message;
    const liveOn = isLive(cqMsg?.chat?.id, cqMsg?.message_id);
    const watched = store.isWatched(net, token);
    const [info, position] = await Promise.all([
      preInfo !== undefined ? Promise.resolve(preInfo) : fetchTokenInfo(net, token),
      // Live mode: never risk Jupiter; EVM path is RPC-only (safe).
      trader.positionValue(net, token).catch(() => null)
    ]);
    const baseText = buildScannerCard({
      badge: NET_BADGE[net],
      token,
      info,
      fallbackSymbol: position?.symbol,
      position: position ?? undefined,
      nowMs: Date.now(),
      live: liveOn,
      watched
    });
    // Live cards skip AI (extra API load).
    const text = liveOn ? baseText : baseText + aiScanLoadingText();
    const d = chartDefaults();
    const kb = scannerKeyboard(net, token, info, !!position, quickFor(net), d.tf, d.mode, liveOn, watched);
    let ref: { chatId: number; messageId: number; wasPhoto: boolean } | null = null;

    // Refresh: edit in place. A card may be a photo (caption) or text message,
    // so try the matching edit, fall back to the other on mismatch, and only if
    // BOTH fail send one fresh card. "not modified" is harmless (ignore it).
    if (ctx.callbackQuery) {
      const msg: any = ctx.callbackQuery.message;
      const isPhoto = !!(msg && msg.photo);
      // Invalidate any in-flight AI update for this message before we repaint it,
      // so a slow prior request can't flash stale stats during the refresh.
      if (msg?.chat?.id && msg.message_id) {
        const k = `${msg.chat.id}:${msg.message_id}`;
        scanGen.set(k, (scanGen.get(k) ?? 0) + 1);
      }
      const editText = () => ctx.editMessageText(text, {
        parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true }
      });
      const editCap = () => ctx.editMessageCaption({ caption: text, parse_mode: "HTML", reply_markup: kb });
      const harmless = (e: any) => /not modified/i.test(String(e?.description ?? e?.message ?? e));
      try {
        await (isPhoto ? editCap() : editText());
        const msg = ctx.callbackQuery.message;
        if (msg?.chat?.id && msg.message_id) ref = { chatId: msg.chat.id, messageId: msg.message_id, wasPhoto: isPhoto };
      } catch (e1) {
        if (harmless(e1)) {
          const msg = ctx.callbackQuery.message;
          if (msg?.chat?.id && msg.message_id) ref = { chatId: msg.chat.id, messageId: msg.message_id, wasPhoto: isPhoto };
          if (!liveOn) startAiScanUpdate(ctx, ref, net as AiScoutChain, token, info, baseText, kb);
          return;
        }
        try {
          await (isPhoto ? editText() : editCap()); // photo/text mismatch fallback
          const msg = ctx.callbackQuery.message;
          if (msg?.chat?.id && msg.message_id) ref = { chatId: msg.chat.id, messageId: msg.message_id, wasPhoto: !isPhoto };
        } catch (e2) {
          if (harmless(e2)) {
            const msg = ctx.callbackQuery.message;
            if (msg?.chat?.id && msg.message_id) ref = { chatId: msg.chat.id, messageId: msg.message_id, wasPhoto: !isPhoto };
            if (!liveOn) startAiScanUpdate(ctx, ref, net as AiScoutChain, token, info, baseText, kb);
            return;
          }
          const sent = await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }).catch(() => null);
          if (sent) ref = { chatId: sent.chat.id, messageId: sent.message_id, wasPhoto: false };
        }
      }
      if (!liveOn) startAiScanUpdate(ctx, ref, net as AiScoutChain, token, info, baseText, kb);
      return;
    }
    // Fresh card: lead with the token logo when we have one.
    if (info?.imageUrl) {
      try {
        const sent = await ctx.replyWithPhoto(info.imageUrl, { caption: text, parse_mode: "HTML", reply_markup: kb });
        startAiScanUpdate(ctx, { chatId: sent.chat.id, messageId: sent.message_id, wasPhoto: true }, net as AiScoutChain, token, info, baseText, kb);
        return;
      } catch {
        /* image host hiccup — fall through to text */
      }
    }
    const sent = await ctx.reply(text, {
      parse_mode: "HTML", reply_markup: kb,
      link_preview_options: { is_disabled: true }
    });
    startAiScanUpdate(ctx, { chatId: sent.chat.id, messageId: sent.message_id, wasPhoto: false }, net as AiScoutChain, token, info, baseText, kb);
  };

  /** Send/refresh a chart snapshot photo with stats + trade buttons. */
  const showChart = async (
    ctx: Context, net: NetworkKey, token: Address, tf: Timeframe, mode: ChartMode
  ) => {
    const [info, position] = await Promise.all([
      fetchTokenInfo(net, token),
      trader.positionValue(net, token).catch(() => null)
    ]);
    const sym = info?.symbol ?? position?.symbol ?? "TOKEN";
    // Circulating supply lets us redraw price candles in market-cap units.
    const supply =
      info?.marketCap && info?.priceUsd ? info.marketCap / info.priceUsd
        : info?.fdv && info?.priceUsd ? info.fdv / info.priceUsd
        : undefined;

    // Stats are baked into the chart image header (colored), not the caption.
    const pcs = (v?: number) => v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
    const mc = info?.marketCap ?? info?.fdv;
    const headline = mode === "mc" ? `MC ${money(mc)}` : `${smallPrice(info?.priceUsd)}`;
    const line1 = mode === "mc"
      ? `Price ${smallPrice(info?.priceUsd)}  ·  Vol24h ${money(info?.volume24h)}  ·  Liq ${money(info?.liquidityUsd)}`
      : `MC ${money(mc)}  ·  Vol24h ${money(info?.volume24h)}  ·  Liq ${money(info?.liquidityUsd)}`;
    const ageTxt = info?.pairCreatedAt ? `   Age ${age(info.pairCreatedAt, Date.now())}` : "";
    const line2 = `5m ${pcs(info?.change5m)}    1h ${pcs(info?.change1h)}    24h ${pcs(info?.change24h)}${ageTxt}`;
    const header = { headline, changePct: info?.change24h, stats: [line1, line2] };

    const markers = store.myTradesFor(token, net);
    const chart = await tokenChartUrl(net, token, tf, sym, { mode, supply, header, markers });
    if (!chart) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: "No chart data for this token yet.", show_alert: true }).catch(() => {});
      } else {
        await ctx.reply("No chart data available yet for this token.").catch(() => {});
      }
      return;
    }

    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    // Caption stays light — market stats are painted on the image.
    const win = chart.windowChangePct;
    const winTxt = `${win >= 0 ? "▲" : "▼"} ${win >= 0 ? "+" : ""}${win.toFixed(1)}%`;
    const lines: string[] = [
      `⚡ <b>$${esc(sym)}</b>  ·  ${NET_BADGE[net]}  ·  ${esc(chart.label)}  ·  ${winTxt}`
    ];
    if (info?.name && info.name !== sym) lines.push(`<i>${esc(info.name)}</i>`);
    if (position) {
      const valueUsd = stableUsdValue(position.proceedsQuote, position.quoteSymbol)
        ?? (info?.priceUsd ? position.uiAmount * info.priceUsd : undefined);
      let line = `💼 ${qty(position.uiAmount)} $${esc(sym)}${valueUsd !== undefined ? ` (~${money(valueUsd)})` : ""}`;
      if (position.pnlQuote !== undefined) {
        const sign = position.pnlQuote >= 0 ? "🟢 +" : "🔴 ";
        const d = position.quoteSymbol === "USDC" ? 2 : 5;
        const pctTxt = position.pnlPct !== undefined ? ` (${position.pnlPct >= 0 ? "+" : ""}${position.pnlPct.toFixed(1)}%)` : "";
        line += ` · ${sign}${position.pnlQuote.toFixed(d)} ${position.quoteSymbol}${pctTxt}`;
      }
      lines.push(line);
    }
    const caption = lines.join("\n");
    const kb = chartKeyboard(net, token, info, !!position, quickFor(net), tf, chart.mode);

    // Refreshing / switching timeframe on an existing chart photo: swap the
    // image in place. Otherwise send a fresh photo.
    const msg: any = ctx.callbackQuery?.message;
    if (msg && msg.photo) {
      try {
        await ctx.editMessageMedia(
          { type: "photo", media: chart.url, caption, parse_mode: "HTML" },
          { reply_markup: kb }
        );
      } catch (e: any) {
        if (!/not modified/i.test(String(e?.description ?? e?.message ?? e))) {
          await ctx.replyWithPhoto(chart.url, { caption, parse_mode: "HTML", reply_markup: kb }).catch(() => {});
        }
      }
      return;
    }
    await ctx.replyWithPhoto(chart.url, { caption, parse_mode: "HTML", reply_markup: kb })
      .catch(() => ctx.reply("Couldn't load the chart image — try again.").catch(() => {}));
  };

  /** Read-only card for chains we don't trade on (Solana, or other EVMs). */
  const showReadonlyCard = async (
    ctx: Context, badge: string, token: string, info: TokenInfo | null, links: InlineKeyboard
  ) => {
    const text = buildScannerCard({ badge, token, info, nowMs: Date.now() });
    if (info?.imageUrl) {
      try {
        await ctx.replyWithPhoto(info.imageUrl, { caption: text, parse_mode: "HTML", reply_markup: links });
        return;
      } catch { /* fall through */ }
    }
    await ctx.reply(text, {
      parse_mode: "HTML", reply_markup: links,
      link_preview_options: { is_disabled: true }
    });
  };

  const showSolScanner = async (
    ctx: Context, mint: string, preInfo?: TokenInfo | null
  ) => {
    const cqMsg: any = ctx.callbackQuery?.message;
    const liveOn = isLive(cqMsg?.chat?.id, cqMsg?.message_id);
    const watched = store.isWatched("solana", mint);
    const [info, position] = await Promise.all([
      preInfo !== undefined ? Promise.resolve(preInfo) : fetchTokenInfoBySlug("solana", mint),
      // Live / normal UI mark: never burn Jupiter for a scan card paint.
      solTrader?.positionValue(mint, { jupiterFallback: false }).catch(() => null) ?? Promise.resolve(null)
    ]);
    const d = chartDefaults();
    const baseText = buildScannerCard({
      badge: SOLANA_BADGE,
      token: mint,
      info,
      fallbackSymbol: position?.symbol,
      position: position ?? undefined,
      nowMs: Date.now(),
      live: liveOn,
      watched
    });
    const text = liveOn ? baseText : baseText + aiScanLoadingText();
    const kb = solScannerKeyboard(
      mint,
      info,
      !!position,
      d.tf,
      d.mode,
      !!solTrader?.enabled,
      store.settings.solQuote === "USDC" ? store.settings.solBuyPresetsUsdc : store.settings.solBuyPresets,
      store.settings.sellPresets,
      store.settings.solQuote,
      liveOn,
      watched
    );
    let ref: { chatId: number; messageId: number; wasPhoto: boolean } | null = null;

    if (ctx.callbackQuery) {
      const msg: any = ctx.callbackQuery.message;
      const isPhoto = !!(msg && msg.photo);
      // Invalidate any in-flight AI update for this message before we repaint it,
      // so a slow prior request can't flash stale stats during the refresh.
      if (msg?.chat?.id && msg.message_id) {
        const k = `${msg.chat.id}:${msg.message_id}`;
        scanGen.set(k, (scanGen.get(k) ?? 0) + 1);
      }
      const editText = () => ctx.editMessageText(text, {
        parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true }
      });
      const editCap = () => ctx.editMessageCaption({ caption: text, parse_mode: "HTML", reply_markup: kb });
      const harmless = (e: any) => /not modified/i.test(String(e?.description ?? e?.message ?? e));
      try {
        await (isPhoto ? editCap() : editText());
        const msg = ctx.callbackQuery.message;
        if (msg?.chat?.id && msg.message_id) ref = { chatId: msg.chat.id, messageId: msg.message_id, wasPhoto: isPhoto };
      } catch (e1) {
        if (harmless(e1)) {
          const msg = ctx.callbackQuery.message;
          if (msg?.chat?.id && msg.message_id) ref = { chatId: msg.chat.id, messageId: msg.message_id, wasPhoto: isPhoto };
          if (!liveOn) startAiScanUpdate(ctx, ref, "solana", mint, info, baseText, kb);
          return;
        }
        try {
          await (isPhoto ? editText() : editCap());
          const msg = ctx.callbackQuery.message;
          if (msg?.chat?.id && msg.message_id) ref = { chatId: msg.chat.id, messageId: msg.message_id, wasPhoto: !isPhoto };
        } catch (e2) {
          if (harmless(e2)) {
            const msg = ctx.callbackQuery.message;
            if (msg?.chat?.id && msg.message_id) ref = { chatId: msg.chat.id, messageId: msg.message_id, wasPhoto: !isPhoto };
            if (!liveOn) startAiScanUpdate(ctx, ref, "solana", mint, info, baseText, kb);
            return;
          }
          const sent = await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } }).catch(() => null);
          if (sent) ref = { chatId: sent.chat.id, messageId: sent.message_id, wasPhoto: false };
        }
      }
      if (!liveOn) startAiScanUpdate(ctx, ref, "solana", mint, info, baseText, kb);
      return;
    }

    if (info?.imageUrl) {
      try {
        const sent = await ctx.replyWithPhoto(info.imageUrl, { caption: text, parse_mode: "HTML", reply_markup: kb });
        startAiScanUpdate(ctx, { chatId: sent.chat.id, messageId: sent.message_id, wasPhoto: true }, "solana", mint, info, baseText, kb);
        return;
      } catch { /* fall through */ }
    }
    const sent = await ctx.reply(text, {
      parse_mode: "HTML", reply_markup: kb,
      link_preview_options: { is_disabled: true }
    });
    startAiScanUpdate(ctx, { chatId: sent.chat.id, messageId: sent.message_id, wasPhoto: false }, "solana", mint, info, baseText, kb);
  };

  const showSolChart = async (
    ctx: Context, mint: string, tf: Timeframe, mode: ChartMode
  ) => {
    const [info, position] = await Promise.all([
      fetchTokenInfoBySlug("solana", mint),
      solTrader?.positionValue(mint, { jupiterFallback: false }).catch(() => null) ?? Promise.resolve(null)
    ]);
    const sym = info?.symbol ?? position?.symbol ?? "TOKEN";
    const supply =
      info?.marketCap && info?.priceUsd ? info.marketCap / info.priceUsd
        : info?.fdv && info?.priceUsd ? info.fdv / info.priceUsd
        : undefined;
    const pcs = (v?: number) => v === undefined ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
    const mc = info?.marketCap ?? info?.fdv;
    const headline = mode === "mc" ? `MC ${money(mc)}` : `${smallPrice(info?.priceUsd)}`;
    const line1 = mode === "mc"
      ? `Price ${smallPrice(info?.priceUsd)}  ·  Vol24h ${money(info?.volume24h)}  ·  Liq ${money(info?.liquidityUsd)}`
      : `MC ${money(mc)}  ·  Vol24h ${money(info?.volume24h)}  ·  Liq ${money(info?.liquidityUsd)}`;
    const ageTxt = info?.pairCreatedAt ? `   Age ${age(info.pairCreatedAt, Date.now())}` : "";
    const line2 = `5m ${pcs(info?.change5m)}    1h ${pcs(info?.change1h)}    24h ${pcs(info?.change24h)}${ageTxt}`;
    const markers = store.myTradesFor(mint, "solana");
    const chart = await tokenChartUrl("solana", mint, tf, sym, {
      mode, supply,
      header: { headline, changePct: info?.change24h, stats: [line1, line2] },
      markers
    });
    if (!chart) {
      if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: "No chart data for this Sol token yet.", show_alert: true }).catch(() => {});
      else await ctx.reply("No chart data available yet for this Sol token.").catch(() => {});
      return;
    }
    const win = chart.windowChangePct;
    const winTxt = `${win >= 0 ? "▲" : "▼"} ${win >= 0 ? "+" : ""}${win.toFixed(1)}%`;
    const lines: string[] = [
      `⚡ <b>$${esc(sym)}</b>  ·  ${SOLANA_BADGE}  ·  ${esc(chart.label)}  ·  ${winTxt}`
    ];
    if (info?.name && info.name !== sym) lines.push(`<i>${esc(info.name)}</i>`);
    if (position) {
      const valueUsd = stableUsdValue(position.proceedsQuote, position.quoteSymbol)
        ?? (info?.priceUsd ? position.uiAmount * info.priceUsd : undefined);
      let line = `💼 ${qty(position.uiAmount)} $${esc(sym)}${valueUsd !== undefined ? ` (~${money(valueUsd)})` : ""}`;
      if (position.pnlQuote !== undefined) {
        const sign = position.pnlQuote >= 0 ? "🟢 +" : "🔴 ";
        const d = position.quoteSymbol === "USDC" ? 2 : 5;
        const pctTxt = position.pnlPct !== undefined ? ` (${position.pnlPct >= 0 ? "+" : ""}${position.pnlPct.toFixed(1)}%)` : "";
        line += ` · ${sign}${position.pnlQuote.toFixed(d)} ${position.quoteSymbol}${pctTxt}`;
      }
      lines.push(line);
    }
    const caption = lines.join("\n");
    const kb = solChartKeyboard(
      mint,
      info,
      !!position,
      !!solTrader?.enabled,
      store.settings.solQuote === "USDC" ? store.settings.solBuyPresetsUsdc : store.settings.solBuyPresets,
      store.settings.sellPresets,
      store.settings.solQuote,
      tf,
      chart.mode
    );
    const msg: any = ctx.callbackQuery?.message;
    if (msg && msg.photo) {
      try {
        await ctx.editMessageMedia(
          { type: "photo", media: chart.url, caption, parse_mode: "HTML" },
          { reply_markup: kb }
        );
      } catch (e: any) {
        if (!/not modified/i.test(String(e?.description ?? e?.message ?? e))) {
          await ctx.replyWithPhoto(chart.url, { caption, parse_mode: "HTML", reply_markup: kb }).catch(() => {});
        }
      }
      return;
    }
    await ctx.replyWithPhoto(chart.url, { caption, parse_mode: "HTML", reply_markup: kb })
      .catch(() => ctx.reply("Couldn't load the Sol chart image — try again.").catch(() => {}));
  };

  /** Resolve a pasted contract address to its chain and show the right card. */
  const scanPasted = async (ctx: Context, token: string) => {
    if (isSolanaAddress(token)) {
      return showSolScanner(ctx, token);
    }
    const resolved = await resolveToken(token);
    if (!resolved) {
      return ctx.reply("❌ No DexScreener data for that address — too new, unlisted, or unsupported chain.");
    }
    if (resolved.net) {
      return showScanner(ctx, resolved.net, token as Address, resolved.info);
    }
    // Indexed, but on a chain we can't trade on — show info + links only.
    const links = new InlineKeyboard();
    if (resolved.info.url) links.url("📈 Chart", resolved.info.url);
    links.url("🔍 DexScreener", `https://dexscreener.com/${resolved.slug}/${token}`);
    return showReadonlyCard(ctx, `🔗 ${resolved.slug}`, token, resolved.info, links);
  };

  const pnlLine = (res: { pnlQuote?: number; pnlPct?: number; quoteSymbol?: string }) => {
    if (res.pnlQuote === undefined) return "";
    const sign = res.pnlQuote >= 0 ? "🟢 +" : "🔴 ";
    const digits = res.quoteSymbol === "USDC" ? 2 : 5;
    const pctTxt =
      res.pnlPct !== undefined
        ? ` (${res.pnlPct >= 0 ? "+" : ""}${res.pnlPct.toFixed(1)}%)`
        : "";
    return `\n💰 PnL: ${sign}${res.pnlQuote.toFixed(digits)} ${res.quoteSymbol ?? ""}${pctTxt}`;
  };

  // ---------- settings fields (shared by commands and ask-buttons) ----------

  interface Field {
    prompt: string;
    usage: string;
    validate: (v: number) => boolean;
    set: (v: number) => void;
  }

  const FIELDS: Record<string, Field> = {
    setbuy: {
      prompt: "💬 Send the new buy amount in ETH (e.g. 0.01)",
      usage: "Usage: /setbuy 0.01",
      validate: v => v > 0,
      set: v => store.updateSettings({ buyAmountEth: v })
    },
    setbuyusdc: {
      prompt: "💬 Send the new buy amount in USDC (e.g. 25)",
      usage: "Usage: /setbuyusdc 25",
      validate: v => v > 0,
      set: v => store.updateSettings({ buyAmountUsdc: v })
    },
    setmax: {
      prompt: "💬 Send the new max buy cap in ETH (e.g. 0.05)",
      usage: "Usage: /setmax 0.05",
      validate: v => v > 0,
      set: v => store.updateSettings({ maxBuyEth: v })
    },
    setslippage: {
      prompt: "💬 Send the new slippage in percent (e.g. 3)",
      usage: "Usage: /setslippage 3  (percent)",
      validate: v => v > 0 && v <= 50,
      set: v => store.updateSettings({ slippageBps: Math.round(v * 100) })
    },
    setsolbuy: {
      prompt: "💬 Send the default Solana buy amount in SOL (e.g. 0.005)",
      usage: "Usage: /setsolbuy 0.005",
      validate: v => v > 0 && v <= 5,
      set: v => store.updateSettings({ solBuyAmount: v })
    },
    setsolbuyusdc: {
      prompt: "💬 Send the default Solana buy amount in USDC (e.g. 1)",
      usage: "Usage: /setsolbuyusdc 1",
      validate: v => v > 0 && v <= 10_000,
      set: v => store.updateSettings({ solBuyAmountUsdc: v })
    },
    setsolslip: {
      prompt: "💬 Send Solana Jupiter slippage in percent (e.g. 3)",
      usage: "Usage: /setsolslip 3",
      validate: v => v > 0 && v <= 50,
      set: v => store.updateSettings({ solSlippageBps: Math.round(v * 100) })
    },
    setsolmaxfee: {
      prompt:
        "💬 Max non-rent SOL the route may burn (priority + Jupiter extras). " +
        "Rent (~0.002 SOL for a new token account) is excluded. " +
        "0 = off. Recommended: 0.01 (ape) · 0.005 (normal). e.g. 0.01",
      usage: "Usage: /setsolmaxfee 0.01",
      validate: v => v >= 0 && v <= 1,
      set: v => store.updateSettings({ solMaxFeeSol: v })
    },
    setgas: {
      prompt: "💬 Send the new gas ceiling in gwei (e.g. 30)",
      usage: "Usage: /setgas 30  (gwei)",
      validate: v => v > 0,
      set: v => store.updateSettings({ gasCeilingGwei: v })
    },
    setminliq: {
      prompt: "💬 Send the new minimum liquidity in USD (0 = off)",
      usage: "Usage: /setminliq 5000  (USD, 0=off)",
      validate: v => v >= 0,
      set: v => store.updateSettings({ minLiquidityUsd: v })
    },
    setcap: {
      prompt: "💬 Send the new daily spend cap in ETH (0 = off)",
      usage: "Usage: /setcap 0.1  (ETH/day, 0=off)",
      validate: v => v >= 0,
      set: v => store.updateSettings({ dailySpendCapEth: v })
    },
    setcooldown: {
      prompt: "💬 Send the new per-token cooldown in seconds",
      usage: "Usage: /setcooldown 60  (seconds)",
      validate: v => v >= 0,
      set: v => store.updateSettings({ buyCooldownSec: v })
    },
    settp: {
      prompt: "💬 Send the take-profit trigger in % (0 = off, e.g. 100)",
      usage: "Usage: /settp 100  (percent, 0=off)",
      validate: v => v >= 0,
      set: v => store.updateSettings({ takeProfitPct: v })
    },
    setsl: {
      prompt: "💬 Send the stop-loss trigger in % (0 = off, e.g. 40)",
      usage: "Usage: /setsl 40  (percent, 0=off)",
      validate: v => v >= 0 && v < 100,
      set: v => store.updateSettings({ stopLossPct: v })
    },
    setairisksl: {
      prompt: "💬 Send AI Scout risk stop in % below entry (0 = off, e.g. 25)",
      usage: "Usage: /setairisksl 25  (percent, 0=off)",
      validate: v => v >= 0 && v < 100,
      set: v => store.updateSettings({ aiScoutRiskStopPct: v })
    },
    settrailsl: {
      prompt:
        "💬 Send trailing stop-loss in % points below best unrealized PnL (0 = off).\n" +
        "Example: 25 → if peak was +80%, sell when PnL falls to +55%.\n" +
        "Arms only after peak ≥ trail (stop sits at entry or better). Fixed SL covers losses before that.\n" +
        "Requires 🎯 Auto-exit ON.",
      usage: "Usage: /settrailsl 25  (percent points off peak, 0=off)",
      validate: v => v >= 0 && v <= 500,
      set: v => store.updateSettings({ trailingStopPct: v })
    },
    setrunnertrail: {
      prompt:
        "💬 Send MOONBAG trailing stop in % points off peak (0 = off, e.g. 70).\n" +
        "Used for leftover size after the full profit ladder finishes. Wider than Trail SL so runners can breathe.",
      usage: "Usage: /setrunnertrail 70  (percent points, 0=off)",
      validate: v => v >= 0 && v <= 500,
      set: v => store.updateSettings({ runnerTrailPct: v })
    },
    setaibuy: {
      prompt: "💬 Send AI Scout buy size in USDC (max 1)",
      usage: "Usage: /setaibuy 1",
      validate: v => v > 0 && v <= 1,
      set: v => store.updateSettings({ aiScoutBuyUsdc: v })
    },
    setaitrades: {
      prompt: "💬 Send max AI Scout entries per UTC day (0 = off)",
      usage: "Usage: /setaitrades 5",
      validate: v => v >= 0 && v <= 25,
      set: v => store.updateSettings({ aiScoutDailyTrades: Math.floor(v) })
    },
    setaicooldown: {
      prompt: "💬 Send AI Scout cooldown in minutes",
      usage: "Usage: /setaicooldown 10",
      validate: v => v >= 1 && v <= 1440,
      set: v => store.updateSettings({ aiScoutCooldownMin: Math.floor(v) })
    },
    setaiscore: {
      prompt: "💬 Send minimum AI Scout score (0-100)",
      usage: "Usage: /setaiscore 45",
      validate: v => v >= 0 && v <= 100,
      set: v => store.updateSettings({ aiScoutMinScore: Math.floor(v) })
    },
    setaimaxmc: {
      prompt: "💬 Send max market cap in USD (0 = unlimited)",
      usage: "Usage: /setaimaxmc 300000",
      validate: v => v >= 0,
      set: v => store.updateSettings({ aiScoutMaxMarketCapUsd: Math.floor(v) })
    },
    setaiminmc: {
      prompt: "💬 Send min market cap in USD (0 = off)",
      usage: "Usage: /setaiminmc 50000",
      validate: v => v >= 0,
      set: v => store.updateSettings({ aiScoutMinMarketCapUsd: Math.floor(v) })
    },
    setaiage: {
      prompt: "💬 Send max token age in minutes (0 = unlimited)",
      usage: "Usage: /setaiage 360",
      validate: v => v >= 0,
      set: v => store.updateSettings({ aiScoutMaxAgeMin: Math.floor(v) })
    }
  };

  interface ListField {
    prompt: string;
    validate: (v: number[]) => boolean;
    set: (v: number[]) => void;
  }

  const LIST_FIELDS: Record<string, ListField> = {
    presetseth: {
      prompt: "💬 Send buy presets in ETH, comma-separated (e.g. 0.01, 0.05, 0.1)",
      validate: v => v.length > 0 && v.length <= 3 && v.every(n => n > 0),
      set: v => store.updateSettings({ buyPresetsEth: v })
    },
    presetsusdc: {
      prompt: "💬 Send buy presets in USDC, comma-separated (e.g. 10, 25, 50)",
      validate: v => v.length > 0 && v.length <= 3 && v.every(n => n > 0),
      set: v => store.updateSettings({ buyPresetsUsdc: v })
    },
    solpresets: {
      prompt: "💬 Send Solana buy presets in SOL, comma-separated (e.g. 0.005, 0.01, 0.02)",
      validate: v => v.length > 0 && v.length <= 3 && v.every(n => n > 0 && n <= 5),
      set: v => store.updateSettings({ solBuyPresets: v })
    },
    solpresetsusdc: {
      prompt: "💬 Send Solana buy presets in USDC, comma-separated (e.g. 1, 2, 5)",
      validate: v => v.length > 0 && v.length <= 3 && v.every(n => n > 0 && n <= 10_000),
      set: v => store.updateSettings({ solBuyPresetsUsdc: v })
    },
    sellpresets: {
      prompt: "💬 Send sell presets in %, comma-separated (e.g. 25, 50, 100)",
      validate: v => v.length > 0 && v.length <= 3 && v.every(n => n > 0 && n <= 100),
      set: v => store.updateSettings({ sellPresets: v })
    },
    setailiq: {
      prompt: "💬 Send AI Scout liquidity range in USD: min,max (0 max = unlimited)",
      validate: v => v.length === 2 && v.every(n => n >= 0) && (v[1] === 0 || v[1] >= v[0]),
      set: v => store.updateSettings({
        aiScoutMinLiquidityUsd: Math.floor(v[0]),
        aiScoutMaxLiquidityUsd: Math.floor(v[1])
      })
    },
    setladder: {
      prompt: "💬 Profit ladder as pairs — gain%, then sell% — e.g. <code>50 25 120 35 300 50</code> means: sell 25% at +50%, 35% at +120%, 50% at +300%. The leftover is your free moonbag.",
      validate: v => v.length >= 2 && v.length % 2 === 0 && v.length <= 8
        && v.every((n, i) => i % 2 === 0 ? n > 0 : (n > 0 && n < 100)),
      set: v => {
        const tpLadder = [];
        for (let i = 0; i < v.length; i += 2) tpLadder.push({ at: Math.round(v[i]), sell: Math.round(v[i + 1]) });
        store.updateSettings({ tpLadder });
      }
    }
  };

  // ---------- commands ----------

  bot.command("start", async ctx => {
    // First run (no wallets yet) → onboarding; otherwise FLUX home desk with balances.
    if (store.wallets.length === 0) return render(ctx, helpText(), mainMenu());
    return render(ctx, await mainHomeText(), mainMenu());
  });

  bot.command("help", ctx =>
    ctx.reply(
      `${deskTitle()} — commands\n\n` +
      "💡 <b>Paste any contract address</b> to open a trade card.\n\n" +
      "<b>Panel</b>\n" +
      "/start — home desk\n" +
      "/status — systems health\n" +
      "/mywallet — trading wallet balances & PnL\n" +
      "/stats — tracked wallet performance\n" +
      "/positions — open positions\n" +
      "/pnl [token] — PnL card summary or one token\n" +
      "/syncpositions [net] — import held tokens into positions\n" +
      "/wallets — tracked wallets\n" +
      "/settings — settings panel\n\n" +
      "<b>Wallets</b>\n" +
      "/add 0x… label — track an EVM wallet\n" +
      "/add SoLAddr label — track a Solana wallet (watch-only)\n" +
      "/import — bulk add, one wallet per line\n\n" +
      "<b>Trading</b>\n" +
      "/scan token [net] — token scanner card with quick actions\n" +
      "/buy token [amount] [base|ethereum|bsc] — manual buy (default base)\n" +
      "/sell token pct — sell a position (e.g. /sell 0xToken 50)\n" +
      "/panic — sell 100% of every open position\n\n" +
      "<b>Settings</b> (or tap the value in /settings)\n" +
      "/setbuy 0.01 • /setbuyusdc 25 • /setmax 0.05\n" +
      "/setsolbuy 0.005 • /setsolbuyusdc 1 • /setsolslip 3\n" +
      "/setslippage 3 • /setgas 30 • /setminliq 5000\n" +
      "/setcap 0.1 • /setcooldown 60\n" +
      "/settp 100 • /setsl 40  (take-profit / fixed stop-loss %, 0=off)\n" +
      "/settrailsl 25 • /setrunnertrail 70  (trailing SL % points off peak, 0=off)\n\n" +
      "<b>Auto-exit:</b> arm 🎯 Auto-exit in /settings, then set fixed SL and/or Trail SL.\n" +
      "Trail SL tracks best unrealized PnL and sells when price falls N points off that peak (only after peak ≥ N so it never forces a loss; fixed SL covers that).\n\n" +
      "/cancel — abort a pending input",
      { parse_mode: "HTML" }
    )
  );

  bot.command("cancel", ctx => {
    const had = pending !== null;
    pending = null;
    return ctx.reply(had ? "✖️ Cancelled." : "Nothing to cancel.");
  });

  bot.command("status", ctx =>
    render(ctx, statusText(), statusMenu())
  );
  bot.command("positions", async ctx => render(ctx, await positionsText(), positionsMenu()));
  bot.command("orders", async ctx => render(ctx, ordersText(), ordersMenu()));
  bot.command("history", async ctx => render(ctx, historyText(), historyMenu()));
  bot.command("pnl", async ctx => {
    const [token, netStr] = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (!token) {
      return showPnlCard(ctx);
    }
    if (isSolanaAddress(token)) {
      return showPnlCard(ctx, { token, network: "solana" });
    }
    if (!isAddress(token)) return ctx.reply("Usage: /pnl or /pnl 0xToken [base|ethereum|bsc] or /pnl SolanaMint");
    const net = (netStr ?? "base") as NetworkKey;
    if (!NETWORKS[net]) return ctx.reply("Network must be base, ethereum or bsc.");
    return showPnlCard(ctx, { token, network: net });
  });
  bot.command("mywallet", async ctx => render(ctx, await myWalletText(), myWalletMenu()));
  bot.command("portfolio", async ctx => render(ctx, await portfolioText(), portfolioMenu()));
  bot.command("stats", ctx => render(ctx, walletStatsText(), walletStatsMenu()));
  bot.command("aistats", ctx => render(ctx, aiStatsText(), aiStatsMenu()));
  bot.command("wallets", ctx =>
    render(ctx, "<b>Tracked wallets</b>\nTap to pause/resume, 🗑 to remove.", walletsMenu())
  );
  bot.command("settings", ctx => render(ctx, settingsHubTitle, settingsMenu()));

  bot.command("add", ctx => {
    const [addr, ...labelParts] = (ctx.match ?? "").trim().split(/\s+/);
    if (!addr) return ctx.reply("Usage: /add 0xWalletAddress optional-label");
    const label = labelParts.join(" ") || shortAddress(addr);
    if (isAddress(addr)) {
      const added = store.addWallet(addr, label, "evm");
      return ctx.reply(added ? `✅ Tracking <b>${label}</b>` : "Already tracked.", { parse_mode: "HTML" });
    }
    if (isSolanaAddress(addr)) {
      const added = store.addWallet(addr, label, "solana");
      return ctx.reply(
        added ? `✅ Tracking <b>${label}</b> ◎ (Solana, watch-only)` : "Already tracked.",
        { parse_mode: "HTML" }
      );
    }
    return ctx.reply("That doesn't look like an EVM (0x…) or Solana address.");
  });

  const importWallets = (text: string): WalletImportResult => {
    const result: WalletImportResult = { added: 0, duplicate: 0, invalid: [] };

    for (const item of parseWalletImport(text)) {
      const chain = isAddress(item.address) ? "evm"
        : isSolanaAddress(item.address) ? "solana"
        : null;
      if (!chain) {
        result.invalid.push(item.address);
        continue;
      }

      const label = item.label || shortAddress(item.address);
      const added = store.addWallet(item.address, label, chain);
      if (added) result.added += 1;
      else result.duplicate += 1;
    }

    return result;
  };

  const importSummary = (result: WalletImportResult) => {
    const parts = [
      `✅ Imported: ${result.added}`,
      `Already tracked: ${result.duplicate}`
    ];

    if (result.invalid.length > 0) {
      const shown = result.invalid.slice(0, 5).join("\n");
      const more = result.invalid.length > 5 ? `\n…and ${result.invalid.length - 5} more` : "";
      parts.push(`Invalid lines: ${result.invalid.length}\n${shown}${more}`);
    }

    return parts.join("\n");
  };

  bot.command("import", ctx => {
    const text = (ctx.match ?? "").trim();
    if (!text) {
      pending = {
        kind: "walletimport",
        prompt: "📥 Paste wallets now — one per line. Labels are optional after the address."
      };
      return ctx.reply(
        "📥 Paste wallets now — one per line. Labels are optional after the address.\n\n" +
        "Example:\n" +
        "0xWallet1 label optional\n" +
        "SoLWallet2\n" +
        "0xWallet3 label optional\n\n" +
        "Send /cancel to abort."
      );
    }

    const result = importWallets(text);
    return ctx.reply(importSummary(result));
  });

  bot.command("importsolkey", ctx => {
    pending = {
      kind: "solkey",
      prompt: "🔑 Send the Solana trading private key now. Base58 secret key or JSON array is accepted."
    };
    return ctx.reply(
      "🔑 Send the Solana trading private key now.\n\n" +
      "Accepted formats:\n" +
      "• base58 secret key\n" +
      "• JSON array exported by a Solana wallet/tool\n\n" +
      "Use a fresh wallet with tiny funds only. Send /cancel to abort."
    );
  });

  const execBuy = async (
    ctx: Context, net: NetworkKey, token: Address, amount?: number
  ): Promise<boolean> => {
    return withCritical(async () => {
      try {
        const res = await trader.copyBuy(net, token, { amount, manual: true });
        await ctx.reply(
          `✅ Bought <b>$${res.symbol}</b>\n${res.detail}\n` +
          `🔎 <a href="${NETWORKS[res.network].explorer}/tx/${res.txHash}">tx</a>`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
        return true;
      } catch (err: any) {
        console.error(`[buy ${net} ${token}] ${diag(err)}`);
        await ctx.reply(`⚠️ <b>Buy not placed</b> — ${esc(errText(err))}`, { parse_mode: "HTML" });
        return false;
      }
    });
  };

  const solPnlLine = (res: { pnlQuote?: number; pnlPct?: number; quoteSymbol?: string }) => pnlLine(res);

  const execSolBuy = async (ctx: Context, mint: string, solAmount: number): Promise<boolean> => {
    if (!solTrader?.enabled) {
      await ctx.reply("❌ Solana trading is not configured. Set SOLANA_PRIVATE_KEY and restart.");
      return false;
    }
    return withCritical(async () => {
      try {
        const res = await solTrader.buy(mint, solAmount);
        await ctx.reply(
          `✅ Bought <b>$${esc(res.symbol)}</b>\n${res.detail}\n` +
          `🔎 <a href="https://solscan.io/tx/${res.signature}">tx</a>`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
        return true;
      } catch (err: any) {
        await ctx.reply(`⚠️ <b>Sol buy not placed</b> — ${esc(errText(err))}`, { parse_mode: "HTML" });
        return false;
      }
    });
  };

  const execSolSell = async (ctx: Context, mint: string, pct: number): Promise<boolean> => {
    if (!solTrader?.enabled) {
      await ctx.reply("❌ Solana trading is not configured. Set SOLANA_PRIVATE_KEY and restart.");
      return false;
    }
    return withCritical(async () => {
      try {
        const res = await solTrader.sell(mint, pct);
        await ctx.reply(
          `✅ Sold ${Math.round(pct)}% of <b>$${esc(res.symbol)}</b>\n${res.detail}${solPnlLine(res)}\n` +
          `<a href="https://solscan.io/tx/${res.signature}">tx</a>`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
        return true;
      } catch (err: any) {
        await ctx.reply(`⚠️ <b>Sol sell not placed</b> — ${esc(errText(err))}`, { parse_mode: "HTML" });
        return false;
      }
    });
  };

  bot.command(["scan", "info"], async ctx => {
    const parts = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const [token, netStr] = parts;
    if (!token || (!isAddress(token) && !isSolanaAddress(token))) {
      return ctx.reply("Usage: /scan 0xToken [base|ethereum|bsc] or /scan SolanaMint");
    }
    if (isSolanaAddress(token)) {
      await ctx.reply("🔍 Scanning Solana token…");
      return showSolScanner(ctx, token);
    }
    const net = (netStr ?? "base") as NetworkKey;
    if (!NETWORKS[net]) return ctx.reply("Network must be base, ethereum or bsc.");
    await ctx.reply("🔍 Scanning…");
    return showScanner(ctx, net, token as Address);
  });

  bot.command("chart", async ctx => {
    const [token, netStr] = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    if (!token || (!isAddress(token) && !isSolanaAddress(token))) {
      return ctx.reply("Usage: /chart 0xToken [base|ethereum|bsc] or /chart SolanaMint");
    }
    const d = chartDefaults();
    if (isSolanaAddress(token)) {
      await ctx.reply("📈 Loading Sol chart…");
      return showSolChart(ctx, token, d.tf, d.mode);
    }
    const net = (netStr ?? "base") as NetworkKey;
    if (!NETWORKS[net]) return ctx.reply("Network must be base, ethereum or bsc.");
    await ctx.reply("📈 Loading chart…");
    return showChart(ctx, net, token as Address, d.tf, d.mode);
  });

  bot.command("recover", async ctx => {
    const [token, netStr] = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    // Solana mint → recover via solTrader (reads real on-chain balance).
    if (token && isSolanaAddress(token)) {
      if (!solTrader?.enabled) return ctx.reply("Solana isn't configured.");
      await ctx.reply("🔧 Checking your Solana balance…");
      try {
        const res = await solTrader.recoverPosition(token);
        if (!res) return ctx.reply("You don't hold any of that token.");
        return ctx.reply(`✅ Recovered <b>$${esc(res.symbol)}</b> — ${res.uiAmount} tokens now tracked & auto-managed.`, { parse_mode: "HTML", reply_markup: positionsMenu() });
      } catch (err: any) {
        return ctx.reply(`❌ Recover failed: ${esc(errText(err))}`, { parse_mode: "HTML" });
      }
    }
    if (!token || !isAddress(token)) {
      return ctx.reply("Usage: /recover <0xToken|SolanaMint> [base|ethereum|bsc]\nImports a coin you already hold into tracked positions.");
    }
    const net = (netStr ?? "base") as NetworkKey;
    if (!NETWORKS[net]) return ctx.reply("Network must be base, ethereum or bsc.");
    await ctx.reply("🔧 Checking your on-chain balance…");
    try {
      const res = await trader.recoverPosition(net, token as Address);
      if (!res) return ctx.reply("You don't hold any of that token in the trading wallet.");
      await ctx.reply(
        `✅ Recovered <b>$${res.symbol}</b> — ${res.uiAmount} tokens now tracked.\n` +
        `Open 📊 Positions to sell it (live PnL shown there).`,
        { parse_mode: "HTML" }
      );
    } catch (err: any) {
      await ctx.reply(`❌ Recover failed: ${errText(err)}`);
    }
  });

  bot.command(["syncpositions", "syncpos"], async ctx => {
    const netStr = (ctx.match ?? "").trim() as NetworkKey | "";
    const net = netStr || undefined;
    if (net && !NETWORKS[net]) return ctx.reply("Network must be base, ethereum or bsc.");
    await ctx.reply("🔎 Syncing held tokens from recent wallet activity…");
    try {
      const res = await trader.syncHeldPositions(net || undefined);
      await ctx.reply(
        `✅ Sync done\n` +
        `Scanned: ${res.scanned}\n` +
        `Added: ${res.added}\n` +
        `Updated: ${res.updated}\n` +
        `Zero balance: ${res.skippedZero}\n` +
        `Failed: ${res.failed}`,
        { reply_markup: positionsMenu() }
      );
    } catch (err: any) {
      await ctx.reply(`❌ Sync failed: ${errText(err)}`);
    }
  });

  bot.command("buy", async ctx => {
    const parts = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const [token, amountStr, netStr] = parts;
    if (!token || !isAddress(token)) {
      return ctx.reply("Usage: /buy 0xToken [amount] [base|ethereum|bsc]");
    }
    const net = (netStr ?? "base") as NetworkKey;
    if (!NETWORKS[net]) return ctx.reply("Network must be base, ethereum or bsc.");
    const amount = amountStr !== undefined ? Number(amountStr) : undefined;
    if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
      return ctx.reply("Amount must be a positive number.");
    }
    await ctx.reply("⏳ Buying…");
    return execBuy(ctx, net, token as Address, amount);
  });

  bot.command("solbuy", async ctx => {
    const [mint, amtStr] = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const defaultAmount = store.settings.solQuote === "USDC"
      ? store.settings.solBuyAmountUsdc
      : store.settings.solBuyAmount;
    const amount = Number(amtStr ?? String(defaultAmount));
    if (!mint || !isSolanaAddress(mint) || !Number.isFinite(amount) || amount <= 0) {
      return ctx.reply("Usage: /solbuy SolanaMint 0.005");
    }
    await ctx.reply("⏳ Buying on Solana…");
    return execSolBuy(ctx, mint, amount);
  });

  bot.command("sell", async ctx => {
    const [token, pctStr] = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const pct = Number(pctStr ?? "100");
    if (!token || !isAddress(token) || !Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return ctx.reply("Usage: /sell 0xToken 50   (percent, 1–100)");
    }
    const pos = store.positions.find(
      p => p.network !== "solana" && p.token.toLowerCase() === token.toLowerCase()
    );
    if (!pos) return ctx.reply("No open position for that token.");
    return withCritical(async () => {
      try {
        const res = await trader.sell(pos.network as NetworkKey, token as Address, Math.round(pct));
        await ctx.reply(
          `✅ Sold ${Math.round(pct)}% of <b>$${res.symbol}</b>\n${res.detail}${pnlLine(res)}\n` +
          `<a href="${NETWORKS[res.network].explorer}/tx/${res.txHash}">tx</a>`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
      } catch (err: any) {
        console.error(`[sell] ${diag(err)}`);
        await ctx.reply(`⚠️ <b>Sell not placed</b> — ${esc(errText(err))}`, { parse_mode: "HTML" });
      }
    });
  });

  bot.command("solsell", async ctx => {
    const [mint, pctStr] = (ctx.match ?? "").trim().split(/\s+/).filter(Boolean);
    const pct = Number(pctStr ?? "100");
    if (!mint || !isSolanaAddress(mint) || !Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return ctx.reply("Usage: /solsell SolanaMint 50");
    }
    await ctx.reply(`⏳ Selling ${Math.round(pct)}% on Solana…`);
    return execSolSell(ctx, mint, Math.round(pct));
  });

  bot.command("reclaim", async ctx => {
    if (!solTrader?.enabled) return ctx.reply("Solana isn't configured — nothing to reclaim.");
    await ctx.reply("♻️ Closing empty Solana token accounts…");
    try {
      const r = await solTrader.reclaimAllEmptyAccounts();
      return ctx.reply(
        r.closed
          ? `♻️ <b>Reclaimed ${r.reclaimedSol.toFixed(5)} SOL</b> from ${r.closed} empty account(s).`
          : "✅ Nothing to reclaim — no empty token accounts.",
        { parse_mode: "HTML" }
      );
    } catch (err: any) {
      return ctx.reply(`❌ Reclaim failed: ${esc(errText(err))}`, { parse_mode: "HTML" });
    }
  });

  bot.command("panic", async ctx => {
    const positions = [...store.positions];
    if (positions.length === 0) return ctx.reply("No open positions.");
    await ctx.reply(`🚨 Panic selling ${positions.length} position(s)…`);
    let ok = 0, fail = 0;
    await withCritical(async () => {
      for (const p of positions) {
        try {
          if (p.network === "solana") await solTrader?.sell(p.token, 100);
          else await trader.sell(p.network, p.token as Address, 100);
          ok++;
        } catch { fail++; }
      }
    });
    return ctx.reply(`Done — ${ok} sold, ${fail} failed.`);
  });

  // register the classic slash commands too
  for (const [name, f] of Object.entries(FIELDS)) {
    bot.command(name, ctx => {
      const v = Number((ctx.match ?? "").trim());
      if (!Number.isFinite(v) || !f.validate(v)) return ctx.reply(f.usage);
      f.set(v);
      return ctx.reply("✅ Saved.");
    });
  }

  for (const [name, f] of Object.entries(LIST_FIELDS)) {
    bot.command(name, ctx => {
      const vals = (ctx.match ?? "")
        .trim()
        .split(/[\s,]+/)
        .filter(Boolean)
        .map(t => Number(t.replace(",", ".")));
      if (vals.length === 0 || vals.some(v => !Number.isFinite(v)) || !f.validate(vals)) {
        return ctx.reply(`Usage: /${name} ${name === "setailiq" ? "5000,75000" : "0.01,0.05,0.1"}`);
      }
      f.set(vals);
      return ctx.reply("✅ Saved.");
    });
  }

  // ---------- callback queries ----------

  bot.callbackQuery("noop", ctx => ctx.answerCallbackQuery());

  bot.callbackQuery(/^hint:(.+)$/, ctx =>
    ctx.answerCallbackQuery({
      text: {
        add: "Send /add 0xWallet label (or a Solana address)",
        import: "Send /import, then one wallet per line"
      }[ctx.match[1]] ?? "",
      show_alert: false
    })
  );

  // tap a settings value -> bot asks, user replies with the number
  bot.callbackQuery(/^ask:(.+)$/, async ctx => {
    const f = FIELDS[ctx.match[1]];
    if (!f) return ctx.answerCallbackQuery();
    pending = {
      kind: "value",
      prompt: f.prompt,
      apply: v => (f.validate(v) ? (f.set(v), null) : f.usage)
    };
    await ctx.answerCallbackQuery();
    return ctx.reply(`${f.prompt}\n(or /cancel)`);
  });

  // tap a list setting (presets) -> bot asks for a comma-separated list
  bot.callbackQuery(/^asklist:(.+)$/, async ctx => {
    const f = LIST_FIELDS[ctx.match[1]];
    if (!f) return ctx.answerCallbackQuery();
    pending = {
      kind: "list",
      prompt: f.prompt,
      apply: v => (f.validate(v) ? (f.set(v), null) : "Up to 3 positive numbers, comma-separated.")
    };
    await ctx.answerCallbackQuery();
    return ctx.reply(`${f.prompt}\n(or /cancel)`);
  });

  bot.callbackQuery(/^menu:(main|wallets|settings|positions|status|mywallet|walletstats|aistats|portfolio|help|defend|watch|orders|history)$/, async ctx => {
    await ctx.answerCallbackQuery();
    switch (ctx.match[1]) {
      case "main":
        return render(ctx, await mainHomeText(), mainMenu());
      case "wallets":
        return render(ctx, `<b>Tracked wallets</b>\n${RULE}\nTap to pause/resume, 🗑 to remove.`, walletsMenu());
      case "settings":
        return render(ctx, settingsHubTitle, settingsMenu());
      case "positions":
        return render(ctx, await positionsText(), positionsMenu());
      case "status":
        return render(ctx, statusText(), statusMenu());
      case "mywallet":
        return render(ctx, await myWalletText(), myWalletMenu());
      case "walletstats":
        return render(ctx, walletStatsText(), walletStatsMenu());
      case "aistats":
        return render(ctx, aiStatsText(), aiStatsMenu());
      case "portfolio":
        return render(ctx, await portfolioText(), portfolioMenu());
      case "help":
        return render(ctx, helpText(), helpMenu());
      case "defend":
        return render(ctx, defendText(), defendMenu());
      case "watch":
        return render(ctx, watchText(), watchMenu());
      case "orders":
        return render(ctx, ordersText(), ordersMenu());
      case "history":
        return render(ctx, historyText(), historyMenu());
    }
  });

  // ---------- ORDERS: limit buy / limit sell / DCA ----------
  const parseOrderChainToken = (chainRaw: string, token: string): { chain: OrderChain; token: string } | null => {
    if (chainRaw === "sol" || chainRaw === "solana") {
      if (!isSolanaAddress(token)) return null;
      return { chain: "solana", token };
    }
    if (chainRaw === "base" || chainRaw === "ethereum" || chainRaw === "bsc") {
      if (!isAddress(token)) return null;
      return { chain: chainRaw, token: token.toLowerCase() };
    }
    return null;
  };

  bot.callbackQuery(/^ord:ask:(lbuy|lsell|dca):(base|ethereum|bsc|sol):(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, async ctx => {
    const kindMap: Record<string, OrderKind> = {
      lbuy: "limit_buy",
      lsell: "limit_sell",
      dca: "dca_buy"
    };
    const orderKind = kindMap[ctx.match[1]];
    const parsed = parseOrderChainToken(ctx.match[2], ctx.match[3]);
    if (!parsed || !orderKind) {
      await ctx.answerCallbackQuery({ text: "Bad token" });
      return;
    }
    let symbol: string | undefined;
    try {
      const info = parsed.chain === "solana"
        ? await fetchTokenInfoBySlug("solana", parsed.token)
        : await fetchTokenInfo(parsed.chain, parsed.token as Address);
      symbol = info?.symbol;
    } catch { /* optional */ }

    const quoteHint = parsed.chain === "solana"
      ? store.settings.solQuote
      : (parsed.chain === "base" ? store.settings.baseQuote : NETWORKS[parsed.chain].nativeSymbol);

    let prompt: string;
    if (orderKind === "limit_buy") {
      prompt =
        `🎯 <b>Limit BUY</b>${symbol ? ` · $${esc(symbol)}` : ""}\n` +
        `Reply: <code>PRICE AMOUNT</code>\n` +
        `Example: <code>0.000012 0.05</code> → buy <b>0.05 ${quoteHint}</b> when price ≤ $0.000012\n` +
        `<i>Current mark from DexScreener. /cancel to abort.</i>`;
    } else if (orderKind === "limit_sell") {
      prompt =
        `🎯 <b>Limit SELL (TP)</b>${symbol ? ` · $${esc(symbol)}` : ""}\n` +
        `Reply: <code>PRICE PCT</code>\n` +
        `Example: <code>0.00005 100</code> → sell <b>100%</b> when price ≥ $0.00005\n` +
        `<i>/cancel to abort.</i>`;
    } else {
      prompt =
        `📅 <b>DCA BUY</b>${symbol ? ` · $${esc(symbol)}` : ""}\n` +
        `Reply: <code>AMOUNT INTERVAL_MIN [COUNT]</code>\n` +
        `Example: <code>0.01 15 8</code> → buy <b>0.01 ${quoteHint}</b> every 15m, 8 times\n` +
        `Omit COUNT to run until you cancel.\n` +
        `<i>/cancel to abort.</i>`;
    }

    pending = {
      kind: "orderinput",
      orderKind,
      chain: parsed.chain,
      token: parsed.token,
      symbol,
      prompt
    };
    await ctx.answerCallbackQuery({ text: "Reply with order params" });
    return ctx.reply(prompt, { parse_mode: "HTML" });
  });

  bot.callbackQuery(/^ord:view:([a-z0-9]+)$/, async ctx => {
    const o = store.orderById(ctx.match[1]);
    await ctx.answerCallbackQuery();
    if (!o) return render(ctx, "Order not found.", ordersMenu());
    return render(ctx, orderDetailText(o), orderDetailMenu(o));
  });

  bot.callbackQuery(/^ord:cancel:([a-z0-9]+)$/, async ctx => {
    const ok = store.cancelOrder(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: ok ? "Cancelled" : "Not open" });
    return render(ctx, ordersText(), ordersMenu());
  });

  bot.callbackQuery("ord:cancelall", async ctx => {
    const n = store.cancelAllOrders();
    await ctx.answerCallbackQuery({ text: `Cancelled ${n}` });
    return render(ctx, ordersText(), ordersMenu());
  });

  // One-tap exit profiles (Degen / Balanced / Safe).
  bot.callbackQuery(/^preset:(degen|balanced|safe)$/, async ctx => {
    const id = ctx.match[1] as ExitPresetId;
    const p = EXIT_PRESETS[id];
    const { label, blurb, ...patch } = p;
    store.updateSettings(patch as any);
    await ctx.answerCallbackQuery({ text: `🛡 ${label} armed — ${blurb}` });
    return render(ctx, defendText(), defendMenu());
  });

  // Watchlist pin / unpin from scan cards — repaint the card so ★ flips.
  bot.callbackQuery(/^watch:add:(base|ethereum|bsc|sol):(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, async ctx => {
    const chainRaw = ctx.match[1];
    const token = ctx.match[2];
    const chain = chainRaw === "sol" ? "solana" as const : chainRaw as "base" | "ethereum" | "bsc";
    let symbol: string | undefined;
    try {
      const info = chain === "solana"
        ? await fetchTokenInfoBySlug("solana", token)
        : await fetchTokenInfo(chain, token as Address);
      symbol = info?.symbol;
    } catch { /* optional */ }
    const added = store.addWatch({ chain, token, symbol });
    await ctx.answerCallbackQuery({
      text: added ? `★ Watched ${symbol ? "$" + symbol : "token"}` : "Already on watchlist"
    });
    // Repaint card so the button shows ★ Watched
    if (chain === "solana") await showSolScanner(ctx, token);
    else await showScanner(ctx, chain, token as Address);
  });

  bot.callbackQuery(/^watch:rm:(base|ethereum|bsc|sol):(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, async ctx => {
    const chainRaw = ctx.match[1];
    const token = ctx.match[2];
    const chain = chainRaw === "sol" ? "solana" as const : chainRaw as "base" | "ethereum" | "bsc";
    store.removeWatch(chain, token);
    await ctx.answerCallbackQuery({ text: "Unwatched" });
    // From watchlist menu → refresh list; from scan card → repaint card
    const data = ctx.callbackQuery?.data ?? "";
    if (ctx.callbackQuery?.message && /solscan:|scan:|live:/.test(String((ctx.callbackQuery as any).message?.reply_markup ?? ""))) {
      // fall through to repaint below
    }
    // Prefer repainting the open card when this was a card button
    try {
      if (chain === "solana") await showSolScanner(ctx, token);
      else await showScanner(ctx, chain, token as Address);
      return;
    } catch {
      return render(ctx, watchText(), watchMenu());
    }
  });

  bot.callbackQuery(/^settings:(sizing|safety|ai|sol|charts)$/, async ctx => {
    await ctx.answerCallbackQuery();
    return renderSettingsGroup(ctx, ctx.match[1] as SettingsGroup);
  });

  // Clear AI provider circuit-breaker after rotating keys / fixing freemodel.
  bot.callbackQuery("sys:resetai", async ctx => {
    resetAiScoutCircuit();
    await ctx.answerCallbackQuery({ text: "AI circuit reset — will retry on next scout tick" });
    return render(ctx, statusText(), statusMenu());
  });

  // New scheme: ascout:<sort>:<chain>:<action>:<page>
  bot.callbackQuery(/^ascout:(top|recent):(all|solana|bsc|base|eth):(all|ENTER|WAIT|AVOID):(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const view = scoutListView(
      ctx.match[1] as "top" | "recent",
      Number(ctx.match[4]),
      ctx.match[2] as "all" | "solana" | "bsc" | "base" | "eth",
      ctx.match[3] as "all" | "ENTER" | "WAIT" | "AVOID"
    );
    return render(ctx, view.text, view.kb);
  });
  // Legacy entry points (old tabs map onto the new filtered view).
  bot.callbackQuery(/^ascout:(top|enters|recent):(\d+)$/, async ctx => {
    await ctx.answerCallbackQuery();
    const mode = ctx.match[1];
    const sort = mode === "top" ? "top" : "recent";
    const action = mode === "enters" ? "ENTER" : "all";
    const view = scoutListView(sort, Number(ctx.match[2]), "all", action);
    return render(ctx, view.text, view.kb);
  });

  bot.callbackQuery(/^toggle:(copy|sells|honeypot|skiphold|basequote|autoexit|ladder|aimomentum|aiwait|aiavoid|solfee|solquote)$/, async ctx => {
    const s = store.settings;
    const which = ctx.match[1];
    if (which === "copy") store.updateSettings({ copyEnabled: !s.copyEnabled });
    if (which === "ladder") store.updateSettings({ partialTpEnabled: !s.partialTpEnabled });
    if (which === "sells") store.updateSettings({ mirrorSells: !s.mirrorSells });
    if (which === "honeypot") store.updateSettings({ honeypotCheck: !s.honeypotCheck });
    if (which === "skiphold") store.updateSettings({ skipIfHolding: !s.skipIfHolding });
    if (which === "autoexit") store.updateSettings({ autoExitEnabled: !s.autoExitEnabled });
    if (which === "aimomentum") {
      store.updateSettings({ aiScoutRequirePositiveMomentum: !s.aiScoutRequirePositiveMomentum });
    }
    if (which === "aiwait") store.updateSettings({ aiScoutNotifyWait: !s.aiScoutNotifyWait });
    if (which === "aiavoid") store.updateSettings({ aiScoutNotifyAvoid: !s.aiScoutNotifyAvoid });
    if (which === "solfee") {
      const next = s.solFeeMode === "cheap" ? "normal" : s.solFeeMode === "normal" ? "ape" : "cheap";
      store.updateSettings({ solFeeMode: next });
    }
    if (which === "solquote") {
      store.updateSettings({ solQuote: s.solQuote === "SOL" ? "USDC" : "SOL" });
    }
    if (which === "autofund") store.updateSettings({ autoFundFromUsdc: !s.autoFundFromUsdc });
    if (which === "basequote") {
      store.updateSettings({ baseQuote: s.baseQuote === "ETH" ? "USDC" : "ETH" });
    }
    await ctx.answerCallbackQuery({ text: "Updated" });
    if (which === "copy") return render(ctx, await mainHomeText(), mainMenu());
    // Defend panel toggles — stay on Defend so presets feel snappy (Trojan-style).
    if (which === "autoexit" || which === "ladder") {
      return render(ctx, defendText(), defendMenu());
    }
    const group: SettingsGroup =
      which === "basequote" ? "sizing"
      : which === "solfee" || which === "solquote" ? "sol"
      : which === "aimomentum" || which === "aiwait" || which === "aiavoid" ? "ai"
      : "safety"; // sells, honeypot, skiphold
    return renderSettingsGroup(ctx, group);
  });

  bot.callbackQuery("toggle:chartmode", async ctx => {
    store.updateSettings({ chartByMarketCap: !store.settings.chartByMarketCap });
    await ctx.answerCallbackQuery({ text: store.settings.chartByMarketCap ? "Charts: Market Cap" : "Charts: Price" });
    return renderSettingsGroup(ctx, "charts");
  });

  bot.callbackQuery("toggle:chartdeftf", async ctx => {
    const cur = store.settings.chartTimeframe;
    const i = TIMEFRAMES.indexOf(isTimeframe(cur) ? cur : "1h");
    const next = TIMEFRAMES[(i + 1) % TIMEFRAMES.length];
    store.updateSettings({ chartTimeframe: next });
    await ctx.answerCallbackQuery({ text: `Default timeframe: ${tfLabel(next)}` });
    return renderSettingsGroup(ctx, "charts");
  });

  bot.callbackQuery("toggle:aiscout", async ctx => {
    const cur = store.settings.aiScoutMode;
    const next = cur === "off" ? "paper" : cur === "paper" ? "live" : "off";
    store.updateSettings({ aiScoutMode: next });
    await ctx.answerCallbackQuery({ text: `AI Scout: ${next}` });
    return renderSettingsGroup(ctx, "ai");
  });

  bot.callbackQuery("toggle:aisource", async ctx => {
    const cur = store.settings.aiScoutSource ?? "profiles";
    const next = cur === "profiles" ? "active" : cur === "active" ? "both" : "profiles";
    store.updateSettings({ aiScoutSource: next });
    await ctx.answerCallbackQuery({ text: `AI source: ${next}` });
    return renderSettingsGroup(ctx, "ai");
  });

  bot.callbackQuery(/^toggle:net:(base|ethereum|bsc)$/, async ctx => {
    const net = ctx.match[1] as NetworkKey;
    if (!NETWORKS[net].wsUrl) {
      return ctx.answerCallbackQuery({
        text: "Add BNB_WS_URL to .env and restart to enable BSC.",
        show_alert: true
      });
    }
    store.toggleNetwork(net);
    await ctx.answerCallbackQuery({ text: "Updated" });
    return renderSettingsGroup(ctx, "sizing");
  });

  bot.callbackQuery(/^wallet:(toggle|remove):(.+)$/, async ctx => {
    const [, action, address] = ctx.match;
    if (action === "toggle") store.toggleWallet(address);
    else store.removeWallet(address);
    await ctx.answerCallbackQuery({ text: action === "toggle" ? "Toggled" : "Removed" });
    return render(ctx, "<b>Tracked wallets</b>", walletsMenu());
  });

  bot.callbackQuery("wallet:import", async ctx => {
    pending = {
      kind: "walletimport",
      prompt: "📥 Paste wallets now — one per line. Labels are optional after the address."
    };
    await ctx.answerCallbackQuery();
    return ctx.reply(
      "📥 Paste wallets now — one per line. Labels are optional after the address.\n\n" +
      "Example:\n" +
      "0xWallet1 label optional\n" +
      "SoLWallet2\n" +
      "0xWallet3 label optional\n\n" +
      "Send /cancel to abort."
    );
  });

  bot.callbackQuery("wallet:solkey", async ctx => {
    pending = {
      kind: "solkey",
      prompt: "🔑 Send the Solana trading private key now. Base58 secret key or JSON array is accepted."
    };
    await ctx.answerCallbackQuery();
    return ctx.reply(
      "🔑 Send the Solana trading private key now.\n\n" +
      "Accepted formats:\n" +
      "• base58 secret key\n" +
      "• JSON array exported by a Solana wallet/tool\n\n" +
      "Use a fresh wallet with tiny funds only. Send /cancel to abort."
    );
  });

  bot.callbackQuery("possync:all", async ctx => {
    await ctx.answerCallbackQuery({ text: "Syncing holdings…" });
    try {
      const res = await trader.syncHeldPositions();
      return render(
        ctx,
        `✅ <b>Positions synced</b>\n` +
        `Scanned: ${res.scanned}\n` +
        `Added: ${res.added}\n` +
        `Updated: ${res.updated}\n` +
        `Zero balance: ${res.skippedZero}\n` +
        `Failed: ${res.failed}\n\n` +
        `${await positionsText()}`,
        positionsMenu()
      );
    } catch (err: any) {
      return render(ctx, `❌ <b>Sync failed</b>\n${esc(errText(err))}`, positionsMenu());
    }
  });

  bot.callbackQuery(/^posrm:(base|ethereum|bsc|solana):([0-9a-zA-Z]+)$/, async ctx => {
    const net = ctx.match[1] as NetworkKey | "solana";
    const token = ctx.match[2];
    const pos = store.position(token, net);
    store.removePosition(token, net);
    await ctx.answerCallbackQuery({ text: pos ? "Removed from bot list" : "Already gone" });
    return render(ctx, await positionsText(), positionsMenu());
  });

  bot.callbackQuery("pnl:all", async ctx => {
    await ctx.answerCallbackQuery({ text: "Refreshing PnL…" });
    return showPnlCard(ctx);
  });

  bot.callbackQuery(/^pnl:(base|ethereum|bsc|solana):([0-9a-zA-Z]+)$/, async ctx => {
    const network = ctx.match[1] as NetworkKey | "solana";
    const token = ctx.match[2];
    await ctx.answerCallbackQuery({ text: "Refreshing PnL…" });
    return showPnlCard(ctx, { token, network });
  });

  bot.callbackQuery(/^scan:(base|ethereum|bsc):(0x[0-9a-fA-F]{40})$/, async ctx => {
    await ctx.answerCallbackQuery({ text: "Refreshing…" });
    await showScanner(ctx, ctx.match[1] as NetworkKey, ctx.match[2] as Address);
  });

  bot.callbackQuery(/^solscan:([1-9A-HJ-NP-Za-km-z]{32,44})$/, async ctx => {
    await ctx.answerCallbackQuery({ text: "Refreshing Sol scan…" });
    await showSolScanner(ctx, ctx.match[1]);
  });

  // Opt-in Live auto-refresh on a token card (DexScreener only — never Jupiter).
  bot.callbackQuery(/^live:(base|ethereum|bsc|sol):(0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})$/, async ctx => {
    const kind = ctx.match[1];
    const token = ctx.match[2];
    const msg: any = ctx.callbackQuery.message;
    if (!msg?.chat?.id || !msg.message_id) {
      await ctx.answerCallbackQuery({ text: "Open a scan card first", show_alert: true });
      return;
    }
    const key = liveKey(msg.chat.id, msg.message_id);
    const wasPhoto = !!msg.photo;
    if (liveCards.has(key)) {
      liveCards.delete(key);
      await ctx.answerCallbackQuery({ text: "⏱ Live OFF" });
      if (kind === "sol") await showSolScanner(ctx, token);
      else await showScanner(ctx, kind as NetworkKey, token as Address);
      return;
    }
    if (liveCards.size >= LIVE_MAX_CARDS) {
      await ctx.answerCallbackQuery({
        text: `Max ${LIVE_MAX_CARDS} Live cards. Turn one off first.`,
        show_alert: true
      });
      return;
    }
    liveCards.set(key, {
      chatId: msg.chat.id,
      messageId: msg.message_id,
      wasPhoto,
      kind: kind === "sol" ? "sol" : "evm",
      network: kind === "sol" ? undefined : (kind as NetworkKey),
      token,
      startedAt: Date.now(),
      lastAt: 0
    });
    await ctx.answerCallbackQuery({
      text: `⏱ Live ON · every ${LIVE_INTERVAL_MS / 1000}s · Dex only (no Jupiter)`
    });
    // Immediate first paint so the button flips to Live ON without waiting a tick.
    if (kind === "sol") await showSolScanner(ctx, token);
    else await showScanner(ctx, kind as NetworkKey, token as Address);
  });

  bot.callbackQuery(/^solchart:([1-9A-HJ-NP-Za-km-z]{32,44}):(1m|5m|15m|1h|4h|1d):(p|m)$/, async ctx => {
    await ctx.answerCallbackQuery({ text: "📈 Loading Sol chart…" });
    const mode: ChartMode = ctx.match[3] === "m" ? "mc" : "price";
    await showSolChart(ctx, ctx.match[1], ctx.match[2] as Timeframe, mode);
  });

  bot.callbackQuery(/^solbuy:([1-9A-HJ-NP-Za-km-z]{32,44}):([0-9]*\.?[0-9]+|x)$/, async ctx => {
    const [, mint, amt] = ctx.match;
    if (amt === "x") {
      pending = { kind: "solcustombuy", mint };
      await ctx.answerCallbackQuery();
      return ctx.reply(`💬 Reply with the amount in ${store.settings.solQuote} to buy (or /cancel)`);
    }
    await ctx.answerCallbackQuery({ text: "Buying on Solana…" });
    const ok = await execSolBuy(ctx, mint, Number(amt));
    if (ok) await showSolScanner(ctx, mint);
  });

  bot.callbackQuery(/^solsell:([1-9A-HJ-NP-Za-km-z]{32,44}):([0-9]{1,3})$/, async ctx => {
    const [, mint, pct] = ctx.match;
    const p = Math.min(100, Math.max(1, Number(pct)));
    await ctx.answerCallbackQuery({ text: `Selling ${p}% on Solana…` });
    const ok = await execSolSell(ctx, mint, p);
    if (ok) await showSolScanner(ctx, mint);
  });

  bot.callbackQuery(/^chart:(base|ethereum|bsc):(0x[0-9a-fA-F]{40}):(1m|5m|15m|1h|4h|1d):(p|m)$/, async ctx => {
    await ctx.answerCallbackQuery({ text: "📈 Loading chart…" });
    const mode: ChartMode = ctx.match[4] === "m" ? "mc" : "price";
    await showChart(ctx, ctx.match[1] as NetworkKey, ctx.match[2] as Address, ctx.match[3] as Timeframe, mode);
  });

  // Back-compat: chart buttons sent before the mode/timeframe expansion landed.
  bot.callbackQuery(/^chart:(base|ethereum|bsc):(0x[0-9a-fA-F]{40}):([0-9a-z]+)$/, async ctx => {
    await ctx.answerCallbackQuery({ text: "📈 Loading chart…" });
    const raw = ctx.match[3];
    const tf: Timeframe = isTimeframe(raw) ? raw : chartDefaults().tf;
    await showChart(ctx, ctx.match[1] as NetworkKey, ctx.match[2] as Address, tf, chartDefaults().mode);
  });

  bot.callbackQuery(/^mbuy:(base|ethereum|bsc):(0x[0-9a-fA-F]{40}):([0-9]*\.?[0-9]+|x)$/, async ctx => {
    const [, netStr, token, amtStr] = ctx.match;
    const net = netStr as NetworkKey;
    if (amtStr === "x") {
      const sym = trader.quoteAsset(net).symbol;
      pending = { kind: "custombuy", net, token: token as Address };
      await ctx.answerCallbackQuery();
      return ctx.reply(`💬 Reply with the amount in ${sym} to buy (or /cancel)`);
    }
    await ctx.answerCallbackQuery({ text: "Buying…" });
    const ok = await execBuy(ctx, net, token as Address, Number(amtStr));
    // Update the card in place so it shows the new holding + live PnL.
    if (ok) await showScanner(ctx, net, token as Address);
  });

  bot.callbackQuery("panic:confirm", async ctx => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text("🚨 YES, sell everything", "panic:go")
      .text("✖️ Cancel", "menu:main");
    return render(
      ctx,
      `🚨 <b>Panic sell — ${store.positions.length} position(s)?</b>\n${RULE}\n` +
      `Sells <b>100% of every open position</b> at market, each as one simulated transaction. ` +
      `This cannot be undone.`,
      kb
    );
  });

  bot.callbackQuery("panic:go", async ctx => {
    await ctx.answerCallbackQuery({ text: "Selling everything…" });
    const positions = [...store.positions];
    if (positions.length === 0) {
      return render(ctx, "<b>No open positions.</b>", new InlineKeyboard().text("⬅️ Back", "menu:main"));
    }
    let ok = 0, fail = 0;
    await withCritical(async () => {
      for (const p of positions) {
        try {
          if (p.network === "solana") await solTrader?.sell(p.token, 100);
          else await trader.sell(p.network, p.token as Address, 100);
          ok++;
        } catch {
          fail++;
        }
      }
    });
    return render(
      ctx,
      `🚨 <b>Panic sell complete</b>\n${RULE}\n🟢 Sold: ${ok}${fail ? `\n🔴 Failed: ${fail} (still held — try again)` : ""}`,
      new InlineKeyboard().text("📊 Positions", "menu:positions").text("⬅️ Back", "menu:main")
    );
  });

  bot.callbackQuery(/^sell:(base|ethereum|bsc):(0x[0-9a-fA-F]{40}):([0-9]{1,3})$/, async ctx => {
    const [, net, token, pct] = ctx.match;
    const p = Math.min(100, Math.max(1, Number(pct)));
    await ctx.answerCallbackQuery({ text: `Selling ${p}%…` });
    let ok = false;
    await withCritical(async () => {
      try {
        const res = await trader.sell(net as NetworkKey, token as Address, p);
        ok = true;
        await ctx.reply(
          `✅ Sold ${p}% of <b>$${res.symbol}</b>\n${res.detail}${pnlLine(res)}\n` +
          `<a href="${NETWORKS[res.network].explorer}/tx/${res.txHash}">tx</a>`,
          { parse_mode: "HTML", link_preview_options: { is_disabled: true } }
        );
      } catch (err: any) {
        console.error(`[sell] ${diag(err)}`);
        await ctx.reply(`⚠️ <b>Sell not placed</b> — ${esc(errText(err))}`, { parse_mode: "HTML" });
      }
    });
    // Refresh the card in place (shows reduced/closed position) — no view switch.
    if (ok) await showScanner(ctx, net as NetworkKey, token as Address);
  });

  // ---------- plain text: pending inputs, then bulk import ----------

  bot.on("message:text", async ctx => {
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;

    // 1) an input the bot explicitly asked for
    if (pending) {
      const p = pending;

      if (p.kind === "walletimport") {
        pending = null;
        const result = importWallets(text);
        return ctx.reply(importSummary(result), { reply_markup: walletsMenu() });
      }

      if (p.kind === "solkey") {
        pending = null;
        try {
          const kp = parseSolanaKeypair(text);
          upsertEnvValue("SOLANA_PRIVATE_KEY", text);
          return ctx.reply(
            `✅ Solana trading key saved.\n` +
            `Public key: <code>${kp.publicKey.toBase58()}</code>\n\n` +
            `Restarting the bot is required before Sol buy/sell uses it.`,
            { parse_mode: "HTML", reply_markup: myWalletMenu() }
          );
        } catch {
          pending = p;
          return ctx.reply(
            "❌ That private key did not parse. Send a base58 Solana secret key or JSON secret array, or /cancel."
          );
        }
      }

      if (p.kind === "list") {
        const vals = text
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(t => Number(t.replace(",", ".")));
        if (vals.length === 0 || vals.some(v => !Number.isFinite(v))) {
          return ctx.reply("Send numbers separated by commas, e.g. 0.01, 0.05, 0.1 — or /cancel.");
        }
        pending = null;
        const err = p.apply(vals);
        if (err) {
          pending = p;
          return ctx.reply(`❌ ${err}`);
        }
        return ctx.reply("✅ Saved.", { reply_markup: settingsMenu() });
      }

      // Multi-number free-form order wizard (must run before single-number parse).
      if (p.kind === "orderinput") {
        const parts = text.split(/[\s,]+/).filter(Boolean).map(t => Number(t.replace(",", ".")));
        if (parts.some(n => !Number.isFinite(n) || n <= 0)) {
          return ctx.reply("Send positive numbers only — or /cancel.\n" + p.prompt, { parse_mode: "HTML" });
        }
        let result: OpenOrder | string;
        if (p.orderKind === "limit_buy") {
          if (parts.length < 2) return ctx.reply("Need: PRICE AMOUNT — e.g. 0.000012 0.05");
          result = store.addOrder({
            kind: "limit_buy", chain: p.chain, token: p.token, symbol: p.symbol,
            triggerPrice: parts[0], amount: parts[1]
          });
        } else if (p.orderKind === "limit_sell") {
          if (parts.length < 2) return ctx.reply("Need: PRICE PCT — e.g. 0.00005 100");
          if (parts[1] > 100) return ctx.reply("Sell % must be 1–100.");
          result = store.addOrder({
            kind: "limit_sell", chain: p.chain, token: p.token, symbol: p.symbol,
            triggerPrice: parts[0], sellPct: parts[1]
          });
        } else {
          if (parts.length < 2) return ctx.reply("Need: AMOUNT INTERVAL_MIN [COUNT] — e.g. 0.01 15 8");
          result = store.addOrder({
            kind: "dca_buy", chain: p.chain, token: p.token, symbol: p.symbol,
            amount: parts[0],
            intervalMin: Math.max(1, Math.floor(parts[1])),
            maxFills: parts[2] ? Math.floor(parts[2]) : 0
          });
        }
        pending = null;
        if (typeof result === "string") {
          pending = p;
          return ctx.reply(`❌ ${result}`);
        }
        return ctx.reply(
          `✅ Order armed\n${orderLine(result)}\n\nMonitor fills from 🎯 Orders.`,
          { parse_mode: "HTML", reply_markup: ordersMenu() }
        );
      }

      const v = Number(text.replace(",", "."));
      if (!Number.isFinite(v)) {
        return ctx.reply("That's not a number — try again, or /cancel.");
      }
      pending = null;
      if (p.kind === "value") {
        const err = p.apply(v);
        if (err) {
          pending = p; // keep waiting
          return ctx.reply(`❌ ${err}`);
        }
        return ctx.reply("✅ Saved.", { reply_markup: settingsMenu() });
      }
      if (p.kind === "custombuy") {
        if (v <= 0) return ctx.reply("Amount must be positive. Tap ✏️ Custom again.");
        await ctx.reply("⏳ Buying…");
        return execBuy(ctx, p.net, p.token, v);
      }
      if (p.kind === "solcustombuy") {
        if (v <= 0) return ctx.reply("Amount must be positive. Tap ✏️ Custom again.");
        await ctx.reply("⏳ Buying on Solana…");
        return execSolBuy(ctx, p.mint, v);
      }
    }

    // 2) a single pasted contract address -> instant scanner (chain auto-detected)
    const oneToken = text.split(/\s+/);
    if (oneToken.length === 1 && (isAddress(text) || isSolanaAddress(text))) {
      await ctx.reply("🔍 Scanning…");
      return scanPasted(ctx, text);
    }

    // 3) multi-line wallet import
    const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length < 2) return;
    const looksLikeWallet = (s: string) => {
      const head = s.split(/\s+/)[0];
      return isAddress(head) || isSolanaAddress(head);
    };
    if (!lines.some(looksLikeWallet)) return;

    const result = importWallets(text);
    if (result.added === 0 && result.duplicate === 0 && result.invalid.length === 0) return;
    return ctx.reply(importSummary(result));
  });

  void bot.api.setMyCommands([
    { command: "start", description: "Open the control panel" },
    { command: "status", description: "Bot status" },
    { command: "portfolio", description: "Portfolio roll-up: cash, positions, PnL" },
    { command: "mywallet", description: "Trading wallet balances & PnL" },
    { command: "stats", description: "Tracked wallet performance" },
    { command: "aistats", description: "AI Scout performance" },
    { command: "positions", description: "Open positions" },
    { command: "orders", description: "Limit & DCA orders" },
    { command: "history", description: "Your trade tape" },
    { command: "pnl", description: "PnL cards" },
    { command: "wallets", description: "Tracked wallets" },
    { command: "settings", description: "Settings panel" },
    { command: "scan", description: "Token scanner: /scan 0xToken [net]" },
    { command: "chart", description: "Chart snapshot: /chart 0xToken [net]" },
    { command: "add", description: "Track a wallet: /add 0x… label" },
    { command: "import", description: "Bulk add wallets" },
    { command: "importsolkey", description: "Import Solana trading private key" },
    { command: "buy", description: "Manual buy: /buy 0xToken [amount] [net]" },
    { command: "sell", description: "Sell a position: /sell 0xToken 50" },
    { command: "solbuy", description: "Solana buy: /solbuy mint 0.005" },
    { command: "solsell", description: "Solana sell: /solsell mint 50" },
    { command: "recover", description: "Track a coin you already hold" },
    { command: "syncpositions", description: "Import held tokens into positions" },
    { command: "reclaim", description: "Close empty Solana token accounts, recover SOL rent" },
    { command: "panic", description: "Sell all open positions" },
    { command: "cancel", description: "Abort a pending input" },
    { command: "help", description: "Show all commands" }
  ]).catch(() => {});

  return bot;
}
