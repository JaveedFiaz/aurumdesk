// Memecoin radar: live pump / dump detection on Binance memecoins, straight from
// the exchange in the browser (1-minute candles with taker buy volume, the top
// of the order book, and 24h tickers).
//
// What the data says (14 days of 1m candles on these 23 coins, Nov 2026):
//   after a PUMP (2%+ in 5 min on 3x volume, 60%+ taker buys) price was LOWER an
//   hour later 70-80% of the time; chasing pumps with a 2R target lost money
//   (profit factor about 0.15). Dumps behaved the same way in reverse.
//   Fading the biggest moves (3%+ in 5 min) after the first candle against them
//   made a small profit (PF 1.25-1.39) but on only 28 trades: experimental.

import { buildUniverse, coinOf, FUT_FALLBACK, NEW_DAYS } from '../shared/memeuniverse.js'; // resolves to /shared/ in the browser

const REST = 'https://data-api.binance.vision/api/v3';
const WS = 'wss://data-stream.binance.vision/stream?streams=';

export const MEME_COINS = ['DOGE', 'SHIB', 'PEPE', 'FLOKI', 'BONK', 'WIF', 'BOME', 'MEME', 'TURBO', 'NEIRO', 'PEOPLE', 'PNUT', 'ACT',
  '1000SATS', 'DOGS', 'TRUMP', '1000CAT', '1MBABYDOGE', 'PENGU', 'BROCCOLI714', '1000CHEEMS', 'TST', 'MUBARAK'];

const RULES = { volX: 3, buy: 0.6, move: 0.02, heatVolX: 2, bigMove: 0.03 };

// Metrics from 1m candles (oldest first; the last one may still be forming).
export function memeMetrics(c) {
  const n = c.length;
  if (n < 65) return null;
  const L = n - 1;
  let v3 = 0;
  let b3 = 0;
  for (let k = L - 2; k <= L; k++) {
    v3 += c[k].volume;
    b3 += c[k].buyVolume;
  }
  let base = 0;
  for (let k = L - 62; k < L - 2; k++) base += c[k].volume;
  base /= 20;
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = L - 60; k < L; k++) {
    hi = Math.max(hi, c[k].high);
    lo = Math.min(lo, c[k].low);
  }
  const price = c[L].close;
  return {
    price,
    volX: base > 0 ? v3 / base : 0,
    buy: v3 > 0 ? b3 / v3 : 0.5,
    m5: price / c[L - 5].close - 1,
    m60: price / c[L - 60].close - 1,
    hi60: hi,
    lo60: lo,
  };
}

// PUMP / DUMP now, HEATING (volume and buyers building before price moves), and
// FADE (experimental): the first candle against a 3%+ move in the last 10 minutes.
export function memeStatus(c, m) {
  if (!m) return null;
  const R = RULES;
  if (m.volX >= R.volX && m.buy >= R.buy && m.m5 >= R.move) return { kind: 'pump', text: 'PUMP' };
  if (m.volX >= R.volX && m.buy <= 1 - R.buy && m.m5 <= -R.move) return { kind: 'dump', text: 'DUMP' };
  const L = c.length - 1;
  for (let k = L - 10; k < L; k++) {
    const mv = c[k].close / c[k - 5].close - 1;
    if (Math.abs(mv) < R.bigMove) continue;
    const up = mv > 0;
    const last = c[L - 1]; // last closed candle
    if (up ? last.close < last.open : last.close > last.open) {
      let ext = up ? -Infinity : Infinity;
      for (let j = k - 5; j < L; j++) ext = up ? Math.max(ext, c[j].high) : Math.min(ext, c[j].low);
      const entry = c[L].close;
      const stop = ext * (up ? 1.002 : 0.998);
      const risk = Math.abs(stop - entry);
      if (!(risk > 0) || risk / entry > 0.05) break;
      return { kind: up ? 'fade-short' : 'fade-long', text: up ? 'FADE ↓' : 'FADE ↑', plan: { entry, stop, target: entry + (up ? -1.5 : 1.5) * risk } };
    }
    break;
  }
  if (m.volX >= R.heatVolX && Math.abs(m.m5) < 0.01 && (m.buy >= R.buy || m.buy <= 1 - R.buy)) return { kind: m.buy >= 0.5 ? 'heat-up' : 'heat-down', text: m.buy >= 0.5 ? 'HEATING ↑' : 'HEATING ↓' };
  return null;
}

