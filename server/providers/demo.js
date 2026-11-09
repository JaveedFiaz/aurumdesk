// Synthetic gold-like prices for running the terminal offline. Price is a
// deterministic function of time (layered value noise), so every timeframe and
// the live tick agree with each other. Not market data.

import { bucketStart, shiftBucket } from '../../shared/timeframes.js';

const SCALES = [60, 240, 960, 3840, 15360, 61440, 245760, 983040, 3932160, 15728640, 31536000];

function hash(n, seed) {
  let h = Math.imul((n | 0) ^ seed, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 4294967295) * 2 - 1;
}

function noise(x, seed) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i, seed) * (1 - u) + hash(i + 1, seed) * u;
}

export function demoPrice(t) {
  let s = 0.00015 * hash(Math.floor(t), 99991);
  for (let k = 0; k < SCALES.length; k++) {
    s += 0.0008 * Math.pow(SCALES[k] / 60, 0.4) * noise(t / SCALES[k], k * 7919 + 13);
  }
  return Math.round(3000 * Math.exp(s) * 100) / 100;
}

function candle(a, b, now) {
  const end = Math.min(b, now);
  const n = Math.max(8, Math.min(300, Math.round((end - a) / 60)));
  const open = demoPrice(a);
  const close = demoPrice(end);
  let high = Math.max(open, close);
  let low = Math.min(open, close);
  for (let k = 1; k < n; k++) {
    const p = demoPrice(a + ((end - a) * k) / n);
    if (p > high) high = p;
    if (p < low) low = p;
  }
  const volume = Math.round(((end - a) / 60) * (400 + 300 * hash(a, 4242)) * (1 + (Math.abs(close - open) / open) * 300));
  // Buyers dominate rising candles and sellers falling ones, with noise.
  const share = Math.min(0.95, Math.max(0.05, 0.5 + 0.35 * Math.tanh(((close - open) / open) * 400) + 0.08 * hash(a, 777)));
  return { time: a, open, high, low, close, volume, buyVolume: Math.round(volume * share) };
}

// Synthetic tape: one trade every 0.6 s, a few of them very large.
function demoTrades(t, limit) {
  const out = [];
  for (let k = limit - 1; k >= 0; k--) {
    const tk = Math.floor((t - k * 0.6) * 10) / 10;
    const n = Math.round(tk * 10);
    let size = Math.exp(hash(n, 31) * 1.6) * 0.6;
    if (hash(n, 97) > 0.985) size *= 30;
    const drift = demoPrice(tk) - demoPrice(tk - 30);
    const side = drift + hash(n, 53) * 0.6 > 0 ? 'buy' : 'sell';
    out.push({ time: tk, price: demoPrice(tk), size: Math.round(size * 1000) / 1000, side });
  }
  return out;
}

// Synthetic order book: thin levels every $0.10 with resting walls at round
// numbers and at a few stable random prices.
function demoBook(t, depth = 400) {
  const mid = demoPrice(t);
  const side = (dir) => Array.from({ length: depth }, (_, k) => {
    const price = Math.round((mid + dir * (0.05 + k * 0.1)) * 100) / 100;
    const key = Math.round(price * 10);
    let size = 0.4 + Math.abs(hash(key, 11)) * 1.2;
    if (key % 50 === 0) size *= 8;
    if (hash(key, 19) > 0.97) size *= 12;
    return { price, size: Math.round(size * 1000) / 1000 };
  });
  return { bids: side(-1), asks: side(1) };
}

const NATIVES = [
  { id: '1m', sec: 60 },
  { id: '3m', sec: 180 },
  { id: '5m', sec: 300 },
  { id: '15m', sec: 900 },
  { id: '30m', sec: 1800 },
  { id: '1h', sec: 3600 },
  { id: '4h', sec: 14400 },
  { id: '1d', sec: 86400 },
  { id: '1w', sec: 604800, week: true },
  { id: '1M', months: 1 },
];

export function createDemo({ now = () => Date.now() / 1000 } = {}) {
  return {
    name: 'demo',
    label: 'Demo data',
    note: 'Synthetic prices for testing. Not real market data.',
    demo: true,
    natives: NATIVES,
    maxCandles: 5000,
    pollMs: 1000,

    async fetchCandles(interval, limit) {
      const nat = NATIVES.find((x) => x.id === interval);
      const t = now();
      const last = bucketStart(nat, Math.floor(t));
      const out = [];
      for (let k = limit - 1; k >= 0; k--) {
        const a = shiftBucket(nat, last, -k);
        out.push(candle(a, shiftBucket(nat, a, 1), t));
      }
      return out;
    },

    async fetchTrades(limit = 1000) {
      return demoTrades(now(), limit);
    },

    async fetchBook(limit = 400) {
      return demoBook(now(), limit);
    },

    async fetchPrice() {
      return demoPrice(now());
    },
  };
}
