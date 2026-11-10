// OANDA v20 REST API (https://developer.oanda.com). TradingView's OANDA:XAUUSD
// chart is this same feed, so with PROVIDER=oanda the zones and trade-finder
// setups use the prices you see on TradingView. A free practice (demo) account
// is enough: create one, then generate an API token under "Manage API Access".

const NATIVES = [
  { id: 'M1', sec: 60 },
  { id: 'M2', sec: 120 },
  { id: 'M4', sec: 240 },
  { id: 'M5', sec: 300 },
  { id: 'M10', sec: 600 },
  { id: 'M15', sec: 900 },
  { id: 'M30', sec: 1800 },
  { id: 'H1', sec: 3600 },
  { id: 'H2', sec: 7200 },
  { id: 'H3', sec: 10800 },
  { id: 'H4', sec: 14400 },
  { id: 'H6', sec: 21600 },
  { id: 'H8', sec: 28800 },
  { id: 'H12', sec: 43200 },
  { id: 'D', sec: 86400 },
  { id: 'W', sec: 604800, week: true },
  { id: 'M', months: 1 },
];

const HOSTS = {
  practice: 'https://api-fxpractice.oanda.com',
  live: 'https://api-fxtrade.oanda.com',
};
const PAGE = 5000; // OANDA's maximum candles per request

export function createOanda({ apiKey, instrument = 'XAU_USD', env = 'practice', base } = {}) {
  if (!apiKey) throw new Error('OANDA_API_KEY is required for PROVIDER=oanda');
  const host = base || HOSTS[env] || HOSTS.practice;

  async function get(path) {
    const res = await fetch(`${host}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Accept-Datetime-Format': 'UNIX' },
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`OANDA ${res.status}: ${j.errorMessage || res.statusText}`);
    return j;
  }

  // Candles align to UTC midnight and Monday, like the rest of AurumDesk.
  const query = (granularity, count, to) => `/v3/instruments/${instrument}/candles?price=M&granularity=${granularity}&count=${count}`
    + `&dailyAlignment=0&alignmentTimezone=UTC&weeklyAlignment=Monday${to ? `&to=${to}` : ''}`;

  const parse = (k) => ({
    time: Math.round(parseFloat(k.time)),
    open: +k.mid.o,
    high: +k.mid.h,
    low: +k.mid.l,
    close: +k.mid.c,
    volume: k.volume || 0,
  });

  return {
    name: 'oanda',
    label: `OANDA ${instrument.replace('_', '/')}`,
    note: 'OANDA spot gold: the same feed as TradingView\'s OANDA:XAUUSD chart.',
    natives: NATIVES,
    maxCandles: 20000,
    pollMs: 2000,

    async fetchCandles(interval, limit) {
      const out = [];
      let to;
      while (out.length < limit) {
        const n = Math.min(PAGE, limit - out.length);
        const j = await get(query(interval, n, to));
        const rows = (j.candles || []).filter((k) => k.mid);
        if (!rows.length) break;
        const parsed = rows.map(parse);
        const older = out.length ? parsed.filter((c) => c.time < out[0].time) : parsed;
        if (!older.length) break;
        out.unshift(...older);
        if (rows.length < n) break;
        to = rows[0].time; // the next page ends where this one began
      }
      return out;
    },

    async fetchPrice() {
      const j = await get(`/v3/instruments/${instrument}/candles?price=M&granularity=S5&count=1`);
      const k = j.candles?.[j.candles.length - 1];
      return k ? +k.mid.c : NaN;
    },
  };
}
