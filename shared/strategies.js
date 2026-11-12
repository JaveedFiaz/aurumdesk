// Trade-finding strategies built on the analysis engine. Every check runs on a
// window of candles that ends at the bar being judged, so a signal only ever
// uses closed candles that existed at that moment. The same function drives the
// backtest and the live scan, so live signals are exactly what was tested.

import { atr, findSwings, marketStructure, supplyDemand, previousDay, vwap, supportResistance } from './analysis.js';
import { deltaRatio } from './flow.js';

const DAY = 86400;

// Strategies that run live. Each one held up on two years of real gold data in
// both the earlier 60% and the most recent 40% of the period (docs/backtest-results.md).
export const STRATEGIES = [
  {
    id: 'zone_retest',
    name: 'Zone retest',
    rr: 2,
    desc: 'With the 15m and 1H trend agreeing, the first pullback into a fresh order block or supply/demand zone (score 50+) that closes with a rejection candle. Target 2R.',
  },
  {
    id: 'vol_breakout',
    name: 'Volume breakout',
    rr: 3,
    desc: 'During the London or New York open, a close through a fresh swing high/low on 2x+ average volume with aggressive buying (selling) and the 1H trend behind it. Target 3R.',
  },
];

// Tested on the same data and rejected: they lost money, or only made money in
// one half of the period. Kept so they can be re-tested (npm run backtest -- --all).
export const RETIRED = [
  { id: 'trap_flow', name: 'Trap + order flow', desc: 'A breakout (or breakdown) through a fresh swing that fails within 5 candles and closes back inside on above-average volume, with cumulative delta already pointing the other way.' },
  { id: 'trap_trend', name: 'Trap with trend', desc: 'A failed breakout or breakdown that closes back inside the level in the direction of the higher-timeframe trend.' },
  { id: 'zone_sweep', name: 'Sweep into zone', desc: 'Liquidity is swept, then price makes its first touch of a fresh order block or supply/demand zone in the trend direction and rejects it.' },
  { id: 'trap', name: 'Trap (unfiltered)', desc: 'Any failed breakout or breakdown.' },
  { id: 'vwap_pullback', name: 'VWAP pullback', desc: 'Trend pullback to the daily VWAP.' },
  { id: 'sweep_choch', name: 'Sweep + CHoCH', desc: 'Liquidity grab followed by a change of character.' },
  { id: 'sr_flip', name: 'S/R flip', desc: 'Broken support/resistance retested from the other side with order-flow confirmation.' },
  { id: 'liq_absorb', name: 'Liquidity absorption', desc: 'Stops run on heavy volume and absorbed by the other side.' },
  { id: 'pdhl_reject', name: 'PDH/PDL reject', desc: 'First wick of the day through the previous day high or low.' },
  { id: 'htf_zone', name: '1H zone reject', desc: 'First touch of an untested 1H supply/demand zone.' },
  { id: 'ema_pullback', name: 'EMA trend pullback', desc: 'EMA 20 above EMA 50 (below for shorts): price dips to the EMA 20 and closes back on the trend side with buyers (sellers) in control.' },
  { id: 'zone_reject', name: 'Strong zone rejection', desc: 'Price wicks into a strong support (demand) or resistance (supply) zone and closes back out of it on 1.2× volume or more, with order flow behind the rejection.' },
  { id: 'zone_reject_trend', name: 'Zone rejection with trend', desc: 'A strong zone rejection in the direction of the 1H trend.' },
  { id: 'bos_retest', name: 'Break & retest', desc: 'Structure breaks in the higher-timeframe trend direction, price comes back to the broken level once and rejects it with order flow.' },
  { id: 'asia_sweep', name: 'Session sweep', desc: 'At the London or New York open, price runs the previous session\'s high or low and closes back inside.' },
  { id: 'surge_go', name: 'Volume surge go', desc: 'A 2.5× volume candle with a full body and order flow behind it, in the higher-timeframe trend, closing at a 10-candle extreme.' },
  { id: 'vwap_reclaim', name: 'VWAP reclaim', desc: 'In the higher-timeframe trend, price reclaims the daily VWAP after at least three candles on the wrong side, on above-average volume.' },
  { id: 'inside_break', name: 'Inside-bar breakout', desc: 'An inside candle breaks out in the higher-timeframe trend direction on above-average volume.' },
];

