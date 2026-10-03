import fs from "node:fs";
import path from "node:path";
import type { Address } from "viem";
import type { NetworkKey } from "./config.js";
import type { AiScoutAction, AiScoutChain, AiScoutMode, AiScoutSource } from "./aiscout.js";

export type WalletChain = "evm" | "solana";

export interface TrackedWallet {
  /** 0x… (lowercased) for EVM, base58 (case-sensitive) for Solana */
  address: string;
  label: string;
  enabled: boolean;
  chain: WalletChain;
}

export interface Position {
  token: string;
  symbol: string;
  network: NetworkKey | "solana";
  /** raw token units held, as decimal string */
  amount: string;
  decimals: number;
  /** quote units spent acquiring the current holding (ETH/BNB/USDC), for PnL */
  costQuote?: number;
  /** what costQuote is denominated in, e.g. "ETH" | "USDC" | "BNB" */
  quoteSymbol?: string;
  /** epoch ms the position was opened */
  openedAt?: number;
}

export interface Settings {
  copyEnabled: boolean;
  networks: Record<NetworkKey, boolean>;
  buyAmountEth: number;
  /** buy size when trading Base with USDC */
  buyAmountUsdc: number;
  maxBuyEth: number;
  slippageBps: number;
  mirrorSells: boolean;
  honeypotCheck: boolean;
  gasCeilingGwei: number;
  /** quote asset used for trading on Base */
  baseQuote: "ETH" | "USDC";
  /** skip buys when DexScreener liquidity is below this many USD (0 = off) */
  minLiquidityUsd: number;
  /** hard ceiling on total ETH-equivalent spent on copy buys per UTC day (0 = unlimited) */
  dailySpendCapEth: number;
  /** ignore repeat buy signals for the same token within this many seconds */
  buyCooldownSec: number;
  /** don't copy-buy a token we already hold */
  skipIfHolding: boolean;
  /** quick-buy preset amounts (ETH/native) shown as alert & scanner buttons */
  buyPresetsEth: number[];
  /** quick-buy preset amounts (USDC) shown when the quote asset is USDC */
  buyPresetsUsdc: number[];
  /** quick-sell preset percentages shown as buttons */
  sellPresets: number[];
  /** Solana default manual buy size in SOL */
  solBuyAmount: number;
  /** Solana default manual buy size in USDC */
  solBuyAmountUsdc: number;
  /** quote asset used for Solana swaps */
  solQuote: "SOL" | "USDC";
  /** Solana quick-buy preset amounts in SOL */
  solBuyPresets: number[];
  /** Solana quick-buy preset amounts in USDC */
  solBuyPresetsUsdc: number[];
  /** Solana Jupiter slippage in basis points */
  solSlippageBps: number;
  /** Solana priority fee mode: cheap = no priority fee, normal/ape pay more to land faster */
  solFeeMode: "cheap" | "normal" | "ape";
  /** block Solana swaps if simulated SOL cost exceeds this many SOL (0 = off) */
  solMaxFeeSol: number;
  /** auto-exit a position when unrealized PnL crosses these thresholds */
  autoExitEnabled: boolean;
  /** take-profit trigger in percent (0 = off) */
  takeProfitPct: number;
  /** stop-loss trigger in percent, as a positive number (0 = off) */
  stopLossPct: number;
  /** AI Scout live entries: sell if PnL falls below the alert risk line (positive %, 0 = off) */
  aiScoutRiskStopPct: number;
  /** trailing stop distance from best unrealized PnL, in percentage points (0 = off) */
  trailingStopPct: number;
  /** scale-out: ladder profits as the coin climbs, then ride a free moonbag */
  partialTpEnabled: boolean;
  /** take-profit ladder — at each +gain%, sell this % of the CURRENT holding.
   *  Tuned so the principal is recouped by ~2x, leaving the rest cost-free. */
  tpLadder: { at: number; sell: number }[];
  /** trailing stop (points off peak) for the leftover moonbag after the ladder */
  runnerTrailPct: number;
  /** when an ETH-priced (V4) buy is short on ETH, auto-sell USDC to cover it */
  autoFundFromUsdc: boolean;
  /** default timeframe for chart snapshots: 1m|5m|15m|1h|4h|1d */
  chartTimeframe: string;
  /** plot market cap instead of price on chart snapshots */
  chartByMarketCap: boolean;
  /** autonomous token scout: off = disabled, paper = notify only, live = $1 trades */
  aiScoutMode: AiScoutMode;
  /** where AI Scout discovers candidates */
  aiScoutSource: AiScoutSource;
  /** fixed USDC spend for each AI Scout entry */
  aiScoutBuyUsdc: number;
  /** max AI Scout entries per UTC day */
  aiScoutDailyTrades: number;
  /** minutes before AI Scout may evaluate another token */
  aiScoutCooldownMin: number;
  /** minimum AI Scout score to notify or consider */
  aiScoutMinScore: number;
  /** max market cap in USD for AI Scout candidates (0 = unlimited) */
  aiScoutMaxMarketCapUsd: number;
  /** min market cap in USD for AI Scout candidates (0 = off) */
  aiScoutMinMarketCapUsd: number;
  /** min liquidity in USD for AI Scout candidates (0 = off) */
  aiScoutMinLiquidityUsd: number;
  /** max liquidity in USD for AI Scout candidates (0 = unlimited) */
  aiScoutMaxLiquidityUsd: number;
  /** max token age in minutes for AI Scout candidates (0 = unlimited) */
  aiScoutMaxAgeMin: number;
  /** require both 5m and 1h price change to be positive */
  aiScoutRequirePositiveMomentum: boolean;
  /** send WAIT scout alerts to Telegram */
  aiScoutNotifyWait: boolean;
  /** send AVOID scout alerts to Telegram */
  aiScoutNotifyAvoid: boolean;
}

