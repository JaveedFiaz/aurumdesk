import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoTrader } from '../shared/autotrader.js';
import { CHECKS, buildContext } from '../shared/strategies.js';
import { MARKETS } from '../shared/markets.js';
import { analyze } from '../shared/bot.js';
import { getCandles } from '../shared/candles.js';
import { classify, parseCalendar, parseRss, createNews } from '../server/news.js';
import { createApp } from '../server/index.js';
import { createProviders } from '../server/providers/index.js';
import { createCotSource } from '../server/cot.js';
import { createPaper } from '../server/paper.js';

const T0 = Date.parse('2026-10-21T10:00:00Z') / 1000;
const GOLD = { id: 'gold', label: 'Gold', costBps: 1, step: 0.01 };
const BTC = { id: 'btc', label: 'Bitcoin', costBps: 2, step: 0.0001 };
const sig = (o = {}) => ({ tf: 'M5', strategy: 'trap_flow', signalTime: T0, status: 'pending', active: true, dir: 'bull', grade: 'A', score: 80, entry: 4000, stop: 3990, target: 4020, why: 'test', ...o });

test('auto-trader sizes to risk per market, charges costs and books the target', () => {
  let t = T0;
  const p = createAutoTrader({ now: () => t });
  p.configure({ startBalance: 10000, riskPct: 1 });
  p.onSignals([sig()], 4000, GOLD);
  let s = p.snapshot({ gold: 4000 });
  const pos = s.positions[0];
  assert.equal(pos.entry, 4000.2); // half of the 1 bp ($0.40) round-trip cost
  assert.equal(pos.units, 9.8); // $100 risk / $10.20 stop distance
  p.onSignals([sig({ entry: 70000, stop: 69800, target: 70400 })], 70000, BTC);
  s = p.snapshot({ gold: 4000, btc: 70000 });
  assert.equal(s.positions.length, 2);
  assert.equal(s.positions[1].market, 'btc');
  assert.ok(Math.abs(s.positions[1].units * (70007 - 69800) - 100) < 0.05, 'BTC sized to $100 risk in 0.0001 steps');
  t += 60;
  p.onPrice(4021, 'gold', { gold: 4021, btc: 70000 });
  s = p.snapshot({ gold: 4021, btc: 70000 });
  assert.equal(s.positions.length, 1, 'only the gold trade closed');
  assert.equal(s.history[0].reason, 'target');
  assert.ok(Math.abs(s.history[0].pnl - (4019.8 - 4000.2) * 9.8) < 1e-6);
  p.onSignals([sig()], 4000, GOLD);
  assert.equal(p.snapshot({}).positions.length, 1, 'the same setup is never taken twice');
});

test('auto-trader limits: unproven strategies, per-market cap, daily loss, runaway price, time stop', () => {
  let t = T0;
  const p = createAutoTrader({ now: () => t });
  p.configure({ riskPct: 2, maxOpen: 1, dailyLossPct: 3 });
  const n = () => p.snapshot({ gold: 4000 }).positions.length;
  p.onSignals([sig({ signalTime: T0 + 1, active: false })], 4000, GOLD);
  assert.equal(n(), 0, 'watch-only setups are not traded');
  p.onSignals([sig({ signalTime: T0 + 2 })], 4015, GOLD);
  assert.equal(n(), 0, 'reward/risk below 1.5 after the move');
  p.onSignals([sig({ signalTime: T0 + 3 }), sig({ signalTime: T0 + 4, tf: 'M1' })], 4000, GOLD);
  assert.equal(n(), 1, 'one open trade per market');
  p.onSignals([sig({ signalTime: T0 + 5, entry: 70000, stop: 69800, target: 70400 })], 70000, BTC);
  assert.equal(p.snapshot({}).positions.length, 2, 'the cap is per market');
  p.onPrice(3989, 'gold');
  p.onSignals([sig({ signalTime: T0 + 6 })], 4000, GOLD);
  p.onPrice(3989, 'gold');
  p.onSignals([sig({ signalTime: T0 + 7 })], 4000, GOLD);
  assert.ok(p.snapshot({}).log.some((l) => /daily loss limit/.test(l.msg)));
  t += 64 * 300 + 1; // 64 five-minute candles: BTC trade was M5
  p.onPrice(70010, 'btc');
  assert.equal(p.snapshot({}).history[0].reason, 'time');
  p.stop();
  p.onSignals([sig({ signalTime: T0 + 99 })], 4000, GOLD);
  assert.equal(p.snapshot({}).positions.length, 0, 'does nothing while stopped');
  assert.throws(() => p.configure({ riskPct: 50 }), /between/);
});

