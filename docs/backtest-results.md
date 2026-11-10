# Backtest results: real gold data

Data: real PAXG/USDT 15m and 1H candles from Binance (with taker buy/sell volume)
and the CFTC Commitments of Traders reports for COMEX gold, November 2024 to
November 2026. Rules: London/NY sessions, entry at the next candle's open, stop
assumed hit first when a candle touches both, $0.40/oz cost per trade.
Reproduce with `npm run backtest -- --all`.

## What runs live

Only strategies that made money in **both** the first 60% and the most recent
40% of the two years:

| Strategy | Target | Trades | Win % | Profit factor | Avg | Total | First 60% | Last 40% |
|---|---|---|---|---|---|---|---|---|
| **Zone retest** | 2R | 45 | 44% | 1.58 | +0.30R | +13.5R | +0.25R | +0.28R |
| **Volume breakout** | 3R | 98 | 36% | 1.41 | +0.27R | +26.5R | +0.27R | +0.24R |

Retired (lost money, or only made money in one half): VWAP pullback, Sweep +
CHoCH, Liquidity absorption, S/R flip, PDH/PDL reject, 1H zone reject.

## Stress tests (both live strategies together)

```
cost $0.4/oz: zone_retest: 47 tr, 45% win, PF 1.52, +12.7R | vol_breakout: 99 tr, 35% win, PF 1.39, +25.4R
  third 1 (from 2024-10-23): 44 tr, 34% win, PF 1.06, +1.9R
  third 2 (from 2025-06-29): 46 tr, 37% win, PF 1.50, +14.0R
  third 3 (from 2026-03-06): 56 tr, 43% win, PF 1.71, +22.3R
  longs : 67 tr, 39% win, PF 1.51, +19.9R
  shorts: 79 tr, 38% win, PF 1.36, +18.3R
  combined: 146 tr, 38% win, PF 1.42, +38.2R, max drawdown 9.5R, longest losing streak 7
cost $0.8/oz: zone_retest: 47 tr, 45% win, PF 1.44, +11.0R | vol_breakout: 97 tr, 36% win, PF 1.35, +23.4R
cost $1.2/oz: zone_retest: 47 tr, 45% win, PF 1.36, +9.3R | vol_breakout: 93 tr, 37% win, PF 1.32, +20.6R
```

## Full report

```

Aurum Pulse backtest — Binance PAXGUSDT
15m with 1H confirmation · 2024-11-12 20:45 → 2026-11-10 18:30 UTC (728 days) · London/NY sessions
Targets: Zone retest 2R, Volume breakout 3R, VWAP pullback 2R, Sweep + CHoCH 2R, S/R flip 2R, Liquidity absorption 2R, PDH/PDL reject 2R, 1H zone reject 2R
Cost $0.4/oz per trade · max 3/day per strategy · 19.5s

Strategy               Trades  Win %   PF     Avg R   Total R  Max DD  OOS R   Status
Zone retest            45      44      1.58   0.30    13.5     5.2     0.28    ACTIVE
Volume breakout        98      36      1.41   0.27    26.5     10.6    0.31    ACTIVE
VWAP pullback          136     40      1.11   0.07    9.4      21.8    0.27    off
Sweep + CHoCH          47      38      0.89   -0.06   -3.0     10.6    0.17    off
Liquidity absorption   62      35      0.87   -0.09   -5.6     12.9    0.09    off
S/R flip               581     32      0.85   -0.11   -62.3    83.6    -0.02   off
PDH/PDL reject         13      15      0.22   -0.69   -9.0     9.5     -0.25   off
1H zone reject         5       20      0.02   -0.81   -4.0     4.0     -1.02   off

By confluence grade (trades · win % · avg R)
Strategy               Grade A (70+)         Grade B (50-69)       Grade C (<50)         
Zone retest            17 · 47% · +0.28R     22 · 50% · +0.51R     6 · 17% · -0.41R      
Volume breakout        87 · 40% · +0.43R     11 · 0% · -0.97R      —                     
VWAP pullback          59 · 41% · +0.12R     55 · 40% · +0.04R     22 · 41% · +0.01R     
Sweep + CHoCH          14 · 36% · -0.22R     22 · 32% · -0.17R     11 · 55% · +0.35R     
S/R flip               376 · 31% · -0.15R    184 · 36% · +0.00R    21 · 29% · -0.26R     
Liquidity absorption   33 · 27% · -0.37R     26 · 50% · +0.37R     3 · 0% · -1.05R       
PDH/PDL reject         4 · 25% · -0.62R      4 · 25% · -0.33R      5 · 0% · -1.03R       
1H zone reject         1 · 0% · -1.04R       2 · 50% · -0.46R      2 · 0% · -1.04R       
All strategies         591 · 33% · -0.05R    326 · 37% · +0.02R    70 · 31% · -0.20R     

Data: candles Binance PAXGUSDT with order flow · COT CFTC Commitments of Traders · COMEX gold

Active = 20+ trades, profit factor ≥ 1.15, avg ≥ 0.05R, and still profitable on the last 40% of the period (OOS).
R = multiples of the amount risked. At 1% risk per trade, +10R ≈ +10% on the account.

No live setups from active strategies right now.

Past results do not guarantee future results. Not financial advice.

```