interface SpendDay {
  /** UTC date key, e.g. "2026-06-12" */
  date: string;
  spentEth: number;
}

/** What a tracked wallet has bought (that we saw), to estimate their PnL. */
interface WalletTradeRecord {
  /** UI token amount attributed to observed buys */
  amount: number;
  /** USD cost of that amount at buy time */
  costUsd: number;
  /** last touch, for pruning */
  at: number;
}

/** Lifetime performance of a tracked wallet, from the trades we observed. */
export interface WalletStats {
  buys: number;
  sells: number;
  /** realized PnL (USD) across the sells we could price */
  pnlUsd: number;
  wins: number;
  losses: number;
  /** epoch ms of the last trade seen */
  lastAt: number;
}

/** Our own realized copy-trade PnL, per quote symbol (ETH / USDC / BNB). */
export interface MyPnl {
  pnl: number;
  trades: number;
  wins: number;
}

export interface MyTradeMark {
  token: string;
  network: NetworkKey | "solana";
  direction: "buy" | "sell";
  at: number;
  /** USD price per token at execution, when known */
  priceUsd?: number;
  /** market cap at execution, when known */
  marketCap?: number;
  txHash: string;
}

export interface AiScoutRecord {
  key: string;
  chain: AiScoutChain;
  token: string;
  symbol: string;
  firstAt: number;
  lastAt: number;
  lastCheckedAt?: number;
  score: number;
  action: AiScoutAction;
  rulesAction?: AiScoutAction;
  aiAction?: AiScoutAction;
  source: "rules" | "openai";
  priceUsd?: number;
  marketCap?: number;
  liquidityUsd?: number;
  volume24h?: number;
  buys1h?: number;
  sells1h?: number;
  change5m?: number;
  change1h?: number;
  change24h?: number;
  firstMarketCap?: number;
  /** MC at the moment the call first became ENTER — the realistic entry reference.
   *  `maxMovePct` is measured from THIS (not first-sighting), so the edge reflects
   *  what you'd actually capture buying at ENTER, not from discovery. */
  entryMarketCap?: number;
  lastMarketCap?: number;
  maxMarketCap?: number;
  /** lowest MC seen since the call — for max drawdown / "how far it dipped" */
  minMarketCap?: number;
  maxMovePct?: number;
  checks: number;
  sent: number;
  entered: number;
  liveBought: number;
  success: boolean;
  /** score at the PREVIOUS re-check — lets us detect a WAIT whose score is climbing
   *  toward ENTER (a leading "heating up" signal). */
  prevScore?: number;
  /** true once we've sent the one-time "heating up" alert for this token. */
  heatAlerted?: boolean;
}

export interface ScoutMessageRef {
  chatId: number;
  messageId: number;
  at: number;
}

interface DB {
  settings: Settings;
  wallets: TrackedWallet[];
  positions: Position[];
  spend?: SpendDay;
  /** key: `${network}:${wallet}:${token}` */
  walletTrades?: Record<string, WalletTradeRecord>;
  /** key: wallet address (EVM lowercased / Solana base58) */
  walletStats?: Record<string, WalletStats>;
  /** key: quote symbol */
  myPnl?: Record<string, MyPnl>;
  myTrades?: MyTradeMark[];
  aiScout?: {
    date: string;
    trades: number;
    lastAt: number;
    seen: string[];
  };
  aiScoutRecords?: Record<string, AiScoutRecord>;
  /** key: `${network}:${token}` -> highest observed pnl %, for trailing stops */
  positionPeaks?: Record<string, number>;
  /** key: `${network}:${token}` -> how many take-profit ladder tiers have fired */
  positionPartials?: Record<string, number>;
  /** key: `${chain}:${token}:${action}` */
  scoutMessages?: Record<string, ScoutMessageRef>;
  /** User pin-list for quick re-open (Trojan/BONK-style watchlist). */
  watchlist?: WatchItem[];
  /** Limit / DCA open orders (persisted; monitor fills them). */
  orders?: OpenOrder[];
}

/** A pinned token for the watchlist panel. */
export interface WatchItem {
  chain: "base" | "ethereum" | "bsc" | "solana";
  token: string;
  symbol?: string;
  addedAt: number;
}

/** Chain key for open orders (mirrors position network keys). */
export type OrderChain = NetworkKey | "solana";

/**
 * Trojan/BONK-style open orders:
 * - limit_buy: buy `amount` quote when mark price ≤ triggerPrice
 * - limit_sell: sell `sellPct` when mark price ≥ triggerPrice
 * - dca_buy: buy `amount` every `intervalMin` minutes, up to `maxFills`
 * Mark price always comes from DexScreener — never Jupiter (no 429 risk).
 */
export type OrderKind = "limit_buy" | "limit_sell" | "dca_buy";
export type OrderStatus = "open" | "filled" | "cancelled" | "failed";