// 30 quiet candles, a swing high at 110, then a breakout above it that fails.
function trapSeries({ failVolume = 300, failBuy = 60 } = {}) {
  const closes = [...Array.from({ length: 30 }, (_, i) => 100 + (i % 2 ? 0.3 : -0.3)), 102, 104, 106, 108, 110, 108.5, 107, 106.5, 106, 105.8, 105.5, 106, 107, 108.5, 109.5, 111.2];
  const end = Date.parse('2026-10-21T08:00:00Z') / 1000;
  const c = closes.map((close, i) => {
    const open = i ? closes[i - 1] : close;
    return { time: end - (closes.length - i) * 300, open, close, high: Math.max(open, close) + 0.2, low: Math.min(open, close) - 0.2, volume: 100, buyVolume: 50 };
  });
  c.push({ time: end, open: 111.2, close: 108.9, high: 111.9, low: 108.7, volume: failVolume, buyVolume: failBuy });
  return c;
}

test('trap: a breakout that closes back inside on seller volume is a sell, with the stop above the trap high', () => {
  const ctx = buildContext(trapSeries(), { trend: 'bear', zones: [] });
  const s = CHECKS.trap(ctx);
  assert.ok(s, 'expected a trap');
  assert.equal(s.dir, 'bear');
  assert.equal(s.trap, true);
  assert.ok(s.stop > 111.9 && s.level > 110 && s.level < 110.5);
  assert.ok(CHECKS.trap_trend(ctx), 'with the higher-timeframe trend');
  assert.equal(CHECKS.trap_trend(buildContext(trapSeries(), { trend: 'bull', zones: [] })), null);
  assert.equal(CHECKS.trap(buildContext(trapSeries({ failVolume: 90, failBuy: 20 }), null)), null, 'needs above-average volume');
  assert.equal(CHECKS.trap(buildContext(trapSeries({ failBuy: 200 }), null)), null, 'needs sellers in control');
});

test('playbook: every listed strategy exists and analyze() carries stats into the live scan', async () => {
  for (const m of MARKETS) for (const play of Object.values(m.plays)) for (const s of play.strategies) assert.equal(typeof CHECKS[s.id], 'function', s.id);
  const { providers } = createProviders({ PROVIDER: 'demo' });
  const c = (await getCandles(providers.btc, 'M5', 2500, { maxCandles: 2600 })).slice(0, -1);
  const h = (await getCandles(providers.btc, 'H1', 600, { maxCandles: 700 })).slice(0, -1);
  const opts = { tf: { id: 'M5', sec: 300 }, htf: { id: 'H1', sec: 3600 }, include: [{ id: 'trap_flow', rr: 2 }] };
  const full = analyze(c, h, opts);
  assert.equal(full.stats[0].rr, 2);
  const live = analyze(c, h, { ...opts, prior: full });
  assert.deepEqual(live.stats, full.stats);
  assert.equal(live.recent.length, full.recent.length);
  assert.deepEqual(live.signals, full.signals);
  for (const t of full.recent) assert.equal(t.tf, 'M5');
});

