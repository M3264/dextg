# Smart Wallets Copy Trader

Self-hosted copy-trading bot for **Base**, **Ethereum** and **BSC** (plus
**Solana** watch-only) with a Telegram control panel. No middleman fees: you
pay only network gas (sub-cent on Base) and the DEX swap fee.

## Features

- 👁 Watches your list of smart wallets in real time over WebSocket log
  subscriptions (cheap on RPC quota)
- 🔁 Mirrors their buys/sells from your own wallet via Uniswap V3 — with your
  own buy size, never the smart wallet's
- 💱 Trade Base with ETH **or native USDC** (toggle in Settings)
- ◎ Solana wallets: rich watch-only alerts (trading planned)
- 🤖 Telegram bot, everything tap-driven:
  - Rich alerts: price, MC, liquidity, volume, 1H buys/sells, age, socials
  - Buy / Buy 2× / ✏️ Buy custom amount buttons on every alert
  - Tap any settings value, then just reply with the new one
  - Per-wallet pause/resume, add/remove, bulk import (EVM + Solana)
  - Positions with Sell 25/50/100% buttons and realized PnL
  - 🚨 Panic sell-all with confirmation
- 🛡 Safety: honeypot heuristic, min-liquidity floor, daily spend cap,
  per-token cooldown, skip-if-holding, gas ceiling, max-buy cap
- 💾 Settings, wallets, and positions persist in `data/store.json`

## Free setup (≈10 minutes)

1. **Telegram bot** – message [@BotFather](https://t.me/BotFather), `/newbot`,
   copy the token. Message [@userinfobot](https://t.me/userinfobot) to get your
   numeric user id.
2. **RPC** – create a free [Alchemy](https://dashboard.alchemy.com) account and
   make apps for the chains you want (Base, Ethereum, BNB). Copy the
   **WebSocket** URLs. BSC and Solana are optional — leave their vars unset to
   skip them.
3. **Wallet** – create a **fresh** wallet for the bot and fund it with a small
   amount of ETH on Base (and mainnet/BNB if you enable them). Export its
   private key.
4. Configure and run:

   ```bash
   cp .env.example .env   # fill in the values
   npm install
   npm run dev
   ```

5. Open your bot in Telegram, send `/start`, add wallets with
   `/add 0xWallet label` or `/import`, then flip **Copy trading: ON**.

## Commands

| Command | Purpose |
| --- | --- |
| `/start` | Open the control panel |
| `/status` `/positions` `/wallets` `/settings` | Jump straight to a panel |
| `/add 0x... label` | Track an EVM wallet |
| `/add SoLAddress label` | Track a Solana wallet (watch-only) |
| `/import` | Track many wallets, one per line |
| `/buy 0xToken [amount] [net]` | Manual buy (default network: base) |
| `/sell 0xToken 50` | Sell a percent of a position |
| `/panic` | Sell 100% of every open position |
| `/setbuy` `/setbuyusdc` `/setmax` `/setslippage` `/setgas` | Trade sizing |
| `/setminliq` `/setcap` `/setcooldown` | Safety rails |
| `/cancel` | Abort a pending input |

Tip: you rarely need the `/set…` commands — tap the value in **Settings** and
reply with the new number.

Bulk import accepts either `/import` followed by one wallet per line, or a plain
multi-line message with one wallet per line. Optional labels can follow each
address; EVM and Solana addresses can be mixed:

```text
/import 0xWallet1 alpha
SoLWallet2 jupiter whale
0xWallet3 smart money
```

## ⚠️ Disclaimer

This is a starting scaffold, not audited financial software. Memecoin copy
trading is high risk: tokens can rug, honeypot checks are heuristics, and the
bot trades with real funds. Start with tiny amounts, keep copy trading OFF
until you have watched notifications for a while, and never use a wallet
holding more than you can lose.

## Roadmap ideas

- Solana trade execution via Jupiter (watch-only today)
- Aerodrome / PancakeSwap / Uniswap V2 routing fallback (V3 only today)
- Proportional position sizing based on the tracked wallet's trade size
- ATH / holder count in alerts (needs a paid Birdeye/Moralis key)
- Mempool (pending tx) watching for faster copies on mainnet