const kline = (k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], buyVolume: +k[9] });

const VENUE = {
  spot: { rest: `${REST}/klines`, ws: WS },
  fut: { rest: 'https://fapi.binance.com/fapi/v1/klines', ws: 'wss://fstream.binance.com/stream?streams=' },
};

// Coins come from the server's /api/memes (found automatically on Binance):
// spot memecoins, futures memecoins, and every futures listing of the last 3 weeks.
// Last resort for the futures list: every perpetual's ticker arrives once a
// second on Binance's futures stream. Memes are matched by coin name; a symbol
// never seen before in this browser is shown as a NEW listing for 3 weeks.
function futuresFromStream(spotCoins) {
  return new Promise((resolve) => {
    let ws;
    const done = (list) => {
      try { ws?.close(); } catch { /* closed */ }
      resolve(list);
    };
    const timer = setTimeout(() => done({ futures: [], fresh: [] }), 8000);
    try {
      ws = new WebSocket('wss://fstream.binance.com/ws/!miniTicker@arr');
    } catch {
      clearTimeout(timer);
      resolve({ futures: [], fresh: [] });
      return;
    }
    ws.onmessage = (e) => {
      clearTimeout(timer);
      const syms = JSON.parse(e.data).map((t) => t.s).filter((s) => /USDT$/.test(s));
      let seen = {};
      try { seen = JSON.parse(localStorage.getItem('scalper4:futSeen') || '{}'); } catch { /* storage off */ }
      const first = !Object.keys(seen).length;
      const now = Date.now();
      for (const s of syms) if (!(s in seen)) seen[s] = first ? 0 : now;
      try { localStorage.setItem('scalper4:futSeen', JSON.stringify(seen)); } catch { /* storage off */ }
      const memes = new Set([...spotCoins, ...FUT_FALLBACK]);
      const row = (s) => ({ symbol: s, name: s.replace(/USDT$/, ''), coin: coinOf(s.replace(/USDT$/, '')) });
      done({
        futures: syms.map(row).filter((x) => memes.has(x.coin)),
        fresh: syms.filter((s) => seen[s] > now - NEW_DAYS * 86400000).map((s) => ({ ...row(s), onboard: seen[s], meme: memes.has(row(s).coin) })),
      });
    };
    ws.onerror = () => { clearTimeout(timer); done({ futures: [], fresh: [] }); };
  });
}

