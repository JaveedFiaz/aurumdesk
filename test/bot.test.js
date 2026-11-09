import test from 'node:test';
import assert from 'node:assert/strict';
import { backtest, manage, runBot, summarize } from '../shared/bot.js';
import { DEFAULT_RULES, STRATEGIES, inSession } from '../shared/strategies.js';
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

test('every trade has a stop on the right side and a 2R target', async () => {
  const p = createDemo({ now: () => NOW });
  const c = await getCandles(p, 'M15', 3000, { maxCandles: 3100 });
  const h = await getCandles(p, 'H1', 1100, { maxCandles: 1200 });
  const trades = backtest(c, h);
  for (const t of trades) {
    const sign = t.dir === 'bull' ? 1 : -1;
    assert.ok(sign * (t.entry - t.stop) > 0, 'stop beyond entry');
    assert.ok(Math.abs(Math.abs(t.target - t.entry) - 2 * Math.abs(t.entry - t.stop)) < 1e-6, '2R target');
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

test('HTTP API serves the trade finder', async (t) => {
  const server = createApp({ provider: createDemo(), botHistory: 1500 });
  await new Promise((res) => server.listen(0, res));
  t.after(() => server.close());
  const j = await (await fetch(`http://127.0.0.1:${server.address().port}/api/bot`)).json();
  assert.equal(j.tf, 'M15');
  assert.equal(j.stats.length, STRATEGIES.length);
});
