import { APP, NETWORKS, SOLANA, type NetworkKey } from "./config.js";
import { formatUnits } from "viem";
import { Store } from "./store.js";
import { WalletWatcher } from "./watcher.js";
import { SolanaWatcher } from "./solwatcher.js";
import { Trader } from "./trader.js";
import { SolTrader } from "./soltrader.js";
import { createBot, tradeAlertKeyboard, solAlertKeyboard } from "./telegram/bot.js";
import { fetchTokenInfo, fetchTokenInfoBySlug } from "./tokeninfo.js";
import {
  age, buildTradeAlert, buildExecLine, money, NET_BADGE, smallPrice, SOLANA_BADGE,
  BRAND, RULE, statTable, cardHeader, delta, flow
} from "./format.js";
import { decideAiScout, findAiScoutCandidates, type AiScoutChain } from "./aiscout.js";
import { findBuySpikes } from "./spikescout.js";

const STABLE_SYMBOLS = new Set(["USDC", "USDT", "USDbC", "DAI", "BUSD", "USD"]);

/** Escape AI/free text before it goes into an HTML Telegram message — an
 *  unescaped `<`, `>` or `&` in the AI thesis silently rejects the whole send. */
const escHtml = (s: string) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const liqMcStat = (liq?: number, mc?: number) =>
  liq !== undefined && mc && mc > 0 ? `${((liq / mc) * 100).toFixed(1)}%` : "—";

const actionStyle = (action: "ENTER" | "WAIT" | "AVOID") => {
  if (action === "ENTER") {
    return { pill: "🟢 ENTER", tag: "🔥 strongest setup found", reasonLabel: "🧠 Thesis" };
  }
  if (action === "WAIT") {
    return { pill: "🟡 WAIT", tag: "👀 interesting, not clean yet", reasonLabel: "🤔 Why wait" };
  }
  return { pill: "⚪ AVOID", tag: "🧊 low priority / noisy", reasonLabel: "🚧 Problem" };
};

const level = (price?: number, mc?: number, mult = 1) => {
  const bits: string[] = [];
  if (price && price > 0) bits.push(smallPrice(price * mult));
  if (mc && mc > 0) bits.push(`MC ${money(mc * mult)}`);
  return bits.length ? bits.join(" / ") : "—";
};

const scoutPlan = (
  decision: Awaited<ReturnType<typeof decideAiScout>>
): string => {
  const i = decision.info;
  const mc = i.marketCap ?? i.fdv;
  const hot5m = (i.change5m ?? 0) > 25;
  const weak1h = (i.change1h ?? 0) < 0;

  if (decision.action === "ENTER") {
    const entryMult = hot5m ? 0.9 : 1;
    const tp1 = decision.chain === "bsc" ? 1.45 : 1.5;
    const tp2 = decision.chain === "solana" ? 2.2 : 2;
    return (
      `🎯 <b>Plan</b>\n` +
      `🟢 Buy zone: ${hot5m ? "prefer pullback near" : "starter valid near"} <b>${level(i.priceUsd, mc, entryMult)}</b>\n` +
      `🔴 Risk line: cut/avoid if it loses <b>${level(i.priceUsd, mc, 0.75)}</b> or 1h sells keep leading\n` +
      `💰 Sells: trim at <b>${level(i.priceUsd, mc, tp1)}</b>, runner near <b>${level(i.priceUsd, mc, tp2)}</b>`
    );
  }

  if (decision.action === "WAIT") {
    return (
      `🎯 <b>Plan</b>\n` +
      `🟡 Buy only if momentum confirms: ${weak1h ? "1h turns green and buys lead sells" : "5m holds green with buys leading sells"}\n` +
      `🟢 Better entry: <b>${level(i.priceUsd, mc, 0.88)}</b> or clean reclaim above <b>${level(i.priceUsd, mc, 1.12)}</b>\n` +
      `🔴 Skip if it breaks below <b>${level(i.priceUsd, mc, 0.72)}</b>`
    );
  }

  return (
    `🎯 <b>Plan</b>\n` +
    `⚪ No buy here. Recheck only if buys overtake sells and price reclaims <b>${level(i.priceUsd, mc, 1.25)}</b>\n` +
    `🔴 Avoid chasing pumps into weak 1h flow or thin liquidity.`
  );
};

const aiScoutBody = (
  decision: Awaited<ReturnType<typeof decideAiScout>>,
  nowMs: number
): string => {
  const i = decision.info;
  const mc = i.marketCap ?? i.fdv;
  const badge = decision.chain === "solana" ? SOLANA_BADGE : NET_BADGE[decision.chain];
  const style = actionStyle(decision.action);
  const notes = [...decision.reasons, ...decision.warnings].slice(0, 5);
  const judgeLine = decision.rulesAction && decision.aiAction && decision.rulesAction !== decision.aiAction
    ? `🧪 Judges: rules=${decision.rulesAction} · ai=${decision.aiAction}`
    : "";

  const rows: [string, string][] = [
    ["Price", smallPrice(i.priceUsd)],
    ["MCap", money(mc)],
    ["FDV", money(i.fdv)],
    ["Liq", money(i.liquidityUsd)],
    ["Liq/MC", liqMcStat(i.liquidityUsd, mc)],
    ["Vol 24h", money(i.volume24h)],
    ["Move", `5m ${delta(i.change5m) || "—"} · 1h ${delta(i.change1h) || "—"} · 24h ${delta(i.change24h) || "—"}`],
    ["Age", age(i.pairCreatedAt, nowMs)],
    ["1h flow", flow(i.buys1h, i.sells1h)]
  ];

  const head = cardHeader({
    pill: `${BRAND} Scout · ${style.pill}`,
    symbol: i.symbol,
    name: i.name,
    meta: [badge, `🌱 ${age(i.pairCreatedAt, nowMs)}`]
  });

  return [
    ...head,
    `<b>Score ${decision.score}/100</b> · ${style.tag}`,
    `${style.reasonLabel}: ${escHtml(decision.aiReason)}`,
    statTable(rows),
    scoutPlan(decision),
    notes.length ? `\n📌 <b>Notes</b>\n- ${notes.map(escHtml).join("\n- ")}` : "",
    judgeLine,
    RULE,
    `<code>${decision.token}</code>`
  ].filter(s => s !== "").join("\n");
};

