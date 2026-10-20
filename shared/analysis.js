// Price-action analysis engine. Pure functions over closed candles
// ({ time, open, high, low, close, volume }), so nothing repaints: a level only
// appears once the candles that define it have closed.

import { bucketStart, nominalSeconds } from './timeframes.js';

const DAY = 86400;

// Wilder's Average True Range. Early values are a running mean.
export function atr(c, len = 14) {
  const out = new Array(c.length);
  let prev = 0;
  for (let i = 0; i < c.length; i++) {
    const tr = i === 0
      ? c[i].high - c[i].low
      : Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    prev = i < len ? (prev * i + tr) / (i + 1) : (prev * (len - 1) + tr) / len;
    out[i] = prev;
  }
  return out;
}

// Fractal swing points: a high higher than `len` bars either side (lows mirrored).
// A swing is only known `len` bars later, recorded as `confirmedAt`.
export function findSwings(c, len = 5) {
  const out = [];
  for (let i = len; i < c.length - len; i++) {
    let isH = true;
    let isL = true;
    for (let k = 1; k <= len && (isH || isL); k++) {
      if (c[i - k].high >= c[i].high || c[i + k].high > c[i].high) isH = false;
      if (c[i - k].low <= c[i].low || c[i + k].low < c[i].low) isL = false;
    }
    if (isH) out.push({ type: 'H', i, time: c[i].time, price: c[i].high, confirmedAt: i + len });
    if (isL) out.push({ type: 'L', i, time: c[i].time, price: c[i].low, confirmedAt: i + len });
  }
  return out;
}

// Walks forward bar by bar. A close beyond the latest unbroken swing is a break of
// structure (BOS) in the trend direction, or a change of character (CHoCH) against it.
// Each break leaves an order block: the last opposite candle at the extreme of the leg.
export function marketStructure(c, swings) {
  const events = [];
  const orderBlocks = [];
  const trendAt = new Array(c.length);
  let hi = null;
  let lo = null;
  let trend = null;
  let k = 0;
  for (let j = 0; j < c.length; j++) {
    while (k < swings.length && swings[k].confirmedAt <= j) {
      const s = swings[k++];
      if (s.type === 'H') hi = { ...s, broken: false };
      else lo = { ...s, broken: false };
    }
    const close = c[j].close;
    if (hi && !hi.broken && close > hi.price) {
      hi.broken = true;
      events.push({ type: trend === 'bear' ? 'CHoCH' : 'BOS', dir: 'bull', level: hi.price, fromIndex: hi.i, index: j, time: c[j].time });
      trend = 'bull';
      orderBlocks.push(findOrderBlock(c, hi.i, j, 'bull'));
    }
    if (lo && !lo.broken && close < lo.price) {
      lo.broken = true;
      events.push({ type: trend === 'bull' ? 'CHoCH' : 'BOS', dir: 'bear', level: lo.price, fromIndex: lo.i, index: j, time: c[j].time });
      trend = 'bear';
      orderBlocks.push(findOrderBlock(c, lo.i, j, 'bear'));
    }
    trendAt[j] = trend;
  }
  return { events, orderBlocks, trend, trendAt };
}

function findOrderBlock(c, from, to, dir) {
  const bull = dir === 'bull';
  let ext = from;
  for (let k = from; k <= to; k++) {
    if (bull ? c[k].low < c[ext].low : c[k].high > c[ext].high) ext = k;
  }
  let ob = ext;
  for (let k = ext; k >= Math.max(from, ext - 6); k--) {
    if (bull ? c[k].close < c[k].open : c[k].close > c[k].open) { ob = k; break; }
  }
  const zone = { kind: bull ? 'bullOB' : 'bearOB', side: dir, top: c[ob].high, bottom: c[ob].low, index: ob, time: c[ob].time, createdIndex: to };
  return track(c, zone);
}

