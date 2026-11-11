# Backtest results: real data

Real Binance candles with taker buy/sell volume: PAXG/USDT for gold and
BTC/USDT for Bitcoin, plus CFTC COT reports for gold. Run on 2026-11-11.
Reproduce with `npm run backtest` (add `-- --costx 2` for double costs).

Rules: London/NY sessions only, entry at the next candle's open, the stop is
assumed hit first when a candle touches both, time stop after 64 candles.
Costs per trade: 1 basis point for gold (about $0.40/oz) and 2 for Bitcoin.

## What is traded

```
Market   TF   Strategy            Days  Trades  Win %  PF     Avg R   Total R  Max DD  First 60%  Last 40%  Status
Gold     15m  Zone retest 2R      728   45      44     1.58   0.30    13.5     5.2     0.33R      0.28R     TRADING
Gold     15m  Volume breakout 3R  728   98      36     1.41   0.27    26.5     10.6    0.25R      0.31R     TRADING
Gold     5m   Trap + order flow 2R364   137     42     1.28   0.17    23.2     7.6     0.19R      0.14R     TRADING
Gold     1m   Sweep into zone 3R  83    45      33     1.17   0.13    5.8      8.5     0.07R      0.33R     TRADING
Bitcoin  15m  Trap with trend 2R  728   78      49     1.69   0.35    27.3     5.6     0.25R      0.50R     TRADING
Bitcoin  5m   Trap + order flow 2R364   88      39     1.14   0.09    7.6      13.0    0.07R      0.10R     watch only
Bitcoin  1m   Sweep into zone 3R  83    36      39     1.28   0.20    7.1      10.3    0.48R      -0.45R    watch only
```

A play is **TRADING** only with 20+ trades, profit factor ≥ 1.15, an average of
+0.05R or more, and a profit on the most recent 40% of its history. The server
re-tests every play every 12 hours and switches it on or off accordingly.

## At double trading costs

```
Pulse Scalper backtest · London/NY sessions · entry at next open · stop first on ties · cost ×2

Market   TF   Strategy            Days  Trades  Win %  PF     Avg R   Total R  Max DD  First 60%  Last 40%  Status
Gold     15m  Zone retest 2R      728   45      44     1.49   0.26    11.9     5.4     0.28R      0.25R     TRADING
Gold     15m  Volume breakout 3R  728   96      36     1.38   0.26    24.5     9.7     0.24R      0.27R     TRADING
Gold     5m   Trap + order flow 2R364   130     42     1.21   0.13    17.0     9.7     0.14R      0.12R     TRADING
Gold     1m   Sweep into zone 3R  83    25      28     0.85   -0.13   -3.3     11.7    -0.30R     0.73R     watch only
Bitcoin  15m  Trap with trend 2R  728   78      49     1.61   0.32    24.9     5.8     0.22R      0.47R     TRADING
Bitcoin  5m   Trap + order flow 2R364   80      38     0.99   -0.01   -0.5     13.5    0.02R      -0.04R    watch only
Bitcoin  1m   Sweep into zone 3R  83    20      35     0.78   -0.17   -3.5     13.7    -0.21R     -0.11R    watch only

```

Gold 15m, Gold 5m and Bitcoin 15m survive double costs. Gold 1m does not: it
only works with tight spreads. Bitcoin 1m and 5m never pass the gate.

## How the strategies were chosen

Eight strategy ideas were tested on each market and timeframe, with the history
split 60/40. Only variants that were profitable in both parts were kept:

- **Zone retest** and **Volume breakout** (gold 15m): unchanged from the earlier study.
- **Trap + order flow** (gold 5m): a breakout or breakdown that fails within 5
  candles. Unfiltered it was break-even (PF 1.09); requiring cumulative delta
  to already point the other way lifted it to PF 1.28 in both halves.
- **Sweep into zone** (gold 1m): a zone retest only after a liquidity sweep.
- **Trap with trend** (Bitcoin 15m): unfiltered traps lost money in the first
  half; taking them only with the 1H trend was profitable in both.

Rejected on the scalping timeframes because they lost money or only worked in
one half: VWAP pullback, Sweep + CHoCH, liquidity absorption, unfiltered traps,
and volume breakouts on 1m and 5m.

Past results do not guarantee future results.
