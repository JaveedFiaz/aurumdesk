// Yahoo Finance chart data (no key). Used for US30: Dow Jones futures (YM=F), which
// trade almost around the clock like broker US30 CFDs and carry real volume.
// No order flow or order book: those are paid exchange data.
// History limits: 1m for 7 days, 5m/15m for 60 days, 1h for 730 days, 1d for years.

const NATIVES = [
  { id: '1m', sec: 60, maxDays: 7 },
  { id: '5m', sec: 300, maxDays: 59 },
  { id: '15m', sec: 900, maxDays: 59 },
  { id: '60m', sec: 3600, maxDays: 729 },
  { id: '1d', sec: 86400, maxDays: 3650 },
];

export function parseYahoo(j) {
  const r = j?.chart?.result?.[0];
  if (!r || !r.timestamp) return [];
  const q = r.indicators.quote[0];
  const sec = { '1m': 60, '5m': 300, '15m': 900, '60m': 3600, '1h': 3600, '1d': 86400 }[r.meta?.dataGranularity] || 60;
  const out = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const [o, h, l, c] = [q.open[i], q.high[i], q.low[i], q.close[i]];
    if (o == null || h == null || l == null || c == null) continue;
    // Bucket to the interval start (Yahoo stamps hourly bars on the half hour for some symbols).
    const time = sec >= 86400 ? r.timestamp[i] - (r.timestamp[i] % 86400) : r.timestamp[i] - (r.timestamp[i] % sec);
    const last = out[out.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, h);
      last.low = Math.min(last.low, l);
      last.close = c;
      last.volume += q.volume[i] || 0;
    } else out.push({ time, open: o, high: h, low: l, close: c, volume: q.volume[i] || 0 });
  }
  return out;
}

export function createYahoo({ symbol = 'YM=F', label = 'Dow futures (YM)', fetchImpl = (...a) => fetch(...a) } = {}) {
  const base = 'https://query1.finance.yahoo.com/v8/finance/chart/';
  async function get(params) {
    const res = await fetchImpl(`${base}${encodeURIComponent(symbol)}?${params}`, { signal: AbortSignal.timeout(20000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) throw new Error(`Yahoo ${res.status}`);
    return res.json();
  }
  return {
    name: 'yahoo',
    label: `${label} · Yahoo`,
    symbol,
    natives: NATIVES,
    maxCandles: 20000,
    pollMs: 5000,
    async fetchCandles(interval, limit) {
      const n = NATIVES.find((x) => x.id === interval) || NATIVES[3];
      const days = Math.min(n.maxDays, Math.ceil((limit * n.sec) / 86400 * 1.6) + 2);
      const now = Math.floor(Date.now() / 1000);
      const j = await get(`interval=${n.id}&period1=${now - days * 86400}&period2=${now}&includePrePost=true`);
      return parseYahoo(j).slice(-limit);
    },
    async fetchPrice() {
      const j = await get('interval=1m&range=1d&includePrePost=true');
      const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (!Number.isFinite(p)) throw new Error('Yahoo: no price');
      return p;
    },
  };
}