// Follows a zone after it forms: counts separate visits and marks it broken
// when a candle closes through the far side.
function track(c, z) {
  const bull = z.side === 'bull';
  let inside = false;
  z.touches = 0;
  z.broken = false;
  z.endIndex = null;
  for (let t = z.createdIndex + 1; t < c.length; t++) {
    if (bull ? c[t].close < z.bottom : c[t].close > z.top) {
      z.broken = true;
      z.endIndex = t;
      break;
    }
    const entered = bull ? c[t].low <= z.top : c[t].high >= z.bottom;
    if (entered && !inside) z.touches++;
    inside = entered;
  }
  return z;
}

const FRESH_SCORE = [30, 18, 8, 0];
const BASE_SCORE = [15, 10, 6];

// Supply/demand: one to three small "base" candles followed by an impulse candle
// whose body is large against ATR. Score (0-100) = impulse strength (40) +
// freshness (30) + tight base (15) + formed with the prevailing structure (15).
export function supplyDemand(c, a, trendAt = [], opts = {}) {
  const impulseMult = opts.impulseMult ?? 1.6;
  const baseMax = opts.baseMax ?? 3;
  const baseBody = opts.baseBody ?? 0.6;
  const zones = [];
  for (let j = 1; j < c.length; j++) {
    const ref = a[j - 1];
    const body = Math.abs(c[j].close - c[j].open);
    const range = c[j].high - c[j].low;
    if (!ref || body < impulseMult * ref || body < 0.55 * range) continue;
    const bull = c[j].close > c[j].open;
    const bases = [];
    for (let b = j - 1; b >= 0 && bases.length < baseMax; b--) {
      if (Math.abs(c[b].close - c[b].open) > baseBody * (a[b] || ref)) break;
      bases.push(b);
    }
    if (!bases.length) continue;
    let top;
    let bottom;
    if (bull) {
      bottom = Math.min(...bases.map((b) => c[b].low));
      top = Math.max(...bases.map((b) => Math.max(c[b].open, c[b].close)));
      if (top <= bottom) top = Math.max(...bases.map((b) => c[b].high));
    } else {
      top = Math.max(...bases.map((b) => c[b].high));
      bottom = Math.min(...bases.map((b) => Math.min(c[b].open, c[b].close)));
      if (top <= bottom) bottom = Math.min(...bases.map((b) => c[b].low));
    }
    if (!(top > bottom)) continue;
    const start = bases[bases.length - 1];
    const zone = track(c, {
      kind: bull ? 'demand' : 'supply',
      side: bull ? 'bull' : 'bear',
      top,
      bottom,
      index: start,
      time: c[start].time,
      createdIndex: j,
      impulse: body / ref,
      bases: bases.length,
      aligned: trendAt[j] === (bull ? 'bull' : 'bear'),
    });
    zone.score = Math.round(
      Math.min(40, (zone.impulse / 4) * 40)
      + FRESH_SCORE[Math.min(zone.touches, 3)]
      + BASE_SCORE[zone.bases - 1]
      + (zone.aligned ? 15 : 0),
    );
    zones.push(zone);
  }
  // Where live zones of the same kind overlap, keep the stronger one.
  const live = zones.filter((z) => !z.broken).sort((x, y) => y.score - x.score);
  const kept = [];
  for (const z of live) {
    if (!kept.some((k) => k.kind === z.kind && z.bottom <= k.top && z.top >= k.bottom)) kept.push(z);
  }
  return [...kept, ...zones.filter((z) => z.broken)];
}

// Horizontal levels: swing points clustered within a fraction of ATR.
// A level needs at least two touches; strength grows with touches and recency.
export function supportResistance(swings, atrNow, price, n) {
  const tol = 0.35 * atrNow;
  const sorted = [...swings].sort((x, y) => x.price - y.price);
  const clusters = [];
  let cur = null;
  for (const s of sorted) {
    if (cur && s.price - cur.first <= 2 * tol) {
      cur.items.push(s);
    } else {
      cur = { first: s.price, items: [s] };
      clusters.push(cur);
    }
  }
  return clusters
    .filter((cl) => cl.items.length >= 2)
    .map((cl) => {
      const p = cl.items.reduce((sum, s) => sum + s.price, 0) / cl.items.length;
      const lastIndex = Math.max(...cl.items.map((s) => s.i));
      return {
        price: p,
        kind: p < price ? 'support' : 'resistance',
        touches: cl.items.length,
        firstIndex: Math.min(...cl.items.map((s) => s.i)),
        lastIndex,
        score: Math.min(100, Math.round(cl.items.length * 18 + (lastIndex / Math.max(1, n)) * 30)),
      };
    });
}

