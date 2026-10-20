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
  return { time: a, open, high, low, close, volume };
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

    async fetchPrice() {
      return demoPrice(now());
    },
  };
}
