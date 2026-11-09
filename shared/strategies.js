// Trade-finding strategies built on the analysis engine. Every check runs on a
// window of candles that ends at the bar being judged, so a signal only ever
// uses closed candles that existed at that moment. The same function drives the
// backtest and the live scan, so live signals are exactly what was tested.

import { atr, findSwings, marketStructure, supplyDemand, previousDay, vwap } from './analysis.js';

const DAY = 86400;

export const STRATEGIES = [
  {
    id: 'zone_retest',
    name: 'Zone retest',
    desc: 'With the 15m and 1H trend agreeing, the first pullback into a fresh order block or supply/demand zone (score 50+) that closes with a rejection candle.',
  },
  {
    id: 'sweep_choch',
    name: 'Sweep + CHoCH',
    desc: 'Price takes out a recent swing high/low, closes back inside (a liquidity grab), then breaks structure the other way (CHoCH) within 12 bars.',
  },
  {
    id: 'pdhl_reject',
    name: 'PDH/PDL reject',
    desc: 'The first wick of the day through the previous day high or low that closes back inside with a rejection candle.',
  },
  {
    id: 'vwap_pullback',
    name: 'VWAP pullback',
    desc: 'With the 15m and 1H trend agreeing, a pullback that tags the daily VWAP and closes back on the trend side after holding it for 3 bars.',
  },
  {
    id: 'htf_zone',
    name: '1H zone reject',
    desc: 'The first touch of an untested 1H supply/demand zone (score 60+) that the 15m candle rejects.',
  },
];

export const STRATEGY_BY_ID = Object.fromEntries(STRATEGIES.map((s) => [s.id, s]));

// London 08:00 to New York 17:00, local time in each city (so DST is handled), weekdays only.
const fmtCache = new Map();
function localMinutes(tz, t) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    fmtCache.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return { wd: p.weekday, min: (+p.hour % 24) * 60 + +p.minute };
}

export function inSession(t) {
  const ldn = localMinutes('Europe/London', t);
  const ny = localMinutes('America/New_York', t);
  const weekday = (d) => d !== 'Sat' && d !== 'Sun';
  return (weekday(ldn.wd) && ldn.min >= 480 && ldn.min < 1020) || (weekday(ny.wd) && ny.min >= 480 && ny.min < 1020);
}

const bullish = (b) => b.close > b.open && b.close >= b.low + (b.high - b.low) * 0.5;
const bearish = (b) => b.close < b.open && b.close <= b.high - (b.high - b.low) * 0.5;
const rejects = (b, dir) => (dir === 'bull' ? bullish(b) : bearish(b));

// Everything the strategies need, computed once per bar on the window.
export function buildContext(w, htf) {
  const a = atr(w);
  const swings = findSwings(w, 5);
  const ms = marketStructure(w, swings);
  const zones = supplyDemand(w, a, ms.trendAt);
  const vw = vwap(w, (t) => Math.floor(t / DAY));
  return { w, a, swings, ms, zones, vw, pd: previousDay(w), htf };
}

// HTF context (1H): trend and zones from closed higher-timeframe candles only.
export function buildHtf(h) {
  if (!h || h.length < 30) return null;
  const a = atr(h);
  const ms = marketStructure(h, findSwings(h, 5));
  return { trend: ms.trend, zones: supplyDemand(h, a, ms.trendAt).filter((z) => !z.broken) };
}

function plan(dir, bar, stop, extra = {}) {
  return { dir, entry: bar.close, stop, ...extra };
}

