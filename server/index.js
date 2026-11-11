// HTTP server: static files, candles, trade finder, order flow, COT, the
// auto-trader and a server-sent-events price stream.
// One poller is shared by every open browser, so the provider sees the same
// request rate however many tabs are open.

import http from 'node:http';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TF, TIMEFRAMES } from '../shared/timeframes.js';
import { getCandles } from '../shared/candles.js';
import { analyze, dropFormingCandle } from '../shared/bot.js';
import { MARKETS, PLAY_TFS } from '../shared/markets.js';
import { DEFAULT_RULES } from '../shared/strategies.js';
import { createNews } from './news.js';

import { deltaSeries, tradeFlow, whales, bookStats } from '../shared/flow.js';
import { createProviders } from './providers/index.js';
import { createCotSource } from './cot.js';
import { createPaper } from './paper.js';

export { getCandles };

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC = {
  '/': path.join(ROOT, 'public'),
  '/shared/': path.join(ROOT, 'shared'),
};
const VENDOR = {
  '/vendor/lightweight-charts.js': path.join(ROOT, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js'),
};
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const CACHE_MS = 3000;
const MAX_LIMIT = 1500;

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function serveFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function resolveStatic(urlPath) {
  if (VENDOR[urlPath]) return VENDOR[urlPath];
  const prefix = urlPath.startsWith('/shared/') ? '/shared/' : '/';
  const root = STATIC[prefix];
  let rel = decodeURIComponent(urlPath.slice(prefix.length));
  if (!rel || rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(root, rel);
  return file.startsWith(root + path.sep) ? file : null;
}

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms).unref?.(); });

function mergeCandles(prev, fresh, n) {
  if (!fresh.length) return prev;
  return prev.filter((x) => x.time < fresh[0].time).concat(fresh).slice(-n);
}

function runInWorker(c, h, opts) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./bt-worker.js', import.meta.url));
    w.once('message', (m) => {
      w.terminate();
      if (m.ok) resolve(m.result);
      else reject(new Error(m.error));
    });
    w.once('error', reject);
    w.postMessage({ c, h, opts });
  });
}

