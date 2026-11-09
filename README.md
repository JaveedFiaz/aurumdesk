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

## How setups are found and graded

Five strategies scan the 15m chart, using the 1H chart for confirmation, during
London and New York hours:

| Strategy | Setup |
|---|---|
| **Zone retest** | 15m and 1H trends agree. The first pullback into a fresh order block or supply/demand zone closes with a rejection candle. |
| **Sweep + CHoCH** | Price takes out a recent swing high or low, closes back inside, then breaks structure the other way. |
| **PDH/PDL reject** | The day's first wick through the previous day's high or low closes back inside. |
| **VWAP pullback** | With the trend, price holds the daily VWAP, tags it and closes back on the trend side. |
| **1H zone reject** | The first touch of an untested 1H zone, rejected on 15m. |

Each setup gets a **confluence score** (0–100) from the factors below. A factor
whose data isn't available counts toward neither the points nor the maximum.

| Factor | Points |
|---|---|
| 1H trend agrees | 20 |
| Liquidity swept first | 15 |
| Candle delta confirms (more market buying for a long) | 15 |
| 15m structure agrees | 10 |
| Cumulative delta rising with the trade | 10 |
| Hedge funds adding in the trade's direction (COT) | 10 |
| London or New York open | 10 |
| Clear path to target | 10 |

**Grade A** is 70+, **B** is 50–69, **C** is below 50.

Every 15 minutes the server backtests all of this on about 100 days of history
(next-open entries, stop-first when a candle hits both, $0.40/oz costs, 2R
target). It reports the real win rate of each grade. A strategy is
**Active**, meaning the auto-trader may take its setups, only if it has:

- 20+ trades
- profit factor ≥ 1.15
- average ≥ +0.05R
- a profit on the most recent 40% of the data

Every decision uses only candles, and COT reports, that existed at that moment.
A test checks that adding future candles never changes past signals.

There is no fixed accuracy promise. The dashboard shows what each grade
actually did, and **Highest accuracy** mode takes grade A only.

## Auto-trader

- **Settings:** amount ($100 to $10M), risk per trade (0.1–5%), accuracy mode (A only, A+B, or all), max open trades (1–5) and daily loss limit (0.5–20%).
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
