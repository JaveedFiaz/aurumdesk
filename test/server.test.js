import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, getCandles } from '../server/index.js';
import { createDemo } from '../server/providers/demo.js';
import { createBinance } from '../server/providers/binance.js';
import { parseTime } from '../server/providers/twelvedata.js';
import { TIMEFRAMES, TF, bucketStart } from '../shared/timeframes.js';

test('every timeframe builds from the demo provider with valid, ordered candles', async () => {
  const provider = createDemo();
  for (const tf of TIMEFRAMES) {
    const c = await getCandles(provider, tf.id, 120);
    assert.ok(c.length > 0, tf.id);
    for (let i = 0; i < c.length; i++) {
      const x = c[i];
      assert.ok(x.high >= Math.max(x.open, x.close) && x.low <= Math.min(x.open, x.close), `${tf.id} OHLC`);
      assert.equal(x.time, bucketStart(TF[tf.id], x.time), `${tf.id} aligned`);
      if (i) assert.ok(x.time > c[i - 1].time, `${tf.id} ordered`);
    }
  }
});

test('binance klines are paginated backwards and parsed', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(url);
    const end = new URL(url).searchParams.get('endTime');
    const lim = +new URL(url).searchParams.get('limit');
    const last = end ? +end + 1 - 60000 : 1_700_000_000_000;
    const rows = Array.from({ length: lim }, (_, k) => {
      const t = last - (lim - 1 - k) * 60000;
      return [t, '2400.1', '2401', '2399', '2400.5', '12.5', t + 59999];
    });
    return { ok: true, json: async () => rows };
  };
  try {
    const c = await createBinance().fetchCandles('1m', 1500);
    assert.equal(calls.length, 2);
    assert.equal(c.length, 1500);
    assert.deepEqual(c[c.length - 1], { time: 1_700_000_000, open: 2400.1, high: 2401, low: 2399, close: 2400.5, volume: 12.5 });
    for (let i = 1; i < c.length; i++) assert.equal(c[i].time - c[i - 1].time, 60);
  } finally {
    globalThis.fetch = orig;
  }
});

test('twelve data timestamps parse as UTC', () => {
  assert.equal(parseTime('2026-10-20 10:15:00'), Date.parse('2026-10-20T10:15:00Z') / 1000);
  assert.equal(parseTime('2026-10-20'), Date.parse('2026-10-20T00:00:00Z') / 1000);
});

test('HTTP API serves config, candles, static files and a live stream', async (t) => {
  const server = createApp({ provider: createDemo(), pollMs: 50 });
  await new Promise((r) => server.listen(0, r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const cfg = await (await fetch(`${base}/api/config`)).json();
  assert.equal(cfg.provider, 'demo');
  assert.equal(cfg.timeframes.length, 14);

  const j = await (await fetch(`${base}/api/candles?tf=M45&limit=50`)).json();
  assert.equal(j.candles.length, 50);

  assert.equal((await fetch(`${base}/api/candles?tf=X9`)).status, 400);
  assert.equal((await fetch(`${base}/index.html`)).status, 200);
  assert.equal((await fetch(`${base}/shared/analysis.js`)).status, 200);
  assert.equal((await fetch(`${base}/vendor/lightweight-charts.js`)).status, 200);
  assert.equal((await fetch(`${base}/%2e%2e/package.json`)).status, 404);

  const res = await fetch(`${base}/api/stream`);
  const reader = res.body.getReader();
  let buf = '';
  while (!buf.includes('"p":')) buf += new TextDecoder().decode((await reader.read()).value);
  const tick = JSON.parse(buf.slice(buf.indexOf('data: ') + 6).split('\n')[0]);
  assert.ok(tick.p > 0 && tick.t > 0);
  await reader.cancel();
});
