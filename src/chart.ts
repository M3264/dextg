import type { NetworkKey } from "./config.js";

/**
 * FLUX chart snapshots — GeckoTerminal OHLCV → QuickChart PNG.
 *
 * Visual system: dark desk terminal (not flat GitHub gray). Candles stay the
 * primary read; last/high/low rails, denser header, volume/SMA in chrome.
 * QuickChart financial charts do NOT accept mixed line/bar datasets (400), so
 * overlays that would break the image are intentionally text/annotation only.
 */

export type ChartNetwork = NetworkKey | "solana";

const GECKO_NET: Partial<Record<ChartNetwork, string>> = {
  base: "base",
  ethereum: "eth",
  bsc: "bsc",
  solana: "solana"
};

export type Timeframe = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
export type ChartMode = "price" | "mc";

/** Every timeframe we expose, in tab order. */
export const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h", "4h", "1d"];

export const isTimeframe = (s: string): s is Timeframe =>
  (TIMEFRAMES as string[]).includes(s);

/**
 * GeckoTerminal free OHLCV granularity. Finest candle is 1 minute.
 */
const TF: Record<Timeframe, { unit: "minute" | "hour" | "day"; aggregate: number; limit: number; label: string }> = {
  "1m": { unit: "minute", aggregate: 1, limit: 60, label: "1m · 1h" },
  "5m": { unit: "minute", aggregate: 5, limit: 60, label: "5m · 5h" },
  "15m": { unit: "minute", aggregate: 15, limit: 64, label: "15m · 16h" },
  "1h": { unit: "hour", aggregate: 1, limit: 48, label: "1H · 2d" },
  "4h": { unit: "hour", aggregate: 4, limit: 60, label: "4H · 10d" },
  "1d": { unit: "day", aggregate: 1, limit: 60, label: "1D · 60d" }
};

export const tfLabel = (tf: Timeframe): string => TF[tf].label;

// —— FLUX desk palette ——
const C = {
  bg: "#070b14",
  grid: "rgba(94, 234, 212, 0.055)",
  gridSoft: "rgba(148, 163, 184, 0.065)",
  tick: "#7d8aa5",
  muted: "#94a3b8",
  accent: "#5eead4",
  up: "#22d3a5",
  upBorder: "#34f5c5",
  down: "#f43f5e",
  downBorder: "#fb7185",
  sma: "#a78bfa",
  last: "rgba(94, 234, 212, 0.8)",
  hi: "rgba(148, 163, 184, 0.4)",
  brand: "#64748b"
};

