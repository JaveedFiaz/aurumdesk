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
    plays: {
      M15: { htf: 'H1', history: 70000, strategies: [{ id: 'zone_retest', rr: 2 }, { id: 'vol_breakout', rr: 3 }, { id: 'ema_pullback', rr: 3 }, { id: 'zone_reject', rr: 2 }] },
      M5: { htf: 'H1', history: 105000, strategies: [{ id: 'trap_flow', rr: 2 }, { id: 'asia_sweep', rr: 3 }, { id: 'zone_reject', rr: 2 }] },
      M1: { htf: 'M15', history: 120000, strategies: [{ id: 'zone_sweep', rr: 3 }] },
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
      M15: { htf: 'H1', history: 70000, strategies: [{ id: 'trap_trend', rr: 2, allHours: true }, { id: 'surge_go', rr: 2 }, { id: 'ema_pullback', rr: 3, allHours: true }, { id: 'zone_reject', rr: 2 }] },
      M5: { htf: 'H1', history: 105000, strategies: [{ id: 'trap_flow', rr: 1.5 }, { id: 'asia_sweep', rr: 3 }, { id: 'zone_reject', rr: 2 }] },
      M1: { htf: 'M15', history: 120000, strategies: [{ id: 'zone_sweep', rr: 3 }] },
    },
  },
];

export const MARKET_BY_ID = Object.fromEntries(MARKETS.map((m) => [m.id, m]));
export const PLAY_TFS = ['M1', 'M5', 'M15'];