export interface OpenOrder {
  id: string;
  kind: OrderKind;
  chain: OrderChain;
  token: string;
  symbol?: string;
  /** Quote units to spend on buy legs (SOL/ETH/BNB/USDC). */
  amount?: number;
  /** Sell percent of holding (1–100). */
  sellPct?: number;
  /** USD trigger price for limit orders. */
  triggerPrice?: number;
  /** DCA interval in minutes. */
  intervalMin?: number;
  /** DCA max fills; 0 = keep going until cancelled (capped per-day in monitor). */
  maxFills?: number;
  fills: number;
  lastFillAt?: number;
  createdAt: number;
  status: OrderStatus;
  lastError?: string;
}

const DEFAULTS: DB = {
  settings: {
    copyEnabled: false, // start OFF: arm it explicitly from Telegram
    networks: { base: true, ethereum: false, bsc: false },
    buyAmountEth: 0.005,
    buyAmountUsdc: 10,
    maxBuyEth: 0.02,
    slippageBps: 300, // 3%
    mirrorSells: true,
    honeypotCheck: true,
    gasCeilingGwei: 30,
    baseQuote: "ETH",
    minLiquidityUsd: 5000,
    dailySpendCapEth: 0.1,
    buyCooldownSec: 60,
    skipIfHolding: true,
    buyPresetsEth: [0.01, 0.05, 0.1],
    buyPresetsUsdc: [10, 25, 50],
    sellPresets: [25, 50, 100],
    solBuyAmount: 0.005,
    solBuyAmountUsdc: 1,
    solQuote: "SOL",
    solBuyPresets: [0.005, 0.01, 0.02],
    solBuyPresetsUsdc: [1, 2, 5],
    solSlippageBps: 300,
    solFeeMode: "cheap",
    // Headroom for Jupiter route fees + ATA rent-adjacent costs. "ape" priority
    // alone is small, but multi-hop routes often burn ~0.001–0.005 SOL non-rent.
    solMaxFeeSol: 0.01,
    autoExitEnabled: false,
    takeProfitPct: 0,
    stopLossPct: 0,
    aiScoutRiskStopPct: 25,
    trailingStopPct: 0,
    partialTpEnabled: false,
    tpLadder: [{ at: 50, sell: 25 }, { at: 120, sell: 35 }, { at: 300, sell: 50 }],
    runnerTrailPct: 70,
    autoFundFromUsdc: true,
    chartTimeframe: "1h",
    chartByMarketCap: false,
    aiScoutMode: "off",
    aiScoutSource: "profiles",
    aiScoutBuyUsdc: 1,
    aiScoutDailyTrades: 5,
    aiScoutCooldownMin: 10,
    aiScoutMinScore: 45,
    aiScoutMaxMarketCapUsd: 300_000,
    aiScoutMinMarketCapUsd: 0,
    aiScoutMinLiquidityUsd: 5_000,
    aiScoutMaxLiquidityUsd: 0,
    aiScoutMaxAgeMin: 24 * 60,
    aiScoutRequirePositiveMomentum: false,
    aiScoutNotifyWait: true,
    aiScoutNotifyAvoid: false
  },
  wallets: [],
  positions: []
};

const SOLANA_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const isSolanaAddress = (s: string): boolean =>
  SOLANA_ADDR.test(s) && !s.startsWith("0x");

/** Canonical stored form: EVM lowercased, Solana untouched (base58 is case-sensitive). */
const canonical = (address: string, chain: WalletChain): string =>
  chain === "evm" ? address.toLowerCase() : address;

const FILE = path.join(process.cwd(), "data", "store.json");

export class Store {
  private db: DB;
  /** invoked after wallet/network changes so watchers can re-subscribe */
  onWalletsChanged: () => void = () => {};

  constructor() {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    if (fs.existsSync(FILE)) {
      const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<DB>;
      this.db = {
        settings: {
          ...DEFAULTS.settings,
          ...raw.settings,
          // deep-merge so newly added networks get their default
          networks: { ...DEFAULTS.settings.networks, ...raw.settings?.networks }
        },
        // wallets saved before the chain field existed are EVM
        wallets: (raw.wallets ?? []).map(w => ({ ...w, chain: w.chain ?? "evm" })),
        positions: raw.positions ?? [],
        spend: raw.spend,
        walletTrades: raw.walletTrades ?? {},
        walletStats: raw.walletStats ?? {},
        myPnl: raw.myPnl ?? {},
        myTrades: raw.myTrades ?? [],
        aiScout: raw.aiScout ?? { date: this.todayKey(), trades: 0, lastAt: 0, seen: [] },
        aiScoutRecords: raw.aiScoutRecords ?? {},
        positionPeaks: raw.positionPeaks ?? {},
        positionPartials: raw.positionPartials ?? {},
        scoutMessages: raw.scoutMessages ?? {},
        watchlist: raw.watchlist ?? [],
        orders: raw.orders ?? []
      };
    } else {
      this.db = structuredClone(DEFAULTS);
      this.save();
    }
  }

  private save() {
    fs.writeFileSync(FILE, JSON.stringify(this.db, null, 2));
  }

  get settings(): Settings {
    return this.db.settings;
  }

  updateSettings(patch: Partial<Settings>) {
    Object.assign(this.db.settings, patch);
    this.save();
  }

  // ---------- watchlist (pin tokens for one-tap re-scan) ----------

  get watchlist(): WatchItem[] {
    return this.db.watchlist ?? [];
  }

  isWatched(chain: WatchItem["chain"], token: string): boolean {
    const t = chain === "solana" ? token : token.toLowerCase();
    return (this.db.watchlist ?? []).some(
      w => w.chain === chain && (chain === "solana" ? w.token === t : w.token.toLowerCase() === t)
    );
  }