const aiScoutSeenKey = (chain: AiScoutChain, token: string) =>
  `${chain}:${chain === "solana" ? token : token.toLowerCase()}`;

type AiScoutTradeChain = Extract<NetworkKey, AiScoutChain>;

const isTradeChain = (chain: AiScoutChain): chain is AiScoutTradeChain => chain !== "solana";

const AUTO_EXIT_INTERVAL_MS = 2_000;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Walk an error's message + cause chain into one lowercased string. */
function errChainText(e: any): string {
  const parts: string[] = [];
  for (let cur = e, i = 0; i < 8 && cur; i++, cur = cur.cause) {
    parts.push(String(cur.shortMessage ?? cur.message ?? cur.reason ?? ""));
  }
  return parts.join(" | ").toLowerCase();
}
/**
 * A reverted swap / rejected on-chain call is DETERMINISTIC — the token's contract
 * said no (anti-snipe, whitelist, fee-on-transfer hook, honeypot, insufficient
 * liquidity). Retrying it just wastes gas-sim time and spams. We retry ONLY genuine
 * transient infra failures (RPC drop, timeout, rate-limit, nonce race).
 */
function isDeterministicRevert(e: any): boolean {
  const s = errChainText(e);
  if (!s) return false;
  return /revert|execution reverted|insufficient (output|liquidity|funds|balance|allowance)|honeypot|transfer_from_failed|st[fa]|exceeds|slippage|too little received|k\b|simulat/.test(s);
}
function isTransientErr(e: any): boolean {
  if (isDeterministicRevert(e)) return false;
  const s = errChainText(e);
  return /fetch failed|econnreset|etimedout|timeout|terminated|socket|enotfound|eai_again|429|rate.?limit|503|502|504|nonce|replacement transaction|already known|http request failed|network|connection/.test(s);
}

async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  tries: number,
  baseDelayMs: number,
  onRetry?: (attempt: number, err: unknown) => Promise<void> | void
): Promise<T> {
  let lastErr: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Don't burn retries (and spam alerts) on a deterministic contract revert —
      // it will fail identically every time. Fail fast so the caller can quarantine.
      if (i >= tries || isDeterministicRevert(err)) break;
      await onRetry?.(i, err);
      await sleep(baseDelayMs * i);
    }
  }
  throw lastErr ?? new Error(`${label} failed`);
}

/** Best USD estimate for a trade: token qty × price, else the stable leg. */
const usdEstimate = (
  qty: number | undefined,
  priceUsd: number | undefined,
  quote?: { amount: number; symbol: string }
): number | undefined => {
  if (qty !== undefined && priceUsd && priceUsd > 0) return qty * priceUsd;
  if (quote && STABLE_SYMBOLS.has(quote.symbol)) return quote.amount;
  return undefined;
};

