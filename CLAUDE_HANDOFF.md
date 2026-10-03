# Claude Code Handoff

This repo is a TypeScript Telegram trading/scout bot for Base/EVM, BSC, and Solana.
This file is the repo map for anyone taking over in Claude Code.

## Run / Build

- Dev process: `./node_modules/.bin/pm2 restart ecosystem.config.cjs --update-env`
- PM2 app name: `dextg-bot`
- Typecheck: `npm run typecheck`
- Build: `npm run build`
- Entry point: `src/index.ts`
- Runtime config: `.env` and `data/store.json`

Do not print `.env`; it contains private keys and bot tokens.

## Current AI Scout Provider

- AI Scout is switched back to Freemodel chat completions with `AI_SCOUT_MODEL=gpt-5.5`.
- Relevant env keys:
  - `AI_SCOUT_PROVIDER=chat`
  - `AI_SCOUT_BASE_URL=https://api.freemodel.dev`
  - `AI_SCOUT_MODEL=gpt-5.5`
  - `AI_SCOUT_API_KEY=...`
- Do not paste or log API keys.
- After provider/model changes, restart with `./node_modules/.bin/pm2 restart ecosystem.config.cjs --update-env`.

## Top-Level Files

- `package.json`: npm scripts and dependencies.
- `ecosystem.config.cjs`: PM2 config, runs `tsx src/index.ts`.
- `data/store.json`: persistent bot state: settings, tracked wallets, positions, AI Scout records, PnL, message refs.
- `dist/`: compiled JS output from `npm run build`; source of truth is `src/`.
- `bot.log`: old/local log output.

## Source File Map

- `src/index.ts`
  - Main application wiring.
  - Starts EVM wallet watcher, Solana watcher, Telegram bot(s), AI Scout loop, and auto-exit loop.
  - Sends trade alerts and AI Scout alerts.
  - Important sections:
    - `notifyScoutDecision`: sends Scout alerts to scout bot and, for AI-approved ENTER, to main SmartDex bot.
    - Auto-exit interval: checks positions every `AUTO_EXIT_INTERVAL_MS` (currently 2s), sells on SL/AI-risk/trailing stop, with retries.
    - AI Scout interval: finds candidates, calls `decideAiScout`, optionally live-buys.
  - Change alert wording, ENTER forwarding, live-buy gating, auto-exit timing, and retry behavior here.

- `src/telegram/bot.ts`
  - Telegram commands, inline buttons, settings UI, scan cards, chart cards, PnL cards.
  - Commands include `/scan`, `/chart`, `/positions`, `/pnl`, `/buy`, `/sell`, `/solbuy`, `/solsell`, `/settings`, `/aistats`.
  - PnL cards are intended to be image cards via QuickChart (`showPnlCard`).
  - Sol scan/chart should have feature parity with Base scan/chart.
  - Change menus, settings buttons, callbacks, scan UX, position UX, import-key flow, and command list here.

- `src/aiscout.ts`
  - AI Scout candidate discovery, scoring, rules decision, and AI decision call.
  - Current provider env:
    - `AI_SCOUT_PROVIDER`
    - `AI_SCOUT_BASE_URL`
    - `AI_SCOUT_MODEL`
    - `AI_SCOUT_API_KEY`
  - Current requested model is `gpt-5.5` through Freemodel's OpenAI-compatible chat route.
  - Previous Claude testing was unreliable: `claude-opus-4.8` through chat did not prove it was Claude, and `cc.freemodel.dev` routes were restricted or intermittently returned HTML. Verify before switching back.
  - `ai=n/a` means AI call returned no usable decision and rules fallback was used. Logging was added for HTTP/empty/invalid/parse failures.
  - Change chain strictness, score thresholds, filters, prompt, provider request shape, and rules-vs-AI gate here.

- `src/trader.ts`
  - EVM trading engine.
  - Handles quote assets, route discovery, Uniswap V3/V4/V2-ish routing, buy/sell, recover/sync positions, live position value.
  - Records positions and PnL in `Store`.
  - Has internal retry helpers for route/simulation.
  - Change Base/BSC buy-sell execution, quote routing, approvals, slippage behavior, and EVM position sync here.

- `src/soltrader.ts`
  - Solana trading engine using Jupiter.
  - Handles Solana keypair, SOL/USDC balances, buy/sell, fee preflight, token positions.
  - Uses settings: `solQuote`, `solBuyAmount`, `solBuyAmountUsdc`, `solSlippageBps`, `solFeeMode`, `solMaxFeeSol`.
  - Important practical constraint: new token accounts may require rent around `0.002 SOL`; code separates non-rent fee cap from rent.
  - Change Solana execution, Jupiter quote/swap behavior, fee guards, token-account rent handling, and Solana position sync here.

