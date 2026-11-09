import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaper, paperBroker } from '../server/paper.js';
import { bookStats, deltaSeries, tradeFlow, whales } from '../shared/flow.js';
import { cotAt, cotBias, cotMetrics, demoCot, parseCot } from '../shared/cot.js';
import { FACTORS, gradeOf, scoreSetup } from '../shared/confluence.js';
import { buildContext } from '../shared/strategies.js';
import { createApp } from '../server/index.js';
import { createDemo } from '../server/providers/demo.js';
import { createCotSource } from '../server/cot.js';

const T0 = Date.parse('2026-10-21T10:00:00Z') / 1000;
const signal = (o = {}) => ({ strategy: 'zone_retest', signalTime: T0, status: 'pending', active: true, dir: 'bull', grade: 'A', score: 80, entry: 2400, stop: 2390, target: 2420, why: 'test', ...o });

test('auto-trader sizes to risk, takes profit and books P&L after costs', () => {
  let t = T0;
  const p = createPaper({ broker: paperBroker({ cost: 0.4 }), now: () => t });
  p.configure({ startBalance: 10000, riskPct: 1 });
  p.start();
  p.onSignals([signal()], 2400);
  let s = p.snapshot(2400);
  assert.equal(s.positions.length, 1);
  const pos = s.positions[0];
  assert.equal(pos.entry, 2400.2); // paid half the spread
  assert.equal(pos.units, 9.8); // $100 risk / $10.20 stop distance = 9.80 oz
  assert.ok(pos.riskCash <= 100);
  t += 600;
  p.onPrice(2421);
  s = p.snapshot(2421);
  assert.equal(s.positions.length, 0);
  const h = s.history[0];
  assert.equal(h.reason, 'target');
  assert.ok(Math.abs(h.pnl - (2419.8 - 2400.2) * 9.8) < 1e-6); // target fill minus half spread
  assert.ok(Math.abs(s.balance - (10000 + h.pnl)) < 1e-6);
  p.onSignals([signal()], 2400);
  assert.equal(p.snapshot(2400).positions.length, 0, 'the same setup is never taken twice');
});

test('auto-trader respects grade, open-trade cap, daily loss limit and stale prices', () => {
  let t = T0;
  const p = createPaper({ broker: paperBroker({ cost: 0 }), now: () => t });
  p.configure({ startBalance: 10000, riskPct: 2, maxOpen: 1, dailyLossPct: 3, minGrade: 'A' });
  p.onSignals([signal()], 2400);
  assert.equal(p.snapshot(2400).positions.length, 0, 'does nothing while stopped');
  p.start();
  p.onSignals([signal({ signalTime: T0 + 1, grade: 'B' })], 2400);
  assert.equal(p.snapshot(2400).positions.length, 0, 'grade B skipped in A-only mode');
  p.onSignals([signal({ signalTime: T0 + 2, active: false })], 2400);
  assert.equal(p.snapshot(2400).positions.length, 0, 'unproven strategy skipped');
  p.onSignals([signal({ signalTime: T0 + 3 })], 2415);
  assert.equal(p.snapshot(2415).positions.length, 0, 'price ran away: reward/risk below 1.5');
  p.onSignals([signal({ signalTime: T0 + 4 }), signal({ signalTime: T0 + 5, strategy: 'vwap_pullback' })], 2400);
  assert.equal(p.snapshot(2400).positions.length, 1, 'max one open trade');
  p.onPrice(2389); // -2%
  p.onSignals([signal({ signalTime: T0 + 6 })], 2400);
  p.onPrice(2389); // -2% again: day is now -4%
  p.onSignals([signal({ signalTime: T0 + 7 })], 2400);
  const s = p.snapshot(2400);
  assert.equal(s.positions.length, 0, 'daily loss limit blocks new trades');
  assert.ok(s.log.some((l) => /daily loss limit/.test(l.msg)));
  t += 86400;
  p.onSignals([signal({ signalTime: T0 + 8 })], 2400);
  assert.equal(p.snapshot(2400).positions.length, 1, 'a new day resets the limit');
});

test('auto-trader validates settings', () => {
  const p = createPaper();
  assert.throws(() => p.configure({ riskPct: 50 }), /between/);
  assert.throws(() => p.configure({ startBalance: 'lots' }), /number/);
  assert.throws(() => p.configure({ minGrade: 'Z' }), /A, B or C/);
  p.configure({ startBalance: 2500 });
  assert.equal(p.snapshot(0).balance, 2500);
});

