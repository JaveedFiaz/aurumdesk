# Aurum Pulse: gold (XAU/USD) intelligence terminal

![Aurum Pulse on demo data](docs/screenshot.png)

A self-hosted gold terminal with an animated dashboard. It finds trade setups,
grades how many independent signals agree with each one, shows what the big
players and the order book are doing, and runs an auto-trader you fund with an
amount of your choice. The auto-trader runs in paper mode today; a live broker
plugs into the same engine later.

## What's on screen

| Panel | What it shows |
|---|---|
| **Chart** | Candles with market structure (BOS/CHoCH), order blocks, supply/demand and 1H zones, liquidity pools, order-book walls, VWAP and volume coloured by buyer/seller aggression. Switch to **TradingView** for their own chart (`OANDA:XAUUSD`). |
| **Best setup** | The highest-graded live setup: direction, entry, stop, target, a 0–100 confluence ring, the checklist of what agrees, and how that grade actually performed in the backtest. |
| **Auto-trader** | Enter an amount, risk per trade and accuracy mode, then press Start. It takes qualifying setups, sizes them, and manages stop and target on every tick. It shows equity, P&L, open trades and activity. |
| **Big players** | CFTC Commitments of Traders for COMEX gold: hedge-fund and bank/producer net positions, weekly change, and a 3-year COT index gauge. |
| **Order flow** | Buyer vs seller aggression on the live tape, delta per candle and cumulative delta (CVD). |
| **Liquidity map** | Order-book ladder with walls highlighted, bid/ask imbalance, and the stop-loss liquidity above and below price (equal highs/lows, previous-day high/low, last liquidity grab). |
| **Whale tape** | The biggest trades (top 2% by size) as they print, with buy/sell share. |
| **Measured accuracy** | Win rate and average R for each grade (A/B/C) and each strategy, from the backtest. |

## Strategies and signals

Only strategies that made money on **two years of real gold data**, in both the
earlier 60% and the most recent 40% of the period, run live
([full results](docs/backtest-results.md)):

| Strategy | Signal | Target | 2-year result |
|---|---|---|---|
| **Zone retest** | 15m and 1H trends agree. The first pullback into a fresh order block or supply/demand zone closes with a rejection candle. | 2R | 45 trades, 44% win, PF 1.58, +13.5R |
| **Volume breakout** | During the London or New York open, a close through a fresh swing high or low on 2x+ average volume, with aggressive buying (selling) in the order flow and the 1H trend behind it. | 3R | 98 trades, 36% win, PF 1.41, +26.5R |

Together that is about 6 signals a month. Over two years they made +38R, with a
worst drawdown of 9.5R and a longest losing streak of 7. Both stayed profitable
at three times the trading cost, for longs and shorts, and in each third of the
period (the first third only just).

Tested and retired, because they lost money or only worked in one half of the
period: VWAP pullback, Sweep + CHoCH, S/R flip, Liquidity absorption,
PDH/PDL reject and 1H zone reject. Re-test them with
`npm run backtest -- --all`.

**On the chart (the "Signals & buy/sell areas" layer):**

- **BUY / SELL AREA:** fresh zones in the trend direction where Zone retest will signal on the first touch, with stop and target.
- **BUY above / SELL below:** the level that Volume breakout is watching.
- **Live signals:** shown as position boxes (green to target, red to stop), with entry, SL and TP on the price axis.
- **Past signals:** boxes from entry to exit, labelled with the result in R.

New signals also appear in the **Best setup** panel, as a toast and a sound,
and (if allowed) as a browser notification. When there is no signal, the panel
lists the areas and levels the strategies are waiting for, and the last signal
with its result.

Every 15 minutes the server re-runs the 2-year backtest (it downloads the
history once, then only new candles). A strategy keeps signalling only while it
stays proven:

- 20+ trades
- profit factor ≥ 1.15
- average ≥ +0.05R
- profitable on the most recent 40% of the period

