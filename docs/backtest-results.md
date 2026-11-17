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

## Scalping strategies tested and rejected (2026-11-11)

Three common scalping methods were tested on the same 1m and 5m history, at
1.5R and 2R targets, for gold and Bitcoin. They trade often but none beats
trading costs, and no filter (trend, sweep, order flow, session) made any of
them profitable in both halves of the data:

| Strategy | Gold 5m | Gold 1m | Bitcoin 5m | Bitcoin 1m |
|---|---|---|---|---|
| EMA 20 trend pullback (2R) | 846 trades, −0.11R | 726, −0.01R | 875, −0.08R | 756, −0.12R |
| VWAP 2σ snap-back (2R) | 460, −0.02R | 600, −0.12R | 682, −0.16R | 664, −0.13R |
| London/NY opening-range breakout (2R) | 26, −0.18R | 3 trades | 47, −0.38R | 2 trades |

They stay in the code for re-testing but are not traded or signalled.

## Memecoins (Memecoins tab)

1 year of 15-minute and 6 months of 5-minute Binance spot candles for 23 memecoins
(DOGE, SHIB, PEPE, FLOKI, BONK, WIF, BOME, MEME, TURBO, NEIRO, PEOPLE, PNUT, ACT,
1000SATS, DOGS, TRUMP, 1000CAT, 1MBABYDOGE, PENGU, BROCCOLI714, 1000CHEEMS, TST,
MUBARAK), 0.1% round-trip cost, all hours. Every strategy at 0, 5/8 and 6/8
confluence, results pooled across coins (`research/`):

| Strategy (15m, 6/8+ confluence) | Target | Trades | Won | PF | Total | First 60% / last 40% | Coins profitable |
|---|---|---|---|---|---|---|---|
| **Trap + order flow** (traded) | 2R | 76 | 45% | 1.31 | +14.3R | +0.10R / +0.29R | 12 of 21 |
| Trap with trend | 2R | 73 | 44% | 1.26 | +11.7R | +0.17R / +0.15R | 11 of 20 |
| Trap + order flow | 1.5R | 76 | 50% | 1.20 | +8.4R | +0.04R / +0.20R | 14 of 21 |
| Trap + order flow | 3R | 76 | 33% | 1.09 | +5.1R | -0.13R / +0.30R | 9 of 21 |

Everything else (volume breakouts, zone retests and rejections, sweeps, EMA
pullbacks, session sweeps, ...) lost money on memecoins or failed one half.

## Liquidity sweep (FAP-style) in Pulse

The FAP AI channel's setup (a sweep of the latest swing high/low that closes back
inside), with a 1H EMA 20/50 trend filter added and a fixed 0.26% stop, run in
Pulse's engine (entry at next open, one trade at a time, 0.01% cost):

| Market / TF | Target | Trades (3 years) | Won | PF | Total | Avg R by year |
|---|---|---|---|---|---|---|
| Gold 5m | 1.5R | 618 | 45% | 1.13 | +45.2R | +0.04 / +0.13 / +0.05 |
| Gold 5m | 2R | 610 | 40% | 1.14 | +52.3R | -0.04 / +0.16 / +0.10 |
| Gold 15m | 1.5R | 268 | 37% | 0.83 | -29.3R | lost |
| Bitcoin 5m / 15m | 1.5-2R | 513-1294 | 33-41% | 0.76-0.92 | -52 to -85R | lost |

On the last 12 months alone (the window the live server tests) gold 5m has PF
1.06-1.10, below the 1.15 gate, so it shows as watch only until it passes a re-test.

## Scalps and crypto strategies (3 years, Nov 2023 - Nov 2026)

Every strategy, including four new crypto order-flow ones (CVD divergence,
squeeze breakout, 48-candle trend breakout, VWAP stretch fade), on Bitcoin 5m,
15m and 1h (all hours) and gold 5m (sessions and all hours), at 1-3R and 0, 5/8
and 6/8 confluence: 634 combinations. Costs: 0.08% per Bitcoin trade (futures
taker fees), 0.01% per gold trade. Kept only if profitable in each of the 3 years
with profit factor 1.15+:

| Market / TF | Strategy | Target | Trades | Won | PF | Total | Avg R by year |
|---|---|---|---|---|---|---|---|
| Gold 5m (London/NY) | Liquidity sweep, 5/8+ | 2R | 107 | 43% | 1.31 | +18.7R | +0.31 / +0.22 / +0.10 |
| Bitcoin 1h | Trend breakout | 3R | 492 | 32% | 1.14 (1.21 at 0.04% fees) | +49R | +0.20 / +0.08 / +0.02 |

The Bitcoin trend breakout is just under the 1.15 bar at full taker fees but
positive in every year; it passes the live gate at the terminal's 0.02% cost.
No Bitcoin 5m or 15m scalp, old or new, made money after fees.

## Swing strategies: 1H and 4H (3 years, Nov 2023 - Nov 2026)

Every strategy on gold 1H/4H and Bitcoin 1H/4H at 1.5-5R (251 combinations with
40+ trades), same costs. 24 were profitable in each year; because gold doubled
and Bitcoin rose over the period, longs and shorts were then checked separately
and only strategies whose sells also made money were kept:

| Market / TF | Strategy | Target | Trades | PF | Total | Longs PF / shorts PF | Worst drawdown |
|---|---|---|---|---|---|---|---|
| Gold 4H | VWAP 2-sigma snap-back | 5R | 97 | 2.01 | +66.7R | 2.87 / 1.45 | 9.1R |
| Gold 4H | VWAP trend pullback | 2R | 54 | 2.65 | +38.3R | 3.41 / 1.23 | 4.1R |
| Bitcoin 4H | VWAP trend pullback | 2R | 93 | 1.60 | +31.6R | 1.61 / 1.59 | 6.6R |
| Bitcoin 4H | Trend breakout, 5/8+ | 5R | 54 | 1.63 | +24.7R | 1.49 / 1.76 | 6.2R |
| Bitcoin 1H | Zone retest | 5R | 50 | 2.06 | +35.6R | 2.26 / 1.86 | 5.9R |
| Bitcoin 1H | Previous-day high/low rejection | 5R | 146 | 1.28 | +32.4R | 1.21 / 1.35 | 13.9R |

Rejected: gold 1H trend breakout (+71.6R, but its shorts lost: the profit was
the gold rally, not the rule). Trades last 1-4 days on 4H and about a day on 1H.
