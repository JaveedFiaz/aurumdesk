import test from 'node:test';
import assert from 'node:assert/strict';
import { memeMetrics, memeStatus } from '../public/memes.js';

const flat = (n, p = 1, v = 100) => Array.from({ length: n }, (_, i) => ({ time: i * 60, open: p, high: p * 1.001, low: p * 0.999, close: p, volume: v, buyVolume: v / 2 }));

test('memecoin radar: pump, dump and quiet', () => {
  const quiet = flat(80);
  assert.equal(memeStatus(quiet, memeMetrics(quiet)), null);

  const pump = flat(80);
  for (let k = 77; k < 80; k++) Object.assign(pump[k], { open: 1, close: 1.03, high: 1.031, low: 1, volume: 600, buyVolume: 450 });
  const m = memeMetrics(pump);
  assert.ok(m.volX >= 3 && m.buy >= 0.6 && m.m5 >= 0.02);
  assert.equal(memeStatus(pump, m).kind, 'pump');

  const dump = flat(80);
  for (let k = 77; k < 80; k++) Object.assign(dump[k], { open: 1, close: 0.97, high: 1, low: 0.969, volume: 600, buyVolume: 120 });
  assert.equal(memeStatus(dump, memeMetrics(dump)).kind, 'dump');
});

test('memecoin radar: fade setup after a 3% pump turns down', () => {
  const c = flat(80);
  // +4% in 5 minutes at bars 70-74, then a red closed candle at 78.
  for (let k = 70; k <= 74; k++) Object.assign(c[k], { close: 1 + 0.008 * (k - 69), open: 1 + 0.008 * (k - 70), high: 1 + 0.008 * (k - 69), low: 1 + 0.008 * (k - 70) });
  for (let k = 75; k < 80; k++) Object.assign(c[k], { open: 1.04, close: 1.04, high: 1.041, low: 1.039 });
  Object.assign(c[78], { open: 1.04, close: 1.03, high: 1.04, low: 1.029 });
  const st = memeStatus(c, memeMetrics(c));
  assert.equal(st.kind, 'fade-short');
  assert.ok(st.plan.stop > st.plan.entry && st.plan.target < st.plan.entry);
});