  addWatch(item: Omit<WatchItem, "addedAt"> & { addedAt?: number }): boolean {
    const list = (this.db.watchlist ??= []);
    const token = item.chain === "solana" ? item.token : item.token.toLowerCase();
    if (list.some(w => w.chain === item.chain && (item.chain === "solana" ? w.token === token : w.token.toLowerCase() === token))) {
      return false;
    }
    // Cap at 12 — keeps the Telegram panel readable (BONK/Trojan style density).
    if (list.length >= 12) list.shift();
    list.push({ chain: item.chain, token, symbol: item.symbol, addedAt: item.addedAt ?? Date.now() });
    this.save();
    return true;
  }

  removeWatch(chain: WatchItem["chain"], token: string): boolean {
    const list = this.db.watchlist ?? [];
    const t = chain === "solana" ? token : token.toLowerCase();
    const next = list.filter(
      w => !(w.chain === chain && (chain === "solana" ? w.token === t : w.token.toLowerCase() === t))
    );
    if (next.length === list.length) return false;
    this.db.watchlist = next;
    this.save();
    return true;
  }

  toggleNetwork(net: NetworkKey) {
    this.db.settings.networks[net] = !this.db.settings.networks[net];
    this.save();
    this.onWalletsChanged();
  }

  get wallets(): TrackedWallet[] {
    return this.db.wallets;
  }

  walletsByChain(chain: WalletChain): TrackedWallet[] {
    return this.db.wallets.filter(w => w.chain === chain);
  }

  addWallet(address: string, label: string, chain: WalletChain = "evm") {
    const a = canonical(address, chain);
    if (this.db.wallets.some(w => w.address === a)) return false;
    this.db.wallets.push({ address: a, label, enabled: true, chain });
    this.save();
    this.onWalletsChanged();
    return true;
  }

  removeWallet(address: string) {
    this.db.wallets = this.db.wallets.filter(
      w => w.address !== address && w.address !== address.toLowerCase()
    );
    this.save();
    this.onWalletsChanged();
  }

  toggleWallet(address: string) {
    const w = this.db.wallets.find(
      w => w.address === address || w.address === address.toLowerCase()
    );
    if (w) {
      w.enabled = !w.enabled;
      this.save();
      this.onWalletsChanged();
    }
  }

  isTracked(address: string): boolean {
    return this.db.wallets.some(
      w => w.enabled &&
        (w.address === address || (w.chain === "evm" && w.address === address.toLowerCase()))
    );
  }

  get positions(): Position[] {
    return this.db.positions;
  }

  position(token: string, network: NetworkKey | "solana"): Position | undefined {
    const t = network === "solana" ? token : token.toLowerCase();
    return this.db.positions.find(
      p => (network === "solana" ? p.token : p.token.toLowerCase()) === t && p.network === network
    );
  }

  upsertPosition(p: Position) {
    const i = this.db.positions.findIndex(
      x => (p.network === "solana" ? x.token : x.token.toLowerCase()) === (p.network === "solana" ? p.token : p.token.toLowerCase()) && x.network === p.network
    );
    if (i >= 0) {
      this.db.positions[i] = p;
    } else {
      // Fresh open: wipe any stale trail/ladder state from a prior trade on this token.
      // Without this, an old peak makes trailing SL fire immediately on re-entry.
      const key = this.posKey(p.network, p.token);
      if (this.db.positionPeaks) delete this.db.positionPeaks[key];
      if (this.db.positionPartials) delete this.db.positionPartials[key];
      this.db.positions.push(p);
    }
    this.save();
  }

  removePosition(token: string, network: NetworkKey | "solana") {
    const t = network === "solana" ? token : token.toLowerCase();
    this.db.positions = this.db.positions.filter(
      p => !((network === "solana" ? p.token : p.token.toLowerCase()) === t && p.network === network)
    );
    // Always clear trail peak + ladder progress with the position (manual sell,
    // panic, auto-exit, or UI remove). Re-entry must start from a clean peak.
    const key = this.posKey(network, token);
    if (this.db.positionPeaks) delete this.db.positionPeaks[key];
    if (this.db.positionPartials) delete this.db.positionPartials[key];
    this.save();
  }

  // ---------- daily spend cap ----------

  /** UTC day key without relying on locale formatting. */
  private todayKey(now = new Date()): string {
    return now.toISOString().slice(0, 10);
  }

  /** ETH-equivalent already spent on copy buys during the current UTC day. */
  spentToday(): number {
    const today = this.todayKey();
    if (this.db.spend?.date === today) return this.db.spend.spentEth;
    return 0;
  }

  /** True if spending `eth` more would stay within the daily cap (0 = no cap). */
  canSpend(eth: number): boolean {
    const cap = this.db.settings.dailySpendCapEth;
    if (!cap || cap <= 0) return true;
    return this.spentToday() + eth <= cap + 1e-12;
  }

  recordSpend(eth: number) {
    const today = this.todayKey();
    if (this.db.spend?.date === today) this.db.spend.spentEth += eth;
    else this.db.spend = { date: today, spentEth: eth };
    this.save();
  }

  // ---------- tracked-wallet PnL (their trades, observed by us) ----------

