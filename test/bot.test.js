import test from 'node:test';
import assert from 'node:assert/strict';
import { backtest, manage, runBot, summarize } from '../shared/bot.js';
import { DEFAULT_RULES, STRATEGIES, STRATEGY_BY_ID, inSession } from '../shared/strategies.js';
import { createDemo } from '../server/providers/demo.js';
import { getCandles } from '../shared/candles.js';
import { createApp } from '../server/index.js';

const utc = (s) => Date.parse(`${s}Z`) / 1000;
const NOW = utc('2026-10-23T18:00:00');

test('session filter covers London and New York weekday hours only', () => {
  assert.equal(inSession(utc('2026-10-21T10:00:00')), true); // Wed, London morning
  assert.equal(inSession(utc('2026-10-21T19:00:00')), true); // Wed, New York afternoon
  assert.equal(inSession(utc('2026-10-21T03:00:00')), false); // Asia
  assert.equal(inSession(utc('2026-10-24T12:00:00')), false); // Saturday
});

test('trade management: stop wins a same-bar tie, cost is charged, time stop closes', () => {
  const rules = { ...DEFAULT_RULES, cost: 0.5, maxBars: 2 };
  const t = { dir: 'bull', entry: 100, stop: 95, target: 110, risk: 5, bars: 0, status: 'open' };
  manage(t, { time: 1, open: 100, high: 111, low: 94, close: 100 }, rules);
  assert.equal(t.reason, 'stop');
  assert.equal(t.r, (-5 - 0.5) / 5);

  const w = { dir: 'bear', entry: 100, stop: 105, target: 90, risk: 5, bars: 0, status: 'open' };
  manage(w, { time: 1, open: 100, high: 101, low: 89, close: 90 }, rules);
  assert.equal(w.reason, 'target');
  assert.equal(w.r, (10 - 0.5) / 5);

  const s = { dir: 'bull', entry: 100, stop: 95, target: 110, risk: 5, bars: 0, status: 'open' };
  manage(s, { time: 1, open: 100, high: 102, low: 99, close: 101 }, rules);
  assert.equal(s.status, 'open');
  manage(s, { time: 2, open: 101, high: 103, low: 99, close: 102 }, rules);
  assert.equal(s.reason, 'time');
  assert.equal(s.exit, 102);
});

test('backtest never looks ahead: adding future candles does not change earlier signals', async () => {
  const p = createDemo({ now: () => NOW });
  const c = await getCandles(p, 'M15', 3000, { maxCandles: 3100 });
  const h = await getCandles(p, 'H1', 1100, { maxCandles: 1200 });
  const cut = c.length - 400;
  const cutTime = c[cut].time;
  const key = (t) => `${t.strategy}:${t.signalTime}:${t.dir}:${t.stop}`;
  const early = backtest(c.slice(0, cut), h.filter((x) => x.time + 3600 <= cutTime)).map(key);
  const full = backtest(c, h).filter((t) => t.signalTime < cutTime).map(key);
  assert.ok(full.length > 0, 'expected some signals in the demo history');
  assert.deepEqual(full, early);
});

test('every trade has a stop on the right side and its strategy\'s R target', async () => {
  const p = createDemo({ now: () => NOW });
  const c = await getCandles(p, 'M15', 3000, { maxCandles: 3100 });
  const h = await getCandles(p, 'H1', 1100, { maxCandles: 1200 });
  const trades = backtest(c, h);
  for (const t of trades) {
    const sign = t.dir === 'bull' ? 1 : -1;
    assert.ok(sign * (t.entry - t.stop) > 0, 'stop beyond entry');
    assert.ok(Math.abs(Math.abs(t.target - t.entry) - STRATEGY_BY_ID[t.strategy].rr * Math.abs(t.entry - t.stop)) < 1e-6, `${t.strategy} target`);
    if (t.status === 'closed') assert.ok(t.exitTime >= t.entryTime);
  }
});

