import { TIMEFRAMES, TF, bucketStart } from '/shared/timeframes.js';
import { analyze, vwap, vwapAnchor } from '/shared/analysis.js';
import { Overlay, COLORS } from '/overlay.js';
import { initSessions } from '/sessions.js';
import { initCalculator } from '/calculator.js';
import { feed } from '/feed.js';

const LC = window.LightweightCharts;
const $ = (id) => document.getElementById(id);
const fmt = (p) => (p == null || Number.isNaN(p) ? '—' : p.toFixed(2));
const nowSec = () => Math.floor(Date.now() / 1000);

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`aurumdesk:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`aurumdesk:${k}`, JSON.stringify(v));
    } catch { /* storage unavailable */ }
  },
};

const LAYERS = [
  { id: 'structure', label: 'Structure', color: COLORS.bull },
  { id: 'ob', label: 'Order blocks', color: COLORS.bear },
  { id: 'zones', label: 'Supply / Demand', color: 'rgb(43,181,160)' },
  { id: 'htf', label: 'HTF zones', color: 'rgb(240,140,46)' },
  { id: 'sr', label: 'S / R', color: COLORS.sr },
  { id: 'liq', label: 'Liquidity', color: COLORS.liq },
  { id: 'vwap', label: 'VWAP', color: '#f5c542' },
  { id: 'profile', label: 'Volume profile', color: COLORS.poc },
  { id: 'volume', label: 'Volume', color: '#4a5361' },
];
const DEFAULT_LAYERS = { structure: true, ob: true, zones: true, htf: true, sr: false, liq: true, vwap: true, profile: false, volume: true };

// Higher timeframe whose supply/demand zones are projected onto each chart.
const HTF_OF = { M1: 'H1', M3: 'H1', M5: 'H1', M10: 'H4', M15: 'H4', M30: 'H4', M45: 'D1', H1: 'D1', H4: 'D1', D1: 'W1' };

const state = {
  tf: TF[store.get('tf', 'M15')] ? store.get('tf', 'M15') : 'M15',
  layers: { ...DEFAULT_LAYERS, ...store.get('layers', {}) },
  candles: [],
  result: null,
  htf: null,
  price: null,
  prevPrice: null,
  dayOpen: null,
  seq: 0,
  seenEvent: null,
  alertedZones: new Set(),
};

// ---- Chart ----------------------------------------------------------------

// Some systems report locales like "en-US@posix" that Intl rejects, which
// stops the chart from formatting its time axis.
function safeLocale() {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([navigator.language])[0] || 'en-US';
  } catch {
    return 'en-US';
  }
}

const chartEl = $('chart');
const chart = LC.createChart(chartEl, {
  autoSize: true,
  layout: { background: { type: 'solid', color: '#0b0f14' }, textColor: '#8b95a3', fontFamily: 'system-ui, sans-serif' },
  grid: { vertLines: { color: '#151b23' }, horzLines: { color: '#151b23' } },
  rightPriceScale: { borderColor: '#222a35' },
  timeScale: { borderColor: '#222a35', timeVisible: true, secondsVisible: false, rightOffset: 8 },
  crosshair: { mode: LC.CrosshairMode.Normal },
  localization: { locale: safeLocale(), priceFormatter: (p) => p.toFixed(2) },
});
const candleSeries = chart.addCandlestickSeries({
  upColor: '#26a69a',
  downColor: '#ef5350',
  borderVisible: false,
  wickUpColor: '#26a69a',
  wickDownColor: '#ef5350',
  priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
});
candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.2 } });
const volumeSeries = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
const vwapSeries = chart.addLineSeries({ color: '#f5c542', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
const overlay = new Overlay(chartEl.parentElement, $('overlay'), chart, candleSeries);

const volBar = (c) => ({ time: c.time, value: c.volume || 0, color: c.close >= c.open ? 'rgba(38,166,154,0.35)' : 'rgba(239,83,80,0.35)' });
const bar = (c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });

// ---- Data -----------------------------------------------------------------

function closedCandles(candles, tfId) {
  const last = candles[candles.length - 1];
  if (last && last.time === bucketStart(TF[tfId], nowSec())) return candles.slice(0, -1);
  return candles;
}

async function load({ soft = false } = {}) {
  const tf = state.tf;
  const seq = ++state.seq;
  if (!soft) $('loading').hidden = false;
  try {
    const candles = await feed.candles(tf, 800);
    if (seq !== state.seq) return;
    const range = soft ? chart.timeScale().getVisibleLogicalRange() : null;
    state.candles = candles;
    candleSeries.setData(state.candles.map(bar));
    volumeSeries.setData(state.layers.volume ? state.candles.map(volBar) : []);
    if (range) chart.timeScale().setVisibleLogicalRange(range);
    if (!soft) chart.timeScale().scrollToRealTime();
    runAnalysis();
    hideBanner();
  } catch (e) {
    if (seq === state.seq) showBanner(`Could not load ${tf} candles: ${e.message}`);
  } finally {
    if (seq === state.seq) $('loading').hidden = true;
  }
  if (!soft || Date.now() - (state.htfAt || 0) > 5 * 60000) loadHTF(seq);
}

async function loadHTF(seq) {
  const htfId = HTF_OF[state.tf];
  state.htfAt = Date.now();
  if (!htfId) {
    state.htf = null;
    pushOverlay();
    return;
  }
  try {
    const htfCandles = await feed.candles(htfId, 500);
    if (seq !== state.seq && HTF_OF[state.tf] !== htfId) return;
    const r = analyze(closedCandles(htfCandles, htfId), { tf: TF[htfId] });
    state.htf = r ? { tf: TF[htfId].label, zones: r.zones } : null;
  } catch {
    state.htf = null;
  }
  pushOverlay();
}

function runAnalysis() {
  const tf = TF[state.tf];
  state.result = analyze(closedCandles(state.candles, state.tf), { tf });
  vwapSeries.setData(state.layers.vwap ? vwap(state.candles, vwapAnchor(tf)) : []);
  pushOverlay();
  renderRead();
  checkStructureAlerts();
}

function pushOverlay() {
  overlay.update({ candles: state.candles, result: state.result, htf: state.htf, layers: state.layers });
}

async function loadDayOpen() {
  try {
    const days = await feed.candles('D1', 10);
    const last = days[days.length - 1];
    state.dayOpen = last ? last.open : null;
    renderQuote();
  } catch { /* header change stays blank */ }
}

// ---- Live ticks -----------------------------------------------------------

let refreshTimer = null;

function onTick({ t, p }) {
  state.prevPrice = state.price;
  state.price = p;
  renderQuote();
  const c = state.candles;
  const last = c[c.length - 1];
  if (!last) return;
  const b = bucketStart(TF[state.tf], t);
  if (b === last.time) {
    last.high = Math.max(last.high, p);
    last.low = Math.min(last.low, p);
    last.close = p;
    candleSeries.update(bar(last));
  } else if (b > last.time) {
    const fresh = { time: b, open: p, high: p, low: p, close: p, volume: 0 };
    c.push(fresh);
    candleSeries.update(bar(fresh));
    if (state.layers.volume) volumeSeries.update(volBar(fresh));
    runAnalysis();
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => load({ soft: true }), 1500 + Math.random() * 1500);
  }
  renderRead();
  checkZoneAlerts(p);
}

function connect() {
  const conn = $('conn');
  feed.subscribe((d) => {
    if (d.error) {
      conn.className = 'conn error';
      conn.title = `Price feed error: ${d.error}`;
      return;
    }
    conn.className = 'conn live';
    conn.title = 'Live';
    onTick(d);
  }, () => {
    conn.className = 'conn error';
    conn.title = 'Reconnecting…';
  });
}

// ---- Panels ---------------------------------------------------------------

function renderQuote() {
  const el = $('price');
  el.textContent = fmt(state.price);
  el.className = `price${state.prevPrice == null || state.price === state.prevPrice ? '' : state.price > state.prevPrice ? ' up' : ' down'}`;
  const ch = $('change');
  if (state.price != null && state.dayOpen) {
    const d = state.price - state.dayOpen;
    ch.textContent = `${d >= 0 ? '+' : ''}${d.toFixed(2)} (${((d / state.dayOpen) * 100).toFixed(2)}%)`;
    ch.className = `chg ${d >= 0 ? 'up' : 'down'}`;
  }
}

function timeLabel(t) {
  const sec = TF[state.tf].sec || Infinity;
  const d = new Date(t * 1000);
  return sec < 86400
    ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function renderRead() {
  const r = state.result;
  $('readTf').textContent = `· ${TF[state.tf].label}`;
  const el = $('read');
  if (!r) {
    el.innerHTML = '<dt>Not enough candles</dt><dd></dd>';
    return;
  }
  const price = state.price ?? state.candles[state.candles.length - 1]?.close;
  const nearest = (list) => list.slice().sort((a, b) => Math.abs((a.top + a.bottom) / 2 - price) - Math.abs((b.top + b.bottom) / 2 - price))[0];
  const zoneTxt = (z) => (z ? `${fmt(z.bottom)}–${fmt(z.top)} · ${z.score}` : '—');
  const demand = nearest(r.zones.filter((z) => z.kind === 'demand' && z.bottom < price));
  const supply = nearest(r.zones.filter((z) => z.kind === 'supply' && z.top > price));
  const sup = r.levels.filter((l) => l.price < price).sort((a, b) => b.price - a.price)[0];
  const res = r.levels.filter((l) => l.price > price).sort((a, b) => a.price - b.price)[0];
  const eqh = r.pools.filter((p) => p.kind === 'EQH' && p.price > price).sort((a, b) => a.price - b.price)[0];
  const eql = r.pools.filter((p) => p.kind === 'EQL' && p.price < price).sort((a, b) => b.price - a.price)[0];
  const vw = state.layers.vwap ? vwap(state.candles, vwapAnchor(TF[state.tf])).pop()?.value : null;
  const ev = r.lastEvent;
  const rows = [
    ['Structure', r.trend ? `<span class="${r.trend}">${r.trend === 'bull' ? 'Bullish' : 'Bearish'}</span>` : '—'],
    ['Last break', ev ? `<span class="${ev.dir}">${ev.type} ${ev.dir === 'bull' ? '↑' : '↓'}</span> ${fmt(ev.level)}` : '—'],
    ['', ev ? `<span class="muted">${timeLabel(ev.time)}</span>` : ''],
    ['Supply above', zoneTxt(supply)],
    ['Demand below', zoneTxt(demand)],
    ['Resistance', res ? `${fmt(res.price)} ×${res.touches}` : '—'],
    ['Support', sup ? `${fmt(sup.price)} ×${sup.touches}` : '—'],
    ['Liquidity above', eqh ? `EQH ${fmt(eqh.price)}` : '—'],
    ['Liquidity below', eql ? `EQL ${fmt(eql.price)}` : '—'],
  ];
  if (r.prevDay) rows.push(['PDH / PDL', `${fmt(r.prevDay.high)} / ${fmt(r.prevDay.low)}`]);
  if (vw) rows.push(['VWAP', `${fmt(vw)} <span class="${price >= vw ? 'bull' : 'bear'}">${price >= vw ? 'above' : 'below'}</span>`]);
  rows.push(['ATR (14)', fmt(r.atr)]);
  el.innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
}

// ---- Alerts ---------------------------------------------------------------

function alertMsg(text) {
  const li = document.createElement('li');
  li.innerHTML = `<time>${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</time><span></span>`;
  li.lastChild.textContent = text;
  const list = $('alerts');
  list.prepend(li);
  while (list.children.length > 30) list.lastChild.remove();
  if ($('notify').checked && 'Notification' in window && Notification.permission === 'granted') {
    try {
      new Notification(`AurumDesk · XAU/USD ${TF[state.tf].label}`, { body: text, tag: text });
    } catch { /* some mobile browsers only allow notifications from a service worker */ }
  }
}

function checkStructureAlerts() {
  const r = state.result;
  if (!r) return;
  const key = `${state.tf}`;
  const ev = r.lastEvent;
  const sw = r.sweeps[r.sweeps.length - 1];
  const prev = state.seenEvent;
  state.seenEvent = { key, ev: ev?.time, sw: sw?.time };
  if (!prev || prev.key !== key) return; // first look at this timeframe: don't replay history
  if (ev && ev.time !== prev.ev) alertMsg(`${ev.type} ${ev.dir === 'bull' ? 'bullish' : 'bearish'} through ${fmt(ev.level)}`);
  if (sw && sw.time !== prev.sw) alertMsg(`Liquidity grab at ${sw.kind} ${fmt(sw.price)}`);
}

function checkZoneAlerts(p) {
  const r = state.result;
  if (!r) return;
  for (const z of r.zones) {
    if (z.score < 60 || p > z.top || p < z.bottom) continue;
    const id = `${state.tf}:${z.kind}:${z.time}`;
    if (state.alertedZones.has(id)) continue;
    state.alertedZones.add(id);
    alertMsg(`Price in ${z.kind} zone ${fmt(z.bottom)}–${fmt(z.top)} (score ${z.score})`);
  }
}

$('notify').addEventListener('change', async (e) => {
  if (!e.target.checked || !('Notification' in window)) return;
  try {
    if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') e.target.checked = false;
  } catch {
    e.target.checked = false;
  }
});

// ---- Toolbar --------------------------------------------------------------

function renderToolbar() {
  $('tfs').innerHTML = TIMEFRAMES.map((t) => `<button type="button" data-tf="${t.id}" aria-pressed="${t.id === state.tf}">${t.label}</button>`).join('');
  $('layers').innerHTML = LAYERS.map((l) => `<button type="button" data-layer="${l.id}" aria-pressed="${!!state.layers[l.id]}"><span class="sw" style="background:${l.color}"></span>${l.label}</button>`).join('');
}

$('tfs').addEventListener('click', (e) => {
  const tf = e.target.closest('button')?.dataset.tf;
  if (!tf || tf === state.tf) return;
  state.tf = tf;
  state.result = null;
  state.htf = null;
  store.set('tf', tf);
  renderToolbar();
  load();
});

$('layers').addEventListener('click', (e) => {
  const id = e.target.closest('button')?.dataset.layer;
  if (!id) return;
  state.layers[id] = !state.layers[id];
  store.set('layers', state.layers);
  renderToolbar();
  if (id === 'volume') volumeSeries.setData(state.layers.volume ? state.candles.map(volBar) : []);
  if (id === 'vwap') vwapSeries.setData(state.layers.vwap ? vwap(state.candles, vwapAnchor(TF[state.tf])) : []);
  if (id === 'htf' && state.layers.htf && !state.htf) loadHTF(state.seq);
  pushOverlay();
  renderRead();
});

function showBanner(msg) {
  const b = $('banner');
  b.textContent = msg;
  b.hidden = false;
}
function hideBanner() {
  $('banner').hidden = true;
}

// ---- Trade plan lines -----------------------------------------------------

let planLines = [];
function drawPlan(plan) {
  planLines.forEach((l) => candleSeries.removePriceLine(l));
  planLines = [];
  if (!plan || !$('showPlan').checked) return;
  const add = (price, color, title) => price && planLines.push(candleSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title }));
  add(plan.entry, '#d4a72c', 'Entry');
  add(plan.stop, '#ef5350', 'SL');
  add(plan.target, '#26a69a', 'TP');
}

// ---- Boot -----------------------------------------------------------------

async function boot() {
  renderToolbar();
  initSessions($('sessions'));
  const recalc = initCalculator($('calc'), $('calcOut'), { getPrice: () => state.price, onPlan: drawPlan });
  $('showPlan').addEventListener('change', recalc);
  try {
    const cfg = await feed.config();
    const src = $('source');
    src.textContent = cfg.demo ? 'DEMO DATA' : cfg.label;
    src.title = cfg.note;
    if (cfg.demo) src.classList.add('demo');
  } catch (e) {
    showBanner(`Server not reachable: ${e.message}`);
  }
  await load();
  loadDayOpen();
  setInterval(loadDayOpen, 5 * 60000);
  setInterval(() => load({ soft: true }), 60000);
  connect();
}

boot();