// Liquidity pools: equal highs (EQH) / equal lows (EQL) where stops cluster.
// A pool is swept when price trades through it; if that candle closes back
// inside, it is marked as a liquidity grab.
export function liquidity(c, swings, a) {
  const pools = [];
  for (const type of ['H', 'L']) {
    const pts = swings.filter((s) => s.type === type);
    for (let q = 1; q < pts.length; q++) {
      for (let p = Math.max(0, q - 6); p < q; p++) {
        const A = pts[p];
        const B = pts[q];
        const tol = Math.max(0.1 * a[B.i], B.price * 0.00005);
        if (Math.abs(A.price - B.price) > tol) continue;
        const level = type === 'H' ? Math.max(A.price, B.price) : Math.min(A.price, B.price);
        let clean = true;
        for (let k = A.i + 1; k < B.i && clean; k++) {
          if (type === 'H' ? c[k].high > level + tol : c[k].low < level - tol) clean = false;
        }
        if (!clean) continue;
        pools.push({ kind: type === 'H' ? 'EQH' : 'EQL', price: level, fromIndex: A.i, index: B.i, confirmedAt: B.confirmedAt, tol });
        break;
      }
    }
  }
  const sweeps = [];
  for (const pl of pools) {
    pl.swept = false;
    pl.endIndex = null;
    for (let t = pl.confirmedAt + 1; t < c.length; t++) {
      const through = pl.kind === 'EQH' ? c[t].high > pl.price : c[t].low < pl.price;
      if (!through) continue;
      pl.swept = true;
      pl.endIndex = t;
      pl.grab = pl.kind === 'EQH' ? c[t].close < pl.price : c[t].close > pl.price;
      if (pl.grab) sweeps.push({ kind: pl.kind, price: pl.price, index: t, time: c[t].time });
      break;
    }
  }
  // Drop near-duplicate live pools, keeping the latest.
  const live = [];
  for (const pl of pools.filter((x) => !x.swept).sort((x, y) => y.index - x.index)) {
    if (!live.some((l) => l.kind === pl.kind && Math.abs(l.price - pl.price) <= pl.tol)) live.push(pl);
  }
  return { pools: live, sweeps };
}

// High and low of the previous trading day (UTC), for intraday charts.
export function previousDay(c) {
  if (c.length < 2) return null;
  const lastDay = Math.floor(c[c.length - 1].time / DAY);
  let s = c.length - 1;
  while (s > 0 && Math.floor(c[s - 1].time / DAY) === lastDay) s--;
  if (s === 0) return null;
  const prevDayKey = Math.floor(c[s - 1].time / DAY);
  let p = s - 1;
  let high = -Infinity;
  let low = Infinity;
  while (p >= 0 && Math.floor(c[p].time / DAY) === prevDayKey) {
    high = Math.max(high, c[p].high);
    low = Math.min(low, c[p].low);
    p--;
  }
  return { high, low, fromIndex: p + 1, todayIndex: s };
}

// VWAP anchor: daily below H4, weekly on H4, monthly on D1, yearly above.
export function vwapAnchor(tf) {
  const sec = nominalSeconds(tf);
  if (sec < 14400) return (t) => Math.floor(t / DAY);
  if (sec < DAY) return (t) => bucketStart({ week: true }, t);
  if (sec < 7 * DAY) return (t) => bucketStart({ months: 1 }, t);
  return (t) => new Date(t * 1000).getUTCFullYear();
}

// Volume-weighted average price, reset at each anchor. Falls back to equal
// weights (a time-weighted average) when the feed has no volume.
export function vwap(c, anchorFn) {
  const hasVol = c.some((x) => x.volume > 0);
  const out = [];
  let key = null;
  let pv = 0;
  let vv = 0;
  for (const x of c) {
    const k = anchorFn(x.time);
    if (k !== key) {
      key = k;
      pv = 0;
      vv = 0;
    }
    const v = hasVol ? x.volume || 0 : 1;
    const tp = (x.high + x.low + x.close) / 3;
    pv += tp * v;
    vv += v;
    out.push({ time: x.time, value: vv ? pv / vv : tp });
  }
  return out;
}

