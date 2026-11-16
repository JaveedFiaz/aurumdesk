# Pulse Gold Sweep Pro (TradingView indicator)

Liquidity-sweep signals for gold (XAUUSD), in the style of the FAP AI signals but
filtered by the 1-hour trend and without "risk-free after TP1", which the
backtest showed was costing most of the profit.

**Rules** (5-minute chart):

1. **Liquidity:** the latest swing high or low with 4 lower highs (higher lows) on each side.
2. **Sweep:** a candle trades through that swing and closes back on the other side, as a
   bearish candle for a sell or a bullish candle for a buy. Each swing is used once.
3. **Trend:** only sells while the 1H EMA 20 is below the 1H EMA 50 (buys when above),
   read from the last closed 1H candle, so signals never repaint.
4. **Trade:** entry at the next candle's open, stop 0.26% away (about $10 at 3850),
   one target at 1.5R, closed after 96 candles (8 hours) if neither is hit.
   At most 3 signals open and 10 per day.

## Backtest: 3 years of 5-minute gold

Nov 2023 to Nov 2026, weekends removed, 0.01% of price (about $0.38/oz) cost per trade.
Data: Binance PAXG/USDT (a token backed by gold that tracks XAU/USD).

| Settings | Trades | Per day | Won | Profit factor | Net | Avg per trade by year (trades) |
|---|---|---|---|---|---|---|
| **PGS Pro default (all sessions)** | 667 | 0.85 | 46% | **1.17** | **+61.3R** | +0.08R (137) / +0.09R (221) / +0.10R (309) |
| PGS Pro, London + New York only | 322 | 0.41 | 46% | 1.15 | +26.6R | -0.02R (65) / +0.16R (108) / +0.07R (149) |
| PGS Pro, killzones only | 195 | 0.25 | 43% | 1.02 | +2.3R | -0.02R (36) / +0.10R (62) / -0.03R (97) |
| PGS Pro at double costs | 667 | 0.85 | 46% | 1.09 | +35.6R | +0.04R / +0.05R / +0.06R |
| FAP replica (no trend filter, 1:2, risk-free after 0.4R) | 1120 | 1.43 | 16%* | 0.90 | **-35.6R** | -0.24R / +0.01R / +0.05R |

\* Trades closed at break-even are not counted as wins.

At 1% risk per trade, +61R is roughly +61% over 3 years before compounding.
Neighbouring settings (pivot length 4-6, 1.5-2R, stop 0.26-0.35%) were also
profitable over the period, so the result does not hang on one exact number.

**About 4-5 trades a day:** no rule set tested made money at that pace. Across
more than 1,000 variations (sweeps, trend pullbacks, breakouts, volume
breakouts; 5m and 15m; different sessions, stops and targets), the busier
versions lost money after costs. Tight 5-minute stops are eaten by the spread.
The default gives about 4 signals a week.

## Install

1. In TradingView open **Pine Editor**, paste `pulse-gold-sweep.pine`, press **Save** then **Add to chart**.
2. Use a **5-minute XAUUSD** chart (OANDA:XAUUSD or your broker's symbol).
3. The table at the bottom right re-runs the rules on the bars loaded in your chart:
   check the results on your broker's own prices before trading it.

## Alerts and auto-trading

Create an alert on the indicator with **"Any alert() function call"**. Each
alert text is in the signal-channel format:

```
Sell Gold (3866.73)
Stoploss at : 3876.78
Tp1 : 3851.65
PGS Pro · liquidity sweep · 60 trend
```

To trade it automatically, tick **Webhook URL** in the alert and enter the
copier's address, e.g. `http://YOUR-VPS-IP:8787/signal?token=YOUR-TOKEN`
(see `copier/README.md`; set `"host": "0.0.0.0"` and a token). TradingView webhooks
need a paid TradingView plan.

## Reproduce the backtest

```
python download.py PAXGUSDT 5m 1700092800 data/m5.json
python download.py PAXGUSDT 1h 1700092800 data/h1.json
node backtest.mjs data
```

## Limits

- PAXG is not identical to spot XAU/USD: small differences in candles change some signals.
  The table on your own chart is the check that counts.
- Results are from past data and do not guarantee future results. Not financial advice.
