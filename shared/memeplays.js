// The memecoin strategy: the only one that held up on memecoins.
//
// Backtest (Nov 2025 - Nov 2026, 15-minute Binance candles of 23 memecoins, entry at
// the next open, 0.1% round-trip cost, trading around the clock): every strategy in
// shared/strategies.js was tested at 0, 5/8 and 6/8 confluence. Only the trap family
// was profitable in both halves of the year:
//   Trap + order flow, 6/8+ confluence, 2R: 76 trades, 45% won, PF 1.31, +14.3R,
//     first 60% +0.10R per trade, last 40% +0.29R, profitable on 12 of 21 coins.
// Every other strategy lost money or failed one half. Results are from past data.

export const MEME_PLAY = {
  tf: 'M15',
  htf: 'H1',
  strategies: [{ id: 'trap_flow', rr: 2, gate: 0.75 }],
  rules: { costPct: 0.001, cost: 0, sessionOnly: false, maxPerDay: 3 },
  stats: { trades: 76, winRate: 0.45, pf: 1.31, totalR: 14.3, coins: '12 of 21', period: 'Nov 2025 – Nov 2026', firstPart: 0.10, lastPart: 0.29 },
};