// Volume by price over a set of candles: point of control (POC) and the
// 70% value area (VAH/VAL). Each candle's volume is spread across its range.
export function volumeProfile(c, bins = 48) {
  if (!c.length) return null;
  let lo = Infinity;
  let hi = -Infinity;
  for (const x of c) {
    lo = Math.min(lo, x.low);
    hi = Math.max(hi, x.high);
  }
  if (!(hi > lo)) return null;
  const step = (hi - lo) / bins;
  const vol = new Array(bins).fill(0);
  const hasVol = c.some((x) => x.volume > 0);
  for (const x of c) {
    const v = hasVol ? x.volume || 0 : 1;
    const b0 = Math.min(bins - 1, Math.floor((x.low - lo) / step));
    const b1 = Math.min(bins - 1, Math.floor((x.high - lo) / step));
    const share = v / (b1 - b0 + 1);
    for (let b = b0; b <= b1; b++) vol[b] += share;
  }
  const total = vol.reduce((s, v) => s + v, 0);
  let poc = 0;
  for (let b = 1; b < bins; b++) if (vol[b] > vol[poc]) poc = b;
  let lowIdx = poc;
  let highIdx = poc;
  let acc = vol[poc];
  while (acc < total * 0.7 && (lowIdx > 0 || highIdx < bins - 1)) {
    const below = lowIdx > 0 ? vol[lowIdx - 1] : -1;
    const above = highIdx < bins - 1 ? vol[highIdx + 1] : -1;
    if (above >= below) acc += vol[++highIdx];
    else acc += vol[--lowIdx];
  }
  return {
    lo,
    step,
    bins: vol,
    poc,
    lowIdx,
    highIdx,
    pocPrice: lo + (poc + 0.5) * step,
    vah: lo + (highIdx + 1) * step,
    val: lo + lowIdx * step,
  };
}

function distance(z, price) {
  if (price > z.top) return price - z.top;
  if (price < z.bottom) return z.bottom - price;
  return 0;
}

function nearestLive(list, price, n) {
  const live = list.filter((z) => !z.broken);
  const pick = (side) => live
    .filter((z) => z.side === side)
    .sort((x, y) => distance(x, price) - distance(y, price))
    .slice(0, n);
  return [...pick('bull'), ...pick('bear')];
}

export function analyze(c, opts = {}) {
  if (c.length < 30) return null;
  const a = atr(c);
  const swings = findSwings(c, opts.swingLen ?? 5);
  const ms = marketStructure(c, swings);
  const zones = supplyDemand(c, a, ms.trendAt);
  const last = c[c.length - 1];
  const atrNow = a[a.length - 1];
  const levels = supportResistance(swings, atrNow, last.close, c.length);
  const liq = liquidity(c, swings, a);
  const intraday = opts.tf && nominalSeconds(opts.tf) < DAY;
  const near = (kind) => levels
    .filter((l) => l.kind === kind)
    .sort((x, y) => Math.abs(x.price - last.close) - Math.abs(y.price - last.close))
    .slice(0, 3);
  const nearPools = (kind) => liq.pools
    .filter((p) => p.kind === kind)
    .sort((x, y) => Math.abs(x.price - last.close) - Math.abs(y.price - last.close))
    .slice(0, 3);
  return {
    atr: atrNow,
    trend: ms.trend,
    events: ms.events.slice(-8),
    lastEvent: ms.events[ms.events.length - 1] || null,
    zones: nearestLive(zones, last.close, 3),
    orderBlocks: nearestLive(ms.orderBlocks, last.close, 2),
    levels: [...near('support'), ...near('resistance')],
    pools: [...nearPools('EQH'), ...nearPools('EQL')],
    sweeps: liq.sweeps.slice(-5),
    prevDay: intraday ? previousDay(c) : null,
  };
}