/** Axis label for a candle, scaled to the timeframe (UTC). */
function fmtLabel(sec: number, unit: "minute" | "hour" | "day"): string {
  const d = new Date(sec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const mo = d.getUTCMonth() + 1;
  const da = d.getUTCDate();
  if (unit === "day") return `${mo}/${da}`;
  if (unit === "hour") return `${mo}/${da} ${hh}h`;
  return `${hh}:${mm}`;
}

/** Compact axis numbers for sub-cent prices / big mcaps. */
function fmtAxis(v: number): string {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  if (a >= 1) return v.toPrecision(4);
  if (a >= 0.01) return v.toFixed(4);
  if (a === 0) return "0";
  const exp = Math.floor(Math.log10(a));
  const mant = v / 10 ** exp;
  return `${mant.toFixed(2)}e${exp}`;
}

function fmtMoneyShort(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${n.toFixed(2)}`;
  if (a <= 0) return "$0";
  return `$${n.toPrecision(3)}`;
}

/** token -> top GeckoTerminal pool address, cached (pools rarely change). */
const poolCache = new Map<string, string>();

async function topPool(gnet: string, token: string): Promise<string | null> {
  const ck = `${gnet}:${token.toLowerCase()}`;
  const cached = poolCache.get(ck);
  if (cached) return cached;
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${gnet}/tokens/${token}/pools`,
      { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const pools: any[] = Array.isArray(data?.data) ? data.data : [];
    if (pools.length === 0) return null;
    const best = pools
      .slice()
      .sort((a, b) => Number(b?.attributes?.reserve_in_usd ?? 0) - Number(a?.attributes?.reserve_in_usd ?? 0))[0];
    const addr = best?.attributes?.address;
    if (!addr) return null;
    poolCache.set(ck, addr);
    return addr;
  } catch {
    return null;
  }
}

/** [unixSec, open, high, low, close, volume][] oldest-last, or null. */
async function ohlcv(gnet: string, pool: string, tf: Timeframe): Promise<number[][] | null> {
  const { unit, aggregate, limit } = TF[tf];
  try {
    const res = await fetch(
      `https://api.geckoterminal.com/api/v2/networks/${gnet}/pools/${pool}/ohlcv/${unit}?aggregate=${aggregate}&limit=${limit}`,
      { signal: AbortSignal.timeout(8000), headers: { accept: "application/json" } }
    );
    if (!res.ok) return null;
    const data: any = await res.json();
    const list: number[][] = data?.data?.attributes?.ohlcv_list ?? [];
    if (!Array.isArray(list) || list.length < 2) return null;
    // GeckoTerminal returns newest-first; chart wants oldest-first.
    return list.slice().reverse();
  } catch {
    return null;
  }
}

/** Pre-formatted stats drawn as a colored header onto the chart image itself. */
export interface ChartHeader {
  /** headline value, already formatted (e.g. "$0.0(6)4443" or "MC $1.2M") */
  headline: string;
  /** window/24h change %, drives the headline color (green up / red down) */
  changePct?: number;
  /** gray stat lines under the headline, already formatted */
  stats: string[];
}

export interface ChartOpts {
  mode?: ChartMode;
  /** circulating supply, used to convert price candles into market-cap candles */
  supply?: number;
  /** stats to render in the chart's own header (not the Telegram caption) */
  header?: ChartHeader;
  markers?: {
    at: number;
    direction: "buy" | "sell";
    priceUsd?: number;
    marketCap?: number;
  }[];
}

export interface ChartResult {
  url: string;
  label: string;
  mode: ChartMode;
  /** newest candle close (price, or market cap when mode==="mc") */
  last: number;
  /** % change across the rendered window */
  windowChangePct: number;
}

/** Simple SMA of closes. */
function smaLast(values: number[], period: number): number | null {
  const p = Math.min(period, values.length);
  if (p < 2) return null;
  let sum = 0;
  for (let i = values.length - p; i < values.length; i++) sum += values[i];
  return sum / p;
}

/**
 * Build a QuickChart candlestick PNG URL for a token, in either price or
 * market-cap units. Returns null if no chart data is available.
 */
export async function tokenChartUrl(
  net: ChartNetwork, token: string, tf: Timeframe, symbol: string, opts: ChartOpts = {}
): Promise<ChartResult | null> {
  const gnet = GECKO_NET[net];
  if (!gnet) return null;
  const pool = await topPool(gnet, token);
  if (!pool) return null;
  const candles = await ohlcv(gnet, pool, tf);
  if (!candles) return null;

  // Market-cap mode rescales every price by circulating supply. Falls back to
  // price if we don't know the supply.
  const supply = opts.supply;
  const mode: ChartMode = opts.mode === "mc" && supply && supply > 0 ? "mc" : "price";
  const k = mode === "mc" ? (supply as number) : 1;

  // Clean the series first — bad pool ticks blow out auto-scale.
  const clean = candles
    .map(c => ({
      t: Number(c[0]),
      o: Number(c[1]) * k,
      h: Number(c[2]) * k,
      l: Number(c[3]) * k,
      c: Number(c[4]) * k,
      v: Number(c[5] ?? 0)
    }))
    .filter(p =>
      Number.isFinite(p.t) &&
      [p.o, p.h, p.l, p.c].every(v => Number.isFinite(v) && v > 0) &&
      p.h >= p.l && p.h >= p.o && p.h >= p.c && p.l <= p.o && p.l <= p.c &&
      Number.isFinite(p.v) && p.v >= 0
    );
  if (clean.length < 2) return null;

  // Even category spacing (DexScreener-style) — real timestamps only on labels.
  const labels = clean.map(p => fmtLabel(p.t, TF[tf].unit));
  const ohlc = clean.map((p, i) => ({ x: i, o: p.o, h: p.h, l: p.l, c: p.c }));
  const closes = clean.map(p => p.c);
  const windowVol = clean.reduce((a, p) => a + (p.v || 0), 0);

  const first = ohlc[0].o || ohlc[0].c;
  const last = ohlc[ohlc.length - 1].c;
  const windowChangePct = first > 0 ? ((last - first) / first) * 100 : 0;
  const windowHigh = Math.max(...clean.map(p => p.h));
  const windowLow = Math.min(...clean.map(p => p.l));
  const smaPeriod = clean.length >= 40 ? 20 : clean.length >= 20 ? 10 : 5;
  const smaVal = smaLast(closes, smaPeriod);

  // Robust y-range from the 2nd/98th percentile — flash-wicks clip, body detail wins.
  const vals = ohlc.flatMap(p => [p.o, p.h, p.l, p.c]).sort((a, b) => a - b);
  const q = (f: number) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(f * (vals.length - 1))))];
  const lo = q(0.02), hi = q(0.98);
  const pad = (hi - lo) * 0.1 || hi * 0.1 || 1;
  // Leave a little headroom so the last-price label isn't clipped.
  const yMin = Math.max(0, lo - pad);
  const yMax = hi + pad * 1.15;

  // Trade markers (your fills).
  const markerAnnotations: Record<string, unknown> = {};
  for (const [idx, m] of (opts.markers ?? []).entries()) {
    const sec = Math.floor(m.at / 1000);
    const candleIndex = clean.reduce((best, p, i) =>
      Math.abs(p.t - sec) < Math.abs(clean[best].t - sec) ? i : best, 0);
    const rawValue = mode === "mc"
      ? m.marketCap
      : m.priceUsd ?? (m.marketCap && supply ? m.marketCap / supply : undefined);
    const yValue = rawValue && Number.isFinite(rawValue)
      ? rawValue
      : clean[candleIndex].c;
    if (!Number.isFinite(yValue) || yValue <= 0) continue;
    const buy = m.direction === "buy";
    markerAnnotations[`trade_${idx}`] = {
      type: "label",
      xValue: candleIndex,
      yValue,
      content: [buy ? "▲ BUY" : "▼ SELL"],
      color: "#ffffff",
      backgroundColor: buy ? C.up : C.down,
      borderColor: buy ? C.upBorder : C.downBorder,
      borderWidth: 1,
      borderRadius: 6,
      font: { size: 10, weight: "bold", family: "Sans-Serif" },
      padding: { top: 3, bottom: 3, left: 5, right: 5 },
      xAdjust: 0,
      yAdjust: buy ? 16 : -16
    };
  }

  // Rails: last price (accent) + window high/low (subtle) + SMA (violet).
  const railAnns: Record<string, unknown> = {
    lastPrice: {
      type: "line",
      yMin: last,
      yMax: last,
      borderColor: C.last,
      borderWidth: 1.25,
      borderDash: [6, 4],
      label: {
        display: true,
        content: ` ${fmtAxis(last)} `,
        position: "end",
        backgroundColor: "rgba(7, 11, 20, 0.92)",
        color: C.accent,
        font: { size: 10, weight: "bold", family: "Sans-Serif" },
        padding: 3,
        borderRadius: 3,
        borderColor: C.accent,
        borderWidth: 1
      }
    },
    hiLine: {
      type: "line",
      yMin: windowHigh,
      yMax: windowHigh,
      borderColor: C.hi,
      borderWidth: 1,
      borderDash: [2, 5],
      label: {
        display: true,
        content: `H ${fmtAxis(windowHigh)}`,
        position: "start",
        backgroundColor: "rgba(7, 11, 20, 0.75)",
        color: C.muted,
        font: { size: 9, family: "Sans-Serif" },
        padding: 2,
        borderRadius: 2
      }
    },
    loLine: {
      type: "line",
      yMin: windowLow,
      yMax: windowLow,
      borderColor: C.hi,
      borderWidth: 1,
      borderDash: [2, 5],
      label: {
        display: true,
        content: `L ${fmtAxis(windowLow)}`,
        position: "start",
        backgroundColor: "rgba(7, 11, 20, 0.75)",
        color: C.muted,
        font: { size: 9, family: "Sans-Serif" },
        padding: 2,
        borderRadius: 2
      }
    }
  };
  if (smaVal && smaVal > 0 && smaVal >= yMin && smaVal <= yMax) {
    railAnns.smaLine = {
      type: "line",
      yMin: smaVal,
      yMax: smaVal,
      borderColor: C.sma,
      borderWidth: 1.25,
      borderDash: [4, 3],
      label: {
        display: true,
        content: `SMA${smaPeriod}`,
        position: "start",
        backgroundColor: "rgba(7, 11, 20, 0.8)",
        color: C.sma,
        font: { size: 9, weight: "bold", family: "Sans-Serif" },
        padding: 2,
        borderRadius: 2
      }
    };
  }

  const unitLabel = mode === "mc" ? "MCap" : "Price";
  const chg = opts.header?.changePct ?? windowChangePct;
  const trendUp = chg >= 0;
  const trendColor = trendUp ? C.up : C.down;
  const chgTxt = `${chg >= 0 ? "▲" : "▼"} ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%`;

  const hdr = opts.header;
  // Hero title: ticker · headline · change
  const titleText = hdr
    ? `$${symbol}    ${hdr.headline}    ${chgTxt}`
    : `$${symbol}    ${unitLabel}    ${chgTxt}`;

  // Desk chrome lines under the title.
  const volTxt = windowVol > 0 ? `Vol ${fmtMoneyShort(windowVol)}` : null;
  const winTxt = `Window ${windowChangePct >= 0 ? "+" : ""}${windowChangePct.toFixed(1)}%`;
  const deskLine = [
    "⚡ FLUX",
    unitLabel,
    TF[tf].label,
    winTxt,
    volTxt,
    smaVal ? `SMA${smaPeriod} ${fmtAxis(smaVal)}` : null
  ].filter(Boolean).join("   ·   ");

  const subtitleLines = hdr
    ? [...hdr.stats, deskLine]
    : [deskLine];

  const cfg = {
    type: "candlestick",
    data: {
      labels,
      datasets: [{
        label: `$${symbol}`,
        data: ohlc,
        color: { up: C.up, down: C.down, unchanged: C.muted },
        borderColor: { up: C.upBorder, down: C.downBorder, unchanged: C.muted },
        borderWidth: 1.35
      }]
    },
    options: {
      responsive: false,
      layout: {
        padding: { left: 8, right: 12, top: 6, bottom: 6 }
      },
      plugins: {
        legend: { display: false },
        annotation: {
          annotations: { ...railAnns, ...markerAnnotations }
        },
        title: {
          display: true,
          align: "start",
          text: titleText,
          color: trendColor,
          font: { size: 18, weight: "bold", family: "Sans-Serif" },
          padding: { top: 6, bottom: 3 }
        },
        subtitle: {
          display: true,
          align: "start",
          text: subtitleLines,
          color: C.muted,
          font: { size: 11, family: "Sans-Serif" },
          padding: { bottom: 12 }
        }
      },
      scales: {
        x: {
          type: "category",
          offset: true,
          ticks: {
            color: C.tick,
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 7,
            font: { size: 10, family: "Sans-Serif" }
          },
          grid: { color: C.gridSoft, drawBorder: false },
          border: { display: false }
        },
        y: {
          position: "right",
          min: yMin,
          max: yMax,
          ticks: {
            color: C.tick,
            font: { size: 10, family: "Sans-Serif" },
            maxTicksLimit: 6,
            callback: (v: unknown) => fmtAxis(Number(v))
          },
          grid: { color: C.grid, drawBorder: false },
          border: { display: false }
        }
      }
    }
  };

  // devicePixelRatio=2 keeps candles crisp after Telegram compression.
  const url =
    "https://quickchart.io/chart?v=3&w=880&h=460&devicePixelRatio=2&bkg=" +
    encodeURIComponent(C.bg) +
    "&c=" + encodeURIComponent(JSON.stringify(cfg));
  return { url, label: TF[tf].label, mode, last, windowChangePct };
}