test('news: RSS parsing, impact and bias tags, calendar filter, and new headlines surface once', async () => {
  const xml = `<rss><channel>
    <item><title><![CDATA[Gold falls as Fed signals rate hike &amp; dollar climbs]]></title><link>https://example.com/a</link><pubDate>Wed, 21 Oct 2026 09:59:00 GMT</pubDate></item>
    <item><title>Bitcoin ETF inflow hits record high</title><link>javascript:alert(1)</link></item>
    <item><title>Local bakery wins award</title></item></channel></rss>`;
  const items = parseRss(xml, 'Test');
  assert.equal(items.length, 3);
  assert.equal(items[0].title, 'Gold falls as Fed signals rate hike & dollar climbs');
  assert.equal(items[1].link, '', 'non-http links are dropped');
  const g = classify(items[0].title);
  assert.deepEqual([g.impact, g.bias.gold, g.markets.includes('gold')], ['high', 'bear', true]);
  assert.equal(classify(items[1].title).bias.btc, 'bull');
  assert.deepEqual(classify(items[2].title).markets, []);
  const cal = parseCalendar([{ title: 'CPI m/m', country: 'USD', impact: 'High', date: '2026-10-21T12:30:00-04:00', forecast: '0.3%' }, { title: 'Minor', country: 'USD', impact: 'Low', date: '2026-10-21T12:30:00-04:00' }, { title: 'ECB', country: 'EUR', impact: 'High', date: '2026-10-21T12:30:00-04:00' }], T0);
  assert.deepEqual(cal.map((e) => e.title), ['CPI m/m']);

  let body = xml;
  let clock = T0;
  const news = createNews({ now: () => clock, fetchImpl: async (url) => ({ ok: true, text: async () => body, json: async () => [{ title: 'CPI m/m', country: 'USD', impact: 'High', date: new Date((T0 + 120) * 1000).toISOString() }] }) });
  await news.tick();
  assert.equal(news.list().items.length, 2, 'the irrelevant headline is filtered out');
  assert.match(news.pauseReason(300), /CPI/);
  clock = T0 + 5;
  body = xml.replace('<channel>', '<channel><item><title>Bitcoin plunges after exchange hack</title></item>');
  await news.tick();
  const l = news.list();
  assert.equal(l.items.length, 3);
  assert.equal(l.items[0].title, 'Bitcoin plunges after exchange hack');
  assert.equal(l.items[0].seenAt, T0 + 5, 'stamped when first seen');
});

test('HTTP API: both markets, every timeframe, flow, news, COT, stream and a guarded auto-trader', async (t) => {
  const { providers, flowProviders } = createProviders({ PROVIDER: 'demo' });
  const server = createApp({ providers, flowProviders, historyScale: 0.02, useWorker: false, pollMs: 50, cotSource: createCotSource({ demo: true }), paper: createPaper(), adminToken: 'secret' });
  await new Promise((r) => server.listen(0, r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p) => (await fetch(base + p)).json();

  const cfg = await get('/api/config');
  assert.deepEqual(cfg.markets.map((m) => m.id), ['gold', 'btc']);
  assert.deepEqual(cfg.tfs, ['M1', 'M5', 'M15']);

  let bot;
  for (let k = 0; k < 200; k++) {
    bot = await get('/api/bot?market=btc');
    if (Object.values(bot.tfs).every((x) => !x.pending)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const tf of ['M1', 'M5', 'M15']) {
    assert.ok(Array.isArray(bot.tfs[tf].stats) && Array.isArray(bot.tfs[tf].signals) && Array.isArray(bot.tfs[tf].areas), tf);
    assert.equal(bot.tfs[tf].tf, tf);
  }
  assert.ok(bot.price > 50000, 'btc demo price is scaled');
  assert.equal((await fetch(`${base}/api/bot?market=doge`)).status, 400);

  assert.equal((await get('/api/candles?market=gold&tf=M1&limit=50')).candles.length, 50);
  assert.equal((await fetch(`${base}/api/candles?market=gold&tf=X9`)).status, 400);
  const flow = await get('/api/flow?market=btc&tf=M1');
  assert.ok(flow.available && flow.delta.length > 50 && flow.book.bids.length);
  assert.ok((await get('/api/news')).items.length > 0);
  assert.equal((await get('/api/cot')).available, true);
  assert.equal((await fetch(`${base}/index.html`)).status, 200);
  assert.equal((await fetch(`${base}/shared/markets.js`)).status, 200);
  assert.equal((await fetch(`${base}/vendor/lightweight-charts.js`)).status, 200);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);

  const post = (body, token) => fetch(`${base}/api/paper`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Admin-Token': token } : {}) }, body: JSON.stringify(body) });
  assert.equal((await post({ action: 'stop' })).status, 401);
  const ok = await (await post({ config: { startBalance: 3000 }, action: 'stop' }, 'secret')).json();
  assert.deepEqual([ok.enabled, ok.startBalance], [false, 3000]);
  assert.equal((await post({ config: { riskPct: 99 } }, 'secret')).status, 400);

  const res = await fetch(`${base}/api/stream`);
  const reader = res.body.getReader();
  let buf = '';
  while (!(buf.includes('"m":"gold"') && buf.includes('"m":"btc"'))) buf += new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
});
