// HTTP server: static files, candle API and a server-sent-events price stream.
// One poller is shared by every open browser, so the provider sees the same
// request rate however many tabs are open.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TIMEFRAMES } from '../shared/timeframes.js';
import { getCandles } from '../shared/candles.js';

export { getCandles };
import { createProvider } from './providers/index.js';

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

export function createApp({ provider, pollMs = provider.pollMs || 1000 }) {
  const cache = new Map();
  const clients = new Set();
  let timer = null;
  let lastTick = null;

  function broadcast(msg) {
    const line = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of clients) res.write(line);
  }

  async function poll() {
    try {
      const p = await provider.fetchPrice();
      if (Number.isFinite(p)) {
        lastTick = { t: Math.floor(Date.now() / 1000), p };
        broadcast(lastTick);
      }
    } catch (e) {
      broadcast({ error: e.message });
    }
    timer = clients.size ? setTimeout(poll, pollMs) : null;
  }

  async function candles(tfId, limit) {
    const key = `${tfId}:${limit}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.promise;
    const promise = getCandles(provider, tfId, limit);
    cache.set(key, { at: Date.now(), promise });
    promise.catch(() => cache.delete(key));
    return promise;
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
          timeframes: TIMEFRAMES.map((t) => t.id),
        });
      }
      if (url.pathname === '/api/candles') {
        const tf = url.searchParams.get('tf') || 'M15';
        const limit = Math.max(10, Math.min(MAX_LIMIT, parseInt(url.searchParams.get('limit'), 10) || 500));
        return send(res, 200, { tf, candles: await candles(tf, limit) });
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
        if (!timer) poll();
        return undefined;
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'Method not allowed' });
      const file = resolveStatic(url.pathname);
      return file ? serveFile(res, file) : send(res, 404, 'Not found', 'text/plain');
    } catch (e) {
      return send(res, e.status || 502, { error: e.message });
    }
  });

  server.on('close', () => clearTimeout(timer));
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  if (process.argv.includes('--demo')) process.env.PROVIDER = 'demo';
  const provider = createProvider(process.env);
  const port = +process.env.PORT || 3000;
  const pollMs = +process.env.POLL_MS || undefined;
  createApp({ provider, pollMs }).listen(port, () => {
    console.log(`AurumDesk running at http://localhost:${port}  (data: ${provider.label})`);
  });
}
