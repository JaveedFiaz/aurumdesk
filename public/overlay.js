// Canvas layer drawn over the chart pane for zones, levels, structure and the
// volume profile. It redraws only when the view (scroll, zoom, price scale,
// size) or the data changes.

import { volumeProfile } from '/shared/analysis.js';

export const COLORS = {
  demand: [43, 181, 160],
  supply: [240, 140, 46],
  bullOB: [38, 166, 154],
  bearOB: [239, 83, 80],
  bull: '#26a69a',
  bear: '#ef5350',
  sr: '#7f8ea3',
  liq: '#a78bfa',
  pd: '#c9b26b',
  poc: '#d4a72c',
  text: '#e6e9ee',
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
    if (sig === this.sig) return;
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
    ctx.restore();
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
      ctx.fillStyle = b === vp.poc ? 'rgba(212,167,44,0.55)' : inVA ? 'rgba(127,142,163,0.30)' : 'rgba(127,142,163,0.14)';
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
    ctx.fillStyle = 'rgba(11,15,20,0.72)';
    ctx.fillRect(left - 3, y - 7, tw + 6, 14);
    ctx.fillStyle = color;
    ctx.fillText(text, left, y + 0.5);
  }
}