export function createMemeRadar({ onUpdate, onSignal }) {
  const coins = new Map(); // key -> coin
  const sockets = [];
  let stopped = false;
  let dirty = false;
  let futDirect = null; // can this browser reach Binance Futures itself?
  const timers = [];

  const getJSON = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  };
  // Futures REST: straight from Binance when it answers, else through the server.
  async function fut(path, proxy) {
    if (futDirect !== false) {
      try {
        const j = await getJSON(`https://fapi.binance.com${path}`);
        futDirect = true;
        return j;
      } catch {
        if (futDirect == null) futDirect = false;
      }
    }
    return getJSON(proxy);
  }

  function add(list, venue, extra = {}) {
    for (const c of list) {
      const key = `${venue}:${c.symbol}`;
      const x = coins.get(key);
      if (x) Object.assign(x, extra);
      else coins.set(key, { key, venue, symbol: c.symbol, name: c.name, onboard: c.onboard || null, candles: [], book: null, day: null, status: null, metrics: null, funding: null, oi1h: null, isNew: false, meme: c.meme !== false, ...extra });
    }
  }

  async function loadUniverse() {
    let u = null;
    try {
      u = await getJSON('/api/memes');
    } catch { /* built in the browser below */ }
    // The server could not get Binance's lists (its shared address is often rate
    // limited): build them here, from this browser's own connection to Binance.
    if (!u || !u.futures?.length || !u.spot?.length) {
      const [spotInfo, futInfo] = await Promise.all([
        getJSON(`${REST}/exchangeInfo?permissions=SPOT`).catch(() => null),
        getJSON('https://fapi.binance.com/fapi/v1/exchangeInfo').catch(() => null),
      ]);
      const mine = buildUniverse({ spotInfo, futInfo, products: null });
      if (!futInfo) Object.assign(mine, await futuresFromStream(new Set(mine.spot.map((x) => x.coin))));
      u = {
        spot: u?.spot?.length ? u.spot : mine.spot,
        futures: u?.futures?.length ? u.futures : mine.futures,
        fresh: u?.fresh?.length ? u.fresh : mine.fresh,
      };
    }
    const before = coins.size;
    add(u?.spot?.length ? u.spot : MEME_COINS.map((n) => ({ symbol: `${n}USDT`, name: n })), 'spot');
    add(u?.futures || [], 'fut');
    for (const c of u?.fresh || []) add([c], 'fut', { isNew: true, meme: !!c.meme });
    return coins.size !== before;
  }

  async function loadHistory(list) {
    const queue = [...list];
    const worker = async () => {
      while (queue.length) {
        const x = queue.shift();
        try {
          const rows = x.venue === 'spot'
            ? await getJSON(`${REST}/klines?symbol=${x.symbol}&interval=1m&limit=90`)
            : await fut(`/fapi/v1/klines?symbol=${x.symbol}&interval=1m&limit=90`, `/api/fut/klines?symbol=${x.symbol}&limit=90`);
          x.candles = rows.map(kline);
          dirty = true;
        } catch { /* fills in from the stream */ }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
  }

  async function loadTickers() {
    const spot = [...coins.values()].filter((x) => x.venue === 'spot');
    for (let i = 0; i < spot.length; i += 100) {
      try {
        const syms = encodeURIComponent(JSON.stringify(spot.slice(i, i + 100).map((x) => x.symbol)));
        for (const t of await getJSON(`${REST}/ticker/24hr?symbols=${syms}`)) {
          const x = coins.get(`spot:${t.symbol}`);
          if (x) x.day = { change: +t.priceChangePercent / 100, quoteVolume: +t.quoteVolume };
        }
      } catch { /* next pass */ }
    }
    const futs = [...coins.values()].filter((x) => x.venue === 'fut');
    if (!futs.length) return;
    try {
      const all = await fut('/fapi/v1/premiumIndex', '/api/fut/premium');
      for (const p of all) {
        const x = coins.get(`fut:${p.symbol}`);
        if (x) x.funding = +p.lastFundingRate;
      }
    } catch { /* next pass */ }
    try {
      const day = await fut('/fapi/v1/ticker/24hr', '/api/fut/ticker');
      if (Array.isArray(day)) for (const t of day) {
        const x = coins.get(`fut:${t.symbol}`);
        if (x && t.priceChangePercent != null) x.day = { change: +t.priceChangePercent / 100, quoteVolume: +t.quoteVolume };
      }
    } catch { /* 24h change from the candles only */ }
    dirty = true;
  }

  // Open interest change over the last hour (futures), a few coins per pass.
  let oiAt = 0;
  async function loadOI() {
    const futs = [...coins.values()].filter((x) => x.venue === 'fut');
    for (let n = 0; n < 8 && futs.length; n++) {
      const x = futs[oiAt++ % futs.length];
      try {
        const h = await fut(`/futures/data/openInterestHist?symbol=${x.symbol}&period=5m&limit=13`, `/api/fut/oi?symbol=${x.symbol}`);
        if (h.length >= 2) x.oi1h = +h[h.length - 1].sumOpenInterest / +h[0].sumOpenInterest - 1;
      } catch { /* next pass */ }
    }
    dirty = true;
  }

  function onMessage(venue, msg) {
    const d = msg.data;
    if (!d) return;
    const x = coins.get(`${venue}:${msg.stream.split('@')[0].toUpperCase()}`);
    if (!x) return;
    if (d.e === 'kline') {
      const k = d.k;
      const bar = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, buyVolume: +k.V };
      const c = x.candles;
      if (c.length && c[c.length - 1].time === bar.time) c[c.length - 1] = bar;
      else if (!c.length || bar.time > c[c.length - 1].time) {
        c.push(bar);
        if (c.length > 120) c.splice(0, c.length - 100);
      }
    } else {
      const bids = d.bids || d.b;
      const asks = d.asks || d.a;
      if (!bids || !asks) return;
      const sum = (side) => side.reduce((t, [p, q]) => t + +p * +q, 0);
      const bid = sum(bids);
      const ask = sum(asks);
      x.book = { bid, ask, imb: bid + ask > 0 ? (bid - ask) / (bid + ask) : 0 };
    }
    dirty = true;
  }

  // Futures candles by polling the server when the browser's futures stream is blocked.
  let pollAt = 0;
  async function pollFutures() {
    const futs = [...coins.values()].filter((x) => x.venue === 'fut');
    for (let n = 0; n < 10 && futs.length; n++) {
      const x = futs[pollAt++ % futs.length];
      try {
        x.candles = (await getJSON(`/api/fut/klines?symbol=${x.symbol}&limit=90`)).map(kline);
        dirty = true;
      } catch { /* next pass */ }
    }
  }

  function connect() {
    sockets.splice(0).forEach((w) => { w.closed = true; w.ws?.close(); });
    for (const venue of ['spot', 'fut']) {
      const list = [...coins.values()].filter((x) => x.venue === venue);
      const streams = list.flatMap((x) => [`${x.symbol.toLowerCase()}@kline_1m`, `${x.symbol.toLowerCase()}@depth10@${venue === 'fut' ? 500 : 1000}ms`]);
      for (let i = 0; i < streams.length; i += 100) {
        const w = { closed: false, ws: null, got: false };
        sockets.push(w);
        let delay = 1000;
        const open = () => {
          if (stopped || w.closed) return;
          try {
            w.ws = new WebSocket(VENUE[venue].ws + streams.slice(i, i + 100).join('/'));
          } catch {
            return;
          }
          w.ws.onopen = () => { delay = 1000; };
          w.ws.onmessage = (e) => {
            w.got = true;
            onMessage(venue, JSON.parse(e.data));
          };
          w.ws.onclose = () => {
            if (stopped || w.closed) return;
            setTimeout(open, delay);
            delay = Math.min(delay * 2, 30000);
          };
          w.ws.onerror = () => w.ws.close();
        };
        open();
        if (venue === 'fut') {
          // No futures data from the stream after 12 s: poll through the server instead.
          setTimeout(() => {
            if (!w.got && !w.closed && !timers.pollFut) timers.pollFut = setInterval(pollFutures, 4000);
          }, 12000);
        }
      }
    }
  }

  function evaluate() {
    if (!dirty) return;
    dirty = false;
    for (const x of coins.values()) {
      x.metrics = memeMetrics(x.candles);
      const st = memeStatus(x.candles, x.metrics);
      const was = x.status?.kind;
      x.status = st;
      if (st && st.kind !== was && ['pump', 'dump', 'fade-short', 'fade-long'].includes(st.kind)) onSignal?.(x, st);
    }
    onUpdate?.([...coins.values()]);
  }

  async function refreshUniverse() {
    const before = new Set(coins.keys());
    if (await loadUniverse()) {
      await loadHistory([...coins.values()].filter((x) => !before.has(x.key)));
      connect();
      loadTickers();
    }
  }

  return {
    async start() {
      await loadUniverse();
      onUpdate?.([...coins.values()]);
      await Promise.all([loadHistory([...coins.values()]), loadTickers()]);
      connect();
      timers.push(setInterval(evaluate, 1000), setInterval(loadTickers, 60000), setInterval(loadOI, 20000), setInterval(refreshUniverse, 30 * 60000));
      loadOI();
      evaluate();
    },
    stop() {
      stopped = true;
      timers.forEach(clearInterval);
      clearInterval(timers.pollFut);
      sockets.forEach((w) => { w.closed = true; w.ws?.close(); });
    },
  };
}
