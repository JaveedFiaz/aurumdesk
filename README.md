# Pulse Scalper: Gold and Bitcoin scalping terminal

![Pulse Scalper](docs/screenshot.png)

A self-hosted terminal for scalping Gold (XAU/USD) and Bitcoin (BTC/USD) on the
1m, 5m and 15m charts. It finds setups, verifies each one against volume,
liquidity and order flow, draws the trade on the chart, and paper-trades it
automatically so you can track performance.

## What it does

- **Two markets, three timeframes.** Switch between Gold and Bitcoin, and between 1m, 5m and 15m. The other market's price and any live signal stay visible in its tab.
- **Automatic trade boxes.** When a setup forms, a position box grows out from the entry candle: for a sell, red above (stop) and green below (target); for a buy, the reverse. Past trades stay on the chart with their result.
- **Verified setups.** Each setup lists its confluence checks: higher-timeframe trend, structure, liquidity sweep, candle delta, cumulative delta, session and room to target (plus hedge-fund positioning for gold).
- **Trap detection.** Breakouts and breakdowns that fail within 5 candles are flagged and labelled on the chart.
- **Volume surges.** Candles with 2.5x+ average volume where buyers or sellers dominated are highlighted and tagged.
- **Everything live.** Your browser streams candles, every trade and the top of the order book (10 times a second) straight from Binance, so prices, whales, order flow and the book update instantly without waiting on the server. If the stream is blocked, the page falls back to the server every few seconds.
- **News.** Headlines from free feeds, checked every few seconds and tagged by market, impact and likely direction, plus a countdown to high-impact US events.
- **Paper auto-trader.** Takes every setup from a proven strategy on both markets, sizes it to your risk %, and manages stop, target and time stop. Shows equity, win rate, profit factor, open trades and history.
- **Track record.** The last 30 days of trades from the proven strategies on both markets, replayed as a $10,000 account at 1% risk, so you can see how the terminal is doing even right after the paper account resets.
- **Always-on zones.** The nearest fresh buy zone (demand) below price and sell zone (supply) above stay on the chart; the setup guide card can be dragged anywhere.
- **TradingView view.** A switch swaps in TradingView's own chart for the current market and timeframe.

## Strategies

Only strategies that made money on real history, in both the first 60% and the
last 40% of the period, are traded ([full results](docs/backtest-results.md)):

Every setup is scored on 8 confluence checks (7 for Bitcoin, which has no COT
data). A setup is traded only with **6 of 8 or more** (7 of 8 where that
backtests better). Each strategy is re-tested with that filter, and only those
still profitable on enough trades are traded:

| Market | Timeframe | Strategy | Target | With the 6/8 quality filter | Status |
|---|---|---|---|---|---|
| Gold | 15m | Volume breakout | 3R | 83 trades in 2 years, 40% won, PF 1.64, +33.4R | **Trading** |
| Gold | 15m | Zone retest | 2R | 16 trades, PF 1.33 (too few) | watch only |
| Gold | 5m | Trap + order flow | 2R | 39 trades, PF 0.77 | watch only |
| Gold | 1m | Sweep into zone | 3R | 24 trades, PF 0.98 | watch only |
| Bitcoin | 15m | Trap with trend | 2R | 6 trades (too few) | watch only |
| Bitcoin | 5m | Trap + order flow | 2R | 9 trades, PF 2.23 (too few) | watch only |
| Bitcoin | 1m | Sweep into zone | 3R | 16 trades, PF 2.16 (too few) | watch only |

The server re-tests every play every 12 hours. A play is traded only while,
with the quality filter, it has 20+ trades, profit factor ≥ 1.15, an average of
+0.05R or more, and a profit on the most recent 40% of its history. Watch-only
setups are drawn faintly on the chart with their confluence score; the
auto-trader ignores them.

Gold 1m only works with tight spreads: at double trading costs it loses money.
Bitcoin has no proven 1m or 5m strategy yet.

## Auto-trader

- **Defaults:** $10,000 paper balance, 1% risk per trade, up to 3 open trades per market, 5% daily loss limit. It starts on its own.
- **Costs:** fills include 1 basis point for gold and 2 for Bitcoin.
- **Safety:** skips a setup if price has moved so far that reward/risk falls below 1.5, stops opening trades after the daily loss limit, and closes trades after 64 candles.
- **News:** it trades through news by default. Set `NEWS_PAUSE=1` to hold new trades within 5 minutes of high-impact events.
- **Access:** set `ADMIN_TOKEN` so only you can change settings when the site is public.
- **Real money:** orders go through a broker object (`paperBroker` in `shared/autotrader.js`). A live broker implements the same `fill()` call.

## Run it

Requires Node.js 20.12 or newer.

```bash
npm install
cp .env.example .env
npm start                 # http://localhost:3000
```

- `npm run demo`: offline, on synthetic data.
- `npm test`: the test suite.
- `npm run backtest`: backtest every play on real data.

On start the server backtests one play at a time in a worker: the 15m plays
are ready in about a minute and the 1m plays after about five. Setups appear
once a timeframe's backtest finishes.

**Hosting:** the Render blueprint (`render.yaml`) deploys it as a web service.
Render's free plan stops a service after 15 minutes without visitors. On
Render the server requests its own address every 10 minutes to stay awake
(`KEEP_ALIVE=0` turns that off); a paid instance is the dependable way to run
it around the clock. The server uses about 130 MB of memory, peaking near 200 MB while it
backtests.

## Data

| What | Source |
|---|---|
| Gold chart candles | Binance's XAUUSDT gold perpetual (deep, real volume), shifted onto the live spot price. Where Binance futures are blocked, candles are built from the live spot ticks while the server runs, with shifted PAXG candles for older history. |
| Gold price | Live spot XAU/USD from Swissquote's public quote feed, polled every second (set `SPOT_GOLD=0` to turn it off). The candles, order flow and signals come from PAXG/USDT, which the strategies were tested on, shifted by the live spot–PAXG gap so everything lines up with spot. |
| Gold candles | PAXG/USDT on Binance by default. Set `PROVIDER=oanda` with a free OANDA practice key for spot XAU/USD, the same prices as TradingView's `OANDA:XAUUSD`. OANDA candles carry no buy/sell volume, so the order-flow checks are skipped and the gold 5m strategy (which requires them) stays idle on that feed. |
| Bitcoin prices | BTC/USDT on Binance. |
| Order flow, whales, order book | Binance trade stream and order book. For gold this is the PAXG market, shifted to line up with the price feed. |
| Big players (gold) | CFTC Commitments of Traders, used as one confluence check. |
| News | Cointelegraph, CoinDesk and MarketWatch feeds, and the Forex Factory weekly calendar. Headlines arrive a few seconds after publication. |

## Project layout

```
server/index.js          web server and engine: prices, history, backtests, live scans
server/bt-worker.js      runs full backtests off the main thread
server/news.js           headline feeds and economic calendar
server/paper.js          auto-trader with file storage
server/providers/        binance, oanda, twelvedata, demo
shared/markets.js        markets and the strategies traded on each timeframe
shared/strategies.js     setup detection (zones, traps, breakouts) and buy/sell areas
shared/confluence.js     confluence checks
shared/bot.js            backtester, approval gate, live analysis
shared/autotrader.js     auto-trader engine and paper broker
shared/flow.js           delta, whales, order-book walls
public/                  the terminal UI
test/                    node:test suite
```

The chart is [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts)
(Apache 2.0).

## Disclaimer

Analysis tool, not financial advice. The auto-trader uses simulated money.
Results are measured on past data and do not guarantee future results.
Leveraged trading can lose more than you invest.
