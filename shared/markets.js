// The markets the terminal trades and, per timeframe, the strategies that
// earned a place on real data (docs/backtest-results.md). A strategy listed
// here still has to pass the live approval gate on every re-test before its
// setups are traded; otherwise they are shown as "watch only".

export const MARKETS = [
  {
    id: 'gold',
    label: 'Gold',
    pair: 'XAU/USD',
    symbol: 'PAXGUSDT',
    tv: 'OANDA:XAUUSD',
    unit: 'oz',
    lot: 100,
    costBps: 1, // round-trip spread + slippage, in basis points of price (about $0.40/oz)
    closedWeekends: true, // spot gold is shut Friday 21:00 to Sunday 23:00 UTC (PAXG is not)
    // Only strategies profitable in each of the last 3 years (docs/backtest-results.md).
    // Dropped after the 3-year check: 15m volume breakout, zone retest, EMA pullback,
    // zone rejection; 5m trap + order flow, session sweep, zone rejection; 1m sweep into zone.
    plays: {
      M5: { htf: 'H1', history: 105000, strategies: [{ id: 'liq_sweep', rr: 2, gate: 0.625 }] },
      // Swing: 3 years, profitable each year, sells as well as buys.
      H4: { htf: 'D1', history: 6600, strategies: [{ id: 'vwap_band', rr: 5, allHours: true, gate: 0 }, { id: 'vwap_pullback', rr: 2, allHours: true, gate: 0 }] },
    },
  },
  {
    id: 'btc',
    label: 'Bitcoin',
    pair: 'BTC/USD',
    symbol: 'BTCUSDT',
    tv: 'BINANCE:BTCUSDT',
    unit: 'BTC',
    lot: 1,
    costBps: 2,
    plays: {
      // Bitcoin trades around the clock: these strategies also scan outside London/NY hours.
      // Only strategies profitable in each of the last 3 years at the 0.02% cost used here.
      // Dropped after the 3-year check: 15m volume surge, zone rejection; 5m trap + order
      // flow, session sweep, zone rejection; 1m sweep into zone.
      M15: { htf: 'H1', history: 70000, strategies: [{ id: 'trap_trend', rr: 2, allHours: true, gate: 0.625 }, { id: 'ema_pullback', rr: 3, allHours: true, gate: 0.75 }] },
      // Crypto trend breakout: 48-hour high/low broken on volume with taker flow (3 years: 492 trades, PF 1.14 at futures taker fees).
      H1: { htf: 'H4', history: 26000, strategies: [{ id: 'donch_break', rr: 3, allHours: true, gate: 0 }, { id: 'zone_retest', rr: 5, allHours: true, gate: 0 }, { id: 'pdhl_reject', rr: 5, allHours: true, gate: 0 }] },
      // Swing: 3 years, profitable each year, longs and shorts both.
      H4: { htf: 'D1', history: 6600, strategies: [{ id: 'vwap_pullback', rr: 2, allHours: true, gate: 0 }, { id: 'donch_break', rr: 5, allHours: true, gate: 0.625 }] },
    },
  },
];

export const MARKET_BY_ID = Object.fromEntries(MARKETS.map((m) => [m.id, m]));
export const PLAY_TFS = ['M1', 'M5', 'M15', 'H1', 'H4'];
