// Twelve Data spot XAU/USD (https://twelvedata.com). Needs an API key.
// The free plan allows 8 requests/minute and 800/day, which is too little for
// a live terminal; a paid plan, or a slower POLL_MS, is recommended.

const NATIVES = [
  { id: '1min', sec: 60 },
  { id: '5min', sec: 300 },
  { id: '15min', sec: 900 },
  { id: '30min', sec: 1800 },
  { id: '45min', sec: 2700 },
  { id: '1h', sec: 3600 },
  { id: '2h', sec: 7200 },
  { id: '4h', sec: 14400 },
  { id: '1day', sec: 86400 },
  { id: '1week', sec: 604800, week: true },
  { id: '1month', months: 1 },
];

export function parseTime(s) {
  return Date.parse(`${s.length === 10 ? `${s}T00:00:00` : s.replace(' ', 'T')}Z`) / 1000;
}

export function createTwelveData({ apiKey, symbol = 'XAU/USD', base = 'https://api.twelvedata.com' } = {}) {
  if (!apiKey) throw new Error('TWELVEDATA_API_KEY is required for PROVIDER=twelvedata');

  async function get(path) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${base}${path}${sep}apikey=${encodeURIComponent(apiKey)}`);
    const j = await res.json();
    if (!res.ok || j.status === 'error') throw new Error(`Twelve Data: ${j.message || res.status}`);
    return j;
  }

  return {
    name: 'twelvedata',
    label: `Twelve Data ${symbol}`,
    note: 'Spot XAU/USD. Prices are indicative and may differ slightly from your broker.',
    natives: NATIVES,
    maxCandles: 5000,
    pollMs: 10000,

    async fetchCandles(interval, limit) {
      const j = await get(`/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${Math.min(limit, 5000)}&timezone=UTC&order=asc`);
      return (j.values || []).map((v) => ({
        time: parseTime(v.datetime),
        open: +v.open,
        high: +v.high,
        low: +v.low,
        close: +v.close,
        volume: +(v.volume || 0),
      }));
    },

    async fetchPrice() {
      const j = await get(`/price?symbol=${encodeURIComponent(symbol)}`);
      return +j.price;
    },
  };
}