// providers: { gold, btc } price/candle feeds. flowProviders: the same shape for
// order flow (taker volume, trades, book), or null per market.
export function createApp({
  providers,
  flowProviders = providers,
  pollMs = 2000,
  historyScale = 1,
  useWorker = true,
  retestMs = 6 * 3600 * 1000,
  cotSource = createCotSource({ demo: !!providers.gold.demo }),
  paper = createPaper(),
  news = createNews({ demo: !!providers.gold.demo }),
  newsPause = false,
  adminToken = '',
  autoStart = true,
}) {
  const clients = new Set();
  const candleCache = new Map();
  const flowCache = new Map();
  const prices = {};
  let closed = false;
  let cot = null;

  const markets = MARKETS.map((m) => ({
    m,
    provider: providers[m.id],
    flow: flowProviders?.[m.id] || null,
    hist: {}, // tf id -> closed + forming candles
    plays: Object.fromEntries(PLAY_TFS.filter((tf) => m.plays[tf]).map((tf) => [tf, { full: null, live: null, error: null, testing: false, testedAt: 0, lastBar: 0 }])),
    ready: false,
    lastRefresh: 0,
  }));
  const byId = Object.fromEntries(markets.map((x) => [x.m.id, x]));
  const need = (x, tf) => Math.max(1500, Math.round(x.m.plays[tf].history * historyScale));

  function broadcast(msg) {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) res.write(line);
  }

  function playOpts(x, tf, extra = {}) {
    const play = x.m.plays[tf];
    const price = prices[x.m.id] ?? x.hist[tf]?.at(-1)?.close ?? 0;
    return {
      tf: { id: tf, sec: TF[tf].sec },
      htf: { id: play.htf, sec: TF[play.htf].sec },
      include: play.strategies,
      rules: { ...DEFAULT_RULES, cost: (price * x.m.costBps) / 10000, maxPerDay: tf === 'M15' ? 3 : 6 },
      cot: x.m.id === 'gold' ? cot : null,
      label: x.provider.label,
      ...extra,
    };
  }

  const closedOf = (x, tf) => dropFormingCandle(x.hist[tf] || [], TF[tf].sec, Date.now() / 1000);

  async function fullTest(x, tf) {
    const st = x.plays[tf];
    if (st.testing) return;
    st.testing = true;
    try {
      const play = x.m.plays[tf];
      const c = closedOf(x, tf);
      const h = closedOf(x, play.htf);
      const opts = playOpts(x, tf, { now: Date.now() / 1000 });
      st.full = useWorker ? await runInWorker(c, h, opts) : analyze(c, h, opts);
      st.live = null;
      st.error = null;
      st.testedAt = Date.now();
    } catch (e) {
      st.error = e.message;
    } finally {
      st.testing = false;
    }
  }

  // Cheap scan of the latest candles for live setups, reusing the last full test's statistics.
  function liveScan(x, tf) {
    const st = x.plays[tf];
    if (!st.full) return;
    const play = x.m.plays[tf];
    const c = closedOf(x, tf);
    const last = c.at(-1)?.time || 0;
    if (last === st.lastBar) return;
    st.lastBar = last;
    try {
      st.live = analyze(c, closedOf(x, play.htf), playOpts(x, tf, { now: Date.now() / 1000, prior: st.full }));
      const pause = newsPause ? news.pauseReason() : null;
      paper.onSignals(st.live.signals, prices[x.m.id], { id: x.m.id, label: x.m.label, costBps: x.m.costBps, step: x.m.id === 'btc' ? 0.0001 : 0.01 }, { pause });
    } catch (e) {
      st.error = e.message;
    }
  }

  async function loadMarket(x) {
    const tfs = new Set();
    for (const tf of Object.keys(x.plays)) {
      tfs.add(tf);
      tfs.add(x.m.plays[tf].htf);
    }
    for (const tf of tfs) {
      const n = x.plays[tf] ? need(x, tf) : 0;
      const asHtf = Math.max(0, ...Object.keys(x.plays).filter((p) => x.m.plays[p].htf === tf).map((p) => Math.ceil((need(x, p) * TF[p].sec) / TF[tf].sec) + 320));
      const want = Math.max(n, asHtf);
      x.hist[tf] = await getCandles(x.provider, tf, want, { maxCandles: want + 100 });
      x.want = { ...x.want, [tf]: want };
      if (closed) return;
    }
    x.ready = true;
    // Shortest history first, so the 15m results appear quickly.
    for (const tf of ['M15', 'M5', 'M1'].filter((t) => x.plays[t])) {
      if (closed) return;
      await fullTest(x, tf);
      liveScan(x, tf);
    }
  }

  async function refreshCandles(x) {
    const now = Date.now() / 1000;
    for (const tf of Object.keys(x.hist)) {
      const prev = x.hist[tf];
      const last = prev.at(-1)?.time ?? 0;
      const sec = TF[tf].sec;
      if (now < last + sec + 1) continue; // the forming candle has not closed yet
      const missing = Math.ceil((now - last) / sec) + 3;
      const fresh = await getCandles(x.provider, tf, Math.min(1000, Math.max(5, missing)));
      x.hist[tf] = mergeCandles(prev, fresh, x.want[tf]);
    }
    for (const tf of Object.keys(x.plays)) {
      liveScan(x, tf);
      if (Date.now() - x.plays[tf].testedAt > retestMs && !x.plays[tf].testing) fullTest(x, tf).then(() => liveScan(x, tf));
    }
  }

  async function loop(x) {
    while (!closed) {
      try {
        const p = await x.provider.fetchPrice();
        if (Number.isFinite(p)) {
          prices[x.m.id] = p;
          broadcast({ m: x.m.id, t: Math.floor(Date.now() / 1000), p });
          paper.onPrice(p, x.m.id, prices);
        }
        if (x.ready && Date.now() - x.lastRefresh > 5000) {
          x.lastRefresh = Date.now();
          await refreshCandles(x);
        }
      } catch (e) {
        broadcast({ m: x.m.id, error: e.message });
      }
      await sleep(x.provider.pollMs && x.provider.pollMs > pollMs ? x.provider.pollMs : pollMs);
    }
  }

  async function boot() {
    cot = await cotSource.get().catch(() => null);
    news.start();
    for (const x of markets) loop(x);
    for (const x of markets) {
      // A failed history load is retried every minute.
      (async () => {
        while (!closed && !x.ready) {
          await loadMarket(x).catch((e) => { for (const st of Object.values(x.plays)) st.error = e.message; });
          if (!x.ready) await sleep(60000);
        }
      })();
    }
  }
  const ready = autoStart ? boot() : Promise.resolve();

  function botView(x) {
    const tfs = {};
    for (const [tf, st] of Object.entries(x.plays)) {
      const r = st.live || st.full;
      tfs[tf] = r ? { ...r, testing: st.testing } : { pending: true, error: st.error, strategies: x.m.plays[tf].strategies.map((s) => s.id) };
    }
    return { market: x.m.id, price: prices[x.m.id] ?? null, tfs };
  }

  async function candles(x, tfId, limit) {
    const key = `${x.m.id}:${tfId}:${limit}`;
    const hit = candleCache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
    // Serve the play timeframes from memory when the history is loaded.
    const promise = x.ready && x.hist[tfId] && x.hist[tfId].length >= limit && Date.now() / 1000 - x.hist[tfId].at(-1).time < TF[tfId].sec + 15
      ? Promise.resolve(x.hist[tfId].slice(-limit))
      : getCandles(x.provider, tfId, limit);
    candleCache.set(key, { at: Date.now(), promise });
    promise.catch(() => candleCache.delete(key));
    return promise;
  }

  // Order flow: taker delta per candle, recent tape, whales and the order book.
  // When the flow market trades at a small premium to the price feed, its
  // prices are shifted by that basis so walls and big trades line up with the chart.
  async function orderFlow(x, tfId) {
    if (!x.flow) return { available: false };
    const key = `${x.m.id}:${tfId}`;
    const hit = flowCache.get(key);
    if (hit && Date.now() - hit.at < 2000) return hit.promise;
    const promise = (async () => {
      const [fc, trades, book] = await Promise.all([getCandles(x.flow, tfId, 120), x.flow.fetchTrades(1000), x.flow.fetchBook(500)]);
      const flowPrice = trades.length ? trades[trades.length - 1].price : fc[fc.length - 1]?.close;
      const main = prices[x.m.id];
      const basis = x.flow !== x.provider && main != null && Number.isFinite(flowPrice) ? main - flowPrice : 0;
      const shift = (l) => ({ ...l, price: l.price + basis });
      const shifted = trades.map(shift);
      return {
        available: true,
        source: x.flow.label,
        symbol: x.flow.symbol || null,
        basis,
        delta: deltaSeries(fc),
        tape: tradeFlow(shifted),
        whales: whales(shifted),
        book: bookStats({ bids: book.bids.map(shift), asks: book.asks.map(shift) }, { bucket: x.m.id === 'btc' ? 25 : 1 }),
      };
    })();
    flowCache.set(key, { at: Date.now(), promise });
    promise.catch(() => flowCache.delete(key));
    return promise;
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (d) => {
        body += d;
        if (body.length > 10000) reject(Object.assign(new Error('Body too large'), { status: 413 }));
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
        }
      });
    });
  }

  async function paperAction(req) {
    if (adminToken && req.headers['x-admin-token'] !== adminToken) throw Object.assign(new Error('Admin token required'), { status: 401 });
    const b = await readJson(req);
    if (b.config) paper.configure(b.config);
    if (b.action === 'start') paper.start();
    else if (b.action === 'stop') paper.stop({ closeAll: !!b.closeAll, prices });
    else if (b.action === 'reset') paper.reset(b.amount != null ? +b.amount : undefined);
    return paper.snapshot(prices);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams;
    const market = () => {
      const x = byId[q.get('market') || 'gold'];
      if (!x) throw Object.assign(new Error(`Unknown market ${q.get('market')}`), { status: 400 });
      return x;
    };
    try {
      if (url.pathname === '/api/config') {
        return send(res, 200, {
          demo: !!providers.gold.demo,
          adminToken: !!adminToken,
          tfs: PLAY_TFS,
          markets: markets.map((x) => ({
            id: x.m.id, label: x.m.label, pair: x.m.pair, tv: x.m.tv, unit: x.m.unit, lot: x.m.lot,
            source: x.provider.label, flow: x.flow ? x.flow.label : null,
            // Binance symbol for the browser's live trade stream, when the flow feed is Binance.
            stream: x.flow && x.flow.name === 'binance' ? x.flow.symbol : null,
          })),
        });
      }
      if (url.pathname === '/api/candles') {
        const tf = q.get('tf') || 'M5';
        if (!TF[tf]) return send(res, 400, { error: `Unknown timeframe ${tf}` });
        const limit = Math.max(10, Math.min(MAX_LIMIT, parseInt(q.get('limit'), 10) || 500));
        return send(res, 200, { tf, candles: await candles(market(), tf, limit) });
      }
      if (url.pathname === '/api/bot') return send(res, 200, botView(market()));
      if (url.pathname === '/api/flow') {
        const tf = q.get('tf') || 'M5';
        if (!TF[tf]) return send(res, 400, { error: `Unknown timeframe ${tf}` });
        return send(res, 200, await orderFlow(market(), tf));
      }
      if (url.pathname === '/api/news') return send(res, 200, news.list());
      if (url.pathname === '/api/cot') {
        const m = cot || (await cotSource.get());
        return send(res, 200, m ? { available: true, source: cotSource.label, latest: m[m.length - 1], series: m.slice(-156) } : { available: false, source: cotSource.label });
      }
      if (url.pathname === '/api/paper') {
        if (req.method === 'POST') return send(res, 200, await paperAction(req));
        return send(res, 200, paper.snapshot(prices));
      }
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        for (const [m, p] of Object.entries(prices)) res.write(`data: ${JSON.stringify({ m, t: Math.floor(Date.now() / 1000), p })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        return undefined;
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      const file = resolveStatic(url.pathname);
      return file ? serveFile(res, file) : send(res, 404, 'Not found', 'text/plain');
    } catch (e) {
      return send(res, e.status || 502, { error: e.message });
    }
  });

  server.on('close', () => {
    closed = true;
    news.stop();
  });
  server.ready = ready;
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  if (process.argv.includes('--demo')) process.env.PROVIDER = 'demo';
  const { providers, flowProviders } = createProviders(process.env);
  const port = +process.env.PORT || 3000;
  const paper = createPaper({ file: path.resolve(ROOT, process.env.DATA_DIR || 'data', 'paper.json') });
  const adminToken = process.env.ADMIN_TOKEN || '';
  createApp({
    providers,
    flowProviders,
    pollMs: +process.env.POLL_MS || undefined,
    historyScale: +process.env.HISTORY_SCALE || undefined,
    newsPause: process.env.NEWS_PAUSE === '1',
    paper,
    adminToken,
  }).listen(port, () => {
    console.log(`Pulse Scalper running at http://localhost:${port}  (gold: ${providers.gold.label}, btc: ${providers.btc.label})`);
    if (!adminToken) console.log('Tip: set ADMIN_TOKEN so only you can change the auto-trader when this is online.');
  });
}
