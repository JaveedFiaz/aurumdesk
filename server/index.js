// HTTP server: static files, candles, trade finder, order flow, COT, the
// auto-trader and a server-sent-events price stream.
// One poller is shared by every open browser, so the provider sees the same
// request rate however many tabs are open.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TF, TIMEFRAMES } from '../shared/timeframes.js';
import { getCandles } from '../shared/candles.js';
import { runBot, BOT_TF } from '../shared/bot.js';

import { deltaSeries, tradeFlow, whales, bookStats } from '../shared/flow.js';
import { createProvider, createFlowProvider } from './providers/index.js';
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

export function createApp({
  provider,
  pollMs = provider.pollMs || 1000,
  botHistory = 10000,
  tvSymbol = 'OANDA:XAUUSD',
  flowProvider = provider.fetchTrades ? provider : null,
  cotSource = createCotSource({ demo: !!provider.demo }),
  paper = createPaper(),
  adminToken = '',
}) {
  const cache = new Map();
  const clients = new Set();
  let bot = null;
  let timer = null;
  let lastTick = null;
  let flow = null;

  // The trade finder reruns once per closed 15m candle; every visitor shares the result.
  function botResult() {
    const bucket = Math.floor(Date.now() / 1000 / BOT_TF.sec);
    if (bot && bot.bucket === bucket) return bot.promise;
    const promise = cotSource.get().then((cot) => runBot({ provider, history: botHistory, cot }));
    bot = { bucket, promise };
    promise.catch(() => {
      if (bot?.promise === promise) bot = null;
    });
    return promise;
  }

  function broadcast(msg) {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) res.write(line);
  }

  // Prices are polled while someone is watching, or while the auto-trader runs.
  async function poll() {
    try {
      const p = await provider.fetchPrice();
      if (Number.isFinite(p)) {
        lastTick = { t: Math.floor(Date.now() / 1000), p };
        broadcast(lastTick);
        paper.onPrice(p);
      }
    } catch (e) {
      broadcast({ error: e.message });
    }
    timer = clients.size || paper.enabled ? setTimeout(poll, pollMs) : null;
  }
  const ensurePolling = () => {
    if (!timer) timer = setTimeout(poll, 0);
  };

  // Auto-trader loop: hand fresh setups to the paper account every 30 s.
  async function autoTrade() {
    if (!paper.enabled) return;
    ensurePolling();
    try {
      const r = await botResult();
      const price = lastTick?.p ?? (await provider.fetchPrice());
      paper.onSignals(r.signals, price);
    } catch { /* retried on the next pass */ }
  }
  const autoTimer = setInterval(autoTrade, 30000);
  autoTimer.unref?.();
  if (paper.enabled) setTimeout(autoTrade, 0).unref?.();

  async function candles(tfId, limit) {
    const key = `${tfId}:${limit}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
    const promise = getCandles(provider, tfId, limit);
    cache.set(key, { at: Date.now(), promise });
    promise.catch(() => cache.delete(key));
    return promise;
  }

  // Order flow from the flow provider (Binance PAXG unless the main feed has its own).
  // When the flow market trades at a small premium to the main feed, its prices are
  // shifted by that basis so walls and big trades line up with the chart.
  async function orderFlow(tfId) {
    if (!flowProvider) return { available: false };
    if (flow && flow.tf === tfId && Date.now() - flow.at < CACHE_MS) return flow.promise;
    const promise = (async () => {
      const [fc, trades, book, mainPrice] = await Promise.all([
        getCandles(flowProvider, tfId, 120),
        flowProvider.fetchTrades(1000),
        flowProvider.fetchBook(500),
        flowProvider === provider ? null : (lastTick?.p ?? provider.fetchPrice()),
      ]);
      const flowPrice = trades.length ? trades[trades.length - 1].price : fc[fc.length - 1]?.close;
      const basis = mainPrice != null && Number.isFinite(flowPrice) ? mainPrice - flowPrice : 0;
      const shift = (l) => ({ ...l, price: l.price + basis });
      const shifted = { bids: book.bids.map(shift), asks: book.asks.map(shift) };
      const tradesShifted = trades.map(shift);
      return {
        available: true,
        source: flowProvider.label,
        basis,
        delta: deltaSeries(fc),
        tape: tradeFlow(tradesShifted),
        whales: whales(tradesShifted),
        book: bookStats(shifted),
      };
    })();
    flow = { tf: tfId, at: Date.now(), promise };
    promise.catch(() => {
      if (flow?.promise === promise) flow = null;
    });
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
    if (adminToken && req.headers['x-admin-token'] !== adminToken) {
      throw Object.assign(new Error('Admin token required'), { status: 401 });
    }
    const b = await readJson(req);
    const price = lastTick?.p ?? (await provider.fetchPrice().catch(() => NaN));
    if (b.config) paper.configure(b.config);
    if (b.action === 'start') {
      paper.start();
      autoTrade();
    } else if (b.action === 'stop') paper.stop({ closeAll: !!b.closeAll, price });
    else if (b.action === 'reset') paper.reset(b.amount != null ? +b.amount : undefined);
    return paper.snapshot(price);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/api/config') {
        return send(res, 200, {
          provider: provider.name,
          label: provider.label,
          note: provider.note,
          demo: !!provider.demo,
          tvSymbol,
          flow: flowProvider ? flowProvider.label : null,
          cot: cotSource.label,
          adminToken: !!adminToken,
          timeframes: TIMEFRAMES.map((t) => t.id),
        });
      }
      if (url.pathname === '/api/candles') {
        const tf = url.searchParams.get('tf') || 'M15';
        const limit = Math.max(10, Math.min(MAX_LIMIT, parseInt(url.searchParams.get('limit'), 10) || 500));
        return send(res, 200, { tf, candles: await candles(tf, limit) });
      }
      if (url.pathname === '/api/bot') {
        return send(res, 200, await botResult());
      }
      if (url.pathname === '/api/flow') {
        const tf = url.searchParams.get('tf') || 'M15';
        if (!TF[tf]) return send(res, 400, { error: `Unknown timeframe ${tf}` });
        return send(res, 200, await orderFlow(tf));
      }
      if (url.pathname === '/api/cot') {
        const m = await cotSource.get();
        return send(res, 200, m ? { available: true, source: cotSource.label, latest: m[m.length - 1], series: m.slice(-156) } : { available: false, source: cotSource.label });
      }
      if (url.pathname === '/api/paper') {
        if (req.method === 'POST') return send(res, 200, await paperAction(req));
        return send(res, 200, paper.snapshot(lastTick?.p));
      }
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        res.write('retry: 3000\n\n');
        if (lastTick) res.write(`data: ${JSON.stringify(lastTick)}\n\n`);
        clients.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(res);
        });
        ensurePolling();
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
    clearTimeout(timer);
    clearInterval(autoTimer);
  });
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  if (process.argv.includes('--demo')) process.env.PROVIDER = 'demo';
  const provider = createProvider(process.env);
  const port = +process.env.PORT || 3000;
  const pollMs = +process.env.POLL_MS || undefined;
  const botHistory = +process.env.BOT_HISTORY || undefined;
  const tvSymbol = process.env.TV_SYMBOL || undefined;
  const flowProvider = createFlowProvider(process.env, provider);
  const paper = createPaper({ file: path.resolve(ROOT, process.env.DATA_DIR || 'data', 'paper.json') });
  const adminToken = process.env.ADMIN_TOKEN || '';
  createApp({ provider, pollMs, botHistory, tvSymbol, flowProvider, paper, adminToken }).listen(port, () => {
    console.log(`Aurum Pulse running at http://localhost:${port}  (prices: ${provider.label}, order flow: ${flowProvider ? flowProvider.label : 'off'})`);
    if (!adminToken) console.log('Tip: set ADMIN_TOKEN so only you can start or change the auto-trader when this is online.');
  });
}
