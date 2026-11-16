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

export function createMemeRadar({ onUpdate, onSignal }) {
  const coins = Object.fromEntries(MEME_COINS.map((s) => [s, { symbol: `${s}USDT`, name: s, candles: [], book: null, day: null, status: null, metrics: null }]));
  let ws = null;
  let stopped = false;
  let dirty = false;
  let timer = null;

  async function loadHistory() {
    await Promise.all(Object.values(coins).map(async (x) => {
      try {
        const res = await fetch(`${REST}/klines?symbol=${x.symbol}&interval=1m&limit=90`);
        if (res.ok) x.candles = (await res.json()).map(kline);
      } catch { /* fills in from the stream */ }
    }));
    dirty = true;
  }

  async function loadTickers() {
    try {
      const syms = encodeURIComponent(JSON.stringify(Object.values(coins).map((x) => x.symbol)));
      const res = await fetch(`${REST}/ticker/24hr?symbols=${syms}`);
      if (!res.ok) return;
      for (const t of await res.json()) {
        const x = Object.values(coins).find((c) => c.symbol === t.symbol);
        if (x) x.day = { change: +t.priceChangePercent / 100, quoteVolume: +t.quoteVolume };
      }
      dirty = true;
    } catch { /* next pass */ }
  }

  function connect() {
    const streams = Object.values(coins).flatMap((x) => [`${x.symbol.toLowerCase()}@kline_1m`, `${x.symbol.toLowerCase()}@depth10@1000ms`]);
    let delay = 1000;
    const open = () => {
      if (stopped) return;
      try {
        ws = new WebSocket(WS + streams.join('/'));
      } catch {
        return;
      }
      ws.onopen = () => { delay = 1000; };
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        const d = msg.data;
        const name = msg.stream.split('@')[0].toUpperCase().replace(/USDT$/, '');
        const x = coins[name];
        if (!x || !d) return;
        if (d.e === 'kline') {
          const k = d.k;
          const bar = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, buyVolume: +k.V };
          const c = x.candles;
          if (c.length && c[c.length - 1].time === bar.time) c[c.length - 1] = bar;
          else if (!c.length || bar.time > c[c.length - 1].time) {
            c.push(bar);
            if (c.length > 120) c.splice(0, c.length - 100);
          }
        } else if (d.bids) {
          const sum = (side) => side.reduce((t, [p, q]) => t + +p * +q, 0);
          const bid = sum(d.bids);
          const ask = sum(d.asks);
          x.book = { bid, ask, imb: bid + ask > 0 ? (bid - ask) / (bid + ask) : 0 };
        }
        dirty = true;
      };
      ws.onclose = () => {
        if (stopped) return;
        setTimeout(open, delay);
        delay = Math.min(delay * 2, 30000);
      };
      ws.onerror = () => ws.close();
    };
    open();
  }

  function evaluate() {
    if (!dirty) return;
    dirty = false;
    for (const x of Object.values(coins)) {
      x.metrics = memeMetrics(x.candles);
      const st = memeStatus(x.candles, x.metrics);
      const was = x.status?.kind;
      x.status = st;
      if (st && st.kind !== was && ['pump', 'dump', 'fade-short', 'fade-long'].includes(st.kind)) onSignal?.(x, st);
    }
    onUpdate?.(Object.values(coins));
  }

  return {
    async start() {
      await Promise.all([loadHistory(), loadTickers()]);
      connect();
      timer = setInterval(evaluate, 1000);
      setInterval(loadTickers, 60000);
      evaluate();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      ws?.close();
    },
  };
}