const CHECKS = {
  zone_retest(ctx) {
    const { w, a, ms, zones, htf } = ctx;
    const L = w.length - 1;
    const bar = w[L];
    const prev = w[L - 1];
    const dir = ms.trend;
    if (!dir || !htf || htf.trend !== dir || !rejects(bar, dir)) return null;
    const bull = dir === 'bull';
    const cands = [
      ...ms.orderBlocks,
      ...zones.filter((z) => z.score >= 50),
    ].filter((z) => z.side === dir && !z.broken && z.touches === 1 && z.createdIndex < L);
    for (const z of cands) {
      const inNow = bull ? bar.low <= z.top : bar.high >= z.bottom;
      const inPrev = bull ? prev.low <= z.top : prev.high >= z.bottom;
      if (!inNow || inPrev) continue;
      const stop = bull ? Math.min(z.bottom, bar.low) - 0.2 * a[L] : Math.max(z.top, bar.high) + 0.2 * a[L];
      return plan(dir, bar, stop, { why: `${z.kind === 'bullOB' || z.kind === 'bearOB' ? 'Order block' : z.kind === 'demand' ? 'Demand' : 'Supply'} ${z.bottom.toFixed(2)}–${z.top.toFixed(2)}` });
    }
    return null;
  },

  sweep_choch(ctx) {
    const { w, a, swings, ms } = ctx;
    const L = w.length - 1;
    const ev = ms.events[ms.events.length - 1];
    if (!ev || ev.index !== L || ev.type !== 'CHoCH') return null;
    const bull = ev.dir === 'bull';
    // Most extreme bar of the last 12 before the break.
    let m = -1;
    for (let k = Math.max(0, L - 12); k < L; k++) {
      if (m < 0 || (bull ? w[k].low < w[m].low : w[k].high > w[m].high)) m = k;
    }
    if (m < 0) return null;
    const swept = swings.find((s) => s.type === (bull ? 'L' : 'H')
      && s.confirmedAt <= m && s.i < m && s.i >= m - 60
      && (bull ? w[m].low < s.price && w[m].close > s.price : w[m].high > s.price && w[m].close < s.price));
    if (!swept) return null;
    const stop = bull ? w[m].low - 0.2 * a[L] : w[m].high + 0.2 * a[L];
    return plan(ev.dir, w[L], stop, { why: `Grabbed ${bull ? 'low' : 'high'} ${swept.price.toFixed(2)}, CHoCH ${ev.level.toFixed(2)}` });
  },

  pdhl_reject(ctx) {
    const { w, a, pd } = ctx;
    if (!pd) return null;
    const L = w.length - 1;
    const bar = w[L];
    for (const dir of ['bull', 'bear']) {
      const bull = dir === 'bull';
      const level = bull ? pd.low : pd.high;
      const pierced = (b) => (bull ? b.low < level : b.high > level);
      if (!pierced(bar) || !(bull ? bar.close > level : bar.close < level) || !rejects(bar, dir)) continue;
      let earlier = false;
      for (let k = pd.todayIndex; k < L && !earlier; k++) earlier = pierced(w[k]);
      if (earlier) continue;
      const stop = bull ? bar.low - 0.2 * a[L] : bar.high + 0.2 * a[L];
      return plan(dir, bar, stop, { why: `Rejected ${bull ? 'PDL' : 'PDH'} ${level.toFixed(2)}` });
    }
    return null;
  },

  vwap_pullback(ctx) {
    const { w, a, ms, vw, htf } = ctx;
    const L = w.length - 1;
    const dir = ms.trend;
    if (!dir || !htf || htf.trend !== dir || L < 4) return null;
    const bar = w[L];
    const v = vw[L].value;
    const day = Math.floor(bar.time / DAY);
    if (Math.floor(w[L - 3].time / DAY) !== day) return null; // need a few bars of today's VWAP
    const bull = dir === 'bull';
    const held = [1, 2, 3].every((k) => (bull ? w[L - k].close > vw[L - k].value : w[L - k].close < vw[L - k].value));
    if (!held || !rejects(bar, dir)) return null;
    if (bull ? !(bar.low <= v && bar.close > v) : !(bar.high >= v && bar.close < v)) return null;
    const stop = bull ? Math.min(bar.low, v - 0.5 * a[L]) - 0.1 * a[L] : Math.max(bar.high, v + 0.5 * a[L]) + 0.1 * a[L];
    return plan(dir, bar, stop, { why: `Held VWAP ${v.toFixed(2)}` });
  },

  htf_zone(ctx) {
    const { w, a, htf } = ctx;
    if (!htf) return null;
    const L = w.length - 1;
    const bar = w[L];
    const prev = w[L - 1];
    for (const z of htf.zones) {
      if (z.score < 60 || z.touches !== 0) continue;
      const bull = z.side === 'bull';
      const inNow = bull ? bar.low <= z.top : bar.high >= z.bottom;
      const inPrev = bull ? prev.low <= z.top : prev.high >= z.bottom;
      if (!inNow || inPrev || !rejects(bar, z.side)) continue;
      if (bull ? bar.close < z.bottom : bar.close > z.top) continue;
      const stop = bull ? Math.min(z.bottom, bar.low) - 0.2 * a[L] : Math.max(z.top, bar.high) + 0.2 * a[L];
      return plan(z.side, bar, stop, { why: `1H ${z.kind} ${z.bottom.toFixed(2)}–${z.top.toFixed(2)} · ${z.score}` });
    }
    return null;
  },
};

export const DEFAULT_RULES = {
  rr: 2, // take profit at 2R
  minStopAtr: 0.5, // stop at least half an ATR away, so noise doesn't take it
  maxStopAtr: 3, // skip setups whose stop is too far to size sensibly
  cost: 0.4, // round-trip spread + slippage in price ($/oz)
  maxPerDay: 3, // trades per strategy per day
  maxBars: 64, // time stop: close after 16 hours on 15m
  sessionOnly: true,
};

// Runs every strategy on a window ending at the bar being judged. Returns
// setups with entry (the bar close), stop and target, or an empty list.
export function scanBar(ctx, rules = DEFAULT_RULES, ids = Object.keys(CHECKS)) {
  const { w, a } = ctx;
  const L = w.length - 1;
  const bar = w[L];
  if (rules.sessionOnly && !inSession(bar.time)) return [];
  const out = [];
  for (const id of ids) {
    const s = CHECKS[id](ctx);
    if (!s) continue;
    const risk = Math.abs(s.entry - s.stop);
    if (!(risk >= rules.minStopAtr * a[L] && risk <= rules.maxStopAtr * a[L] && risk >= 3 * rules.cost)) continue;
    const sign = s.dir === 'bull' ? 1 : -1;
    out.push({ ...s, strategy: id, time: bar.time, target: s.entry + sign * rules.rr * risk });
  }
  return out;
}
