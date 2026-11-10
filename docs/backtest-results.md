# Backtest results: real gold data (run 2026-11-09)

Real PAXG/USDT 15m candles from Binance (with taker buy/sell volume) and the CFTC COT reports for COMEX gold. Settings: London/NY sessions, 2R target, $0.40/oz cost per trade, next-open entries, stop-first on ties. Reproduce with `npm run backtest -- --bars N`.

## 103 days (`--bars 10000`)

```
Strategy          Trades  Win %   PF     Avg R   Total R  Max DD  OOS R   Status
Sweep + CHoCH     3       33      0.98   -0.02   -0.0     2.0     0.48    off
Zone retest       10      30      0.92   -0.05   -0.5     3.1     0.32    off
PDH/PDL reject    2       50      0.62   -0.20   -0.4     1.0     -1.03   off
VWAP pullback     20      30      0.73   -0.20   -4.0     6.5     0.09    off
1H zone reject    1       0       0.00   -1.02   -1.0     1.0     0.00    off

By confluence grade (trades · win % · avg R)
Strategy          Grade A (70+)         Grade B (50-69)       Grade C (<50)         
Zone retest       4 · 50% · +0.47R      4 · 25% · -0.28R      2 · 0% · -0.66R       
Sweep + CHoCH     —                     3 · 33% · -0.02R      —                     
PDH/PDL reject    1 · 100% · +0.64R     —                     1 · 0% · -1.03R       
VWAP pullback     11 · 36% · -0.06R     7 · 29% · -0.18R      2 · 0% · -1.04R       
1H zone reject    —                     —                     1 · 0% · -1.02R       
All strategies    16 · 44% · +0.12R     14 · 29% · -0.17R     6 · 0% · -0.91R       
```

## 1 year (`--bars 35000`)

```
Strategy          Trades  Win %   PF     Avg R   Total R  Max DD  OOS R   Status
Zone retest       29      45      1.58   0.29    8.5      3.9     -0.05   off
Sweep + CHoCH     20      50      1.58   0.27    5.5      4.5     0.48    off
VWAP pullback     65      43      1.26   0.16    10.2     7.5     -0.03   off
PDH/PDL reject    7       29      0.51   -0.36   -2.5     3.1     -0.20   off
1H zone reject    2       0       0.00   -1.02   -2.0     2.0     -1.02   off

By confluence grade (trades · win % · avg R)
Strategy          Grade A (70+)         Grade B (50-69)       Grade C (<50)         
Zone retest       10 · 50% · +0.24R     16 · 50% · +0.53R     3 · 0% · -0.78R       
Sweep + CHoCH     6 · 33% · -0.33R      8 · 63% · +0.49R      6 · 50% · +0.59R      
PDH/PDL reject    2 · 50% · -0.20R      2 · 50% · +0.46R      3 · 0% · -1.02R       
VWAP pullback     28 · 39% · +0.09R     29 · 48% · +0.29R     8 · 38% · -0.09R      
1H zone reject    —                     1 · 0% · -1.02R       1 · 0% · -1.02R       
All strategies    46 · 41% · +0.05R     56 · 50% · +0.37R     21 · 29% · -0.17R     
```

## 2 years (`--bars 70000`)

```
Strategy          Trades  Win %   PF     Avg R   Total R  Max DD  OOS R   Status
Zone retest       45      44      1.58   0.30    13.5     5.2     0.28    ACTIVE
VWAP pullback     136     40      1.11   0.07    9.4      21.8    0.30    off
Sweep + CHoCH     47      38      0.89   -0.06   -3.0     10.6    0.17    off
PDH/PDL reject    13      15      0.22   -0.69   -9.0     9.5     -0.25   off
1H zone reject    5       20      0.02   -0.81   -4.0     4.0     -1.02   off

By confluence grade (trades · win % · avg R)
Strategy          Grade A (70+)         Grade B (50-69)       Grade C (<50)         
Zone retest       17 · 47% · +0.28R     22 · 50% · +0.51R     6 · 17% · -0.41R      
Sweep + CHoCH     14 · 36% · -0.22R     22 · 32% · -0.17R     11 · 55% · +0.35R     
PDH/PDL reject    4 · 25% · -0.62R      4 · 25% · -0.33R      5 · 0% · -1.03R       
VWAP pullback     59 · 41% · +0.12R     55 · 40% · +0.04R     22 · 41% · +0.01R     
1H zone reject    1 · 0% · -1.04R       2 · 50% · -0.46R      2 · 0% · -1.04R       
All strategies    95 · 40% · +0.05R     105 · 40% · +0.07R    46 · 35% · -0.12R     
```