Each signal also gets a confluence score (A/B/C) from trend, liquidity sweep,
candle delta, CVD, COT, session and room to target. On real data these factors
did not consistently predict winners, so the auto-trader takes every signal
from the proven strategies by default. The stricter A/B modes are optional.

## Auto-trader

- **Settings:** amount ($100 to $10M), risk per trade (0.1–5%), accuracy mode (every signal from the proven strategies by default, or A+B / A only), max open trades (1–5) and daily loss limit (0.5–20%).
- **Position size:** risk % of balance ÷ stop distance, in 0.01 oz steps. 100 oz = 1 lot.
- **Safety rules:**
  - Skips a setup if price has moved so far that reward/risk drops below 1.5.
  - Stops opening trades for the day once the daily loss limit is hit.
  - Closes trades after 16 hours.
- **Persistence:** the account is saved to `data/paper.json` and survives restarts. On Render's free plan the disk resets on each deploy.
- **Uptime:** the server keeps polling prices while the auto-trader is on, even with no browser open. Render's free plan sleeps after 15 idle minutes, so use a paid instance (or your own machine) to keep it running.
- **Access:** set `ADMIN_TOKEN` when the site is public, so only you can start, stop or change it.

**Going live later:** orders go through a broker object (`paperBroker` in
`shared/autotrader.js`). A live broker such as OANDA or MetaTrader implements
the same `fill()` call and places real orders. Run paper mode first and compare
its results with the backtest before risking money.

## Put it online

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/JaveedFiaz/aurumdesk)

Click the button, sign in to Render, set `ADMIN_TOKEN`, and press **Apply**.

## Run it on your computer

Requires Node.js 20.12 or newer.

```bash
npm install
cp .env.example .env      # choose a price feed, set ADMIN_TOKEN
npm start                 # http://localhost:3000
```

- `npm run demo`: run offline on synthetic data.
- `npm test`: run the test suite.
- `npm run backtest`: print the strategy ranking.
- `npm run build:hosted`: build `dist/aurumdesk.html`, a static preview that runs entirely in the browser on demo data.

## Data sources

| Setting | Source | Key |
|---|---|---|
| `PROVIDER=binance` (default) | PAXG/USDT, a token backed by physical gold that tracks spot closely and trades 24/7. | None |
| `PROVIDER=oanda` | Spot XAU/USD from OANDA: the same prices as TradingView's `OANDA:XAUUSD`. A free practice account works (*Manage API Access → Generate token*). | `OANDA_API_KEY` |
| `PROVIDER=twelvedata` | Spot XAU/USD (paid plan recommended). | `TWELVEDATA_API_KEY` |
| `PROVIDER=demo` | Synthetic prices, order flow and COT. | None |
| Order flow (`FLOW_PROVIDER`) | Spot gold has no free public order book, so taker volume, big trades and the order book come from PAXG on Binance. Prices are shifted by the PAXG–spot difference so they line up with the chart. Set `FLOW_PROVIDER=none` to turn it off. | None |
| COT | CFTC public reporting API (legacy futures-only report, COMEX gold 088691), refreshed every 6 hours. | None |

## Project layout

```
server/index.js          HTTP server and APIs: candles, bot, flow, cot, paper, stream
server/providers/        binance, oanda, twelvedata, demo
server/cot.js            CFTC fetcher
server/paper.js          auto-trader with file storage
shared/analysis.js       structure, order blocks, zones, liquidity, VWAP, profile
shared/strategies.js     setup detection
shared/confluence.js     confluence score and grades
shared/flow.js           delta, whales, order-book walls
shared/cot.js            COT parsing, index and bias
shared/bot.js            backtester, grade accuracy, strategy approval, live setups
shared/autotrader.js     auto-trader engine and paper broker
public/                  the Aurum Pulse UI (app.js, ui.js, overlay.js, style.css)
test/                    node:test suite
```

The chart is [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts)
(Apache 2.0, attribution logo kept).

## Disclaimer

Analysis tool, not financial advice. Accuracy figures are measured on recent
history and do not guarantee future results. Order flow comes from a gold-token
market as a proxy for spot gold. Trading leveraged gold products can lose more
than you invest.
