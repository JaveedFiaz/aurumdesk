// Small animation and drawing helpers for the terminal UI. No dependencies.

export const reduceMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
export const $ = (id) => document.getElementById(id);
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
export const fmt = (p, dp = 2) => (p == null || !Number.isFinite(p) ? '—' : p.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp }));
export const money = (v, dp = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : ''}$${fmt(Math.abs(v), dp)}`);
export const signed = (v, dp = 2) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v), dp)}`);
export const compact = (v) => (Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : v.toFixed(v < 10 ? 2 : 0));
export const pct = (v, dp = 0) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(dp)}%`);
export const ago = (t) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000 - t));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
};
export const clock = (t) => new Date(t * 1000).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// Animates the number shown in an element from its last value to `to`.
const tweens = new WeakMap();
export function tween(el, to, format = (v) => fmt(v), ms = 700) {
  if (!el) return;
  const from = tweens.get(el)?.value ?? to;
  cancelAnimationFrame(tweens.get(el)?.raf);
  if (reduceMotion() || from === to || !Number.isFinite(from)) {
    el.textContent = format(to);
    tweens.set(el, { value: to });
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    const e = 1 - (1 - k) ** 3;
    const v = from + (to - from) * e;
    el.textContent = format(v);
    const raf = k < 1 ? requestAnimationFrame(step) : 0;
    tweens.set(el, { value: k < 1 ? v : to, raf });
  };
  tweens.set(el, { value: from, raf: requestAnimationFrame(step) });
}

// Briefly glows an element green or red.
export function flash(el, dir) {
  if (!el || reduceMotion()) return;
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // restart the animation
  el.classList.add(dir > 0 ? 'flash-up' : 'flash-down');
}

// SVG confidence ring. Returns markup; the arc animates by CSS transition.
export function ring(score, { size = 132, stroke = 10, label = 'confluence' } = {}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, score)) / 100);
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Confluence ${score} of 100">
    <defs><linearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--gold)"/><stop offset="1" stop-color="var(--bull)"/></linearGradient></defs>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-track" stroke-width="${stroke}"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" class="ring-arc" stroke-width="${stroke}" stroke-dasharray="${c}" stroke-dashoffset="${c}" data-off="${off}" transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="50%" y="48%" class="ring-num">${score}</text><text x="50%" y="66%" class="ring-lbl">${label}</text></svg>`;
}

// Kicks off CSS transitions on rings just inserted into `root`.
export function animateRings(root) {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    root.querySelectorAll('.ring-arc[data-off]').forEach((a) => a.setAttribute('stroke-dashoffset', a.dataset.off));
  }));
}

// Half-circle gauge 0-100 with a needle.
export function gauge(value, { lo = 'Bearish', hi = 'Bullish' } = {}) {
  const v = Math.max(0, Math.min(100, value));
  return `<svg class="gauge" viewBox="0 0 200 118" role="img" aria-label="${Math.round(v)} of 100">
    <defs><linearGradient id="gaugeGrad" x1="0" x2="1"><stop offset="0" stop-color="var(--bear)"/><stop offset=".5" stop-color="var(--gold)"/><stop offset="1" stop-color="var(--bull)"/></linearGradient></defs>
    <path d="M20 100 A80 80 0 0 1 180 100" class="gauge-track"/>
    <path d="M20 100 A80 80 0 0 1 180 100" class="gauge-arc"/>
    <g class="needle" style="--deg:${-90 + (v / 100) * 180}deg"><line x1="100" y1="100" x2="100" y2="34"/><circle cx="100" cy="100" r="6"/></g>
    <text x="20" y="116" class="gauge-end">${lo}</text><text x="180" y="116" class="gauge-end" text-anchor="end">${hi}</text></svg>`;
}

// Line sparkline (optionally filled) for a numeric series.
export function spark(values, { w = 300, h = 64, fill = true, cls = '' } = {}) {
  if (!values.length) return '';
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const pts = values.map((v, i) => [(i / Math.max(1, values.length - 1)) * w, hi === lo ? h / 2 : h - 4 - ((v - lo) / span) * (h - 8)]);
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return `<svg class="spark ${up ? 'up' : 'down'} ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    ${fill ? `<path class="spark-fill" d="${d} L${w} ${h} L0 ${h} Z"/>` : ''}<path class="spark-line" d="${d}" pathLength="1"/></svg>`;
}

// Delta histogram with the cumulative delta line on top.
export function deltaChart(rows, { w = 300, h = 110 } = {}) {
  if (!rows.length) return '';
  const max = Math.max(...rows.map((r) => Math.abs(r.delta)), 1);
  const bw = w / rows.length;
  const mid = h * 0.62;
  const bars = rows.map((r, i) => {
    const bh = (Math.abs(r.delta) / max) * (h * 0.36);
    const y = r.delta >= 0 ? mid - bh : mid;
    return `<rect x="${(i * bw + bw * 0.15).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(1, bh).toFixed(1)}" class="${r.delta >= 0 ? 'b-up' : 'b-down'}" style="--i:${i}"/>`;
  }).join('');
  const cv = rows.map((r) => r.cvd);
  const lo = Math.min(...cv);
  const span = Math.max(...cv) - lo || 1;
  const d = cv.map((v, i) => `${i ? 'L' : 'M'}${(i * bw + bw / 2).toFixed(1)} ${(4 + (1 - (v - lo) / span) * (h * 0.5)).toFixed(1)}`).join(' ');
  return `<svg class="delta" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" x2="${w}" y1="${mid}" y2="${mid}" class="zero"/>${bars}<path d="${d}" class="cvd" pathLength="1"/></svg>`;
}
