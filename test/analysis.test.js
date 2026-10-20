import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, atr, findSwings, liquidity, marketStructure, supplyDemand, volumeProfile, vwap } from '../shared/analysis.js';
import { positionSize } from '../public/calculator.js';

// Build candles from a list of closes; each candle opens at the previous close.
function series(closes, wick = 0.2) {
  return closes.map((close, i) => {
    const open = i ? closes[i - 1] : close;
    return { time: 1_700_000_000 + i * 60, open, close, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, volume: 100 };
  });
}

const zigzag = (points, steps = 6) => points.slice(1).flatMap((p, k) => Array.from({ length: steps }, (_, s) => points[k] + ((p - points[k]) * (s + 1)) / steps));

test('swings are confirmed only after the right-hand bars close', () => {
  const c = series(zigzag([100, 110, 104, 116, 108], 6));
  const sw = findSwings(c, 3);
  const highs = sw.filter((s) => s.type === 'H');
  assert.ok(highs.length >= 1);
  for (const s of sw) assert.equal(s.confirmedAt, s.i + 3);
});

test('a higher high breaks structure bullishly and leaves a bull order block', () => {
  const c = series(zigzag([100, 110, 104, 116, 108, 122], 6));
  const ms = marketStructure(c, findSwings(c, 3));
  const bull = ms.events.filter((e) => e.dir === 'bull');
  assert.ok(bull.length >= 1, 'expected a bullish break');
  assert.equal(ms.trend, 'bull');
  const e = bull[0];
  assert.ok(c[e.index].close > e.level);
  assert.ok(ms.orderBlocks.some((z) => z.kind === 'bullOB' && z.index < e.index));
});

test('a break against the trend is a CHoCH', () => {
  const c = series(zigzag([100, 110, 104, 116, 108, 122, 112, 118, 95], 6));
  const ms = marketStructure(c, findSwings(c, 3));
  const last = ms.events[ms.events.length - 1];
  assert.equal(last.dir, 'bear');
  assert.equal(last.type, 'CHoCH');
});

test('base then impulse forms a scored demand zone', () => {
  const closes = [...Array(30).fill(0).map((_, i) => 100 + Math.sin(i) * 0.6), 100.1, 100.05, 100.1, 104, 105, 105.5, 106];
  const c = series(closes, 0.1);
  const zones = supplyDemand(c, atr(c));
  const d = zones.find((z) => z.kind === 'demand' && z.createdIndex === 33);
  assert.ok(d, 'expected demand at the impulse');
  assert.ok(d.top > d.bottom);
  assert.ok(d.score > 0 && d.score <= 100);
  assert.equal(d.broken, false);
});

test('equal highs become a liquidity pool that is grabbed on a wick through', () => {
  const closes = zigzag([100, 110, 104, 110, 103], 6);
  const c = series(closes, 0.05);
  c.push({ time: c[c.length - 1].time + 60, open: 103, high: 111, low: 102.9, close: 104, volume: 100 });
  const { pools, sweeps } = liquidity(c, findSwings(c, 3), atr(c));
  assert.equal(pools.filter((p) => p.kind === 'EQH').length, 0, 'pool should be swept');
  assert.equal(sweeps.length, 1);
  assert.equal(sweeps[0].kind, 'EQH');
});

test('vwap resets at the anchor and falls back to equal weights without volume', () => {
  const c = series([10, 11, 12, 13]).map((x) => ({ ...x, volume: 0 }));
  const v = vwap(c, (t) => (t < c[2].time ? 0 : 1));
  assert.equal(v[2].value, (c[2].high + c[2].low + c[2].close) / 3);
  assert.ok(Math.abs(v[1].value - ((c[0].high + c[0].low + c[0].close) / 3 + (c[1].high + c[1].low + c[1].close) / 3) / 2) < 1e-9);
});

test('volume profile conserves volume and brackets the POC', () => {
  const c = series(zigzag([100, 110, 104, 116, 108], 6));
  const vp = volumeProfile(c, 40);
  const total = vp.bins.reduce((s, v) => s + v, 0);
  assert.ok(Math.abs(total - c.length * 100) < 1e-6);
  assert.ok(vp.val <= vp.pocPrice && vp.pocPrice <= vp.vah);
});

test('analyze returns the panels the UI reads', () => {
  const c = series(zigzag([100, 110, 104, 116, 108, 122, 112, 118, 95, 105, 99, 112], 8));
  const r = analyze(c);
  for (const k of ['atr', 'trend', 'events', 'zones', 'orderBlocks', 'levels', 'pools', 'sweeps']) assert.ok(k in r, k);
  assert.ok(r.zones.every((z) => !z.broken));
});

test('position size risks the chosen amount', () => {
  const r = positionSize({ balance: 10000, risk: 1, entry: 2400, stop: 2395, target: 2415, contract: 100 });
  assert.equal(r.side, 'Long');
  assert.equal(r.lots, 0.2);
  assert.equal(r.riskCash, 100);
  assert.equal(r.rr, 3);
  assert.equal(positionSize({ balance: 10000, risk: 1, entry: 2400, stop: 2400, contract: 100 }), null);
});
