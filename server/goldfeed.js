// Gold candles for the chart that move like TradingView's XAU/USD.
//
// PAXG (the token the strategies were tested on) trades too thinly for a smooth
// 1-minute chart: many candles are flat dashes. The chart uses, in order:
//   1. Binance's XAUUSDT perpetual (a deep gold market with real volume),
//      shifted onto the live spot price;
//   2. candles built from the live spot quotes the server polls every second,
//      for the time the server has been running.
// The browser falls back to shifted PAXG candles for anything older.

const IV = { M1: '1m', M5: '5m', M15: '15m', H1: '1h' };
const SEC = { M1: 60, M5: 300, M15: 900, H1: 3600 };
const KEEP = 3 * 1440;
const r2 = (x) => Math.round(x * 100) / 100; // three days of 1-minute spot candles

export function parseFutures(rows) {
  return (rows || []).map((k) => ({
    time: Math.floor(k[0] / 1000),
    open: +k[1], high: +k[2], low: +k[3], close: +k[4],
    volume: +k[5],
    buyVolume: +k[9],
  }));
}

export function aggregate(m1, sec) {
  if (sec === 60) return m1.map((c) => ({ ...c }));
  const out = [];
  for (const c of m1) {
    const t = Math.floor(c.time / sec) * sec;
    const last = out[out.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
    } else out.push({ time: t, open: c.open, high: c.high, low: c.low, close: c.close });
  }
  return out;
}

export function createGoldCandles({ fetchImpl = (...a) => fetch(...a), base = 'https://fapi.binance.com', symbol = 'XAUUSDT', log = () => {} } = {}) {
  const m1 = []; // sorted spot candles
  const cache = {};
  let futuresOffUntil = 0;
  let futuresOk = null;

  function onSpot(p, now = Date.now() / 1000) {
    const t = Math.floor(now / 60) * 60;
    const last = m1[m1.length - 1];
    if (last && last.time === t) {
      last.high = Math.max(last.high, p);
      last.low = Math.min(last.low, p);
      last.close = p;
    } else if (!last || t > last.time) {
      m1.push({ time: t, open: last ? last.close : p, high: Math.max(p, last ? last.close : p), low: Math.min(p, last ? last.close : p), close: p });
      if (m1.length > KEEP) m1.splice(0, m1.length - KEEP);
    }
  }

  async function futures(tf, limit) {
    if (Date.now() < futuresOffUntil) return null;
    const key = `${tf}:${limit}`;
    const hit = cache[key];
    if (hit && Date.now() - hit.at < 5000) return hit.candles;
    try {
      const res = await fetchImpl(`${base}/fapi/v1/klines?symbol=${symbol}&interval=${IV[tf]}&limit=${limit}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`${res.status}`);
      const candles = parseFutures(await res.json());
      if (!candles.length) throw new Error('empty');
      cache[key] = { at: Date.now(), candles };
      if (futuresOk !== true) log(`Gold chart: ${symbol} perpetual candles available`);
      futuresOk = true;
      return candles;
    } catch (e) {
      if (futuresOk !== false) log(`Gold chart: ${symbol} perpetual unavailable (${e.message}); using spot-built candles`);
      futuresOk = false;
      futuresOffUntil = Date.now() + 10 * 60 * 1000;
      return null;
    }
  }

  return {
    onSpot,
    get spotCount() {
      return m1.length;
    },
    // { source, candles } on the spot price level (spot is the live quote, or null).
    async get(tf, limit = 600, spot = null) {
      if (!SEC[tf]) throw Object.assign(new Error(`Unknown timeframe ${tf}`), { status: 400 });
      const f = await futures(tf, limit);
      if (f) {
        const shift = spot != null ? spot - f[f.length - 1].close : 0;
        return {
          source: `Binance ${symbol} perpetual`,
          shift,
          candles: f.map((c) => ({ ...c, open: r2(c.open + shift), high: r2(c.high + shift), low: r2(c.low + shift), close: r2(c.close + shift) })),
        };
      }
      // Drop the first bucket: it may only hold part of its period.
      const agg = aggregate(m1, SEC[tf]);
      return { source: 'Swissquote spot ticks', shift: 0, candles: agg.slice(agg.length > 1 ? 1 : 0).slice(-limit) };
    },
  };
}