test('order flow: delta, aggressor split, whales and book walls', () => {
  const d = deltaSeries([{ time: 1, volume: 10, buyVolume: 7 }, { time: 2, volume: 10, buyVolume: 2 }]);
  assert.deepEqual(d.map((x) => [x.delta, x.cvd]), [[4, 4], [-6, -2]]);
  assert.deepEqual(deltaSeries([{ time: 1, volume: 5 }]), []);

  const trades = Array.from({ length: 200 }, (_, k) => ({ time: k, price: 2400, size: k === 150 ? 50 : 1, side: k % 3 ? 'buy' : 'sell' }));
  const w = whales(trades);
  assert.equal(w.list.length, 1);
  assert.equal(w.list[0].size, 50);
  assert.equal(w.list[0].notional, 120000);
  assert.ok(Math.abs(tradeFlow(trades).buyPct - 133 / 249) < 1e-9); // trade 150 (50 oz) is a sell

  const lv = (p0, dir) => Array.from({ length: 40 }, (_, k) => ({ price: p0 + dir * k * 0.5, size: k === 10 ? 40 : 1 }));
  const b = bookStats({ bids: lv(2399.9, -1), asks: lv(2400.1, 1) });
  assert.equal(b.bidWalls.length, 1);
  assert.equal(b.askWalls.length, 1);
  assert.ok(b.bidWalls[0].price < 2400 && b.askWalls[0].price > 2400);
  assert.ok(Math.abs(b.spread - 0.2) < 1e-9);
});

test('COT: parsing, index, bias and publication delay', () => {
  const rows = parseCot([
    { report_date_as_yyyy_mm_dd: '2026-10-13T00:00:00.000', noncomm_positions_long_all: '300', noncomm_positions_short_all: '100', comm_positions_long_all: '50', comm_positions_short_all: '250', open_interest_all: '900' },
    { report_date_as_yyyy_mm_dd: '2026-10-06T00:00:00.000', noncomm_positions_long_all: '250', noncomm_positions_short_all: '100', comm_positions_long_all: '80', comm_positions_short_all: '250', open_interest_all: '880' },
  ]);
  assert.equal(rows[0].specNet, 150); // sorted oldest first
  const m = cotMetrics(rows);
  assert.equal(m[1].specChange, 50);
  assert.equal(m[1].specIndex, 100);
  assert.equal(cotBias(m[1]), 'bull');
  const tue = Date.parse('2026-10-13T00:00:00Z') / 1000;
  assert.equal(cotAt(m, tue + 86400), m[0], 'Tuesday data is not public until Friday');
  assert.equal(cotAt(m, tue + 4 * 86400), m[1]);
  assert.ok(demoCot(T0).length > 100);
});

test('confluence: every factor counts, missing data is left out, grades follow the score', () => {
  const c = Array.from({ length: 120 }, (_, i) => {
    const o = 2400 + Math.sin(i / 6) * 8;
    const cl = o + (i % 2 ? 1 : -1);
    return { time: T0 - (120 - i) * 900, open: o, close: cl, high: Math.max(o, cl) + 1, low: Math.min(o, cl) - 1, volume: 100, buyVolume: 60 };
  });
  const ctx = buildContext(c, { trend: 'bull', zones: [] });
  const s = { dir: 'bull', entry: c[119].close, stop: c[119].close - 5 };
  const r = scoreSetup(s, ctx, { specChange: 10 });
  assert.equal(r.factors.length, FACTORS.length);
  assert.ok(r.factors.find((f) => f.id === 'htf').ok);
  assert.ok(r.factors.find((f) => f.id === 'delta').ok);
  assert.ok(r.factors.find((f) => f.id === 'cot').ok);
  const noFlow = scoreSetup(s, buildContext(c.map(({ buyVolume, ...x }) => x), null), null);
  assert.ok(!noFlow.factors.some((f) => ['delta', 'cvd', 'cot', 'htf'].includes(f.id)));
  assert.equal(gradeOf(70), 'A');
  assert.equal(gradeOf(69), 'B');
  assert.equal(gradeOf(10), 'C');
});

test('HTTP API: order flow, COT, and an auto-trader guarded by the admin token', async (t) => {
  const provider = createDemo();
  const server = createApp({ provider, botHistory: 1500, cotSource: createCotSource({ demo: true }), paper: createPaper(), adminToken: 'secret' });
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;

  const flow = await (await fetch(`${base}/api/flow?tf=M15`)).json();
  assert.equal(flow.available, true);
  assert.ok(flow.delta.length > 50 && flow.book.bids.length && flow.whales.list.length >= 0);
  assert.equal((await fetch(`${base}/api/flow?tf=X`)).status, 400);

  const cot = await (await fetch(`${base}/api/cot`)).json();
  assert.equal(cot.available, true);
  assert.ok(cot.latest.specIndex >= 0 && cot.latest.specIndex <= 100);

  const bot = await (await fetch(`${base}/api/bot`)).json();
  assert.equal(bot.grades.length, 3);
  for (const tr of bot.recent) assert.ok(['A', 'B', 'C'].includes(tr.grade) && tr.factors.length);

  const post = (body, token) => fetch(`${base}/api/paper`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Admin-Token': token } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ action: 'start' })).status, 401);
  const ok = await (await post({ config: { startBalance: 3000, minGrade: 'B' }, action: 'start' }, 'secret')).json();
  assert.equal(ok.enabled, true);
  assert.equal(ok.startBalance, 3000);
  assert.equal((await post({ config: { riskPct: 99 } }, 'secret')).status, 400);
  const stopped = await (await post({ action: 'stop' }, 'secret')).json();
  assert.equal(stopped.enabled, false);
});