export const STRATEGY_BY_ID = Object.fromEntries([...STRATEGIES, ...RETIRED].map((s) => [s.id, s]));

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

// London open (07:00-10:00 UTC) and New York open (12:30-15:30 UTC).
export function inKillzone(t) {
  const m = Math.floor((t % 86400) / 60);
  return (m >= 420 && m < 600) || (m >= 750 && m < 930);
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

const avgVolume = (w, L, n = 20) => {
  let s = 0;
  let k = 0;
  for (let i = Math.max(0, L - n); i < L; i++, k++) s += w[i].volume || 0;
  return k ? s / k : 0;
};
// Order flow agrees with the direction (or there is no order-flow data to say otherwise).
const flowAgrees = (bar, dir, min = 0) => {
  const d = deltaRatio(bar);
  return d == null || (dir === 'bull' ? d > min : d < -min);
};

// Was liquidity on the opposite side taken in the last 20 bars and reclaimed?
export function swept(ctx, dir) {
  const { w, swings } = ctx;
  const L = w.length - 1;
  const bull = dir === 'bull';
  for (const s of swings) {
    if (s.type !== (bull ? 'L' : 'H') || s.confirmedAt > L || s.i < L - 80) continue;
    for (let k = Math.max(s.confirmedAt, L - 20); k <= L; k++) {
      if (bull ? w[k].low < s.price && w[k].close > s.price : w[k].high > s.price && w[k].close < s.price) return true;
    }
  }
  return false;
}

// Sign of cumulative delta over the last 8 candles (null without order-flow data).
export function cvdSign(w, L) {
  if (w[L].buyVolume == null || L < 8) return null;
  let cvd = 0;
  for (let k = L - 7; k <= L; k++) cvd += 2 * (w[k].buyVolume ?? w[k].volume / 2) - (w[k].volume || 0);
  return Math.sign(cvd);
}

const ema = (w, n, L = w.length - 1) => {
  const k = 2 / (n + 1);
  let e = w[Math.max(0, L - n * 4)].close;
  for (let i = Math.max(0, L - n * 4) + 1; i <= L; i++) e += (w[i].close - e) * k;
  return e;
};

// VWAP standard deviation since the daily anchor, at the last bar.
function vwapBand(w, L) {
  const day = Math.floor(w[L].time / DAY);
  let pv = 0;
  let v = 0;
  let pv2 = 0;
  for (let i = L; i >= 0 && Math.floor(w[i].time / DAY) === day; i--) {
    const tp = (w[i].high + w[i].low + w[i].close) / 3;
    const vol = w[i].volume || 1;
    pv += tp * vol;
    pv2 += tp * tp * vol;
    v += vol;
  }
  if (!v) return null;
  const mean = pv / v;
  return { mean, sd: Math.sqrt(Math.max(0, pv2 / v - mean * mean)) };
}

// Session opens (UTC minutes): London 07:00, New York 13:30.
const OPENS = [420, 810];

// Strong zones: unbroken supply/demand scoring 50+ (or 1H zones), touched at
// most three times before, and no taller than 2.5 ATR.
export function strongZones(zones, htf, A) {
  return [...zones, ...(htf?.zones || []).map((z) => ({ ...z, htf: true }))]
    .filter((z) => !z.broken && (z.htf || z.score >= 50) && (z.touches ?? 0) <= 3 && z.top - z.bottom <= 2.5 * A);
}

export const CHECKS = {
  // Trend pullback: EMA 20 above EMA 50 (below for shorts), price dips to the
  // EMA 20 and closes back on the trend side with buyers (sellers) in control.
  ema_pullback(ctx) {
    const { w, a } = ctx;
    const L = w.length - 1;
    if (L < 220) return null;
    const bar = w[L];
    const e20 = ema(w, 20);
    const e50 = ema(w, 50);
    const e20p = ema(w, 20, L - 5);
    for (const dir of ['bull', 'bear']) {
      const bull = dir === 'bull';
      if (bull ? !(e20 > e50 && e20 > e20p) : !(e20 < e50 && e20 < e20p)) continue;
      if (bull ? !(bar.low <= e20 && bar.close > e20) : !(bar.high >= e20 && bar.close < e20)) continue;
      if (!rejects(bar, dir) || !flowAgrees(bar, dir, 0.05)) continue;
      const stop = bull ? Math.min(bar.low, e50) - 0.2 * a[L] : Math.max(bar.high, e50) + 0.2 * a[L];
      return plan(dir, bar, stop, { why: `Pullback to EMA 20 (${e20.toFixed(2)}) in a ${bull ? 'rising' : 'falling'} trend` });
    }
    return null;
  },

  // Opening range breakout: the high/low of the first 15 minutes of London or
  // New York, broken by a strong close on above-average volume.
  orb(ctx) {
    const { w, a } = ctx;
    const L = w.length - 1;
    const bar = w[L];
    const sec = L ? w[L].time - w[L - 1].time : 60;
    const m = Math.floor((bar.time % 86400) / 60);
    const open = OPENS.find((o) => m >= o + 15 && m < o + 120);
    if (open == null) return null;
    const day = Math.floor(bar.time / 86400) * 86400;
    const from = day + open * 60;
    const to = from + 900;
    let hi = -Infinity;
    let lo = Infinity;
    let n = 0;
    let broken = false;
    for (let i = L - 1; i >= 0 && w[i].time >= from; i--) {
      if (w[i].time < to) {
        hi = Math.max(hi, w[i].high);
        lo = Math.min(lo, w[i].low);
        n++;
      } else if (w[i].close > hi || w[i].close < lo) broken = true;
    }
    if (n < Math.max(1, Math.floor(900 / sec) - 1) || !Number.isFinite(hi)) return null;
    // A break counts only the first time; re-check closes after the range against the final range.
    for (let i = L - 1; i >= 0 && w[i].time >= to; i--) if (w[i].close > hi || w[i].close < lo) broken = true;
    if (broken) return null;
    const vAvg = avgVolume(w, L);
    if (!(bar.volume >= 1.5 * vAvg)) return null;
    const range = hi - lo;
    if (!(range > 0.3 * a[L] && range < 4 * a[L])) return null;
    for (const dir of ['bull', 'bear']) {
      const bull = dir === 'bull';
      if (bull ? !(bar.close > hi) : !(bar.close < lo)) continue;
      if (!rejects(bar, dir) || !flowAgrees(bar, dir, 0.1)) continue;
      const stop = bull ? Math.max(lo, hi - range * 0.5) - 0.1 * a[L] : Math.min(hi, lo + range * 0.5) + 0.1 * a[L];
      return plan(dir, bar, stop, { why: `${open === 420 ? 'London' : 'New York'} opening range ${lo.toFixed(2)}–${hi.toFixed(2)} broken on volume`, level: bull ? hi : lo });
    }
    return null;
  },

  // VWAP band reversion: price stretches beyond 2 standard deviations from the
  // day's VWAP and the next close snaps back inside with order flow agreeing.
  vwap_band(ctx) {
    const { w, a } = ctx;
    const L = w.length - 1;
    if (L < 30) return null;
    const bar = w[L];
    const prev = w[L - 1];
    const band = vwapBand(w, L - 1);
    if (!band || !(band.sd > 0.3 * a[L])) return null;
    const up = band.mean + 2 * band.sd;
    const dn = band.mean - 2 * band.sd;
    for (const dir of ['bull', 'bear']) {
      const bull = dir === 'bull';
      if (bull ? !(prev.low < dn && bar.close > dn) : !(prev.high > up && bar.close < up)) continue;
      if (!rejects(bar, dir) || !flowAgrees(bar, dir, 0.05)) continue;
      const ext = bull ? Math.min(prev.low, bar.low) : Math.max(prev.high, bar.high);
      const stop = bull ? ext - 0.2 * a[L] : ext + 0.2 * a[L];
      return plan(dir, bar, stop, { why: `Snapped back inside the VWAP 2σ band (VWAP ${band.mean.toFixed(2)})` });
    }
    return null;
  },

  // Strong zone rejection: a wick into strong demand (support) or supply
  // (resistance), a close back out of the zone, big volume and order flow.
  zone_reject(ctx) {
    const { w, a, zones, htf } = ctx;
    const L = w.length - 1;
    const bar = w[L];
    const A = a[L];
    const vAvg = avgVolume(w, L);
    if (!(bar.volume >= 1.2 * vAvg)) return null;
    const range = bar.high - bar.low;
    if (!(range > 0)) return null;
    const pool = strongZones(zones, htf, A);
    for (const dir of ['bull', 'bear']) {
      const bull = dir === 'bull';
      if (!rejects(bar, dir) || !flowAgrees(bar, dir, 0.1)) continue;
      const wick = bull ? Math.min(bar.open, bar.close) - bar.low : bar.high - Math.max(bar.open, bar.close);
      if (wick < 0.4 * range) continue;
      const z = pool.find((x) => x.side === dir && (bull
        ? bar.low <= x.top && bar.low >= x.bottom - 0.5 * A && bar.close > x.top
        : bar.high >= x.bottom && bar.high <= x.top + 0.5 * A && bar.close < x.bottom));
      if (!z) continue;
      const stop = bull ? Math.min(bar.low, z.bottom) - 0.2 * A : Math.max(bar.high, z.top) + 0.2 * A;
      return plan(dir, bar, stop, { why: `Rejected strong ${bull ? 'support' : 'resistance'} ${z.bottom.toFixed(2)}–${z.top.toFixed(2)} on ${(bar.volume / vAvg).toFixed(1)}× volume`, zone: { top: z.top, bottom: z.bottom } });
    }
    return null;
  },

  zone_reject_trend(ctx) {
    const s = CHECKS.zone_reject(ctx);
    return s && ctx.htf && ctx.htf.trend === s.dir ? { ...s, why: `${s.why}, with the 1H trend` } : null;
  },

  // Break and retest: the most recent structure break in the 1H trend
  // direction, then the first return to the broken level, rejected with flow.
  bos_retest(ctx) {
    const { w, a, ms, htf } = ctx;
    const L = w.length - 1;
    const bar = w[L];
    const A = a[L];
    if (!htf || !htf.trend) return null;
    const e = [...ms.events].reverse().find((x) => x.index >= L - 30 && x.index <= L - 3);
    if (!e || e.dir !== htf.trend) return null;
    const bull = e.dir === 'bull';
    if (!rejects(bar, e.dir) || !flowAgrees(bar, e.dir, 0.05)) return null;
    // First touch of the level since the break.
    for (let k = e.index + 1; k < L; k++) if (bull ? w[k].low <= e.level + 0.15 * A : w[k].high >= e.level - 0.15 * A) return null;
    const touched = bull ? bar.low <= e.level + 0.15 * A && bar.close > e.level : bar.high >= e.level - 0.15 * A && bar.close < e.level;
    if (!touched) return null;
    const stop = bull ? Math.min(bar.low, e.level) - 0.3 * A : Math.max(bar.high, e.level) + 0.3 * A;
    return plan(e.dir, bar, stop, { why: `Retest of the broken ${bull ? 'high' : 'low'} ${e.level.toFixed(2)} held`, level: e.level });
  },

  // Session sweep: at the London open (07-10 UTC) the Asian range (00-07 UTC),
  // at the New York open (13-16 UTC) the London range (07-13 UTC), gets run and
  // price closes back inside: the stops are taken, fade the move.
  asia_sweep(ctx) {
    const { w, a } = ctx;
    const L = w.length - 1;
    const bar = w[L];
    const A = a[L];
    const day = Math.floor(bar.time / DAY) * DAY;
    const min = (bar.time - day) / 60;
    let from;
    let to;
    if (min >= 420 && min < 600) [from, to] = [day, day + 420 * 60];
    else if (min >= 780 && min < 960) [from, to] = [day + 420 * 60, day + 780 * 60];
    else return null;
    let hi = -Infinity;
    let lo = Infinity;
    let k = L;
    while (k > 0 && w[k].time >= to) k--;
    for (; k >= 0 && w[k].time >= from; k--) {
      hi = Math.max(hi, w[k].high);
      lo = Math.min(lo, w[k].low);
    }
    if (!Number.isFinite(hi)) return null;
    // Look back over this session's candles for the sweep, at most 6 bars ago.
    for (const dir of ['bull', 'bear']) {
      const bull = dir === 'bull';
      const lvl = bull ? lo : hi;
      if (!rejects(bar, dir) || !flowAgrees(bar, dir, 0.05)) continue;
      if (bull ? !(bar.close > lvl) : !(bar.close < lvl)) continue;
      let ext = null;
      for (let j = L; j >= Math.max(0, L - 6) && w[j].time >= to; j--) if (bull ? w[j].low < lvl : w[j].high > lvl) ext = ext == null ? (bull ? w[j].low : w[j].high) : bull ? Math.min(ext, w[j].low) : Math.max(ext, w[j].high);
      if (ext == null) continue;
      // Only the first reclaim: the previous candle must have closed outside.
      if (bull ? w[L - 1].close > lvl : w[L - 1].close < lvl) continue;
      const stop = bull ? ext - 0.2 * A : ext + 0.2 * A;
      return plan(dir, bar, stop, { why: `Swept the ${min < 600 ? 'Asian' : 'London'} session ${bull ? 'low' : 'high'} ${lvl.toFixed(2)} and reclaimed it`, level: lvl, trap: true });
    }
    return null;
  },

  // Volume surge continuation in the 1H trend.
  surge_go(ctx) {
    const { w, a, htf } = ctx;
    const L = w.length - 1;
    const bar = w[L];
    const A = a[L];
    if (!htf || !htf.trend) return null;
    const vAvg = avgVolume(w, L);
    if (!(bar.volume >= 2.5 * vAvg)) return null;
    const range = bar.high - bar.low;
    if (!(Math.abs(bar.close - bar.open) >= 0.6 * range)) return null;
    const dir = bar.close > bar.open ? 'bull' : 'bear';
    if (dir !== htf.trend || !flowAgrees(bar, dir, 0.15)) return null;
    let ext = true;
    for (let k = L - 10; k < L; k++) if (dir === 'bull' ? w[k].high >= bar.close : w[k].low <= bar.close) ext = false;
    if (!ext) return null;
    const mid = (bar.high + bar.low) / 2;
    const stop = dir === 'bull' ? mid - 0.2 * A : mid + 0.2 * A;
    return plan(dir, bar, stop, { why: `${(bar.volume / vAvg).toFixed(1)}× volume surge with the trend` });
  },

  // VWAP reclaim in the 1H trend.
  vwap_reclaim(ctx) {
    const { w, a, vw, htf } = ctx;
    const L = w.length - 1;
    const bar = w[L];
    const A = a[L];
    if (!htf || !htf.trend || !vw || L < 5) return null;
    const v = (i) => (vw[i] && vw[i].value != null ? vw[i].value : null);
    const dir = htf.trend;
    const bull = dir === 'bull';
    const now = v(L);
    if (now == null || !rejects(bar, dir) || !flowAgrees(bar, dir, 0.1) || !(bar.volume >= 1.2 * avgVolume(w, L))) return null;
    if (bull ? !(bar.close > now) : !(bar.close < now)) return null;
    for (let k = L - 3; k < L; k++) {
      const x = v(k);
      if (x == null || (bull ? w[k].close >= x : w[k].close <= x)) return null;
    }
    let ext = bar[bull ? 'low' : 'high'];
    for (let k = L - 5; k < L; k++) ext = bull ? Math.min(ext, w[k].low) : Math.max(ext, w[k].high);
    const stop = bull ? ext - 0.2 * A : ext + 0.2 * A;
    return plan(dir, bar, stop, { why: `Reclaimed VWAP ${now.toFixed(2)} with the trend` });
  },

  // Inside-bar breakout in the 1H trend.
  inside_break(ctx) {
    const { w, a, htf } = ctx;
    const L = w.length - 1;
    if (L < 3 || !htf || !htf.trend) return null;
    const bar = w[L];
    const A = a[L];
    const mom = w[L - 2];
    const ins = w[L - 1];
    if (!(ins.high <= mom.high && ins.low >= mom.low)) return null;
    const dir = htf.trend;
    const bull = dir === 'bull';
    if (bull ? !(bar.close > mom.high) : !(bar.close < mom.low)) return null;
    if (!flowAgrees(bar, dir, 0.1) || !(bar.volume >= 1.2 * avgVolume(w, L))) return null;
    const stop = bull ? ins.low - 0.2 * A : ins.high + 0.2 * A;
    return plan(dir, bar, stop, { why: `Inside-bar breakout ${bull ? 'above' : 'below'} ${(bull ? mom.high : mom.low).toFixed(2)}` });
  },

  // Trap confirmed by order flow: cumulative delta already points the trade's way.
  trap_flow(ctx) {
    const s = CHECKS.trap(ctx);
    if (!s) return null;
    const cv = cvdSign(ctx.w, ctx.w.length - 1);
    return cv != null && cv === (s.dir === 'bull' ? 1 : -1) ? { ...s, why: `${s.why} · order flow agrees` } : null;
  },

  // Trap in the direction of the higher-timeframe trend.
  trap_trend(ctx) {
    const s = CHECKS.trap(ctx);
    return s && ctx.htf && ctx.htf.trend === s.dir ? { ...s, why: `${s.why} · with the higher-timeframe trend` } : null;
  },

  // Zone retest that comes right after a liquidity sweep.
  zone_sweep(ctx) {
    const s = CHECKS.zone_retest(ctx);
    return s && swept(ctx, s.dir) ? { ...s, why: `${s.why} after a liquidity sweep` } : null;
  },

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

  // Support/resistance flip: a level breaks, price comes back to test it from
  // the other side, and buyers (sellers) defend it with a rejection candle.
  sr_flip(ctx) {
    const { w, a, swings, htf } = ctx;
    const L = w.length - 1;
    const bar = w[L];
    const A = a[L];
    const known = swings.filter((x) => x.confirmedAt <= L && x.i >= L - 250);
    const levels = supportResistance(known, A, bar.close, w.length);
    for (const lv of levels) {
      const p = lv.price;
      for (const dir of ['bull', 'bear']) {
        const bull = dir === 'bull';
        if (htf && htf.trend && htf.trend !== dir) continue;
        let brk = -1;
        for (let k = L - 30; k <= L - 2; k++) {
          if (k < 1) continue;
          if (bull ? w[k].close > p + 0.1 * A && w[k - 1].close <= p : w[k].close < p - 0.1 * A && w[k - 1].close >= p) brk = k;
        }
        if (brk < 0) continue;
        let held = true;
        for (let k = brk; k < L && held; k++) held = bull ? w[k].close > p - 0.1 * A : w[k].close < p + 0.1 * A;
        if (!held) continue;
        const touch = bull ? bar.low <= p + 0.15 * A && bar.close > p : bar.high >= p - 0.15 * A && bar.close < p;
        if (!touch || !rejects(bar, dir) || !flowAgrees(bar, dir)) continue;
        const stop = bull ? Math.min(bar.low, p) - 0.3 * A : Math.max(bar.high, p) + 0.3 * A;
        return plan(dir, bar, stop, { why: `${bull ? 'Resistance turned support' : 'Support turned resistance'} ${p.toFixed(2)} ×${lv.touches}`, level: p });
      }
    }
    return null;
  },

  // Absorption at liquidity: price runs the stops under a fresh swing low (above a
  // high) on heavy volume, but market buyers (sellers) absorb it and the candle
  // closes back inside.
  liq_absorb(ctx) {
    const { w, a, swings } = ctx;
    const L = w.length - 1;
    const bar = w[L];
    const A = a[L];
    const vAvg = avgVolume(w, L);
    if (!(bar.volume >= 1.5 * vAvg)) return null;
    for (const dir of ['bull', 'bear']) {
      const bull = dir === 'bull';
      const range = bar.high - bar.low;
      if (bull ? bar.close < bar.low + range * 0.55 : bar.close > bar.high - range * 0.55) continue;
      if (!flowAgrees(bar, dir, 0.05)) continue;
      for (const s of swings) {
        if (s.type !== (bull ? 'L' : 'H') || s.confirmedAt > L - 1 || s.i < L - 100) continue;
        if (bull ? !(bar.low < s.price && bar.close > s.price) : !(bar.high > s.price && bar.close < s.price)) continue;
        let fresh = true;
        for (let k = s.i + 1; k < L && fresh; k++) fresh = bull ? w[k].low >= s.price : w[k].high <= s.price;
        if (!fresh) continue;
        const stop = bull ? bar.low - 0.2 * A : bar.high + 0.2 * A;
        return plan(dir, bar, stop, { why: `Stops ${bull ? 'below' : 'above'} ${s.price.toFixed(2)} taken on ${(bar.volume / vAvg).toFixed(1)}× volume and absorbed` });
      }
    }
    return null;
  },

  // Volume breakout: a close through a fresh swing high (low) on at least twice
  // the average volume, with aggressive buying (selling) and the 1H trend behind it.
  vol_breakout(ctx) {
    const { w, a, swings, htf } = ctx;
    const L = w.length - 1;
    const bar = w[L];
    const A = a[L];
    const vAvg = avgVolume(w, L);
    if (!(bar.volume >= 2 * vAvg)) return null;
    const range = bar.high - bar.low;
    if (Math.abs(bar.close - bar.open) < 0.6 * range) return null;
    const dir = bar.close > bar.open ? 'bull' : 'bear';
    const bull = dir === 'bull';
    if (!ctx.anyHour && !inKillzone(bar.time)) return null;
    if (!htf || htf.trend !== dir || !flowAgrees(bar, dir, 0.15)) return null;
    const lv = swings.filter((s) => s.type === (bull ? 'H' : 'L') && s.confirmedAt <= L - 1 && s.i >= L - 150)
      .find((s) => {
        if (bull ? !(bar.close > s.price && w[L - 1].close <= s.price) : !(bar.close < s.price && w[L - 1].close >= s.price)) return false;
        for (let k = s.i + 1; k < L; k++) if (bull ? w[k].close > s.price : w[k].close < s.price) return false;
        return true;
      });
    if (!lv) return null;
    const stop = bull ? Math.max(bar.low, lv.price - A) - 0.1 * A : Math.min(bar.high, lv.price + A) + 0.1 * A;
    return plan(dir, bar, stop, { why: `Broke ${bull ? 'swing high' : 'swing low'} ${lv.price.toFixed(2)} on ${(bar.volume / vAvg).toFixed(1)}× volume` });
  },

  // Trap (failed breakout / breakdown): price closes through a fresh swing
  // high (low), traps the breakout traders, then within a few bars closes
  // back inside the level with volume and order flow on the other side.
  trap(ctx) {
    const { w, a, swings } = ctx;
    const L = w.length - 1;
    const bar = w[L];
    const A = a[L];
    const vAvg = avgVolume(w, L);
    for (const dir of ['bear', 'bull']) {
      const bull = dir === 'bull'; // bull = failed breakdown, we buy
      if (!rejects(bar, dir) || !flowAgrees(bar, dir, 0.05) || !(bar.volume >= 1.2 * vAvg)) continue;
      for (const s of swings) {
        if (s.type !== (bull ? 'L' : 'H') || s.confirmedAt > L - 2 || s.i < L - 120) continue;
        const p = s.price;
        if (bull ? !(bar.close > p && w[L - 1].close <= p) : !(bar.close < p && w[L - 1].close >= p)) continue;
        // The breakout: first close beyond the level, at most 5 bars ago, untouched before that.
        let brk = -1;
        let clean = true;
        for (let k = s.i + 1; k < L && clean; k++) {
          const beyond = bull ? w[k].close < p : w[k].close > p;
          if (beyond && brk < 0) brk = k;
          if (brk < 0 && (bull ? w[k].low < p - 0.1 * A : w[k].high > p + 0.1 * A)) clean = false;
        }
        if (!clean || brk < 0 || L - brk > 5) continue;
        let ext = bar;
        for (let k = brk; k <= L; k++) if (bull ? w[k].low < ext.low : w[k].high > ext.high) ext = w[k];
        const stop = bull ? ext.low - 0.2 * A : ext.high + 0.2 * A;
        return plan(dir, bar, stop, { why: `Trap ${bull ? 'breakdown below' : 'breakout above'} ${p.toFixed(2)}: failed after ${L - brk} bar${L - brk > 1 ? 's' : ''}`, level: p, trap: true });
      }
    }
    return null;
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
export function scanBar(ctx, rules = DEFAULT_RULES, ids = STRATEGIES.map((x) => x.id)) {
  const { w, a } = ctx;
  const L = w.length - 1;
  const bar = w[L];
  const inSess = !rules.sessionOnly || inSession(bar.time);
  const out = [];
  for (const id of ids) {
    if (!inSess && !rules.allHours?.includes(id)) continue;
    const s = CHECKS[id](ctx);
    if (!s) continue;
    const risk = Math.abs(s.entry - s.stop);
    if (!(risk >= rules.minStopAtr * a[L] && risk <= rules.maxStopAtr * a[L] && risk >= 3 * rules.cost)) continue;
    const sign = s.dir === 'bull' ? 1 : -1;
    const rr = rules.rrBy?.[id] ?? STRATEGY_BY_ID[id]?.rr ?? rules.rr;
    out.push({ ...s, strategy: id, time: bar.time, rr, target: s.entry + sign * rr * risk });
  }
  return out;
}

// Where the live strategies are waiting for price: the "buy / sell areas" drawn
// on the chart. Zone retest fires on the first touch of a fresh zone in the
// trend direction; volume breakout fires on a high-volume close through the
// nearest fresh swing in the 1H trend direction.
export function tradeAreas(ctx, rules = DEFAULT_RULES, ids = STRATEGIES.map((x) => x.id)) {
  const { w, a, ms, zones, swings, htf } = ctx;
  const L = w.length - 1;
  if (L < 30) return { areas: [], triggers: [] };
  const A = a[L];
  const price = w[L].close;
  const areas = [];
  const triggers = [];
  const dir = ms.trend;
  const zoneId = ids.find((x) => x === 'zone_retest' || x === 'zone_sweep');
  if (zoneId && dir && htf && htf.trend === dir) {
    const bull = dir === 'bull';
    const rr = rules.rrBy?.[zoneId] ?? STRATEGY_BY_ID[zoneId].rr ?? rules.rr;
    [...ms.orderBlocks, ...zones.filter((z) => z.score >= 50)]
      .filter((z) => z.side === dir && !z.broken && z.touches === 0 && (bull ? z.top < price : z.bottom > price))
      .sort((x, y) => Math.abs((x.top + x.bottom) / 2 - price) - Math.abs((y.top + y.bottom) / 2 - price))
      .slice(0, 2)
      .forEach((z) => {
        const entry = bull ? z.top : z.bottom;
        const stop = bull ? z.bottom - 0.2 * A : z.top + 0.2 * A;
        const risk = Math.abs(entry - stop);
        if (!(risk <= rules.maxStopAtr * A)) return;
        areas.push({
          dir, strategy: zoneId, top: z.top, bottom: z.bottom, time: z.time,
          kind: z.kind === 'bullOB' || z.kind === 'bearOB' ? 'Order block' : bull ? 'Demand' : 'Supply',
          entry, stop, target: entry + (bull ? 1 : -1) * rr * risk,
        });
      });
  }
  if (ids.includes('vol_breakout') && htf && htf.trend) {
    const bull = htf.trend === 'bull';
    const lv = swings
      .filter((s) => s.type === (bull ? 'H' : 'L') && s.confirmedAt <= L && s.i >= L - 150 && (bull ? s.price > price : s.price < price))
      .filter((s) => {
        for (let k = s.i + 1; k <= L; k++) if (bull ? w[k].close > s.price : w[k].close < s.price) return false;
        return true;
      })
      .sort((x, y) => Math.abs(x.price - price) - Math.abs(y.price - price))[0];
    if (lv) triggers.push({ dir: htf.trend, strategy: 'vol_breakout', price: lv.price, time: lv.time });
  }
  return { areas, triggers };
}