test('a strategy is active only if it holds up overall and out of sample', () => {
  const mk = (r, k) => ({ strategy: 'x', status: 'closed', r, signalTime: k });
  const good = Array.from({ length: 30 }, (_, k) => mk(k % 2 ? 2 : -1, k));
  assert.equal(summarize(good, 'x', 18).active, true);
  const fades = Array.from({ length: 30 }, (_, k) => mk(k < 18 ? (k % 2 ? 2 : -1) : -1, k));
  const s = summarize(fades, 'x', 18);
  assert.ok(s.outSample.expR < 0);
  assert.equal(s.active, false);
  assert.equal(summarize(good.slice(0, 10), 'x', 6).active, false, 'too few trades');
});

test('runBot reports every strategy and only signals from active ones', async () => {
  const r = await runBot({ provider: createDemo({ now: () => NOW }), now: NOW, history: 3000 });
  assert.equal(r.stats.length, STRATEGIES.length);
  const active = new Set(r.stats.filter((s) => s.active).map((s) => s.id));
  for (const t of r.signals) assert.ok(active.has(t.strategy));
  assert.ok(r.to <= NOW);
});


// A rally to 110, a pullback, then a high-volume close through 110 at the London open.
function breakoutSeries() {
  const pts = [100, 110, 104];
  const closes = Array.from({ length: 20 }, (_, i) => 100 + (i % 2 ? 0.3 : -0.3));
  for (let k = 1; k < pts.length; k++) for (let s = 1; s <= 12; s++) closes.push(pts[k - 1] + ((pts[k] - pts[k - 1]) * s) / 12);
  const end = utc('2026-10-21T08:00:00');
  const c = closes.map((close, i) => {
    const open = i ? closes[i - 1] : close;
    return { time: end - (closes.length - i) * 900, open, close, high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2, volume: 100, buyVolume: 50 };
  });
  c.push({ time: end, open: 104.2, close: 111.5, high: 111.7, low: 104.1, volume: 400, buyVolume: 320 });
  return c;
}

test('volume breakout fires on a high-volume close through a fresh swing high at the open', async () => {
  const { CHECKS, buildContext } = await import('../shared/strategies.js');
  const c = breakoutSeries();
  const sig = CHECKS.vol_breakout(buildContext(c, { trend: 'bull', zones: [] }));
  assert.ok(sig, 'expected a breakout');
  assert.equal(sig.dir, 'bull');
  assert.ok(sig.stop < sig.entry);
  assert.equal(CHECKS.vol_breakout(buildContext(c, { trend: 'bear', zones: [] })), null, '1H trend must agree');
  const quiet = c.map((x, i) => (i === c.length - 1 ? { ...x, volume: 120, buyVolume: 90 } : x));
  assert.equal(CHECKS.vol_breakout(buildContext(quiet, { trend: 'bull', zones: [] })), null, 'needs 2x volume');
  const late = c.map((x) => ({ ...x, time: x.time + 4 * 3600 }));
  assert.equal(CHECKS.vol_breakout(buildContext(late, { trend: 'bull', zones: [] })), null, 'only at the London/NY open');
});

test('buy/sell areas: breakout trigger above price in a 1H uptrend, with stop and target on every area', async () => {
  const { tradeAreas, buildContext } = await import('../shared/strategies.js');
  const c = breakoutSeries().slice(0, -1);
  const { triggers, areas } = tradeAreas(buildContext(c, { trend: 'bull', zones: [] }));
  assert.equal(triggers.length, 1);
  assert.equal(triggers[0].dir, 'bull');
  assert.ok(triggers[0].price > c[c.length - 1].close);
  for (const a of areas) assert.ok(a.dir === 'bull' ? a.stop < a.bottom && a.target > a.top : a.stop > a.top && a.target < a.bottom);
});

test('runBot downloads history once, then only the latest candles', async () => {
  const base = createDemo({ now: () => NOW });
  const calls = [];
  const provider = { ...base, fetchCandles: (iv, n) => { calls.push(n); return base.fetchCandles(iv, n); } };
  const cache = {};
  await runBot({ provider, now: NOW, history: 3000, cache });
  const first = calls.reduce((s, n) => s + n, 0);
  calls.length = 0;
  const r = await runBot({ provider, now: NOW, history: 3000, cache });
  assert.ok(calls.every((n) => n <= 600), `second run fetched ${calls}`);
  assert.ok(first > 3000);
  assert.ok(Array.isArray(r.areas) && Array.isArray(r.triggers));
});
