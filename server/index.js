// HTTP server: static files, candles, trade finder, order flow, COT, the
// auto-trader and a server-sent-events price stream.
// One poller is shared by every open browser, so the provider sees the same
// request rate however many tabs are open.

import http from 'node:http';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TF, TIMEFRAMES, bucketStart } from '../shared/timeframes.js';
import { getCandles } from '../shared/candles.js';
import { analyze, dropFormingCandle } from '../shared/bot.js';
import { MARKETS, PLAY_TFS } from '../shared/markets.js';
import { DEFAULT_RULES } from '../shared/strategies.js';
import { createNews } from './news.js';
import { loadAndAnalyze, TAIL, HTF_TAIL } from './play.js';
import { createSpotGold } from './spot.js';
import { createGoldCandles } from './goldfeed.js';
import { setBinanceBlocked } from './providers/binance.js';

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

function runInWorker(payload) {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL('./bt-worker.js', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 256 } });
    w.once('message', (m) => {
      w.terminate();
      if (m.ok) return resolve(m.out);
      if (m.blockedUntil) setBinanceBlocked(m.blockedUntil);
      return reject(new Error(m.error));
    });
    w.once('error', reject);
    w.postMessage(payload);
  });
}

// providers: { gold, btc } price/candle feeds. flowProviders: the same shape for
// order flow (taker volume, trades, book), or null per market.
export function createApp({
  providers,
  flowProviders = providers,
  pollMs = 3000,
  historyScale = 1,
  // Environment for createProviders() inside the backtest worker. Without it,
  // backtests run in this thread (tests, small histories).
  workerEnv = null,
  retestMs = 12 * 3600 * 1000,
  cotSource = createCotSource({ demo: !!providers.gold.demo }),
  paper = createPaper(),
  news = createNews({ demo: !!providers.gold.demo }),
  newsPause = false,
  adminToken = '',
  autoStart = true,
  log = () => {},
  spot = null, // live spot price feed for gold (shown instead of PAXG)
  goldCandles = null, // real-time gold chart candles (perpetual or spot-built)
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
    hist: {}, // tf id -> the recent candles kept in memory (closed + forming)
    want: {},
    plays: Object.fromEntries(PLAY_TFS.filter((tf) => m.plays[tf]).map((tf) => [tf, { full: null, live: null, error: null, testing: false, testedAt: 0, lastBar: 0 }])),
    ready: false,
    lastRefresh: 0,
    fetched: {}, // tf id -> time of the newest candle the feed has confirmed
    tape: [], // recent trades from the live stream
    streamAt: 0,
    lastPush: 0,
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

  // One history load + backtest at a time, so memory and request rate stay low.
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    chain = chain.then(fn, fn);
    return chain;
  };

  function adopt(x, tf, list, want) {
    if (x.hist[tf] && x.hist[tf].length >= list.length) return; // already tracked live
    x.hist[tf] = list;
    x.fetched[tf] = list.at(-1)?.time ?? 0;
    x.want[tf] = Math.max(x.want[tf] || 0, want);
  }

  // Loads the play's full history, backtests it, and keeps only the recent candles.
  async function fullTest(x, tf) {
    const st = x.plays[tf];
    if (st.testing || closed) return;
    st.testing = true;
    try {
      const play = x.m.plays[tf];
      const n = need(x, tf);
      const job = {
        tf: { id: tf, sec: TF[tf].sec },
        htf: { id: play.htf, sec: TF[play.htf].sec },
        n,
        hn: Math.ceil((n * TF[tf].sec) / TF[play.htf].sec) + 320,
        costBps: x.m.costBps,
        opts: playOpts(x, tf),
      };
      const out = workerEnv ? await runInWorker({ env: workerEnv, market: x.m.id, job }) : await loadAndAnalyze(x.provider, job);
      st.full = out.result;
      st.live = null;
      st.error = null;
      st.testedAt = Date.now();
      adopt(x, tf, out.c, TAIL);
      adopt(x, play.htf, out.h, HTF_TAIL);
      log(`${x.m.label} ${tf} tested on ${out.loaded} candles: ${st.full.stats.map((z) => `${z.id} (${Math.round((z.gate ?? 0.75) * 8)}/8+) ${z.trades} trades PF ${Number.isFinite(z.pf) ? z.pf.toFixed(2) : 'inf'} ${z.active ? 'TRADING' : 'watch'}`).join(', ')}`);
    } catch (e) {
      st.error = e.message;
      st.testedAt = Date.now() - retestMs + 5 * 60000; // try again in 5 minutes
      log(`${x.m.label} ${tf} backtest failed: ${e.message}`);
    } finally {
      st.testing = false;
      st.queued = false;
    }
  }

  function queueTest(x, tf) {
    const st = x.plays[tf];
    if (st.queued) return;
    st.queued = true;
    enqueue(() => fullTest(x, tf).then(() => liveScan(x, tf)));
  }

  // Cheap scan of the latest candles for live setups, reusing the last full test's statistics.
  function liveScan(x, tf) {
    const st = x.plays[tf];
    const play = x.m.plays[tf];
    if (!st.full || !x.hist[tf] || !x.hist[play.htf]) return;
    const c = closedOf(x, tf);
    const last = c.at(-1)?.time || 0;
    if (last === st.lastBar) return;
    st.lastBar = last;
    try {
      st.live = analyze(c, closedOf(x, play.htf), playOpts(x, tf, { now: Date.now() / 1000, prior: st.full }));
      const pause = newsPause ? news.pauseReason() : null;
      for (const sg of st.live.signals) if (sg.status === 'pending') log(`${x.m.label} ${tf} setup: ${sg.dir === 'bull' ? 'BUY' : 'SELL'} ${sg.strategy} entry ${sg.entry.toFixed(2)} stop ${sg.stop.toFixed(2)} target ${sg.target.toFixed(2)}`);
      paper.onSignals(st.live.signals, prices[x.m.id] ?? c.at(-1)?.close, { id: x.m.id, label: x.m.label, costBps: x.m.costBps, step: x.m.id === 'btc' ? 0.0001 : 0.01 }, { pause });
    } catch (e) {
      st.error = e.message;
    }
  }

  async function refreshCandles(x) {
    const now = Date.now() / 1000;
    for (const tf of Object.keys(x.hist)) {
      const last = x.fetched[tf] ?? 0;
      const sec = TF[tf].sec;
      if (now < last + sec + 1) continue; // the candle the feed last confirmed is still forming
      const missing = Math.ceil((now - last) / sec) + 3;
      const fresh = await getCandles(x.provider, tf, Math.min(1000, Math.max(5, missing)));
      if (!fresh.length) continue;
      // Replaces the candles built from ticks since the last fetch with the feed's own.
      x.hist[tf] = mergeCandles(x.hist[tf], fresh, x.want[tf]);
      x.fetched[tf] = fresh.at(-1).time;
    }
    for (const tf of Object.keys(x.plays)) {
      liveScan(x, tf);
      if (Date.now() - x.plays[tf].testedAt > retestMs) queueTest(x, tf);
    }
  }

  // Keeps the newest candle of every loaded timeframe current between fetches,
  // so charts and order flow served from memory are never stale.
  function tickCandles(x, p, t = null) {
    const now = Math.floor(Date.now() / 1000);
    const vol = t && x.flow === x.provider ? t.size : 0;
    for (const tf of Object.keys(x.hist)) {
      const list = x.hist[tf];
      const c = list[list.length - 1];
      if (!c) continue;
      const b = bucketStart(TF[tf], now);
      if (b > c.time) {
        list.push({ time: b, open: p, high: p, low: p, close: p, volume: vol, ...(c.buyVolume != null ? { buyVolume: t && t.side === 'buy' ? vol : 0 } : {}) });
        if (list.length > x.want[tf] + 50) list.splice(0, list.length - x.want[tf]);
      } else if (b === c.time) {
        if (p > c.high) c.high = p;
        if (p < c.low) c.low = p;
        c.close = p;
        if (vol) {
          c.volume += vol;
          if (c.buyVolume != null && t.side === 'buy') c.buyVolume += vol;
        }
      }
    }
  }

  // Gap between the spot quote and the market the strategies trade (PAXG for
  // gold), smoothed so the chart does not jump. 0 for markets without spot.
  const basis = {};
  const spotPrice = {};
  const tickMsg = (id) => ({ m: id, t: Math.floor(Date.now() / 1000), p: prices[id], ...(spotPrice[id] != null ? { spot: spotPrice[id], basis: basis[id] ?? 0 } : {}) });
  function onSpot(id, s) {
    spotPrice[id] = s;
    if (id === 'gold') goldCandles?.onSpot(s);
    const p = prices[id];
    if (Number.isFinite(p)) {
      const gap = s - p;
      basis[id] = basis[id] == null ? gap : basis[id] + (gap - basis[id]) * 0.1;
    }
    broadcast(tickMsg(id));
  }

  function setPrice(x, p) {
    if (!Number.isFinite(p)) return;
    prices[x.m.id] = p;
    broadcast(tickMsg(x.m.id));
    paper.onPrice(p, x.m.id, prices);
  }

  const streaming = (x) => Date.now() - x.streamAt < 15000;

  // One WebSocket carries every market's trades: prices without polling, and
  // the tape for whales and order flow.
  let stopStream = () => {};
  function startStream() {
    const src = markets.filter((x) => x.flow && x.flow.stream && x.flow.symbol);
    if (!src.length) return;
    const bySymbol = Object.fromEntries(src.map((x) => [x.flow.symbol.toUpperCase(), x]));
    const onState = (on) => log(`Trade stream ${on ? 'connected' : 'disconnected'}`);
    stopStream = src[0].flow.stream(Object.keys(bySymbol), (symbol, t) => {
      const x = bySymbol[symbol];
      if (!x) return;
      x.streamAt = Date.now();
      x.tape.push(t);
      if (x.tape.length > 1500) x.tape.splice(0, x.tape.length - 1000);
      if (x.flow === x.provider) tickCandles(x, t.price, t);
      // The stream is the price feed only when prices and flow come from the same market.
      if (x.flow === x.provider && Date.now() - x.lastPush >= 500) {
        x.lastPush = Date.now();
        setPrice(x, t.price);
      }
    }, onState);
  }

  async function loop(x) {
    while (!closed) {
      try {
        if (!(streaming(x) && x.flow === x.provider)) {
          const p = await x.provider.fetchPrice();
          setPrice(x, p);
          if (Number.isFinite(p)) tickCandles(x, p);
        }
        x.err = null;
        if (Date.now() - x.lastRefresh > 5000) {
          x.lastRefresh = Date.now();
          await refreshCandles(x);
        }
      } catch (e) {
        broadcast({ m: x.m.id, error: e.message });
        const kind = e.message.replace(/\d+/g, '#'); // log each kind of error once, not every countdown tick
        if (x.err !== kind) log(`${x.m.label} feed error: ${e.message}`);
        x.err = kind;
      }
      await sleep(x.provider.pollMs && x.provider.pollMs > pollMs ? x.provider.pollMs : pollMs);
    }
  }

  async function boot() {
    cot = await cotSource.get().catch(() => null);
    news.start();
    spot?.start((s) => onSpot('gold', s));
    startStream();
    for (const x of markets) loop(x);
    // Shortest histories first, so the 15m results appear quickly.
    for (const tf of ['M15', 'M5', 'M1']) for (const x of markets) if (x.plays[tf]) queueTest(x, tf);
  }
  const ready = autoStart ? boot() : Promise.resolve();

  function botView(x) {
    const tfs = {};
    for (const [tf, st] of Object.entries(x.plays)) {
      const r = st.live || st.full;
      tfs[tf] = r ? { ...r, recent: r.recent.slice(-40).map(({ factors, expected, ...t }) => t), testing: st.testing } : { pending: true, error: st.error, strategies: x.m.plays[tf].strategies.map((s) => s.id) };
    }
    return { market: x.m.id, price: prices[x.m.id] ?? null, spot: spotPrice[x.m.id] ?? null, basis: basis[x.m.id] ?? 0, tfs };
  }

  async function candles(x, tfId, limit) {
    const key = `${x.m.id}:${tfId}:${limit}`;
    const hit = candleCache.get(key);
    // Timeframes outside the plays (the daily candle for the day's change) change slowly.
    if (hit && Date.now() - hit.at < (x.hist[tfId] ? CACHE_MS : 60000)) return hit.promise;
    // Serve the play timeframes from memory when the history is loaded.
    const promise = x.hist[tfId] && x.hist[tfId].length >= limit && Date.now() / 1000 - x.hist[tfId].at(-1).time < TF[tfId].sec + 15
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
    // The book is the one heavy request (weight 25), so every viewer shares it for 8 s.
    const bk = flowCache.get(`book:${x.m.id}`);
    const bookP = bk && Date.now() - bk.at < 8000 ? bk.promise : x.flow.fetchBook(500);
    if (!bk || bk.promise !== bookP) {
      flowCache.set(`book:${x.m.id}`, { at: Date.now(), promise: bookP });
      bookP.catch(() => flowCache.delete(`book:${x.m.id}`));
    }
    const mem = x.flow === x.provider && x.hist[tfId];
    const tk = flowCache.get(`tape:${x.m.id}`);
    const tapeP = streaming(x) && x.tape.length >= 200 ? Promise.resolve(x.tape.slice(-1000))
      : tk && Date.now() - tk.at < 8000 ? tk.promise : x.flow.fetchTrades(1000);
    if (!(streaming(x) && x.tape.length >= 200) && (!tk || tk.promise !== tapeP)) {
      flowCache.set(`tape:${x.m.id}`, { at: Date.now(), promise: tapeP });
      tapeP.catch(() => flowCache.delete(`tape:${x.m.id}`));
    }
    const ck = flowCache.get(`c:${x.m.id}:${tfId}`);
    const candP = mem ? Promise.resolve(mem.slice(-120)) : ck && Date.now() - ck.at < 8000 ? ck.promise : getCandles(x.flow, tfId, 120);
    if (!mem && (!ck || ck.promise !== candP)) {
      flowCache.set(`c:${x.m.id}:${tfId}`, { at: Date.now(), promise: candP });
      candP.catch(() => flowCache.delete(`c:${x.m.id}:${tfId}`));
    }
    const [fc, trades, book] = await Promise.all([candP, tapeP, bookP]);
    const flowPrice = trades.length ? trades[trades.length - 1].price : fc[fc.length - 1]?.close;
    const main = prices[x.m.id];
    const basis = x.flow !== x.provider && main != null && Number.isFinite(flowPrice) ? main - flowPrice : 0;
    const shift = (l) => ({ ...l, price: l.price + basis });
    const shifted = trades.map(shift);
    return {
      available: true,
      source: x.flow.label,
      symbol: x.flow.symbol || null,
      live: streaming(x),
      basis,
      delta: deltaSeries(fc),
      tape: tradeFlow(shifted),
      whales: whales(shifted),
      book: bookStats({ bids: book.bids.map(shift), asks: book.asks.map(shift) }, { bucket: x.m.id === 'btc' ? 25 : 1 }),
    };
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
            // Candles and live data come straight from Binance in the browser when this is set.
            binance: x.provider.name === 'binance' ? x.provider.symbol : null,
            spot: !!spot && x.m.id === 'gold',
            spotSource: spot && x.m.id === 'gold' ? 'Swissquote spot XAU/USD' : null,
            goldChart: !!goldCandles && x.m.id === 'gold',
          })),
        });
      }
      if (url.pathname === '/api/candles') {
        const tf = q.get('tf') || 'M5';
        if (!TF[tf]) return send(res, 400, { error: `Unknown timeframe ${tf}` });
        const limit = Math.max(10, Math.min(MAX_LIMIT, parseInt(q.get('limit'), 10) || 500));
        return send(res, 200, { tf, candles: await candles(market(), tf, limit) });
      }
      if (url.pathname === '/api/goldcandles') {
        if (!goldCandles) return send(res, 404, { error: 'No real-time gold chart feed' });
        const limit = Math.max(10, Math.min(1000, parseInt(q.get('limit'), 10) || 600));
        return send(res, 200, await goldCandles.get(q.get('tf') || 'M1', limit, spotPrice.gold ?? null));
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
        for (const m of Object.keys(prices)) res.write(`data: ${JSON.stringify(tickMsg(m))}\n\n`);
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
    spot?.stop();
    stopStream();
    news.stop();
  });
  server.ready = ready;
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  if (process.argv.includes('--demo')) process.env.PROVIDER = 'demo';
  const stamp = () => new Date().toISOString().slice(11, 19);
  process.on('uncaughtException', (e) => console.error(`${stamp()} Uncaught error: ${e.stack || e}`));
  process.on('unhandledRejection', (e) => console.error(`${stamp()} Unhandled rejection: ${e?.stack || e}`));
  setInterval(() => console.log(`${stamp()} Memory ${Math.round(process.memoryUsage().rss / 1048576)} MB`), 10 * 60000).unref();
  const { providers, flowProviders } = createProviders(process.env);
  // Render's free plan stops a service after 15 minutes without a visitor, which
  // also stops the auto-trader and forces a fresh backtest on the next visit.
  // A request to the service's own public address every 10 minutes keeps it awake.
  const self = process.env.RENDER_EXTERNAL_URL;
  if (self && process.env.KEEP_ALIVE !== '0') {
    setInterval(() => {
      fetch(`${self}/api/config`, { signal: AbortSignal.timeout(20000) }).catch((e) => console.log(`${stamp()} Keep-alive failed: ${e.message}`));
    }, 10 * 60000).unref();
    console.log(`${stamp()} Keep-alive on for ${self}`);
  }
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
    workerEnv: { ...process.env },
    spot: providers.gold.demo || process.env.SPOT_GOLD === '0' ? null : createSpotGold(),
    goldCandles: providers.gold.demo || process.env.SPOT_GOLD === '0' ? null : createGoldCandles({ log: (msg) => console.log(`${stamp()} ${msg}`) }),
    log: (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${msg}`),
  }).listen(port, () => {
    console.log(`Pulse Scalper running at http://localhost:${port}  (gold: ${providers.gold.label}, btc: ${providers.btc.label})`);
    if (!adminToken) console.log('Tip: set ADMIN_TOKEN so only you can change the auto-trader when this is online.');
  });
}
