import test from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, weekendClosed } from '../shared/strategies.js';

const bar = (i, o, h, l, c) => ({ time: 1794700800 + i * 300, open: o, high: h, low: l, close: c, volume: 10, buyVolume: 5 });

test('liquidity sweep: a red candle that runs the latest swing high and closes back below it, with the 1H trend down', () => {
  const w = [];
  for (let i = 0; i < 30; i++) w.push(bar(i, 100, 100.5, 99.5, 100));
  w[20] = bar(20, 100, 103, 99.8, 100.2); // swing high 103, 4 lower highs each side
  w.push(bar(30, 102.5, 103.4, 101.5, 101.8)); // sweeps 103, closes back below as a red candle
  const sell = CHECKS.liq_sweep({ w, htf: { emaTrend: 'bear' } });
  assert.equal(sell.dir, 'bear');
  assert.equal(sell.level, 103);
  assert.ok(Math.abs(sell.stop - 101.8 * 1.0026) < 1e-9 && sell.fixedStop);
  assert.equal(CHECKS.liq_sweep({ w, htf: { emaTrend: 'bull' } }), null); // against the trend
  w.splice(27, 1, bar(27, 100, 103.2, 99.8, 100)); // the swing was already run 3 candles ago: used up
  assert.equal(CHECKS.liq_sweep({ w, htf: { emaTrend: 'bear' } }), null);
});

test('gold market hours', () => {
  assert.equal(weekendClosed(Date.UTC(2026, 10, 14, 12) / 1000), true); // Saturday
  assert.equal(weekendClosed(Date.UTC(2026, 10, 16, 12) / 1000), false); // Monday
  assert.equal(weekendClosed(Date.UTC(2026, 10, 13, 21, 30) / 1000), true); // Friday after 21:00
});
