// Confluence score: how many independent things agree with a setup. Every
// factor uses only data that existed when the setup's candle closed, so the
// backtest can measure the real win rate of each grade.

import { deltaRatio } from './flow.js';
import { cotBias } from './cot.js';
import { inKillzone, swept, cvdSign } from './strategies.js';

export const FACTORS = [
  { id: 'htf', label: '1H trend agrees', weight: 20 },
  { id: 'ltf', label: '15m structure agrees', weight: 10 },
  { id: 'sweep', label: 'Liquidity swept first', weight: 15 },
  { id: 'delta', label: 'Order flow confirms (candle delta)', weight: 15 },
  { id: 'cvd', label: 'Cumulative delta rising with trade', weight: 10 },
  { id: 'cot', label: 'Big funds adding in trade direction (COT)', weight: 10 },
  { id: 'killzone', label: 'London or New York open', weight: 10 },
  { id: 'room', label: 'Clear path to target (no level in the way)', weight: 10 },
];

export const GRADES = [
  { id: 'A', min: 70 },
  { id: 'B', min: 50 },
  { id: 'C', min: 0 },
];

export const gradeOf = (score) => GRADES.find((g) => score >= g.min).id;


// Nearest swing on the target side that price has not yet traded through.
function room(ctx, s) {
  const { w, swings } = ctx;
  const L = w.length - 1;
  const bull = s.dir === 'bull';
  const risk = Math.abs(s.entry - s.stop);
  let nearest = null;
  for (const sw of swings) {
    if (sw.type !== (bull ? 'H' : 'L') || sw.confirmedAt > L) continue;
    if (bull ? sw.price <= s.entry : sw.price >= s.entry) continue;
    let taken = false;
    for (let k = sw.i + 1; k <= L && !taken; k++) taken = bull ? w[k].high > sw.price : w[k].low < sw.price;
    if (taken) continue;
    const d = Math.abs(sw.price - s.entry);
    if (nearest == null || d < nearest) nearest = d;
  }
  return nearest == null || nearest >= 2 * risk;
}

// Returns { score 0-100, grade, factors: [{id, label, ok}] }. Factors without
// data (no order flow, no COT) are left out, and the score is scaled to what
// could be measured.
export function scoreSetup(s, ctx, cot = null) {
  const { w, ms, htf } = ctx;
  const L = w.length - 1;
  const bull = s.dir === 'bull';
  const sign = bull ? 1 : -1;
  const out = [];
  const add = (id, ok) => {
    if (ok == null) return;
    const f = FACTORS.find((x) => x.id === id);
    out.push({ id, label: f.label, weight: f.weight, ok: !!ok });
  };
  add('htf', htf ? htf.trend === s.dir : null);
  add('ltf', ms.trend ? ms.trend === s.dir : false);
  add('sweep', swept(ctx, s.dir));
  const dr = deltaRatio(w[L]);
  add('delta', dr == null ? null : sign * dr > 0.05);
  const cv = cvdSign(w, L);
  if (cv != null) add('cvd', sign * cv > 0);
  const cb = cot ? cotBias(cot) : null;
  add('cot', cot ? cb === s.dir : null);
  add('killzone', inKillzone(w[L].time));
  add('room', room(ctx, s));
  const max = out.reduce((t, f) => t + f.weight, 0);
  const got = out.reduce((t, f) => t + (f.ok ? f.weight : 0), 0);
  const score = max ? Math.round((got / max) * 100) : 0;
  return { score, grade: gradeOf(score), factors: out };
}
