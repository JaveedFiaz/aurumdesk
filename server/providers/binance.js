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

export function createBinance({ base = 'https://data-api.binance.vision', symbol = 'PAXGUSDT' } = {}) {
  async function get(path) {
    const res = await fetch(`${base}${path}`);
    if (!res.ok) throw new Error(`Binance ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  return {
    name: 'binance',
    label: `Binance ${symbol}`,
    note: 'PAXG (gold-backed token) as a free proxy for XAU/USD. Trades 24/7 and can differ slightly from broker spot.',
    natives: NATIVES,
    maxCandles: 5000,
    pollMs: 1000,

    async fetchCandles(interval, limit) {
      const out = [];
      let endTime;
      while (out.length < limit) {
        const n = Math.min(1000, limit - out.length);
        const q = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${n}${endTime ? `&endTime=${endTime}` : ''}`;
        const rows = await get(q);
        if (!rows.length) break;
        out.unshift(...rows.map((k) => ({
          time: Math.floor(k[0] / 1000),
          open: +k[1],
          high: +k[2],
          low: +k[3],
          close: +k[4],
          volume: +k[5],
        })));
        if (rows.length < n) break;
        endTime = rows[0][0] - 1;
      }
      return out;
    },

    async fetchPrice() {
      const j = await get(`/api/v3/ticker/price?symbol=${symbol}`);
      return +j.price;
    },
  };
}
