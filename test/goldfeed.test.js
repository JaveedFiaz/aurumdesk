import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoldCandles, aggregate, parseFutures } from '../server/goldfeed.js';

test('spot ticks build 1m candles and aggregate to 5m', async () => {
  const g = createGoldCandles({ fetchImpl: async () => ({ ok: false, status: 451 }) });
  const t0 = 1_700_000_000 - (1_700_000_000 % 300);
  [[0, 10], [10, 12], [50, 9], [60, 11], [130, 13], [301, 14]].forEach(([dt, p]) => g.onSpot(p, t0 + dt));
  const m1 = (await g.get('M1', 10)).candles;
  assert.equal(m1[0].time, t0 + 60); // the first, possibly partial, bucket is dropped
  const all = aggregate([{ time: t0, open: 10, high: 12, low: 9, close: 9 }, { time: t0 + 60, open: 9, high: 11, low: 9, close: 11 }], 300);
  assert.deepEqual(all, [{ time: t0, open: 10, high: 12, low: 9, close: 11 }]);
  const r = await g.get('M5', 10);
  assert.equal(r.source, 'Swissquote spot ticks');
  assert.equal(r.candles[r.candles.length - 1].close, 14);
});

test('perpetual candles are used when available and shifted onto spot', async () => {
  const rows = [[1_700_000_000_000, '100', '102', '99', '101', '5', 0, 0, 0, '3']];
  assert.deepEqual(parseFutures(rows)[0], { time: 1_700_000_000, open: 100, high: 102, low: 99, close: 101, volume: 5, buyVolume: 3 });
  const g = createGoldCandles({ fetchImpl: async () => ({ ok: true, json: async () => rows }) });
  const r = await g.get('M1', 10, 103);
  assert.match(r.source, /perpetual/);
  assert.equal(r.candles[0].close, 103);
  assert.equal(r.candles[0].open, 102);
});