- `src/watcher.ts`
  - EVM wallet watcher.
  - Subscribes to tracked wallet transfer/swap logs and emits trade events.
  - Uses WebSocket RPCs from `NETWORKS`.

- `src/solwatcher.ts`
  - Solana wallet watcher.
  - Watches Solana tracked wallets and emits buy/sell activity.

- `src/store.ts`
  - Persistent state model and helpers.
  - Settings defaults live here.
  - Stores wallets, positions, spend, wallet stats, realized PnL, trade markers, AI Scout records, message refs, trailing stop peaks.
  - Important methods:
    - `position`, `upsertPosition`, `removePosition`
    - `recordMyPnl`, `recordMyTrade`, `myTradesFor`
    - `recordAiScoutDecision`, `markAiScoutLiveBought`, `aiScoutRecords`
    - `updatePositionPeak`, `clearPositionPeak`
  - Change default settings, persisted data shape, stats aggregation, AI learning summaries, and position removal helpers here.

- `src/tokeninfo.ts`
  - DexScreener/chain token info resolution.
  - Used by scans, charts, Scout, and trade summaries.

- `src/chart.ts`
  - QuickChart/GeckoTerminal chart snapshot generation.
  - Builds candlestick chart URLs and trade markers.
  - Change chart snapshot output and buy/sell markers here.

- `src/format.ts`
  - Telegram HTML formatting helpers for scan cards, trade alerts, money/price/qty/age formatting.

- `src/config.ts`
  - Chain config and env loading.
  - Requires Base/Ethereum env vars; BSC/Solana are optional in parts.
  - Contains `NETWORKS`, `SOLANA`, and `APP`.

- `src/v4.ts`
  - Uniswap V4 helper logic for route/build execution.

- `src/abi.ts`
  - Contract ABI fragments used by EVM trader/watcher.

## Current Behavior / State Notes

- AI Scout mode is live in `data/store.json`.
- Auto-exit is enabled.
- TP was turned off so runners are not capped at +50%.
- Current protection settings at last handoff:
  - Normal SL: `40%`
  - AI risk SL: `25%`
  - Trailing SL: `40%`
  - Auto-exit check interval: `2s`
  - Auto-exit sell retries: 4 total attempts
  - AI Scout buy retries: 3 total attempts
- Live AI buys are blocked if any open position exists. This is intentional safety in `src/index.ts`.
- SmartDex/main bot forwarding should be AI-approved ENTER only:
  - final `decision.action === "ENTER"`
  - and `decision.aiAction === "ENTER"`
  - Rules-only ENTER must stay in Scout only.

## Where To Look First

1. AI Scout too quiet/noisy/wrong action:
   - `src/aiscout.ts` for candidate scoring, filters, prompt, and model call.
   - `src/index.ts` for notification routing, live buy rules, cooldown, and batching.
   - `src/store.ts` for saved settings and learning stats.

2. PnL image cards.
   - `/pnl` and PnL buttons should send actual image cards, not just text.
   - Current implementation uses QuickChart URLs in `src/telegram/bot.ts`.
   - Verify in Telegram that image renders.

3. Open positions block Scout live buys.
   - `data/store.json` had tracked positions including Base/Solana positions.
   - If they are stale, user can remove via `/positions`; do not remove silently.

4. Solana live Scout buys.
   - Solana Scout live buys were added via `solTrader.buy`.
   - Ensure `solQuote` is USDC if the user expects $1 buys.

5. AI `n/a`.
   - Now logs reasons from `src/aiscout.ts`.
   - Check PM2 logs with `./node_modules/.bin/pm2 logs dextg-bot --lines 200 --nostream`.

## Useful Commands

```bash
npm run typecheck
npm run build
./node_modules/.bin/pm2 restart ecosystem.config.cjs --update-env
./node_modules/.bin/pm2 status
./node_modules/.bin/pm2 logs dextg-bot --lines 200 --nostream
```

Process hygiene check the user cares about:

```bash
ps -eo pid,ppid,stat,etime,cmd | rg 'node - <<|getLogs|quoteExact|poolFactories|poolImplementation|factoryRegistry|pm2 logs'
```

## Caution

- Do not expose `.env` values.
- Do not leave background terminals/log tails running.
- Do not remove positions or change trading guards silently.
- For any AI-provider change, run a direct request and confirm the response is actual model JSON, not HTML, Cloudflare, or another model alias.
