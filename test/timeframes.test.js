import test from 'node:test';
import assert from 'node:assert/strict';
import { TF, aggregate, bucketStart, pickNative, shiftBucket } from '../shared/timeframes.js';

const utc = (s) => Date.parse(`${s}Z`) / 1000;

test('buckets align to calendar boundaries', () => {
  assert.equal(bucketStart(TF.M45, utc('2026-10-20T10:50:00')), utc('2026-10-20T10:30:00'));
  assert.equal(bucketStart(TF.H4, utc('2026-10-20T10:50:00')), utc('2026-10-20T08:00:00'));
  assert.equal(bucketStart(TF.W1, utc('2026-10-22T10:00:00')), utc('2026-10-19T00:00:00')); // Monday
  assert.equal(bucketStart(TF.MN, utc('2026-10-20T10:00:00')), utc('2026-10-01T00:00:00'));
  assert.equal(bucketStart(TF['3M'], utc('2026-11-20T10:00:00')), utc('2026-10-01T00:00:00'));
  assert.equal(bucketStart(TF['6M'], utc('2026-05-20T10:00:00')), utc('2026-01-01T00:00:00'));
  assert.equal(shiftBucket(TF['3M'], utc('2026-10-01T00:00:00'), 1), utc('2027-01-01T00:00:00'));
});

test('pickNative chooses the coarsest interval that tiles the timeframe', () => {
  const natives = [{ id: '1m', sec: 60 }, { id: '5m', sec: 300 }, { id: '15m', sec: 900 }, { id: '30m', sec: 1800 }, { id: '1d', sec: 86400 }, { id: '1w', sec: 604800, week: true }, { id: '1M', months: 1 }];
  assert.equal(pickNative(TF.M10, natives).id, '5m');
  assert.equal(pickNative(TF.M45, natives).id, '15m');
  assert.equal(pickNative(TF.W1, natives).id, '1w');
  assert.equal(pickNative(TF['6M'], natives).id, '1M');
  assert.equal(pickNative(TF.MN, natives.filter((n) => !n.months)).id, '1d');
});

test('aggregate merges OHLCV into buckets', () => {
  const base = utc('2026-10-20T10:00:00');
  const c = [0, 1, 2, 3].map((k) => ({ time: base + k * 300, open: 10 + k, high: 12 + k, low: 9 + k, close: 11 + k, volume: 1 }));
  const out = aggregate(c, TF.M10);
  assert.deepEqual(out, [
    { time: base, open: 10, high: 13, low: 9, close: 12, volume: 2 },
    { time: base + 600, open: 12, high: 15, low: 11, close: 14, volume: 2 },
  ]);
});
