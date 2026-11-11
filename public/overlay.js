// Canvas layer drawn over the chart pane for zones, levels, structure and the
// volume profile. It redraws only when the view (scroll, zoom, price scale,
// size) or the data changes.

import { volumeProfile } from '/shared/analysis.js';

export const COLORS = {
  demand: [52, 245, 197],
  supply: [255, 95, 162],
  bullOB: [52, 245, 197],
  bearOB: [255, 95, 162],
  bull: '#34f5c5',
  bear: '#ff5fa2',
  sr: '#c3bde0',
  liq: '#c4b5fd',
  pd: '#e9e3ff',
  poc: '#c4b5fd',
  text: '#f4f1ff',
};

const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const fmt = (p) => p.toFixed(2);

function lowerBound(candles, time) {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class Overlay {
  constructor(container, canvas, chart, series) {
    this.container = container;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.chart = chart;
    this.series = series;
    this.data = null;
    this.version = 0;
    this.sig = '';
    this.profile = null;
    this.profileKey = '';
    const loop = () => {
      this.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  update(data) {
    this.data = data;
    this.version++;
  }

  draw() {
    const d = this.data;
    const ts = this.chart.timeScale();
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const range = ts.getVisibleLogicalRange();
    const y0 = this.series.priceToCoordinate(1000);
    const y1 = this.series.priceToCoordinate(2000);
    const sig = [this.version, w, h, range && range.from.toFixed(2), range && range.to.toFixed(2), y0, y1].join('|');
    if (sig === this.sig && performance.now() - (this.animStart || 0) > 1000) return;
    this.sig = sig;

    const dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(w * dpr) || this.canvas.height !== Math.round(h * dpr)) {
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!d || !d.candles.length || !range) return;

    const paneW = ts.width();
    const paneH = h - ts.height();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, paneW, paneH);
    ctx.clip();
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    const X = (i) => ts.logicalToCoordinate(i);
    const Y = (p) => this.series.priceToCoordinate(p);
    const right = paneW;
    const { layers, result, htf, candles } = d;

    if (layers.profile) this.drawProfile(candles, range, paneW, Y);

    if (layers.htf && htf) {
      for (const z of htf.zones) {
        const col = COLORS[z.kind];
        const x = Math.max(0, X(Math.max(0, lowerBound(candles, z.time))) ?? 0);
        this.box(x, right, Y(z.top), Y(z.bottom), rgba(col, 0.07), rgba(col, 0.75), true);
        this.tag(`${htf.tf} ${z.kind === 'demand' ? 'Demand' : 'Supply'} ${z.score}`, right - 6, Y(z.top) + 8, rgba(col, 1), 'right');
      }
    }

    if (result) {
      if (layers.zones) {
        for (const z of result.zones) {
          const col = COLORS[z.kind];
          this.box(X(z.index), right, Y(z.top), Y(z.bottom), rgba(col, 0.16), rgba(col, 0.5));
          this.tag(`${z.kind === 'demand' ? 'Demand' : 'Supply'} ${z.score}`, right - 6, (Y(z.top) + Y(z.bottom)) / 2, rgba(col, 1), 'right');
        }
      }
      if (layers.ob) {
        for (const z of result.orderBlocks) {
          const col = COLORS[z.kind];
          this.box(X(z.index), right, Y(z.top), Y(z.bottom), rgba(col, 0.22), rgba(col, 0.9));
          this.tag(z.kind === 'bullOB' ? 'Bull OB' : 'Bear OB', Math.max(4, X(z.index) + 4), (Y(z.top) + Y(z.bottom)) / 2, rgba(col, 1), 'left');
        }
      }
      if (layers.sr) {
        const live = candles[candles.length - 1].close;
        for (const l of result.levels) {
          this.hline(X(l.firstIndex), right, Y(l.price), COLORS.sr, [], 1);
          this.tag(`${l.price < live ? 'S' : 'R'} ×${l.touches}  ${fmt(l.price)}`, right - 6, Y(l.price) - 8, COLORS.sr, 'right');
        }
      }
      if (layers.liq) {
        for (const p of result.pools) {
          this.hline(X(p.fromIndex), right, Y(p.price), COLORS.liq, [2, 3], 1);
          this.tag(`${p.kind} ${fmt(p.price)}`, X(p.index) + 6, Y(p.price) + (p.kind === 'EQH' ? -8 : 8), COLORS.liq, 'left');
        }
        for (const s of result.sweeps) {
          const c = candles[s.index];
          if (!c) continue;
          const y = s.kind === 'EQH' ? Y(c.high) - 10 : Y(c.low) + 10;
          this.tag('✕ grab', X(s.index), y, COLORS.liq, 'center');
        }
        if (result.prevDay) {
          const pd = result.prevDay;
          this.hline(X(pd.fromIndex), right, Y(pd.high), COLORS.pd, [6, 4], 1);
          this.hline(X(pd.fromIndex), right, Y(pd.low), COLORS.pd, [6, 4], 1);
          this.tag('PDH', X(pd.todayIndex) + 4, Y(pd.high) - 8, COLORS.pd, 'left');
          this.tag('PDL', X(pd.todayIndex) + 4, Y(pd.low) + 8, COLORS.pd, 'left');
        }
      }
      if (layers.structure) {
        for (const e of result.events) {
          const col = e.dir === 'bull' ? COLORS.bull : COLORS.bear;
          const xa = X(e.fromIndex);
          const xb = X(e.index);
          const y = Y(e.level);
          this.hline(xa, xb, y, col, [4, 3], 1.2);
          this.tag(e.type, (xa + xb) / 2, y + (e.dir === 'bull' ? -8 : 8), col, 'center', true);
        }
      }
    }
    if (layers.signals && d.trade) this.drawTrade(d.trade, candles, X, Y, right);

    ctx.restore();
  }

  // Trade-finder layer: where the strategies will buy or sell next (areas and
  // breakout triggers), live signals as position boxes, and past signals with
  // their result.
  drawTrade(t, candles, X, Y, right) {
    const idx = (time) => {
      const i = lowerBound(candles, time + 1) - 1;
      return i < 0 ? null : i;
    };
    const green = (a) => `rgba(52,245,197,${a})`;
    const red = (a) => `rgba(255,95,162,${a})`;
    const lastX = X(candles.length - 1);

    for (const p of t.history || []) {
      const i0 = idx(p.entryTime);
      const i1 = idx(p.exitTime);
      if (i0 == null || i1 == null) continue;
      const x1 = X(i0);
      let x2 = X(i1);
      if (x1 == null || x2 == null || x2 < 0 || x1 > right) continue;
      x2 = Math.max(x2, x1 + 6);
      this.box(x1, x2, Y(p.entry), Y(p.target), green(0.1), green(0.35));
      this.box(x1, x2, Y(p.entry), Y(p.stop), red(0.1), red(0.35));
      const win = p.r > 0;
      this.tag(`${win ? '+' : ''}${p.r.toFixed(1)}R`, x2 + 3, Y(win ? p.target : p.stop), win ? COLORS.bull : COLORS.bear, 'left', true);
    }

    for (const a of t.areas || []) {
      const bull = a.dir === 'bull';
      const i = idx(a.time);
      const x1 = Math.max(0, (i == null ? null : X(i)) ?? 0);
      this.box(x1, right, Y(a.top), Y(a.bottom), bull ? green(0.16) : red(0.16), bull ? green(0.85) : red(0.85));
      this.hline(x1, right, Y(a.stop), bull ? red(0.7) : green(0.7), [4, 4], 1);
      this.tag(`${bull ? 'BUY' : 'SELL'} AREA · ${a.kind} retest · SL ${a.stop.toFixed(2)} · TP ${a.target.toFixed(2)}`, right - 6, Y(bull ? a.top : a.bottom) + (bull ? -9 : 9), bull ? COLORS.bull : COLORS.bear, 'right', true);
    }

    for (const g of t.triggers || []) {
      const bull = g.dir === 'bull';
      const i = idx(g.time);
      const x1 = Math.max(0, (i == null ? null : X(i)) ?? 0);
      this.hline(x1, right, Y(g.price), bull ? green(0.9) : red(0.9), [8, 4], 1.5);
      this.tag(`${bull ? 'BUY above' : 'SELL below'} ${g.price.toFixed(2)} · high-volume breakout`, right - 6, Y(g.price) + (bull ? -9 : 9), bull ? COLORS.bull : COLORS.bear, 'right', true);
    }

    // Live setups: a position box that grows out from the entry candle. For a
    // sell the red (stop) half is above and the green (target) half below.
    const key = (t.live || []).map((s) => `${s.strategy}:${s.signalTime}`).join('|');
    if (key !== this.liveKey) {
      this.liveKey = key;
      if (key) this.animStart = performance.now();
    }
    const k = Math.min(1, (performance.now() - (this.animStart || 0)) / 900);
    const ease = 1 - (1 - k) ** 3;
    for (const s of t.live || []) {
      const bull = s.dir === 'bull';
      const i = s.entryTime ? idx(s.entryTime) : candles.length - 1;
      const x1 = (i == null ? null : X(i)) ?? lastX;
      if (x1 == null) continue;
      const x2 = x1 + (right - x1) * ease;
      this.box(x1, x2, Y(s.entry), Y(s.target), green(0.22), green(0.95));
      this.box(x1, x2, Y(s.entry), Y(s.stop), red(0.24), red(0.95));
      this.hline(x1, x2, Y(s.entry), '#e9e3ff', [], 2);
      // Take-profit steps at 1R, 2R (and 3R) inside the target zone.
      const risk = Math.abs(s.entry - s.stop);
      const steps = Math.max(1, Math.round(Math.abs(s.target - s.entry) / risk));
      for (let k = 1; k < steps; k++) this.hline(x1, x2, Y(s.entry + (bull ? 1 : -1) * k * risk), green(0.7), [3, 3], 1);
      if (ease < 1) continue;
      for (let k = 1; k < steps; k++) this.tag(`TP${k} · ${k}R`, right - 6, Y(s.entry + (bull ? 1 : -1) * k * risk), COLORS.bull, 'right');
      // The BUY/SELL marker on the candle and the setup card name the trade; no extra label here.
      this.tag(`TP${steps} ${s.target.toFixed(2)} · ${steps}R`, right - 6, Y(s.target) + (bull ? 9 : -9), COLORS.bull, 'right', true);
      this.tag(`SL ${s.stop.toFixed(2)}`, right - 6, Y(s.stop) + (bull ? -9 : 9), COLORS.bear, 'right', true);
      if (s.trap && s.level) {
        const si = idx(s.signalTime);
        const sx = si == null ? x1 : X(si);
        this.hline(Math.max(0, (sx ?? x1) - 90), x1, Y(s.level), '#c4b5fd', [3, 3], 1);
        this.tag(bull ? 'TRAP BREAKDOWN · failed' : 'TRAP BREAKOUT · failed', x1 - 8, Y(s.level) + (bull ? 12 : -12), '#c4b5fd', 'right', true);
      }
    }

    // Volume surges: candles with at least twice the average volume where one side dominated.
    for (const v of t.surges || []) {
      const x = X(v.index);
      if (x == null || x < 0 || x > right) continue;
      const buy = v.side === 'buy';
      const y = buy ? Y(candles[v.index].low) + 14 : Y(candles[v.index].high) - 14;
      this.tag(`${buy ? 'BUYERS' : 'SELLERS'} ${v.mult.toFixed(1)}×`, x, y, buy ? COLORS.bull : COLORS.bear, 'center', true);
    }
  }

  drawProfile(candles, range, paneW, Y) {
    const from = Math.max(0, Math.floor(range.from));
    const to = Math.min(candles.length - 1, Math.ceil(range.to));
    if (to <= from) return;
    const last = candles[candles.length - 1];
    const key = `${from}-${to}-${candles.length}-${last.close}-${this.version}`;
    if (key !== this.profileKey) {
      this.profileKey = key;
      this.profile = volumeProfile(candles.slice(from, to + 1), 48);
    }
    const vp = this.profile;
    if (!vp) return;
    const ctx = this.ctx;
    const maxW = paneW * 0.2;
    const max = Math.max(...vp.bins);
    for (let b = 0; b < vp.bins.length; b++) {
      const yTop = Y(vp.lo + (b + 1) * vp.step);
      const yBot = Y(vp.lo + b * vp.step);
      if (yTop == null || yBot == null) continue;
      const bw = (vp.bins[b] / max) * maxW;
      const inVA = b >= vp.lowIdx && b <= vp.highIdx;
      ctx.fillStyle = b === vp.poc ? 'rgba(245,196,81,0.55)' : inVA ? 'rgba(127,142,163,0.30)' : 'rgba(127,142,163,0.14)';
      ctx.fillRect(paneW - bw, yTop + 0.5, bw, Math.max(1, yBot - yTop - 1));
    }
    this.hline(paneW - maxW, paneW, Y(vp.pocPrice), COLORS.poc, [], 1);
    this.tag(`POC ${fmt(vp.pocPrice)}`, paneW - maxW - 4, Y(vp.pocPrice), COLORS.poc, 'right');
    this.hline(paneW - maxW, paneW, Y(vp.vah), COLORS.sr, [3, 3], 1);
    this.hline(paneW - maxW, paneW, Y(vp.val), COLORS.sr, [3, 3], 1);
    this.tag('VAH', paneW - maxW - 4, Y(vp.vah), COLORS.sr, 'right');
    this.tag('VAL', paneW - maxW - 4, Y(vp.val), COLORS.sr, 'right');
  }

  box(x1, x2, ya, yb, fill, stroke, dashed = false) {
    if (x1 == null || ya == null || yb == null) return;
    const ctx = this.ctx;
    const top = Math.min(ya, yb);
    const hgt = Math.max(1, Math.abs(yb - ya));
    ctx.fillStyle = fill;
    ctx.fillRect(x1, top, x2 - x1, hgt);
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.setLineDash(dashed ? [5, 4] : []);
    ctx.strokeRect(Math.round(x1) + 0.5, Math.round(top) + 0.5, Math.round(x2 - x1), Math.round(hgt));
    ctx.setLineDash([]);
  }

  hline(x1, x2, y, color, dash, width) {
    if (x1 == null || x2 == null || y == null) return;
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(x1, Math.round(y) + 0.5);
    ctx.lineTo(x2, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  tag(text, x, y, color, align, bold = false) {
    if (x == null || y == null || Number.isNaN(y)) return;
    const ctx = this.ctx;
    ctx.font = `${bold ? '600 ' : ''}11px system-ui, sans-serif`;
    const tw = ctx.measureText(text).width;
    const left = align === 'right' ? x - tw : align === 'center' ? x - tw / 2 : x;
    ctx.fillStyle = 'rgba(11,7,32,0.85)';
    ctx.fillRect(left - 3, y - 7, tw + 6, 14);
    ctx.fillStyle = color;
    ctx.fillText(text, left, y + 0.5);
  }
}