async function main() {
  const store = new Store();

  // Forward references: trader needs watcher's RPC clients.
  let trader!: Trader;

  // viem revert errors are huge; keep notifications short (Telegram caps at 4096).
  const shortErr = (e: any): string => {
    const m = String(e?.shortMessage ?? e?.message ?? e ?? "error").split("\n")[0];
    return m.length > 300 ? m.slice(0, 297) + "…" : m;
  };

  const notifyWith = (api: typeof bot.api, text: string, extra: Record<string, unknown> = {}) =>
    api.sendMessage(APP.adminId, text, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...extra
    }).catch(() => {});
  const notify = (text: string, extra: Record<string, unknown> = {}) =>
    notifyWith(bot.api, text, extra);

  // Lead a fresh alert with the token logo when DexScreener has one and the body
  // fits a photo caption (Telegram caps captions at 1024 chars); otherwise send
  // a plain text card. Falls back to text if the image host hiccups.
  const notifyCard = (
    text: string,
    opts: { imageUrl?: string; reply_markup?: unknown } = {}
  ) => {
    const extra: Record<string, unknown> = opts.reply_markup ? { reply_markup: opts.reply_markup } : {};
    if (opts.imageUrl && text.length <= 1000) {
      return bot.api
        .sendPhoto(APP.adminId, opts.imageUrl, { caption: text, parse_mode: "HTML", ...extra } as any)
        .catch(() => notifyWith(bot.api, text, extra));
    }
    return notifyWith(bot.api, text, extra);
  };

  const quickFor = (net: keyof typeof NETWORKS) => {
    const qa = trader.quoteAsset(net);
    return {
      buyAmounts: qa.isNative ? store.settings.buyPresetsEth : store.settings.buyPresetsUsdc,
      quoteSymbol: qa.symbol,
      sellPcts: store.settings.sellPresets
    };
  };

  const watcher = new WalletWatcher(
    store,
    async trade => {
      const cfg = NETWORKS[trade.network];
      const info = await fetchTokenInfo(trade.network, trade.token);
      // On-chain metadata: decimals to size the trade, symbol as a fallback
      // when DexScreener has nothing for brand-new/unlisted tokens.
      const meta = await trader.tokenMeta(trade.network, trade.token);
      const tokenQty = Number(formatUnits(trade.tokenAmount, meta.decimals));
      const usdValue = usdEstimate(tokenQty, info?.priceUsd, trade.quoteAmount);

      // Track the smart wallet's own cost basis so their sells show PnL.
      const pnlKey = `${trade.network}:${trade.wallet.toLowerCase()}:${trade.token.toLowerCase()}`;
      let walletPnl;
      if (trade.direction === "buy" && usdValue !== undefined) {
        store.recordWalletBuy(pnlKey, tokenQty, usdValue);
      } else if (trade.direction === "sell") {
        walletPnl = store.settleWalletSell(pnlKey, tokenQty, usdValue) ?? undefined;
      }
      store.bumpWalletStats(trade.wallet.toLowerCase(), trade.direction, walletPnl?.pnlUsd);

      const holding = !!store.position(trade.token, trade.network);
      const qa = trader.quoteAsset(trade.network);
      const quick = {
        buyAmounts: qa.isNative ? store.settings.buyPresetsEth : store.settings.buyPresetsUsdc,
        quoteSymbol: qa.symbol,
        sellPcts: store.settings.sellPresets
      };
      await notifyCard(
        buildTradeAlert({
          badge: NET_BADGE[trade.network],
          direction: trade.direction,
          token: trade.token,
          walletLabel: trade.walletLabel,
          txUrl: `${cfg.explorer}/tx/${trade.txHash}`,
          info,
          fallbackSymbol: info ? undefined : meta.symbol,
          tokenQty,
          usdValue,
          quoteAmount: trade.quoteAmount,
          walletPnl,
          nowMs: Date.now()
        }),
        { imageUrl: info?.imageUrl, reply_markup: tradeAlertKeyboard(trade.network, trade.token, info, holding, quick) }
      );

      const s = store.settings;
      if (!s.copyEnabled) return;
      if (trade.direction === "sell" && !s.mirrorSells) return;

      try {
        const res =
          trade.direction === "buy"
            ? await trader.copyBuy(trade.network, trade.token)
            : await trader.sell(trade.network, trade.token, 100);

        let line = buildExecLine({
          direction: res.direction,
          symbol: res.symbol,
          detail: res.detail,
          explorer: NETWORKS[res.network].explorer,
          txHash: res.txHash
        });
        if (res.pnlQuote !== undefined) {
          const sign = res.pnlQuote >= 0 ? "🟢 +" : "🔴 -";
          const digits = res.quoteSymbol === "USDC" ? 2 : 5;
          const pctTxt = res.pnlPct !== undefined ? ` (${delta(res.pnlPct)})` : "";
          line += `\n💰 Realized PnL: <b>${sign}${Math.abs(res.pnlQuote).toFixed(digits)} ${res.quoteSymbol ?? ""}</b>${pctTxt}`;
        }
        await notify(line);
      } catch (err: any) {
        await notify(`⚠️ <b>Copy not placed</b> — ${shortErr(err)}\n<i>Your funds are untouched; only the swap was skipped.</i>`);
      }
    },
    msg => console.error(msg)
  );

  // Solana is watch-only for now: rich alerts, no auto-trading.
  const solWatcher = new SolanaWatcher(
    store,
    async trade => {
      const info = await fetchTokenInfoBySlug(SOLANA.dsSlug, trade.mint);
      const usdValue = usdEstimate(trade.uiAmount, info?.priceUsd, trade.quoteAmount);

      const pnlKey = `solana:${trade.wallet}:${trade.mint}`;
      let walletPnl;
      if (trade.direction === "buy" && usdValue !== undefined) {
        store.recordWalletBuy(pnlKey, trade.uiAmount, usdValue);
      } else if (trade.direction === "sell") {
        walletPnl = store.settleWalletSell(pnlKey, trade.uiAmount, usdValue) ?? undefined;
      }
      store.bumpWalletStats(trade.wallet, trade.direction, walletPnl?.pnlUsd);

      await notify(
        buildTradeAlert({
          badge: SOLANA_BADGE,
          direction: trade.direction,
          token: trade.mint,
          walletLabel: trade.walletLabel,
          txUrl: `${SOLANA.explorer}/tx/${trade.signature}`,
          info,
          tokenQty: trade.uiAmount,
          usdValue,
          quoteAmount: trade.quoteAmount,
          walletPnl,
          nowMs: Date.now()
        }),
        { imageUrl: info?.imageUrl, reply_markup: solAlertKeyboard(trade.mint, info) }
      );
    },
    msg => console.error(msg)
  );

  trader = new Trader(store, watcher);
  const solTrader = new SolTrader(store);
  const bot = createBot(store, trader, solTrader);
  const scoutBot = APP.scoutTelegramToken
    ? createBot(store, trader, solTrader, APP.scoutTelegramToken)
    : null;
  const notifyScout = (text: string, extra: Record<string, unknown> = {}) =>
    notifyWith((scoutBot ?? bot).api, text, extra);
  const notifyScoutDecision = async (
    decision: Awaited<ReturnType<typeof decideAiScout>>,
    text: string,
    extra: Record<string, unknown> = {}
  ) => {
    const api = (scoutBot ?? bot).api;
    const msgKey = `${aiScoutSeenKey(decision.chain, decision.token)}:${decision.action}`;
    const prev = store.scoutMessage(msgKey);
    const payload = {
      parse_mode: "HTML" as const,
      link_preview_options: { is_disabled: true },
      ...extra
    };
    if (prev) {
      try {
        await api.editMessageText(prev.chatId, prev.messageId, text, payload);
        store.setScoutMessage(msgKey, { ...prev, at: Date.now() });
      } catch {
        store.deleteScoutMessage(msgKey);
        const sent = await api.sendMessage(APP.adminId, text, payload).catch(() => null);
        if (sent) store.setScoutMessage(msgKey, { chatId: sent.chat.id, messageId: sent.message_id, at: Date.now() });
      }
    } else {
      const sent = await api.sendMessage(APP.adminId, text, payload).catch(() => null);
      if (sent) store.setScoutMessage(msgKey, { chatId: sent.chat.id, messageId: sent.message_id, at: Date.now() });
    }
    if (scoutBot && decision.action === "ENTER" && decision.aiAction === "ENTER") await notify(text, extra);
  };

  // Rebuild subscriptions whenever wallets or networks change in the UI.
  store.onWalletsChanged = () => {
    watcher.refresh();
    solWatcher.refresh();
  };

  watcher.start();
  solWatcher.start();

  // Take-profit / stop-loss / trailing-SL monitor: poll open positions and
  // auto-sell when unrealized PnL crosses configured thresholds. Off unless
  // armed in settings; runs serially so it never overlaps itself.
  let autoExitBusy = false;
  // Consecutive auto-exit sell failures per position. A rugged/frozen token (e.g.
  // Token-2022 custom error 0x11) can NEVER be sold, so after a few failures we
  // quarantine it — stop retrying, alert once — instead of looping forever.
  const exitFails = new Map<string, number>();
  const MAX_EXIT_FAILS = 4;
  /** True when at least one exit rule can fire. */
  const hasAutoExitRules = (s: typeof store.settings) =>
    s.partialTpEnabled
    || s.takeProfitPct > 0
    || s.stopLossPct > 0
    || s.aiScoutRiskStopPct > 0
    || s.trailingStopPct > 0
    || s.runnerTrailPct > 0;
  setInterval(async () => {
    const s = store.settings;
    if (autoExitBusy) return;
    if (!s.autoExitEnabled || !hasAutoExitRules(s)) return;
    autoExitBusy = true;
    try {
      // Drop ghost peaks/partials from closed trades so they can't poison re-entry.
      store.pruneExitState();
      for (const pos of [...store.positions]) {
        const exitKey = `${pos.network}:${pos.token}`;
        if ((exitFails.get(exitKey) ?? 0) >= MAX_EXIT_FAILS) continue; // quarantined — don't hammer a rug
        const pv = pos.network === "solana"
          ? await solTrader.positionValue(pos.token).catch(() => null)
          : await trader.positionValue(pos.network, pos.token as `0x${string}`).catch(() => null);
        if (!pv || pv.pnlPct === undefined) continue;
        const peak = store.updatePositionPeak(pos.network, pos.token, pv.pnlPct);
        const scoutLive = store.aiScoutRecordForPosition(pos.network, pos.token);
        const tier = store.partialTier(pos.network, pos.token);
        const ladder = s.tpLadder ?? [];

        // Count a failed exit; quarantine + alert ONCE when it can't be sold (rug/frozen).
        // Rate-limits (429) are NOT permanent — never quarantine those; next tick retries.
        const onExitFail = async (err: any, what: string) => {
          const msg = shortErr(err);
          if (/429|rate.?limit|too many requests/i.test(msg)) {
            console.warn(`[auto-exit] ${what} $${pos.symbol} rate-limited — will retry (not quarantined): ${msg}`);
            return;
          }
          const n = (exitFails.get(exitKey) ?? 0) + 1;
          exitFails.set(exitKey, n);
          if (n >= MAX_EXIT_FAILS) {
            await notify(`⛔ <b>$${pos.symbol}</b> can't be sold after ${n} tries — likely <b>rugged / frozen</b>. Auto-exit has stopped retrying it. It stays in /positions; remove it when ready.\n<i>${msg}</i>`);
          } else {
            console.warn(`[auto-exit] ${what} $${pos.symbol} failed (${n}/${MAX_EXIT_FAILS}): ${msg}`);
          }
        };
        // Retries are silent now (no per-attempt Telegram spam) — only the final
        // failure/quarantine notifies.
        const onRetry = async (attempt: number, err: any) => {
          console.warn(`[auto-exit] retry ${attempt} $${pos.symbol}: ${shortErr(err)}`);
        };
        // Solana sells get longer outer backoff — Jupiter free tier 429s need room.
        const doSell = (pct: number) => pos.network === "solana"
          ? withRetry(`auto-exit sell ${pos.symbol}`, () => solTrader.sell(pos.token, pct), 6, 2_000, onRetry)
          : withRetry(`auto-exit sell ${pos.symbol}`, () => trader.sell(pos.network as NetworkKey, pos.token as `0x${string}`, pct), 4, 500, onRetry);
        const pnlLine = (res: { pnlQuote?: number; quoteSymbol?: string; pnlPct?: number }) => {
          if (res.pnlQuote === undefined) return "";
          const sign = res.pnlQuote >= 0 ? "🟢 +" : "🔴 ";
          const digits = res.quoteSymbol === "USDC" ? 2 : 5;
          const pctTxt = res.pnlPct !== undefined ? ` (${res.pnlPct >= 0 ? "+" : ""}${res.pnlPct.toFixed(1)}%)` : "";
          return `\n💰 PnL: ${sign}${res.pnlQuote.toFixed(digits)} ${res.quoteSymbol ?? ""}${pctTxt}`;
        };
        const txLink = (res: any) => "signature" in res
          ? `\n🔎 <a href="${SOLANA.explorer}/tx/${res.signature}">View tx</a>`
          : `\n🔎 <a href="${NETWORKS[res.network as NetworkKey].explorer}/tx/${res.txHash}">View tx</a>`;

        // --- Ladder scale-out: sell a slice INTO STRENGTH at each tier (recoup the
        //     principal early), then ride a cost-free moonbag for the fat tail. ---
        if (s.partialTpEnabled && tier < ladder.length
            && ladder[tier].at > 0 && ladder[tier].sell > 0 && ladder[tier].sell < 100
            && pv.pnlPct >= ladder[tier].at) {
          try {
            const res = await doSell(ladder[tier].sell);
            exitFails.delete(exitKey);
            store.bumpPartialTier(pos.network, pos.token);
            const last = tier + 1 >= ladder.length;
            await notify(`🎯 <b>TP${tier + 1} · +${ladder[tier].at}%</b> — sold ${ladder[tier].sell}% of <b>$${res.symbol}</b>${last ? " · moonbag now rides free 🌙" : " 🪜"}${pnlLine(res)}${txLink(res)}`);
          } catch (err: any) {
            await onExitFail(err, "ladder TP");
          }
          continue; // sold a tier this tick; don't also full-exit
        }

        // Once ANY ladder tier has banked profit, the trade can never go red again:
        // the stop jumps to breakeven (entry). Fully laddered ⇒ ride the wide moonbag
        // trail; partially laddered ⇒ keep the normal trail but with the breakeven floor.
        const banked = ladder.length > 0 && tier > 0;          // at least one TP taken
        const laddered = ladder.length > 0 && tier >= ladder.length; // all tiers done
        // Trail distance in percentage points off best unrealized PnL.
        // Pre-ladder / no-ladder: trailingStopPct. After full ladder: wider runnerTrailPct.
        const trailPts = laddered && s.runnerTrailPct > 0 ? s.runnerTrailPct : s.trailingStopPct;
        // Arm trailing SL only once peak ≥ trail distance so the stop is at entry or
        // better (peak - trail ≥ 0). Fixed SL covers losses before the trail arms.
        // Example: trail 25, peak +80% → stop +55%; sell if PnL falls to +55%.
        const trailArmed = trailPts > 0 && peak >= trailPts;
        const trailStop = peak - trailPts;
        const hitTrail = trailArmed && pv.pnlPct <= trailStop;
        const hitTp = s.takeProfitPct > 0 && pv.pnlPct >= s.takeProfitPct;
        const hitSl = s.stopLossPct > 0 && pv.pnlPct <= -s.stopLossPct;
        const hitAiRisk = !!scoutLive && s.aiScoutRiskStopPct > 0 && pv.pnlPct <= -s.aiScoutRiskStopPct;
        const hitBreakeven = banked && pv.pnlPct <= 0; // after a partial TP, never let it turn into a loss
        if (!hitTp && !hitSl && !hitAiRisk && !hitTrail && !hitBreakeven) continue;
        try {
          // Prefer the most specific reason. Fixed SL wins over trail when both fire
          // deep red (a correctly armed trail should already have exited while green).
          const reason = hitTp
            ? `🎯 Take-profit (+${s.takeProfitPct}%)`
            : hitSl
              ? `🛑 Stop-loss (-${s.stopLossPct}%)`
              : hitTrail
                ? `📉 Trailing SL (−${trailPts}pts off peak ${peak >= 0 ? "+" : ""}${peak.toFixed(1)}% → stop ${trailStop >= 0 ? "+" : ""}${trailStop.toFixed(1)}%)`
                : hitBreakeven
                  ? `💚 Breakeven floor (profit already banked)`
                  : `🧠 AI risk stop (-${s.aiScoutRiskStopPct}%)`;
          const res = await doSell(100);
          exitFails.delete(exitKey);
          // removePosition (inside sell) already clears peak/partials; keep explicit
          // clears as a safety net if the sell path ever leaves the row in place.
          store.clearPositionPeak(pos.network, pos.token);
          store.clearPartialTp(pos.network, pos.token);
          await notify(`${reason} hit — auto-sold <b>$${res.symbol}</b>\n${res.detail}${pnlLine(res)}${txLink(res)}`);
        } catch (err: any) {
          await onExitFail(err, "auto-exit");
        }
      }
    } finally {
      autoExitBusy = false;
    }
  }, AUTO_EXIT_INTERVAL_MS);

  // ---------- Limit / DCA order monitor (DexScreener mark only — never Jupiter) ----------
  // Industry-standard open orders: limit buy when mark ≤ trigger, limit sell when
  // mark ≥ trigger, DCA on interval. Polls every 8s; uses free DexScreener so we
  // never burn Jupiter quota on idle order watching.
  const ORDER_POLL_MS = 8_000;
  let orderBusy = false;
  setInterval(async () => {
    if (orderBusy) return;
    const open = store.openOrders();
    if (!open.length) return;
    orderBusy = true;
    try {
      for (const o of open) {
        // Fresh read — order may have been cancelled mid-loop.
        const cur = store.orderById(o.id);
        if (!cur || cur.status !== "open") continue;

        try {
          if (cur.kind === "dca_buy") {
            const intervalMs = Math.max(1, cur.intervalMin ?? 1) * 60_000;
            const last = cur.lastFillAt ?? 0;
            // First fill after a short arm delay (30s) so user can cancel a mis-type.
            const armed = Date.now() - cur.createdAt >= 30_000;
            const due = !last ? armed : Date.now() - last >= intervalMs;
            if (!due) continue;
            if (!(cur.amount && cur.amount > 0)) continue;
            if (cur.chain === "solana") {
              if (!solTrader.enabled) {
                store.markOrderFailed(cur.id, "Solana trading not configured");
                continue;
              }
              const res = await withRetry(
                `dca buy ${cur.symbol ?? cur.token}`,
                () => solTrader.buy(cur.token, cur.amount!),
                3, 1500
              );
              store.bumpOrderFill(cur.id);
              await notify(
                `📅 <b>DCA fill</b> · <b>$${escHtml(res.symbol)}</b>\n` +
                `${res.detail}\n` +
                `Fills: ${(store.orderById(cur.id)?.fills ?? 0)}` +
                (cur.maxFills ? `/${cur.maxFills}` : "") +
                `\n🔎 <a href="${SOLANA.explorer}/tx/${res.signature}">tx</a>`
              );
            } else {
              const res = await withRetry(
                `dca buy ${cur.symbol ?? cur.token}`,
                () => trader.copyBuy(cur.chain as NetworkKey, cur.token as `0x${string}`, {
                  amount: cur.amount, manual: true
                }),
                3, 800
              );
              store.bumpOrderFill(cur.id);
              await notify(
                `📅 <b>DCA fill</b> · <b>$${escHtml(res.symbol)}</b>\n` +
                `${res.detail}\n` +
                `Fills: ${(store.orderById(cur.id)?.fills ?? 0)}` +
                (cur.maxFills ? `/${cur.maxFills}` : "") +
                `\n🔎 <a href="${NETWORKS[res.network].explorer}/tx/${res.txHash}">tx</a>`
              );
            }
            continue;
          }

          // Limit orders need a mark price from DexScreener.
          const info = cur.chain === "solana"
            ? await fetchTokenInfoBySlug("solana", cur.token)
            : await fetchTokenInfo(cur.chain as NetworkKey, cur.token as `0x${string}`);
          const px = info?.priceUsd;
          if (!px || !(px > 0) || !cur.triggerPrice) continue;

          if (cur.kind === "limit_buy") {
            if (px > cur.triggerPrice) continue; // wait for dip
            if (!(cur.amount && cur.amount > 0)) continue;
            if (cur.chain === "solana") {
              if (!solTrader.enabled) {
                store.markOrderFailed(cur.id, "Solana trading not configured");
                continue;
              }
              const res = await withRetry(
                `limit buy ${cur.symbol ?? cur.token}`,
                () => solTrader.buy(cur.token, cur.amount!),
                3, 1500
              );
              store.bumpOrderFill(cur.id);
              await notify(
                `🎯 <b>Limit BUY filled</b> · <b>$${escHtml(res.symbol)}</b>\n` +
                `Trigger ≤ ${smallPrice(cur.triggerPrice)} · mark ${smallPrice(px)}\n` +
                `${res.detail}\n` +
                `🔎 <a href="${SOLANA.explorer}/tx/${res.signature}">tx</a>`
              );
            } else {
              const res = await withRetry(
                `limit buy ${cur.symbol ?? cur.token}`,
                () => trader.copyBuy(cur.chain as NetworkKey, cur.token as `0x${string}`, {
                  amount: cur.amount, manual: true
                }),
                3, 800
              );
              store.bumpOrderFill(cur.id);
              await notify(
                `🎯 <b>Limit BUY filled</b> · <b>$${escHtml(res.symbol)}</b>\n` +
                `Trigger ≤ ${smallPrice(cur.triggerPrice)} · mark ${smallPrice(px)}\n` +
                `${res.detail}\n` +
                `🔎 <a href="${NETWORKS[res.network].explorer}/tx/${res.txHash}">tx</a>`
              );
            }
          } else if (cur.kind === "limit_sell") {
            if (px < cur.triggerPrice) continue; // wait for pump
            const pct = cur.sellPct ?? 100;
            if (cur.chain === "solana") {
              if (!solTrader.enabled) {
                store.markOrderFailed(cur.id, "Solana trading not configured");
                continue;
              }
              const res = await withRetry(
                `limit sell ${cur.symbol ?? cur.token}`,
                () => solTrader.sell(cur.token, pct),
                4, 2000
              );
              store.bumpOrderFill(cur.id);
              await notify(
                `🎯 <b>Limit SELL filled</b> · <b>$${escHtml(res.symbol)}</b>\n` +
                `Trigger ≥ ${smallPrice(cur.triggerPrice)} · mark ${smallPrice(px)}\n` +
                `Sold ${pct}%\n` +
                `🔎 <a href="${SOLANA.explorer}/tx/${res.signature}">tx</a>`
              );
            } else {
              const res = await withRetry(
                `limit sell ${cur.symbol ?? cur.token}`,
                () => trader.sell(cur.chain as NetworkKey, cur.token as `0x${string}`, pct),
                3, 800
              );
              store.bumpOrderFill(cur.id);
              await notify(
                `🎯 <b>Limit SELL filled</b> · <b>$${escHtml(res.symbol)}</b>\n` +
                `Trigger ≥ ${smallPrice(cur.triggerPrice)} · mark ${smallPrice(px)}\n` +
                `Sold ${pct}%\n` +
                `🔎 <a href="${NETWORKS[res.network].explorer}/tx/${res.txHash}">tx</a>`
              );
            }
          }
        } catch (err: any) {
          const msg = shortErr(err);
          store.markOrderFailed(o.id, msg);
          // Soft: one notify per failure is noisy; only alert on first error or rate-limit free.
          if (!/429|rate.?limit/i.test(msg)) {
            console.warn(`[orders] ${o.kind} ${o.id} failed: ${msg}`);
          }
        }
      }
    } finally {
      orderBusy = false;
    }
  }, ORDER_POLL_MS);

  let aiScoutBusy = false;
  const aiScoutFilters = () => {
    const s = store.settings;
    return {
      source: s.aiScoutSource,
      minScore: s.aiScoutMinScore,
      minMarketCapUsd: s.aiScoutMinMarketCapUsd,
      maxMarketCapUsd: s.aiScoutMaxMarketCapUsd,
      minLiquidityUsd: s.aiScoutMinLiquidityUsd,
      maxLiquidityUsd: s.aiScoutMaxLiquidityUsd,
      maxAgeMin: s.aiScoutMaxAgeMin,
      requirePositiveMomentum: s.aiScoutRequirePositiveMomentum
    };
  };
  setInterval(async () => {
    const s = store.settings;
    if (aiScoutBusy || s.aiScoutMode === "off") return;
    // NB: the daily-cap / cooldown check (canAiScoutTrade) gates only the live
    // BUY below — NOT scouting + alerts. Otherwise one buy silences the Scout
    // for the rest of the UTC day (you stop getting any intel).
    aiScoutBusy = true;
    try {
      const paper = s.aiScoutMode === "paper";
      const candidates = paper
        ? await findAiScoutCandidates(store.aiScoutSeen(), 5, aiScoutFilters())
        : (await findAiScoutCandidates(store.aiScoutSeen(), 1, aiScoutFilters()));
      if (candidates.length === 0) {
        console.log("[aiscout] no candidates after filters");
        return;
      }
      console.log(`[aiscout] ${candidates.length} candidate(s): ${candidates.map(c => `${c.chain}:${c.info.symbol}:${c.score}`).join(", ")}`);
      const learningSummary = store.aiScoutLearningSummary();
      for (const candidate of candidates) {
        if (!candidate) continue;
        // Honeypot gate: drop freezable/seizable Solana tokens BEFORE anything —
        // no decision, no record, no alert, no log. (Catches the Token-2022 /
        // freeze-authority rugs: $SUCK, $0XDEAD, etc.) Marked seen so we never
        // re-check it.
        if (candidate.chain === "solana") {
          const risk = await solTrader.mintHoneypotRisk(candidate.token).catch(() => null);
          if (risk) {
            store.markAiScoutSeen(aiScoutSeenKey("solana", candidate.token));
            continue;
          }
        }
        const decision = await decideAiScout(candidate, learningSummary);
        console.log(
          `[aiscout] final=${decision.action} rules=${decision.rulesAction ?? "n/a"} ` +
          `ai=${decision.aiAction ?? "n/a"} ${decision.chain}:$${decision.info.symbol} ` +
          `score=${decision.score} source=${decision.source}`
        );
        const scoutKey = aiScoutSeenKey(decision.chain, decision.token);
        const scoutMc = decision.info.marketCap ?? decision.info.fdv;
        store.recordAiScoutDecision({
          key: scoutKey,
          chain: decision.chain,
          token: decision.token,
          symbol: decision.info.symbol,
          score: decision.score,
          action: decision.action,
          rulesAction: decision.rulesAction,
          aiAction: decision.aiAction,
          source: decision.source,
          priceUsd: decision.info.priceUsd,
          marketCap: scoutMc,
          liquidityUsd: decision.info.liquidityUsd,
          volume24h: decision.info.volume24h,
          buys1h: decision.info.buys1h,
          sells1h: decision.info.sells1h,
          change5m: decision.info.change5m,
          change1h: decision.info.change1h,
          change24h: decision.info.change24h
        });
        if (decision.aiAction === "ENTER" && decision.action === "ENTER") {
          store.markAiScoutSeen(scoutKey);
        }
        else store.touchAiScout();

        // Leading "heating up" signal: a still-WAIT call whose score is CLIMBING
        // toward ENTER while buyers lead and it hasn't already run far — a chance to
        // catch the move BEFORE the full ENTER confirmation (which fires too late).
        // Alert-only, once per token; we measure whether it pays before automating.
        const rec = store.aiScoutRecordByKey(scoutKey);
        const di = decision.info;
        const heating = decision.action !== "ENTER"
          && !!rec && !rec.heatAlerted && rec.prevScore !== undefined
          && (decision.score - rec.prevScore) >= 8
          && decision.score >= 50
          && (di.buys1h ?? 0) > (di.sells1h ?? 0)
          && ((di.change1h ?? 0) > 0 || (di.change5m ?? 0) > 0)
          && (!rec.firstMarketCap || !scoutMc || scoutMc < rec.firstMarketCap * 1.8);

        const body = aiScoutBody(decision, Date.now());
        const reply_markup = decision.chain === "solana"
          ? solAlertKeyboard(decision.token, decision.info)
          : tradeAlertKeyboard(
            decision.chain,
            decision.token as `0x${string}`,
            decision.info,
            !!store.position(decision.token as `0x${string}`, decision.chain),
            quickFor(decision.chain)
          );
        const shouldNotifyScout =
          decision.action === "ENTER" ||
          (decision.action === "WAIT" && s.aiScoutNotifyWait) ||
          (decision.action === "AVOID" && s.aiScoutNotifyAvoid);

        // Fresh, always-notifying ⚡ alert (not an edit) so you actually get pinged.
        if (heating) {
          store.markHeatAlerted(scoutKey);
          const badge = decision.chain === "solana" ? "◎" : decision.chain;
          await notifyScout(
            `⚡ <b>HEATING UP</b> — <b>$${di.symbol}</b> ${badge} may be about to flip to ENTER\n` +
            `📈 Score <b>${rec?.prevScore}→${decision.score}</b> · buyers ${di.buys1h ?? 0}/${di.sells1h ?? 0} · 1h ${(di.change1h ?? 0) >= 0 ? "+" : ""}${(di.change1h ?? 0).toFixed(0)}%\n` +
            `<i>Early watch — no auto-buy yet. Tap to scan/ape if you like it.</i>\n<code>${decision.token}</code>`,
            { reply_markup }
          );
          continue;
        }

        if (paper) {
          if (shouldNotifyScout) {
            await notifyScoutDecision(decision, `${body}\n\n📝 <b>Paper mode:</b> no buy placed.`, { reply_markup });
          }
          continue;
        }

        // Buy when the AI confirms ENTER — OR when the AI was simply UNREACHABLE
        // (aiAction n/a) and rules gave a high-conviction ENTER. An AI outage must
        // not silently freeze valid signals (this is the $LIGMA case). A real AI
        // veto (aiAction WAIT/AVOID) is still respected — no buy.
        const HIGH_CONVICTION = 75;
        const aiDown = !decision.aiAction;
        const buyOk = decision.action === "ENTER" && (
          decision.aiAction === "ENTER" ||
          (aiDown && decision.rulesAction === "ENTER" && decision.score >= HIGH_CONVICTION)
        );
        if (!buyOk) {
          // High-conviction veto: rules wanted ENTER but the AI actively said WAIT on
          // a strong setup. We don't auto-buy a veto, but we flag it so you can act
          // manually — these occasionally run (the $BTL/$SPACE case). Always alerts.
          const highConvVeto = decision.action === "WAIT" && decision.rulesAction === "ENTER"
            && decision.aiAction === "WAIT" && decision.score >= 85;
          if (highConvVeto) {
            await notifyScoutDecision(decision, `${body}\n\n👀 <b>High-conviction veto</b> — rules flagged ENTER (score ${decision.score}) but the AI said WAIT, so no auto-buy. Worth an eyeball — these occasionally run hard.`, { reply_markup });
          } else if (shouldNotifyScout) {
            await notifyScoutDecision(decision, body, { reply_markup });
          }
          return;
        }

        if (decision.chain !== "solana" && !NETWORKS[decision.chain].wsUrl) {
          await notifyScoutDecision(decision, `${body}\n\n⛔ Live buy blocked: ${decision.chain.toUpperCase()} RPC is not configured.`, { reply_markup });
          return;
        }

        if (store.positions.length > 0) {
          await notifyScoutDecision(
            decision,
            `${body}\n\n⛔ Live buy blocked: already holding ${store.positions.length} open position(s). Open /positions to sell or remove stale ones.`,
            { reply_markup }
          );
          return;
        }
        if (!s.autoExitEnabled || !hasAutoExitRules(s)) {
          await notifyScoutDecision(decision, `${body}\n\n⛔ Live buy blocked: enable Auto-exit with TP, SL, AI risk SL, or trailing SL first.`, { reply_markup });
          return;
        }
        // Daily cap / cooldown gates the BUY only — the ENTER alert already went
        // out above, so you still see the call, just no auto-buy.
        if (!store.canAiScoutTrade()) {
          await notifyScoutDecision(decision, `${body}\n\n⏳ Entry alert only — daily cap / cooldown reached, no auto-buy. Resets 00:00 UTC.`, { reply_markup });
          return;
        }

        let res: Awaited<ReturnType<typeof solTrader.buy>> | Awaited<ReturnType<typeof trader.copyBuy>>;
        try {
          res = decision.chain === "solana"
            ? await withRetry(
              `AI Scout Sol buy ${decision.info.symbol}`,
              () => solTrader.buy(decision.token, Math.min(Math.max(s.aiScoutBuyUsdc, 0.01), 1)),
              3,
              700,
              async (attempt, err) => { await notifyScout(`↻ AI Scout Sol buy retry ${attempt}/2 for $${decision.info.symbol}: ${shortErr(err)}`); }
            )
            : await withRetry(
              `AI Scout buy ${decision.info.symbol}`,
              () => trader.copyBuy(decision.chain as AiScoutTradeChain, decision.token as `0x${string}`, {
                amount: Math.min(Math.max(s.aiScoutBuyUsdc, 0.01), 1),
                quote: "USDC"
              }),
              3,
              700,
              async (attempt, err) => { await notifyScout(`↻ AI Scout buy retry ${attempt}/2 for $${decision.info.symbol}: ${shortErr(err)}`); }
            );
        } catch (buyErr: any) {
          if (isDeterministicRevert(buyErr)) {
            // The token's contract rejected the swap (anti-snipe / honeypot / fee hook /
            // no liquidity). It will fail identically forever — quarantine it so the
            // scout never re-picks it, and alert ONCE instead of spamming every cycle.
            store.markAiScoutSeen(scoutKey);
            await notifyScoutDecision(decision, `${body}\n\n⛔ Auto-buy blocked — <b>$${decision.info.symbol}</b>'s contract rejected the swap (anti-snipe / honeypot / fee-on-transfer / no liquidity). Skipping this token for good. Nothing was spent.`, { reply_markup });
          } else {
            // Transient infra failure — leave the token un-seen so the next scan can
            // retry it cleanly. One alert, no per-attempt spam.
            await notifyScout(`⚠️ AI Scout couldn't buy $${decision.info.symbol} (network hiccup) — will retry on the next scan. ${shortErr(buyErr)}`);
          }
          return;
        }
        store.recordAiScoutTrade();
        store.markAiScoutLiveBought(scoutKey);
        await notifyScoutDecision(
          decision,
          `${body}\n\n✅ AI Scout bought <b>$${res.symbol}</b>\n${res.detail}\n` +
          ("signature" in res
            ? `🔎 <a href="${SOLANA.explorer}/tx/${res.signature}">View tx</a>`
            : `🔎 <a href="${NETWORKS[res.network].explorer}/tx/${res.txHash}">View tx</a>`),
          { reply_markup }
        );
        return;
      }
      return;
    } catch (err: any) {
      await notifyScout(`⚠️ AI Scout error: ${shortErr(err)}`);
    } finally {
      aiScoutBusy = false;
    }
  }, 60_000);

  let aiScoutOutcomeBusy = false;
  setInterval(async () => {
    if (aiScoutOutcomeBusy) return;
    aiScoutOutcomeBusy = true;
    try {
      const now = Date.now();
      const records = store.aiScoutRecords()
        .filter(r => (r.action === "WAIT" || r.action === "ENTER") && now - r.lastAt < 24 * 60 * 60_000)
        .filter(r => !r.lastCheckedAt || now - r.lastCheckedAt > 10 * 60_000)
        .slice(0, 20);
      for (const r of records) {
        const info = r.chain === "solana"
          ? await fetchTokenInfoBySlug("solana", r.token).catch(() => null)
          : await fetchTokenInfo(r.chain, r.token as `0x${string}`).catch(() => null);
        if (!info) continue;
        store.updateAiScoutOutcome(r.key, info.marketCap ?? info.fdv, info.priceUsd);
      }
    } finally {
      aiScoutOutcomeBusy = false;
    }
  }, 5 * 60_000);

  // --- Buy-Spike alerts (alert-only) ---------------------------------------
  // Independent of the AI scout: pings you when a FRESH token's buy pressure is
  // accelerating right now (5m pace outrunning the 1h average). No safety gate,
  // no auto-buy — a pure momentum heads-up. Disable with SPIKE_ALERTS=off.
  const spikeAlertsOn = String(process.env.SPIKE_ALERTS ?? "on").toLowerCase() !== "off";
  if (spikeAlertsOn) {
    const spikeAlerted = new Map<string, number>();      // token -> last alert ms
    const SPIKE_REALERT_MS = 45 * 60_000;                // re-ping a token at most every 45m
    let spikeBusy = false;
    setInterval(async () => {
      if (spikeBusy) return;
      spikeBusy = true;
      try {
        const spikes = await findBuySpikes({ limit: 6 });
        const now = Date.now();
        for (const sp of spikes) {
          const key = `${sp.chain}:${sp.token.toLowerCase()}`;
          if (now - (spikeAlerted.get(key) ?? 0) < SPIKE_REALERT_MS) continue;
          spikeAlerted.set(key, now);   // dedup slot taken even if we drop it below
          // On-chain safety gate: drop Solana mints that can freeze/seize/block
          // your sell (same check the AI scout uses). EVM sellability can't be
          // pre-simulated cheaply here, so it is flagged in the alert instead.
          let safety: string;
          if (sp.chain === "solana") {
            const risk = await solTrader.mintHoneypotRisk(sp.token).catch(() => null);
            if (risk) continue;   // silently skip honeypots (already deduped)
            safety = "\ud83d\udee1 passed freeze/seize check \u00b7 still DYOR";
          } else {
            safety = "\u26a0\ufe0f EVM \u2014 sellability not pre-checked \u00b7 DYOR";
          }
          const badge = sp.chain === "solana" ? "\u25ce" : sp.chain.toUpperCase();
          const ageTxt = sp.ageMin >= 60 ? `${Math.round(sp.ageMin / 60)}h` : `${Math.round(sp.ageMin)}m`;
          const mcTxt = sp.marketCap ? ` \u00b7 MC $${Math.round(sp.marketCap).toLocaleString()}` : "";
          const reply_markup = sp.chain === "solana" ? solAlertKeyboard(sp.token, null) : undefined;
          const text =
            `\ud83d\ude80 <b>BUY SPIKE</b> \u2014 <b>$${escHtml(sp.symbol)}</b> ${badge}\n` +
            `\ud83d\udcc8 5m buys <b>${sp.buys5m}/${sp.sells5m}</b> (${(sp.buyRatio5m * 100).toFixed(0)}% buys) \u00b7 accel <b>${sp.accel.toFixed(1)}\u00d7</b>\n` +
            `\u23f1 1h <b>${sp.buys1h}/${sp.sells1h}</b> \u00b7 5m ${sp.change5m >= 0 ? "+" : ""}${sp.change5m.toFixed(0)}% \u00b7 1h ${sp.change1h >= 0 ? "+" : ""}${sp.change1h.toFixed(0)}%\n` +
            `\ud83d\udca7 liq $${Math.round(sp.liquidityUsd).toLocaleString()}${mcTxt} \u00b7 age ${ageTxt}` +
            (sp.url ? ` \u00b7 <a href="${sp.url}">chart</a>` : "") + `\n` +
            `${safety} \u2014 set an exit.\n` +
            `<code>${sp.token}</code>`;
          await notifyScout(text, reply_markup ? { reply_markup } : {});
        }
        for (const [k, t] of spikeAlerted) if (now - t > 6 * 60 * 60_000) spikeAlerted.delete(k);
      } catch (err: any) {
        console.error(`[spike] scan error: ${shortErr(err)}`);
      } finally {
        spikeBusy = false;
      }
    }, 3 * 60_000);
    console.log("[spike] buy-spike alerts enabled (every 3m, alert-only)");
  }

  console.log(`Trading wallet: ${trader.account.address}`);
  console.log(`Watchers started. Launching Telegram bot${scoutBot ? "s" : ""}…`);
  if (scoutBot) await Promise.all([bot.start(), scoutBot.start()]);
  else await bot.start();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
