// Reference backtest for pulse-gold-sweep.pine: the same rules, bar by bar, no lookahead.
// Data: python download.py PAXGUSDT 5m <start-unix> data/m5.json and ... 1h ... data/h1.json
// Run:  node backtest.mjs data
// Mirrors the Pine indicator logic bar by bar (no lookahead).
import fs from 'node:fs';
const D = process.argv[2] || 'data';
const raw = JSON.parse(fs.readFileSync(`${D}/${process.env.TFF || 'm5'}.json`));
const h1raw = JSON.parse(fs.readFileSync(`${D}/h1.json`));
// Spot gold is closed from Friday 21:00 to Sunday 23:00 UTC (PAXG is not): drop those candles.
const closedMkt = (t) => { const d = new Date(t * 1000); const wd = d.getUTCDay(); const hr = d.getUTCHours(); return (wd === 5 && hr >= 21) || wd === 6 || (wd === 0 && hr < 23); };
export const C = raw.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v })).filter((x) => !closedMkt(x.t));
const H = h1raw.map(([t, o, h, l, c]) => ({ t, c }));
const emaArr = (xs, n) => { const k = 2 / (n + 1); let e = xs[0]; return xs.map((x) => (e = e + (x - e) * k)); };
const atrArr = (n) => { let a = null; return C.map((b, i) => { const tr = i ? Math.max(b.h - b.l, Math.abs(b.h - C[i - 1].c), Math.abs(b.l - C[i - 1].c)) : b.h - b.l; a = a == null ? tr : a + (tr - a) / n; return a; }); };
const ATR = atrArr(14);
const cache = {};
// HTF EMA value from the last CLOSED 1h candle at time t.
function htfEma(n) {
  if (cache['h' + n]) return cache['h' + n];
  const e = emaArr(H.map((x) => x.c), n);
  const out = new Float64Array(C.length); let j = 0;
  for (let i = 0; i < C.length; i++) { const close = C[i].t + (process.env.TFF === 'm15' ? 900 : 300); while (j + 1 < H.length && H[j + 1].t + 3600 <= close) j++; out[i] = H[j].t + 3600 <= close ? e[j] : NaN; }
  return (cache['h' + n] = out);
}
function ltfEma(n) { return cache['l' + n] || (cache['l' + n] = emaArr(C.map((x) => x.c), n)); }

