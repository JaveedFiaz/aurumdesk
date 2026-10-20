// Timeframe definitions and candle bucketing, shared by the server and the browser.
// Times are Unix seconds (UTC). Weeks start Monday 00:00 UTC; month-based frames
// align to calendar months (quarters for 3M, half-years for 6M).

export const TIMEFRAMES = [
  { id: 'M1', label: '1m', sec: 60 },
  { id: 'M3', label: '3m', sec: 180 },
  { id: 'M5', label: '5m', sec: 300 },
  { id: 'M10', label: '10m', sec: 600 },
  { id: 'M15', label: '15m', sec: 900 },
  { id: 'M30', label: '30m', sec: 1800 },
  { id: 'M45', label: '45m', sec: 2700 },
  { id: 'H1', label: '1H', sec: 3600 },
  { id: 'H4', label: '4H', sec: 14400 },
  { id: 'D1', label: '1D', sec: 86400 },
  { id: 'W1', label: '1W', sec: 604800, week: true },
  { id: 'MN', label: '1M', months: 1 },
  { id: '3M', label: '3M', months: 3 },
  { id: '6M', label: '6M', months: 6 },
];

export const TF = Object.fromEntries(TIMEFRAMES.map((t) => [t.id, t]));

const DAY = 86400;
const WEEK = 7 * DAY;
const MONDAY_OFFSET = 4 * DAY; // 1970-01-01 was a Thursday

export function bucketStart(tf, t) {
  if (tf.months) {
    const d = new Date(t * 1000);
    const m = d.getUTCFullYear() * 12 + d.getUTCMonth();
    const b = Math.floor(m / tf.months) * tf.months;
    return Date.UTC(Math.floor(b / 12), b % 12, 1) / 1000;
  }
  if (tf.week) return Math.floor((t - MONDAY_OFFSET) / WEEK) * WEEK + MONDAY_OFFSET;
  return Math.floor(t / tf.sec) * tf.sec;
}

export function shiftBucket(tf, start, n) {
  if (tf.months) {
    const d = new Date(start * 1000);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n * tf.months, 1) / 1000;
  }
  return start + n * (tf.week ? WEEK : tf.sec);
}

export function nominalSeconds(tf) {
  if (tf.months) return tf.months * 30 * DAY;
  return tf.week ? WEEK : tf.sec;
}

export function sameInterval(a, b) {
  if (a.months || b.months) return a.months === b.months;
  return !!a.week === !!b.week && a.sec === b.sec;
}

// Pick the coarsest native interval a provider offers that tiles `tf` exactly,
// so every timeframe can be built even when the provider lacks it (M10, M45, 3M, 6M).
export function pickNative(tf, natives) {
  const intraday = natives.filter((n) => !n.months && !n.week);
  let fits;
  if (tf.months) {
    fits = natives.filter((n) => n.months && tf.months % n.months === 0);
    if (!fits.length) fits = intraday.filter((n) => DAY % n.sec === 0);
  } else if (tf.week) {
    fits = natives.filter((n) => n.week);
    if (!fits.length) fits = intraday.filter((n) => DAY % n.sec === 0);
  } else {
    fits = intraday.filter((n) => tf.sec % n.sec === 0);
  }
  if (!fits.length) throw new Error(`No native interval can build ${tf.id}`);
  return fits.reduce((a, b) => (nominalSeconds(b) > nominalSeconds(a) ? b : a));
}

export function aggregate(candles, tf) {
  const out = [];
  let cur = null;
  for (const c of candles) {
    const b = bucketStart(tf, c.time);
    if (!cur || cur.time !== b) {
      cur = { time: b, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 };
      out.push(cur);
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume || 0;
    }
  }
  return out;
}
