import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYahoo } from '../server/providers/yahoo.js';

test('yahoo chart data: hourly bars on the half hour are bucketed to the hour, gaps skipped', () => {
  const t = 1795000000 - (1795000000 % 3600);
  const j = { chart: { result: [{ meta: { dataGranularity: '60m' }, timestamp: [t, t + 1800, t + 3600, t + 7200], indicators: { quote: [{ open: [1, 2, null, 4], high: [2, 3, null, 5], low: [0.5, 1.5, null, 3.5], close: [1.5, 2.5, null, 4.5], volume: [10, 20, null, 40] }] } }] } };
  const c = parseYahoo(j);
  assert.deepEqual(c.map((x) => x.time), [t, t + 7200]);
  assert.deepEqual([c[0].high, c[0].low, c[0].close, c[0].volume], [3, 0.5, 2.5, 30]);
});