  /** Remember what a tracked wallet paid (USD) for tokens we watched it buy. */
  recordWalletBuy(key: string, uiAmount: number, usd: number) {
    if (!(uiAmount > 0) || !(usd > 0)) return;
    const trades = (this.db.walletTrades ??= {});
    const r = trades[key] ?? { amount: 0, costUsd: 0, at: 0 };
    r.amount += uiAmount;
    r.costUsd += usd;
    r.at = Date.now();
    trades[key] = r;
    this.pruneWalletTrades(trades);
    this.save();
  }

  /**
   * Settle a tracked wallet's sell against its recorded cost basis.
   * Returns their realized PnL, or null when we never saw the buy (entered
   * before tracking started) or can't price the sale.
   */
  settleWalletSell(
    key: string, uiAmount: number, proceedsUsd?: number
  ): { pnlUsd: number; pnlPct?: number } | null {
    const trades = this.db.walletTrades ?? {};
    const r = trades[key];
    if (!r || r.amount <= 0) return null;

    const fraction = Math.min(1, uiAmount / r.amount);
    const cost = r.costUsd * fraction;
    r.amount -= Math.min(uiAmount, r.amount);
    r.costUsd -= cost;
    r.at = Date.now();
    if (r.amount <= 1e-9) delete trades[key];
    this.save();

    if (proceedsUsd === undefined) return null;
    const pnlUsd = proceedsUsd - cost;
    return {
      pnlUsd,
      pnlPct: cost > 0 ? (pnlUsd / cost) * 100 : undefined
    };
  }

  /** Keep the trade history bounded: drop the stalest entries beyond 300. */
  private pruneWalletTrades(trades: Record<string, WalletTradeRecord>) {
    const keys = Object.keys(trades);
    if (keys.length <= 300) return;
    keys
      .sort((a, b) => trades[a].at - trades[b].at)
      .slice(0, keys.length - 300)
      .forEach(k => delete trades[k]);
  }

  // ---------- per-wallet performance + our own PnL ----------

  statsFor(address: string): WalletStats | undefined {
    return this.db.walletStats?.[address];
  }

  /** Count an observed trade towards the tracked wallet's lifetime stats. */
  bumpWalletStats(address: string, direction: "buy" | "sell", pnlUsd?: number) {
    const all = (this.db.walletStats ??= {});
    const s = all[address] ?? { buys: 0, sells: 0, pnlUsd: 0, wins: 0, losses: 0, lastAt: 0 };
    if (direction === "buy") s.buys += 1;
    else s.sells += 1;
    if (pnlUsd !== undefined) {
      s.pnlUsd += pnlUsd;
      if (pnlUsd >= 0) s.wins += 1;
      else s.losses += 1;
    }
    s.lastAt = Date.now();
    all[address] = s;
    this.save();
  }

  get myPnl(): Record<string, MyPnl> {
    return this.db.myPnl ?? {};
  }

  /** Accumulate our own realized copy-trade PnL, per quote symbol. */
  recordMyPnl(quoteSymbol: string, pnlQuote: number) {
    const all = (this.db.myPnl ??= {});
    const r = all[quoteSymbol] ?? { pnl: 0, trades: 0, wins: 0 };
    r.pnl += pnlQuote;
    r.trades += 1;
    if (pnlQuote >= 0) r.wins += 1;
    all[quoteSymbol] = r;
    this.save();
  }

  /** Most recent self trades (buy/sell), newest first. */
  recentMyTrades(limit = 5): MyTradeMark[] {
    return [...(this.db.myTrades ?? [])]
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  }

  recordMyTrade(mark: MyTradeMark) {
    const all = (this.db.myTrades ??= []);
    all.push(mark);
    this.db.myTrades = all
      .slice()
      .sort((a, b) => b.at - a.at)
      .slice(0, 500);
    this.save();
  }

  myTradesFor(token: string, network: NetworkKey | "solana"): MyTradeMark[] {
    const t = network === "solana" ? token : token.toLowerCase();
    return (this.db.myTrades ?? [])
      .filter(x => x.network === network && (network === "solana" ? x.token : x.token.toLowerCase()) === t)
      .sort((a, b) => a.at - b.at);
  }

  // ---------- Open orders (limit / DCA) ----------

  get orders(): OpenOrder[] {
    return this.db.orders ?? [];
  }

  openOrders(): OpenOrder[] {
    return this.orders.filter(o => o.status === "open");
  }

  orderById(id: string): OpenOrder | undefined {
    return this.orders.find(o => o.id === id);
  }