export function run(p) {
  const { mode = 'sweep', K = 6, N = 20, slAtr = 0, L = 5, sess = [[7, 11], [12.5, 16]], trend = 'h1', fast = 20, slow = 50, buf = 0.1, minR = 0.5, maxR = 3, rr = 2, wick = 0, be = 0, maxBars = 48, cost = 0.0001, maxDay = 6, look = 60 } = p;
  const ef = trend === 'h1' ? htfEma(p.hf || 20) : null;
  const es = trend === 'h1' ? htfEma(p.hs || 50) : null;
  let ph = null, phI = -1, phUsed = true, pl = null, plI = -1, plUsed = true;
  let pos = null; const open = []; const trades = []; let dayKey = -1, dayN = 0;
  for (let i = 300; i < C.length - 1; i++) {
    const b = C[i];
    // manage open positions on this bar
    for (let q = open.length - 1; q >= 0; q--) {
      const ps = open[q]; if (i <= ps.i0 - 0) { if (i < ps.i0) continue; }
      const s = ps.dir;
      const hitS = s > 0 ? b.l <= ps.sl : b.h >= ps.sl;
      const hitT = s > 0 ? b.h >= ps.tp : b.l <= ps.tp;
      let exit = null;
      if (hitS) exit = ps.sl; else if (hitT) exit = ps.tp; else if (i - ps.i0 >= maxBars) exit = b.c;
      if (!exit && be && !ps.beDone && (s > 0 ? b.h >= ps.e + be * ps.risk : b.l <= ps.e - be * ps.risk)) { ps.beDone = true; ps.sl = ps.e; }
      if (exit != null) { trades.push({ t: ps.t, dir: s, r: (s * (exit - ps.e) - ps.e * cost) / ps.risk }); open.splice(q, 1); }
    }
    pos = open.length >= (p.maxPos || 1) ? open[0] : null;
    // pivots confirmed at i (pivot at i-L)
    const k = i - L; let isH = true, isL = true;
    for (let j = k - L; j <= k + L; j++) { if (j === k) continue; if (C[j].h >= C[k].h) isH = false; if (C[j].l <= C[k].l) isL = false; }
    if (isH) { ph = C[k].h; phI = k; phUsed = false; }
    if (isL) { pl = C[k].l; plI = k; plUsed = false; }
    const hr = (b.t % 86400) / 3600; const inS = sess.some(([a, z]) => hr >= a && hr < z);
    const dk = Math.floor(b.t / 86400); if (dk !== dayKey) { dayKey = dk; dayN = 0; }
    const A = ATR[i]; const rng = b.h - b.l;
    let sig = null;
    if (mode === 'sweep' && ph != null && !phUsed && b.h > ph) {
      phUsed = true;
      if (b.c < ph && b.c < b.o && i - phI <= look && (rng > 0 && (b.h - Math.max(b.o, b.c)) / rng >= wick)) sig = -1;
    }
    if (mode === 'sweep' && pl != null && !plUsed && b.l < pl) {
      plUsed = true;
      if (b.c > pl && b.c > b.o && i - plI <= look && (rng > 0 && (Math.min(b.o, b.c) - b.l) / rng >= wick)) sig = sig ? null : 1;
    }
    if (mode !== 'sweep') sig = null;
    if (mode === 'pullback' && !pos && inS) {
      const f = ltfEma(fast)[i], sl50 = ltfEma(slow)[i];
      let touchedUp = false, touchedDn = false;
      for (let j = i - K; j < i; j++) { const fe = ltfEma(fast)[j]; if (C[j].l <= fe) touchedUp = true; if (C[j].h >= fe) touchedDn = true; }
      if (touchedUp && b.c > f && b.c > sl50 && f > sl50 && b.c > b.o && b.c > C[i - 1].h) sig = 1;
      else if (touchedDn && b.c < f && b.c < sl50 && f < sl50 && b.c < b.o && b.c < C[i - 1].l) sig = -1;
    }
    if (mode === 'donch' && !pos && inS) {
      let hh = -Infinity, ll = Infinity; for (let j = i - N; j < i; j++) { hh = Math.max(hh, C[j].h); ll = Math.min(ll, C[j].l); }
      if (b.c > hh && C[i - 1].c <= hh) sig = 1; else if (b.c < ll && C[i - 1].c >= ll) sig = -1;
    }
    if (mode === 'volbrk' && !pos && inS) {
      let vs = 0; for (let j = i - 20; j < i; j++) vs += C[j].v; const vAvg = vs / 20;
      const body = Math.abs(b.c - b.o);
      if (b.v >= (p.vm || 2) * vAvg && rng > 0 && body >= 0.6 * rng) {
        const d = b.c > b.o ? 1 : -1;
        const strong = d > 0 ? (b.c - b.l) / rng >= (p.cl || 0) : (b.h - b.c) / rng >= (p.cl || 0);
        // the most recent confirmed pivot on the breakout side, not closed through since
        const lvl = d > 0 ? ph : pl; const lvlI = d > 0 ? phI : plI;
        if (strong && lvl != null && i - lvlI <= 150) {
          let fresh = true; for (let j = lvlI + 1; j < i; j++) if (d > 0 ? C[j].c > lvl : C[j].c < lvl) { fresh = false; break; }
          if (fresh && (d > 0 ? b.c > lvl && C[i - 1].c <= lvl : b.c < lvl && C[i - 1].c >= lvl)) { sig = d; pos === null && (p._lvl = lvl); }
        }
      }
    }
    if (!sig || pos || !inS || dayN >= maxDay) continue;
    if (ef && !(sig > 0 ? ef[i] > es[i] : ef[i] < es[i])) continue;
    const e = C[i + 1].o;
    let ext = sig < 0 ? b.h : b.l;
    if (mode !== 'sweep') for (let j = i - K; j <= i; j++) ext = sig < 0 ? Math.max(ext, C[j].h) : Math.min(ext, C[j].l);
    let sl = slAtr ? e - sig * slAtr * A : sig < 0 ? ext + buf * A : ext - buf * A;
    if (p.slPct) sl = e - sig * e * p.slPct;
    if (mode === 'volbrk') sl = sig > 0 ? Math.max(b.l, p._lvl - A) - 0.1 * A : Math.min(b.h, p._lvl + A) + 0.1 * A;
    const risk = sig * (e - sl);
    if (!p.slPct && !(risk >= minR * A && risk <= maxR * A)) continue;
    open.push({ dir: sig, e, sl, tp: e + sig * rr * risk, risk, i0: i + 1, t: b.t });
    dayN++;
  }
  return trades;
}
export function stats(tr, years = [[1700092800, 1731715200], [1731715200, 1763251200], [1763251200, 1800000000]]) {
  const f = (ts) => { const R = ts.map((x) => x.r); const w = R.filter((x) => x > 0).reduce((a, b) => a + b, 0); const l = -R.filter((x) => x <= 0).reduce((a, b) => a + b, 0); return { n: ts.length, win: ts.length ? R.filter((x) => x > 0).length / ts.length : 0, pf: l ? w / l : 0, avg: ts.length ? (w - l) / ts.length : 0, tot: w - l }; };
  const all = f(tr);
  const days = (C.at(-1).t - C[0].t) / 86400 * 5 / 7;
  return { ...all, perDay: tr.length / days, yrs: years.map(([a, z]) => f(tr.filter((x) => x.t >= a && x.t < z)).avg) };
}


const base = { sess: [[0, 24]], mode: 'sweep', trend: 'h1', rr: 1.5, L: 4, look: 100, slPct: 0.0026, be: 0, maxBars: 96, maxDay: 10, maxPos: 3 };
const rows = [
  ['PGS Pro default (all sessions)', base],
  ['PGS Pro, London + New York only', { ...base, sess: [[7, 17]] }],
  ['PGS Pro, killzones only', { ...base, sess: [[7, 10], [12.5, 15.5]] }],
  ['PGS Pro at double costs', { ...base, cost: 0.0002 }],
  ['FAP replica (no trend, 1:2, risk-free after 0.4R)', { ...base, trend: 'none', rr: 2, L: 5, be: 0.4 }],
];
for (const [name, p] of rows) {
  const tr = run(p); const s = stats(tr);
  const yrN = [[1700092800, 1731715200], [1731715200, 1763251200], [1763251200, 1800000000]].map(([a, z]) => tr.filter((x) => x.t >= a && x.t < z).length);
  console.log(`| ${name} | ${s.n} | ${s.perDay.toFixed(2)} | ${(s.win * 100).toFixed(0)}% | ${s.pf.toFixed(2)} | ${s.tot >= 0 ? '+' : ''}${s.tot.toFixed(1)}R | ${s.yrs.map((v, i) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R (${yrN[i]})`).join(' / ')} |`);
}
