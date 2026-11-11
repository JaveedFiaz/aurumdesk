// Binance public market data. PAXG is a token backed 1:1 by a London Good
// Delivery gold ounce, so PAXG/USDT tracks spot XAU/USD closely. No API key needed.
// It trades 24/7, so weekend candles exist even though spot gold is closed.

const NATIVES = [
  { id: '1m', sec: 60 },
  { id: '3m', sec: 180 },
  { id: '5m', sec: 300 },
  { id: '15m', sec: 900 },
  { id: '30m', sec: 1800 },
  { id: '1h', sec: 3600 },
  { id: '2h', sec: 7200 },
  { id: '4h', sec: 14400 },
  { id: '6h', sec: 21600 },
  { id: '12h', sec: 43200 },
  { id: '1d', sec: 86400 },
  { id: '1w', sec: 604800, week: true },
  { id: '1M', months: 1 },
];

// Binance limits request "weight" per IP and bans IPs that keep going after a
// 429. Every provider in this process shares one budget: bulk history pages
// are paced, and after a 429/418 nothing is sent until the ban has passed.
const limiter = { nextFree: 0, blockedUntil: 0 };
const PACE_MS = 400; // one history page (weight 2) every 400 ms, about 300 weight a minute

export function binanceBlockedUntil() {
  return limiter.blockedUntil;
}

// A ban seen in another thread applies here too: it is per IP.
export function setBinanceBlocked(until) {
  if (until > limiter.blockedUntil) limiter.blockedUntil = until;
}

async function pace() {
  const now = Date.now();
  const at = Math.max(now, limiter.nextFree);
  limiter.nextFree = at + PACE_MS;
  if (at > now) await new Promise((r) => { setTimeout(r, at - now); });
}

export function createBinance({ base = 'https://data-api.binance.vision', symbol = 'PAXGUSDT', fetchImpl = (...a) => fetch(...a) } = {}) {
  async function get(path, { bulk = false } = {}) {
    if (bulk) await pace();
    if (Date.now() < limiter.blockedUntil) {
      throw new Error(`Binance rate limit: paused for ${Math.ceil((limiter.blockedUntil - Date.now()) / 1000)} s`);
    }
    const res = await fetchImpl(`${base}${path}`);
    if (res.status === 429 || res.status === 418) {
      const text = await res.text().catch(() => '');
      const until = +(text.match(/banned until (\d+)/)?.[1] || 0);
      const retry = +(res.headers?.get?.('retry-after') || 0) * 1000;
      limiter.blockedUntil = Math.max(until, Date.now() + Math.max(retry, 60000)) + 5000;
      throw new Error(`Binance rate limit: paused for ${Math.ceil((limiter.blockedUntil - Date.now()) / 1000)} s`);
    }
    if (!res.ok) throw new Error(`Binance ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  return {
    name: 'binance',
    symbol,
    label: `Binance ${symbol}`,
    note: 'PAXG (gold-backed token) as a free proxy for XAU/USD. Trades 24/7 and can differ slightly from broker spot.',
    natives: NATIVES,
    maxCandles: 5000,
    pollMs: 3000,

    async fetchCandles(interval, limit) {
      const out = [];
      let endTime;
      while (out.length < limit) {
        const n = Math.min(1000, limit - out.length);
        const q = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${n}${endTime ? `&endTime=${endTime}` : ''}`;
        const rows = await get(q, { bulk: limit > 1000 });
        if (!rows.length) break;
        out.unshift(...rows.map((k) => ({
          time: Math.floor(k[0] / 1000),
          open: +k[1],
          high: +k[2],
          low: +k[3],
          close: +k[4],
          volume: +k[5],
          buyVolume: +k[9], // taker buy volume: market buyers lifting the offer
        })));
        if (rows.length < n) break;
        endTime = rows[0][0] - 1;
      }
      return out;
    },

    // Recent trades. isBuyerMaker means the seller hit the bid, so that trade was a market sell.
    async fetchTrades(limit = 1000) {
      const rows = await get(`/api/v3/aggTrades?symbol=${symbol}&limit=${Math.min(1000, limit)}`);
      return rows.map((r) => ({ time: r.T / 1000, price: +r.p, size: +r.q, side: r.m ? 'sell' : 'buy' }));
    },

    async fetchBook(limit = 500) {
      const j = await get(`/api/v3/depth?symbol=${symbol}&limit=${limit}`);
      const side = (rows) => rows.map(([p, q]) => ({ price: +p, size: +q }));
      return { bids: side(j.bids), asks: side(j.asks) };
    },

    // Live trades over one WebSocket for several providers' symbols. onTrade(symbol, trade).
    stream(symbols, onTrade, onState = () => {}) {
      if (typeof WebSocket === 'undefined') return () => {};
      const url = `wss://data-stream.binance.vision/stream?streams=${symbols.map((x) => `${x.toLowerCase()}@aggTrade`).join('/')}`;
      let ws;
      let stopped = false;
      let delay = 2000;
      let timer;
      const open = () => {
        if (stopped) return;
        try {
          ws = new WebSocket(url);
        } catch {
          return;
        }
        ws.onopen = () => { delay = 2000; onState(true); };
        ws.onmessage = (e) => {
          try {
            const d = JSON.parse(e.data).data;
            if (d && d.e === 'aggTrade') onTrade(d.s, { time: d.T / 1000, price: +d.p, size: +d.q, side: d.m ? 'sell' : 'buy' });
          } catch { /* ignore a malformed frame */ }
        };
        ws.onclose = () => {
          onState(false);
          if (stopped) return;
          timer = setTimeout(open, delay);
          timer.unref?.();
          delay = Math.min(delay * 2, 60000);
        };
        ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
      };
      open();
      return () => { stopped = true; clearTimeout(timer); try { ws?.close(); } catch { /* already closed */ } };
    },

    async fetchPrice() {
      const j = await get(`/api/v3/ticker/price?symbol=${symbol}`);
      return +j.price;
    },
  };
}