  addOrder(input: Omit<OpenOrder, "id" | "fills" | "createdAt" | "status"> & {
    id?: string;
    fills?: number;
    createdAt?: number;
    status?: OrderStatus;
  }): OpenOrder | string {
    const list = (this.db.orders ??= []);
    const open = list.filter(o => o.status === "open");
    if (open.length >= 25) return "Max 25 open orders — cancel one first.";
    const token = input.chain === "solana" ? input.token : input.token.toLowerCase();
    const order: OpenOrder = {
      id: input.id ?? `o${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind: input.kind,
      chain: input.chain,
      token,
      symbol: input.symbol,
      amount: input.amount,
      sellPct: input.sellPct,
      triggerPrice: input.triggerPrice,
      intervalMin: input.intervalMin,
      maxFills: input.maxFills,
      fills: input.fills ?? 0,
      lastFillAt: input.lastFillAt,
      createdAt: input.createdAt ?? Date.now(),
      status: input.status ?? "open",
      lastError: input.lastError
    };
    // light validation
    if (order.kind === "limit_buy") {
      if (!(order.amount && order.amount > 0)) return "Limit buy needs a positive amount.";
      if (!(order.triggerPrice && order.triggerPrice > 0)) return "Limit buy needs a trigger price.";
    } else if (order.kind === "limit_sell") {
      if (!(order.sellPct && order.sellPct > 0 && order.sellPct <= 100)) return "Limit sell needs sell % 1–100.";
      if (!(order.triggerPrice && order.triggerPrice > 0)) return "Limit sell needs a trigger price.";
    } else if (order.kind === "dca_buy") {
      if (!(order.amount && order.amount > 0)) return "DCA needs a positive amount.";
      if (!(order.intervalMin && order.intervalMin >= 1)) return "DCA interval must be ≥ 1 min.";
    }
    list.push(order);
    // Keep history bounded
    if (list.length > 200) {
      const closed = list.filter(o => o.status !== "open").sort((a, b) => a.createdAt - b.createdAt);
      while (list.length > 200 && closed.length) {
        const drop = closed.shift()!;
        const i = list.findIndex(o => o.id === drop.id);
        if (i >= 0) list.splice(i, 1);
      }
    }
    this.save();
    return order;
  }

  updateOrder(id: string, patch: Partial<OpenOrder>): OpenOrder | undefined {
    const o = this.orderById(id);
    if (!o) return undefined;
    Object.assign(o, patch);
    this.save();
    return o;
  }

  cancelOrder(id: string): boolean {
    const o = this.orderById(id);
    if (!o || o.status !== "open") return false;
    o.status = "cancelled";
    this.save();
    return true;
  }

  cancelAllOrders(): number {
    let n = 0;
    for (const o of this.orders) {
      if (o.status === "open") {
        o.status = "cancelled";
        n++;
      }
    }
    if (n) this.save();
    return n;
  }

  bumpOrderFill(id: string): OpenOrder | undefined {
    const o = this.orderById(id);
    if (!o) return undefined;
    o.fills += 1;
    o.lastFillAt = Date.now();
    o.lastError = undefined;
    if (o.kind === "limit_buy" || o.kind === "limit_sell") {
      o.status = "filled";
    } else if (o.kind === "dca_buy") {
      const max = o.maxFills ?? 0;
      if (max > 0 && o.fills >= max) o.status = "filled";
    }
    this.save();
    return o;
  }

  markOrderFailed(id: string, err: string) {
    const o = this.orderById(id);
    if (!o) return;
    o.lastError = err.slice(0, 200);
    // Don't auto-kill limit orders on one fail (RPC blip); DCA can retry next interval.
    this.save();
  }

  // ---------- AI Scout ----------

  private aiScoutDay() {
    const today = this.todayKey();
    const state = (this.db.aiScout ??= { date: today, trades: 0, lastAt: 0, seen: [] });
    if (state.date !== today) {
      state.date = today;
      state.trades = 0;
      state.lastAt = 0;
      state.seen = [];
      this.save();
    }
    return state;
  }

  aiScoutSeen(): Set<string> {
    return new Set(this.aiScoutDay().seen);
  }

  markAiScoutSeen(token: string) {
    const state = this.aiScoutDay();
    const [prefix, rest] = token.split(":", 2);
    const t = rest ? `${prefix}:${prefix === "solana" ? rest : rest.toLowerCase()}` : token.toLowerCase();
    state.seen = [t, ...state.seen.filter(x => x !== t)].slice(0, 300);
    // NB: do NOT stamp lastAt here — the cooldown must count from the last actual
    // BUY (recordAiScoutTrade), not from merely seeing/deciding on a token, or
    // every ENTER would instantly fail its own cooldown check.
    this.save();
  }

  touchAiScout() {
    // Intentionally a no-op on the cooldown clock — see markAiScoutSeen. Kept so
    // existing callers don't break; the buy cooldown is owned by recordAiScoutTrade.
    void this.aiScoutDay();
  }

  canAiScoutTrade(): boolean {
    const s = this.db.settings;
    const state = this.aiScoutDay();
    if (s.aiScoutMode === "off") return false;
    if (Date.now() - state.lastAt < s.aiScoutCooldownMin * 60_000) return false;
    return s.aiScoutDailyTrades <= 0 || state.trades < s.aiScoutDailyTrades;
  }

  recordAiScoutTrade() {
    const state = this.aiScoutDay();
    state.trades += 1;
    state.lastAt = Date.now();
    this.save();
  }

  recordAiScoutDecision(input: Omit<AiScoutRecord, "firstAt" | "lastAt" | "checks" | "sent" | "entered" | "liveBought" | "success">) {
    const all = (this.db.aiScoutRecords ??= {});
    const prev = all[input.key];
    const now = Date.now();
    const firstMarketCap = prev?.firstMarketCap ?? input.marketCap;
    // Stamp the entry reference the first time this token becomes an ENTER. Peak/
    // dip are measured from here so the stats reflect a realistic buy, not the
    // (often far lower) first-sighting MC.
    const entryMarketCap = prev?.entryMarketCap ?? (input.action === "ENTER" ? input.marketCap : undefined);
    const maxMarketCap =
      Math.max(prev?.maxMarketCap ?? 0, input.marketCap ?? 0) ||
      prev?.maxMarketCap ||
      input.marketCap;
    const minMarketCap =
      Math.min(prev?.minMarketCap ?? Infinity, input.marketCap ?? Infinity) ||
      prev?.minMarketCap ||
      input.marketCap;
    // Reference = entry (if we ever ENTERed) else first-sighting. So a coin that
    // climbed before triggering ENTER no longer shows an inflated peak %.
    const moveRef = entryMarketCap ?? firstMarketCap;
    const maxMovePct =
      moveRef && maxMarketCap
        ? ((maxMarketCap - moveRef) / moveRef) * 100
        : prev?.maxMovePct;
    all[input.key] = {
      ...prev,
      ...input,
      firstAt: prev?.firstAt ?? now,
      lastAt: now,
      firstMarketCap,
      entryMarketCap,
      lastMarketCap: input.marketCap ?? prev?.lastMarketCap,
      maxMarketCap,
      minMarketCap: Number.isFinite(minMarketCap) ? minMarketCap : undefined,
      maxMovePct,
      checks: (prev?.checks ?? 0) + 1,
      sent: (prev?.sent ?? 0) + 1,
      entered: (prev?.entered ?? 0) + (input.action === "ENTER" ? 1 : 0),
      liveBought: prev?.liveBought ?? 0,
      success: maxMovePct !== undefined && maxMovePct >= 100,
      prevScore: prev?.score, // last check's score, to detect a rising "heating up" trend
      heatAlerted: prev?.heatAlerted ?? false
    };
    this.pruneAiScoutRecords();
    this.save();
  }

  aiScoutRecordByKey(key: string): AiScoutRecord | undefined {
    return this.db.aiScoutRecords?.[key];
  }
  /** One-time flag so the "heating up" alert fires once per token, not every check. */
  markHeatAlerted(key: string) {
    const r = this.db.aiScoutRecords?.[key];
    if (r && !r.heatAlerted) { r.heatAlerted = true; this.save(); }
  }

  aiScoutRecordForPosition(network: NetworkKey | "solana", token: string): AiScoutRecord | undefined {
    const t = network === "solana" ? token : token.toLowerCase();
    return Object.values(this.db.aiScoutRecords ?? {})
      .filter(r => r.chain === network && (network === "solana" ? r.token : r.token.toLowerCase()) === t && (r.liveBought ?? 0) > 0)
      .sort((a, b) => b.lastAt - a.lastAt)[0];
  }

  updateAiScoutOutcome(key: string, marketCap?: number, priceUsd?: number) {
    const r = this.db.aiScoutRecords?.[key];
    if (!r) return;
    r.lastCheckedAt = Date.now();
    if (priceUsd !== undefined) r.priceUsd = priceUsd;
    if (marketCap !== undefined) {
      r.lastMarketCap = marketCap;
      r.maxMarketCap = Math.max(r.maxMarketCap ?? 0, marketCap);
      r.minMarketCap = Math.min(r.minMarketCap ?? marketCap, marketCap);
      const ref = r.entryMarketCap ?? r.firstMarketCap;
      if (ref && r.maxMarketCap) {
        r.maxMovePct = ((r.maxMarketCap - ref) / ref) * 100;
        r.success = r.maxMovePct >= 100;
      }
    }
    this.save();
  }

  markAiScoutLiveBought(key: string) {
    const r = this.db.aiScoutRecords?.[key];
    if (!r) return;
    r.liveBought += 1;
    this.save();
  }

  /**
   * Track the best unrealized PnL % seen for a position (for trailing stops).
   * Only persists when the peak actually rises — the auto-exit loop polls every
   * few seconds and must not rewrite store.json on every tick.
   */
  updatePositionPeak(network: NetworkKey | "solana", token: string, pnlPct: number): number {
    const key = this.posKey(network, token);
    const all = (this.db.positionPeaks ??= {});
    const prev = all[key];
    const next = prev === undefined ? pnlPct : Math.max(prev, pnlPct);
    if (prev === undefined || next > prev) {
      all[key] = next;
      this.save();
    }
    return all[key] ?? next;
  }

  /** Current stored peak PnL % (undefined if never observed). */
  getPositionPeak(network: NetworkKey | "solana", token: string): number | undefined {
    return this.db.positionPeaks?.[this.posKey(network, token)];
  }

  clearPositionPeak(network: NetworkKey | "solana", token: string) {
    const key = this.posKey(network, token);
    if (!this.db.positionPeaks?.[key]) return;
    delete this.db.positionPeaks[key];
    this.save();
  }

  /**
   * Drop peak/partial entries that no longer match an open position.
   * Prevents ghost peaks from closed trades poisoning later re-entries.
   */
  pruneExitState() {
    const open = new Set(this.db.positions.map(p => this.posKey(p.network, p.token)));
    let changed = false;
    for (const map of [this.db.positionPeaks, this.db.positionPartials]) {
      if (!map) continue;
      for (const key of Object.keys(map)) {
        if (!open.has(key)) {
          delete map[key];
          changed = true;
        }
      }
    }
    if (changed) this.save();
  }

  private posKey(network: NetworkKey | "solana", token: string) {
    return `${network}:${network === "solana" ? token : token.toLowerCase()}`;
  }
  /** How many take-profit ladder tiers have already fired for this position. */
  partialTier(network: NetworkKey | "solana", token: string): number {
    return this.db.positionPartials?.[this.posKey(network, token)] ?? 0;
  }
  bumpPartialTier(network: NetworkKey | "solana", token: string) {
    const k = this.posKey(network, token);
    const m = (this.db.positionPartials ??= {});
    m[k] = (m[k] ?? 0) + 1;
    this.save();
  }
  clearPartialTp(network: NetworkKey | "solana", token: string) {
    const key = this.posKey(network, token);
    if (!this.db.positionPartials?.[key]) return;
    delete this.db.positionPartials[key];
    this.save();
  }

  aiScoutRecords(): AiScoutRecord[] {
    return Object.values(this.db.aiScoutRecords ?? {}).sort((a, b) => b.lastAt - a.lastAt);
  }

  aiScoutLearningSummary(): string {
    const rows = this.aiScoutRecords().filter(r => Date.now() - r.lastAt < 72 * 60 * 60_000);
    if (rows.length < 5) return "Not enough local outcome history yet. Use default conservative rules.";

    // --- Data hygiene -------------------------------------------------------
    // maxMovePct is derived from DexScreener market-cap/FDV reads which can be
    // wildly wrong for brand-new pump.fun pairs (we have records showing
    // 3,500,000%). Those fake mega-winners used to dominate the AI's "what
    // worked" evidence. cleanMove() drops impossible values and clamps the rest
    // to a sane ceiling so the summary reflects reality, not bad data.
    const MOVE_CEILING = 1000;            // clamp display/avg to +1000%
    const CORRUPT_ABOVE = 5000;           // treat >5000% as a bad MC read -> ignore
    const cleanMove = (r: AiScoutRecord): number | undefined => {
      const m = r.maxMovePct;
      if (m === undefined || !Number.isFinite(m)) return undefined;
      if (m > CORRUPT_ABOVE) return undefined;
      if (!r.firstMarketCap || r.firstMarketCap <= 0) return undefined;
      return Math.max(-100, Math.min(MOVE_CEILING, m));
    };
    const median = (xs: number[]): number => {
      if (xs.length === 0) return 0;
      const s = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    };
    const isWin = (r: AiScoutRecord): boolean => {
      const m = cleanMove(r);
      return m !== undefined && m >= 100;
    };

    const groups = new Map<string, AiScoutRecord[]>();
    for (const r of rows) {
      for (const key of [`action:${r.action}`, `chain:${r.chain}`, `chain_action:${r.chain}:${r.action}`]) {
        const g = groups.get(key) ?? [];
        g.push(r);
        groups.set(key, g);
      }
    }
    const summarize = (key: string, label: string): string | null => {
      const g = groups.get(key);
      if (!g || g.length < 3) return null;
      const valid = g.map(cleanMove).filter((x): x is number => x !== undefined);
      if (valid.length < 3) return null;
      const success = g.filter(isWin).length;
      // median is robust to the remaining outliers in a way mean never was.
      return `${label}: n=${g.length}, success=${success}/${g.length}, medMaxMove=${median(valid).toFixed(0)}%`;
    };
    const lines = [
      summarize("action:ENTER", "ENTER"),
      summarize("action:WAIT", "WAIT"),
      summarize("action:AVOID", "AVOID"),
      summarize("chain:base", "Base"),
      summarize("chain:solana", "Solana"),
      summarize("chain:bsc", "BSC")
    ].filter((x): x is string => !!x);
    const fmt = (r: AiScoutRecord, tag: string) =>
      `${tag} ${r.chain} $${r.symbol}: ${r.action}, score=${r.score}, maxMove=${(cleanMove(r) ?? 0).toFixed(0)}%, liq=${Math.round(r.liquidityUsd ?? 0)}, 1h=${r.buys1h ?? 0}/${r.sells1h ?? 0}`;
    const winners = rows
      .filter(isWin)
      .sort((a, b) => (cleanMove(b) ?? 0) - (cleanMove(a) ?? 0))
      .slice(0, 3)
      .map(r => fmt(r, "winner"));
    const losers = rows
      .filter(r => (r.action === "ENTER" || r.action === "WAIT") && !isWin(r) && cleanMove(r) !== undefined && Date.now() - r.lastAt > 30 * 60_000)
      .sort((a, b) => (cleanMove(a) ?? 0) - (cleanMove(b) ?? 0))
      .slice(0, 3)
      .map(r => fmt(r, "miss"));
    return [...lines, ...winners, ...losers].slice(0, 12).join(" | ");
  }


  scoutMessage(key: string): ScoutMessageRef | undefined {
    return this.db.scoutMessages?.[key];
  }

  setScoutMessage(key: string, ref: ScoutMessageRef) {
    const all = (this.db.scoutMessages ??= {});
    all[key] = ref;
    this.pruneScoutMessages();
    this.save();
  }

  deleteScoutMessage(key: string) {
    if (!this.db.scoutMessages?.[key]) return;
    delete this.db.scoutMessages[key];
    this.save();
  }

  private pruneAiScoutRecords() {
    const all = this.db.aiScoutRecords ?? {};
    const keys = Object.keys(all);
    if (keys.length <= 500) return;
    keys
      .sort((a, b) => all[a].lastAt - all[b].lastAt)
      .slice(0, keys.length - 500)
      .forEach(k => delete all[k]);
  }

  private pruneScoutMessages() {
    const all = this.db.scoutMessages ?? {};
    const keys = Object.keys(all);
    const cutoff = Date.now() - 48 * 60 * 60_000;
    for (const k of keys) {
      if (all[k].at < cutoff) delete all[k];
    }
    const fresh = Object.keys(all);
    if (fresh.length <= 300) return;
    fresh
      .sort((a, b) => all[a].at - all[b].at)
      .slice(0, fresh.length - 300)
      .forEach(k => delete all[k]);
  }
}
