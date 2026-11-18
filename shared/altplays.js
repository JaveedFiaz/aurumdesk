import { MEME_PLAY } from './memeplays.js';

// Altcoins on the Crypto tab and the strategies that held up on each.
//
// Backtest (Nov 2023 - Nov 2026, Binance 1h/4h candles with taker flow, entry at
// the next open, all hours): every strategy at 2/3/5R and 0, 5/8, 6/8 confluence on
// ETH, SOL, XRP, BNB, LTC, ADA, DOGE (2,246 combinations). Kept only if profitable
// in each of the 3 years with PF >= 1.3 at 0.02% cost per trade, 40+ trades, and
// both longs and shorts profitable, and (except where noted) still profitable at
// Binance futures taker fees (0.08%). Stats below are at 0.02%.

const DAY = 'Nov 2023 – Nov 2026';

export const ALT_PLAYS = {
  ETHUSDT: {
    name: 'ETH',
    plays: [{ tf: 'H4', strategies: [
      { id: 'vwap_pullback', rr: 2, gate: 0.625, stats: '43 trades, PF 2.11, +23.0R' },
      { id: 'sr_flip', rr: 5, gate: 0, stats: '102 trades, PF 1.53, +36.9R' },
    ] }],
  },
  SOLUSDT: {
    name: 'SOL',
    plays: [
      { tf: 'H1', strategies: [{ id: 'ema_pullback', rr: 5, gate: 0.625, stats: '155 trades, PF 1.57, +62.6R' }] },
      { tf: 'H4', strategies: [{ id: 'vwap_pullback', rr: 3, gate: 0, stats: '68 trades, PF 1.60, +25.0R' }] },
    ],
  },
  XRPUSDT: {
    name: 'XRP',
    plays: [{ tf: 'H1', strategies: [{ id: 'surge_go', rr: 3, gate: 0, stats: '50 trades, PF 1.77, +24.5R' }] }],
  },
  DOGEUSDT: {
    name: 'DOGE',
    plays: [
      { tf: 'H1', strategies: [{ id: 'squeeze_break', rr: 5, gate: 0, stats: '103 trades, PF 1.74, +54.0R' }] },
      { tf: 'H4', strategies: [
        { id: 'ema_pullback', rr: 5, gate: 0, stats: '112 trades, PF 1.82, +60.1R' },
        { id: 'vwap_pullback', rr: 5, gate: 0, stats: '75 trades, PF 1.57, +31.0R' },
      ] },
    ],
  },
  ADAUSDT: {
    name: 'ADA',
    plays: [{ tf: 'H4', strategies: [{ id: 'vwap_pullback', rr: 3, gate: 0, stats: '74 trades, PF 1.51, +24.7R' }] }],
  },
};

export const ALT_PERIOD = DAY;
export const HTF_OF = { M5: 'H1', M15: 'H1', H1: 'H4', H4: 'D1' };

// The plays for a coin: its own proven altcoin strategies, or the memecoin
// strategy for memecoins.
export function playsFor(symbol, isMeme = !ALT_PLAYS[symbol]) {
  const out = (ALT_PLAYS[symbol]?.plays || []).map((p) => ({ tf: p.tf, htf: HTF_OF[p.tf], strategies: p.strategies, rules: { costPct: 0.0002, cost: 0, sessionOnly: false, maxPerDay: 3 } }));
  if (isMeme && !ALT_PLAYS[symbol]) out.push({ tf: MEME_PLAY.tf, htf: MEME_PLAY.htf, strategies: MEME_PLAY.strategies, rules: MEME_PLAY.rules });
  return out;
}
