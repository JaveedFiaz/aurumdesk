import { TF, bucketStart } from '/shared/timeframes.js';
import { analyze, vwap, vwapAnchor } from '/shared/analysis.js';
import { STRATEGY_BY_ID } from '/shared/strategies.js';
import { Overlay } from '/overlay.js';
import { sessionsNow } from '/sessions.js';
import { feed } from '/feed.js';
import { $, esc, fmt, money, signed, compact, pct, ago, clock, tween, flash, ring, animateRings, spark, deltaChart } from '/ui.js';

const LC = window.LightweightCharts;
const nowSec = () => Math.floor(Date.now() / 1000);
const stratName = (id) => STRATEGY_BY_ID[id]?.name || id;
const sigId = (t) => `${t.tf}:${t.strategy}:${t.signalTime}`;
const UP = '#34f5c5';
const DN = '#ff5fa2';

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`scalper2:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`scalper2:${k}`, JSON.stringify(v));
    } catch { /* storage unavailable */ }
  },
};

const LAYERS = [
  { id: 'signals', label: 'Setups & areas' },
  { id: 'surges', label: 'Volume surges' },
  { id: 'structure', label: 'Structure' },
  { id: 'zones', label: 'Zones' },
  { id: 'liq', label: 'Liquidity' },
  { id: 'walls', label: 'Book walls' },
  { id: 'vwap', label: 'VWAP' },
];
const DEFAULT_LAYERS = { signals: true, surges: true, structure: true, zones: false, ob: false, liq: true, walls: true, vwap: true, htf: false, sr: false, profile: false };
const TFS = ['M1', 'M5', 'M15'];

const state = {
  market: store.get('market', 'gold'),
  tf: TFS.includes(store.get('tf')) ? store.get('tf') : 'M5',
  view: store.get('view', 'pulse') === 'tv' ? 'tv' : 'pulse',
  layers: { ...DEFAULT_LAYERS, ...store.get('layers', {}) },
  token: store.get('token', ''),
  cfg: { markets: [] },
  prices: {},
  dayOpen: {},
  candles: [],
  result: null,
  bots: {}, // market -> /api/bot result
  flow: null,
  paper: null,
  seq: 0,
  heroKey: '',
  seenSignals: null,
  seenNews: null,
  seenLog: null,
  whaleList: [],
  whaleMin: {},
  tape: [], // rolling live trades of the current market
  streamOn: false,
  formDirty: false,
};
const mk = () => state.cfg.markets.find((m) => m.id === state.market) || { id: state.market, label: state.market, unit: '' };

// ---- Chart ---------------------------------------------------------------------

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
  layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#c3bde0', fontFamily: 'Inter, system-ui, sans-serif' },
  grid: { vertLines: { color: 'rgba(255,255,255,0.05)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
  rightPriceScale: { borderColor: 'rgba(255,255,255,0.16)' },
  timeScale: { borderColor: 'rgba(255,255,255,0.16)', timeVisible: true, secondsVisible: false, rightOffset: 14 },
  crosshair: { mode: LC.CrosshairMode.Normal, vertLine: { color: 'rgba(196,181,253,0.6)', labelBackgroundColor: '#2a1a5e' }, horzLine: { color: 'rgba(196,181,253,0.6)', labelBackgroundColor: '#2a1a5e' } },
  localization: { locale: safeLocale(), priceFormatter: (p) => p.toFixed(2) },
});
const candleSeries = chart.addCandlestickSeries({ upColor: UP, downColor: DN, borderVisible: false, wickUpColor: UP, wickDownColor: DN, priceFormat: { type: 'price', precision: 2, minMove: 0.01 } });
candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.2 } });
const volumeSeries = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
const vwapSeries = chart.addLineSeries({ color: '#c4b5fd', lineWidth: 1, lineStyle: LC.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
const overlay = new Overlay(chartEl.parentElement, $('overlay'), chart, candleSeries);
const bar = (c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });

// Candles with at least twice the average volume where one side clearly dominated.
function findSurges(c) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < c.length; i++) {
    if (i >= 20) {
      const avg = sum / 20;
      const v = c[i].volume || 0;
      const share = c[i].buyVolume != null && v ? c[i].buyVolume / v : null;
      if (avg > 0 && v >= 2.5 * avg && share != null && (share >= 0.6 || share <= 0.4)) out.push({ index: i, side: share >= 0.6 ? 'buy' : 'sell', mult: v / avg });
      sum -= c[i - 20].volume || 0;
    }
    sum += c[i].volume || 0;
  }
  return out;
}

function volBars(c, surges) {
  const hot = new Map(surges.map((s) => [s.index, s.side]));
  return c.map((x, i) => {
    const side = hot.get(i);
    const up = x.buyVolume != null ? x.buyVolume * 2 >= x.volume : x.close >= x.open;
    return { time: x.time, value: x.volume || 0, color: side ? (side === 'buy' ? UP : DN) : up ? 'rgba(52,245,197,0.28)' : 'rgba(255,95,162,0.28)' };
  });
}

function closedCandles() {
  const c = state.candles;
  const last = c[c.length - 1];
  return last && last.time === bucketStart(TF[state.tf], nowSec()) ? c.slice(0, -1) : c;
}

async function load({ soft = false } = {}) {
  const { market, tf } = state;
  const seq = ++state.seq;
  if (!soft) $('loading').hidden = false;
  try {
    const candles = await feed.candles(market, tf, 600);
    if (seq !== state.seq) return;
    const range = soft ? chart.timeScale().getVisibleLogicalRange() : null;
    state.candles = candles;
    state.surges = findSurges(candles);
    candleSeries.setData(candles.map(bar));
    volumeSeries.setData(volBars(candles, state.layers.surges ? state.surges : []));
    if (range) chart.timeScale().setVisibleLogicalRange(range);
    else chart.timeScale().setVisibleLogicalRange({ from: candles.length - 110, to: candles.length + 12 });
    runAnalysis();
    $('banner').hidden = true;
  } catch (e) {
    if (seq === state.seq) {
      $('banner').textContent = `Could not load ${mk().label} ${TF[tf].label} candles: ${e.message}`;
      $('banner').hidden = false;
    }
  } finally {
    if (seq === state.seq) $('loading').hidden = true;
  }
}

function runAnalysis() {
  const tf = TF[state.tf];
  state.result = analyze(closedCandles(), { tf });
  vwapSeries.setData(state.layers.vwap ? vwap(state.candles, vwapAnchor(tf)) : []);
  pushOverlay();
  renderBias();
  renderLiq();
}

const play = () => state.bots[state.market]?.tfs?.[state.tf];

function pushOverlay() {
  const b = play();
  const first = state.candles[0]?.time ?? 0;
  const trade = b && !b.pending ? {
    areas: b.areas,
    triggers: b.triggers,
    live: [...b.signals, ...b.watch],
    history: b.recent.filter((t) => t.entryTime >= first).slice(-25),
    surges: state.layers.surges ? (state.surges || []).slice(-5) : [],
  } : { surges: state.layers.surges ? (state.surges || []).slice(-5) : [] };
  overlay.update({ candles: state.candles, result: state.result, htf: null, layers: state.layers, trade });
}

function renderBias() {
  const r = state.result;
  const b = play();
  const chip = (label, trend) => `<span class="chip ${trend || ''}">${label} ${trend === 'bull' ? '▲ Bullish' : trend === 'bear' ? '▼ Bearish' : '· Ranging'}</span>`;
  $('bias').innerHTML = [
    r ? chip(TF[state.tf].label, r.trend) : '',
    r ? `<span class="chip">ATR ${fmt(r.atr)}</span>` : '',
    b && !b.pending ? `<span class="chip">${b.stats.filter((s) => s.active).length ? 'Strategy proven · trading' : 'Strategy on watch · not traded'}</span>` : '<span class="chip">Backtesting…</span>',
  ].join('');
}

let wallLines = [];
function drawWalls() {
  wallLines.forEach((l) => candleSeries.removePriceLine(l));
  wallLines = [];
  const book = state.flow?.book;
  if (!book || !state.layers.walls) return;
  const top = (w) => w.slice().sort((a, b) => b.size - a.size).slice(0, 2);
  for (const w of top(book.bidWalls)) wallLines.push(candleSeries.createPriceLine({ price: w.price, color: 'rgba(52,245,197,0.6)', lineWidth: 2, lineStyle: LC.LineStyle.SparseDotted, axisLabelVisible: false, title: `bid wall ${compact(w.size)}` }));
  for (const w of top(book.askWalls)) wallLines.push(candleSeries.createPriceLine({ price: w.price, color: 'rgba(255,95,162,0.6)', lineWidth: 2, lineStyle: LC.LineStyle.SparseDotted, axisLabelVisible: false, title: `ask wall ${compact(w.size)}` }));
}

// ---- Header ---------------------------------------------------------------------

function renderHeader() {
  $('mtabs').innerHTML = state.cfg.markets.map((m) => {
    const b = state.bots[m.id];
    const sig = b ? Object.values(b.tfs).flatMap((t) => t.signals || []).find((s) => s.status === 'pending' || s.status === 'open') : null;
    return `<button type="button" data-m="${m.id}" aria-pressed="${m.id === state.market}">${esc(m.label)}<span class="p" id="mp-${m.id}">${fmt(state.prices[m.id])}</span>${sig ? `<span class="sig ${sig.dir}">${sig.dir === 'bull' ? 'BUY' : 'SELL'}</span>` : ''}</button>`;
  }).join('');
  $('tfs').innerHTML = TFS.map((t) => `<button type="button" data-tf="${t}" aria-pressed="${t === state.tf}">${TF[t].label}</button>`).join('');
  $('views').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  $('layers').innerHTML = LAYERS.map((l) => `<button type="button" data-layer="${l.id}" aria-pressed="${!!state.layers[l.id]}">${l.label}</button>`).join('');
  $('layers').hidden = $('bias').hidden = state.view === 'tv';
}

function renderPills() {
  const s = sessionsNow();
  const kill = s.find((x) => x.killzone);
  const open = s.filter((x) => x.open).map((x) => x.name);
  const m = mk();
  $('pills').innerHTML = [
    state.cfg.demo ? '<span class="pill demo">DEMO DATA</span>' : `<span class="pill" title="Price feed">${esc(m.source || '')}</span>`,
    `<span class="pill ${state.streamOn ? 'on' : ''}" title="Live trade stream for whales and order flow">${state.streamOn ? 'Trades: live stream' : 'Trades: 3 s refresh'}</span>`,
    kill ? `<span class="pill kill">${kill.name} open · killzone</span>` : `<span class="pill ${open.length ? 'on' : ''}">${open.length ? open.join(' + ') : 'Sessions closed'}</span>`,
  ].join('');
}

function switchTo(market, tf) {
  if (market === state.market && tf === state.tf) return;
  const marketChanged = market !== state.market;
  state.market = market;
  state.tf = tf;
  store.set('market', market);
  store.set('tf', tf);
  state.result = null;
  state.heroKey = '';
  if (marketChanged) {
    state.flow = null;
    state.tape = [];
    state.whaleList = [];
    $('whales').innerHTML = '';
    $('price').textContent = fmt(state.prices[market]);
  }
  renderHeader();
  renderPills();
  renderChange();
  load();
  loadFlow();
  renderHero();
  renderScore();
  renderNews();
  if (state.view === 'tv') showTradingView();
}

$('mtabs').addEventListener('click', (e) => {
  const m = e.target.closest('button')?.dataset.m;
  if (m) switchTo(m, state.tf);
});
$('tfs').addEventListener('click', (e) => {
  const tf = e.target.closest('button')?.dataset.tf;
  if (tf) switchTo(state.market, tf);
});
$('layers').addEventListener('click', (e) => {
  const id = e.target.closest('button')?.dataset.layer;
  if (!id) return;
  state.layers[id] = !state.layers[id];
  if (id === 'zones') state.layers.ob = state.layers.zones;
  store.set('layers', state.layers);
  renderHeader();
  if (id === 'vwap') vwapSeries.setData(state.layers.vwap ? vwap(state.candles, vwapAnchor(TF[state.tf])) : []);
  if (id === 'walls') drawWalls();
  if (id === 'surges') volumeSeries.setData(volBars(state.candles, state.layers.surges ? state.surges : []));
  pushOverlay();
});

// TradingView's free Advanced Chart widget.
const TV_INTERVAL = { M1: '1', M5: '5', M15: '15' };
function showTradingView() {
  const el = $('tv');
  el.innerHTML = '<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div></div>';
  const s = document.createElement('script');
  s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  s.async = true;
  s.text = JSON.stringify({ autosize: true, symbol: mk().tv, interval: TV_INTERVAL[state.tf], timezone: 'Etc/UTC', theme: 'dark', style: '1', locale: 'en', backgroundColor: '#0b0720', allow_symbol_change: true, calendar: false, support_host: 'https://www.tradingview.com' });
  s.onerror = () => { el.innerHTML = '<p class="banner">Could not load the TradingView chart. Check your connection or ad blocker.</p>'; };
  el.firstChild.appendChild(s);
}
$('views').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.view;
  if (!v || v === state.view) return;
  state.view = v;
  store.set('view', v);
  $('tv').hidden = v !== 'tv';
  if (v === 'tv') showTradingView();
  else $('tv').innerHTML = '';
  renderHeader();
});

// ---- Live prices and trades -------------------------------------------------------

let refreshTimer = null;
function onPrice(market, p, t = nowSec()) {
  const prev = state.prices[market];
  state.prices[market] = p;
  const tab = $(`mp-${market}`);
  if (tab) tab.textContent = fmt(p);
  if (market !== state.market) return;
  const el = $('price');
  el.textContent = fmt(p);
  if (prev != null && p !== prev) flash(el, p - prev);
  renderChange();
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
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      load({ soft: true });
      loadBots();
    }, 2500);
  }
}

function renderChange() {
  const p = state.prices[state.market];
  const o = state.dayOpen[state.market];
  const el = $('change');
  if (p == null || !o) {
    el.textContent = '';
    return;
  }
  const d = p - o;
  el.textContent = `${signed(d)} (${signed((d / o) * 100)}%)`;
  el.className = `chg ${d >= 0 ? 'bull' : 'bear'}`;
}

async function loadDayOpen() {
  for (const m of state.cfg.markets) {
    try {
      const days = await feed.candles(m.id, 'D1', 3);
      state.dayOpen[m.id] = days[days.length - 1]?.open ?? null;
    } catch { /* change stays blank */ }
  }
  renderChange();
}

let tapeDirty = false;
// Busy markets print dozens of trades a second: the price on screen is
// refreshed once per animation frame with the latest one.
const pendingPrice = {};
let priceFrame = 0;
function queuePrice(market, p, t) {
  pendingPrice[market] = { p, t };
  if (priceFrame) return;
  priceFrame = requestAnimationFrame(() => {
    priceFrame = 0;
    for (const [m, v] of Object.entries(pendingPrice)) {
      delete pendingPrice[m];
      onPrice(m, v.p, v.t);
    }
  });
}

function onTrade(market, t) {
  queuePrice(market, t.price + (market === state.market ? (state.flow?.basis || 0) : 0), Math.floor(t.time));
  if (market !== state.market) return;
  state.tape.push(t);
  tapeDirty = true;
  const min = state.whaleMin[market];
  if (min && t.size >= min) addWhale({ ...t, price: t.price + (state.flow?.basis || 0), notional: t.size * t.price }, true);
}

// ---- Setup panel -------------------------------------------------------------------

function candidates() {
  const b = state.bots[state.market];
  if (!b) return { list: [], ready: false };
  const plays = Object.values(b.tfs).filter((t) => !t.pending);
  const order = (a, z) => (a.status === 'pending' ? 0 : 1) - (z.status === 'pending' ? 0 : 1) || z.signalTime - a.signalTime;
  const sig = plays.flatMap((t) => t.signals).sort(order);
  if (sig.length) return { list: sig, tradable: true, ready: true };
  return { list: plays.flatMap((t) => t.watch).sort(order), tradable: false, ready: plays.length > 0 };
}

function renderHero() {
  const b = state.bots[state.market];
  const el = $('hero');
  if (!b) return;
  const { list, tradable, ready } = candidates();
  const best = list[0];
  const waits = Object.entries(b.tfs).flatMap(([tf, t]) => (t.pending ? [] : [
    ...t.areas.map((a) => `<div class="wait ${a.dir}">${TF[tf].label} · ${a.dir === 'bull' ? 'BUY' : 'SELL'} AREA ${fmt(a.bottom)}–${fmt(a.top)}<span>${esc(a.kind)} retest · SL ${fmt(a.stop)} · TP ${fmt(a.target)}</span></div>`),
    ...t.triggers.map((g) => `<div class="wait ${g.dir}">${TF[tf].label} · ${g.dir === 'bull' ? 'BUY above' : 'SELL below'} ${fmt(g.price)}<span>on a high-volume breakout at the London/NY open</span></div>`),
  ]));
  const key = best ? `${sigId(best)}:${best.status}:${tradable}` : `none:${ready}:${waits.join('').length}:${Object.values(b.tfs).map((t) => (t.pending ? 'p' : 'r')).join('')}`;
  if (key === state.heroKey) return;
  state.heroKey = key;
  if (!best) {
    const testing = Object.entries(b.tfs).filter(([, t]) => t.pending).map(([tf]) => TF[tf].label);
    $('heroMeta').textContent = '';
    el.innerHTML = `<div class="radar"></div><div class="center"><b>Scanning 1m · 5m · 15m</b></div>
      <div class="center muted small">${testing.length ? `Backtesting ${testing.join(', ')} on real history. This takes a few minutes after a restart.` : 'No setup right now. Every closed candle is checked for a zone touch, a trap or a breakout, then verified with volume, liquidity and order flow.'}</div>
      ${waits.slice(0, 4).join('')}`;
    return;
  }
  const t = best;
  const long = t.dir === 'bull';
  const risk = Math.abs(t.entry - t.stop);
  const okCount = t.factors.filter((f) => f.ok).length;
  $('heroMeta').textContent = `${TF[t.tf].label} · ${ago(t.signalTime + TF[t.tf].sec)}`;
  el.innerHTML = `
    <div class="sig-head">${ring(t.score, { size: 84, stroke: 8, label: 'score' })}
      <div><div style="display:flex;gap:6px;margin-bottom:6px"><span class="tag ${!tradable ? 'watch' : t.status === 'open' ? 'run' : ''}">${!tradable ? 'WATCH ONLY' : t.status === 'open' ? 'RUNNING' : 'NEW'}</span><span class="tag watch">${TF[t.tf].label}</span></div>
      <div class="dir ${t.dir}"><span class="arrow">${long ? '▲' : '▼'}</span>${long ? 'BUY' : 'SELL'}</div></div></div>
    <div><b>${esc(stratName(t.strategy))}</b><div class="muted small">${esc(t.why)}</div></div>
    <div class="lv3"><div><span>ENTRY</span>${fmt(t.entry)}</div><div class="bear"><span>STOP</span>${fmt(t.stop)}</div><div class="bull"><span>TARGET</span>${fmt(t.target)}</div></div>
    <div class="note">Risk ${fmt(risk)} per ${esc(mk().unit)} for ${fmt(Math.abs(t.target - t.entry) / risk, 1)}R. <b>${okCount} of ${t.factors.length}</b> confluence checks passed.${tradable ? '' : ' This strategy has not passed the backtest gate, so the auto-trader will not take it.'}</div>
    <ul class="checks">${t.factors.map((f, i) => `<li class="${f.ok ? 'ok' : 'no'}" style="--i:${i}"><b>✓</b>${esc(f.label)}</li>`).join('')}</ul>
    ${t.tf !== state.tf ? `<button type="button" class="btn" id="goTf">Show on the ${TF[t.tf].label} chart</button>` : ''}`;
  animateRings(el);
  $('goTf')?.addEventListener('click', () => switchTo(state.market, t.tf));
}

function checkNewSignals() {
  const all = Object.entries(state.bots).flatMap(([m, b]) => Object.values(b.tfs).flatMap((t) => (t.signals || []).map((s) => ({ ...s, market: m }))));
  const ids = new Set(all.map((s) => `${s.market}:${sigId(s)}`));
  const prev = state.seenSignals;
  state.seenSignals = ids;
  if (!prev) return;
  for (const s of all) {
    if (prev.has(`${s.market}:${sigId(s)}`) || s.status !== 'pending') continue;
    const m = state.cfg.markets.find((x) => x.id === s.market);
    toast(`<b>New ${esc(m?.label || s.market)} ${TF[s.tf].label} setup:</b> ${s.dir === 'bull' ? 'BUY' : 'SELL'} · ${esc(stratName(s.strategy))} · entry ≈ ${fmt(s.entry)}`);
    beep();
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`${m?.label} ${s.dir === 'bull' ? 'BUY' : 'SELL'} · ${TF[s.tf].label}`, { body: `${stratName(s.strategy)} · entry ≈ ${fmt(s.entry)} · SL ${fmt(s.stop)} · TP ${fmt(s.target)}` });
      } catch { /* needs a service worker on some phones */ }
    }
    if (s.market === state.market && s.tf !== state.tf) switchTo(s.market, s.tf); // jump to the timeframe that fired
  }
}

function renderScore() {
  const b = state.bots[state.market];
  if (!b) return;
  $('scoreMeta').textContent = `${mk().label} · real history · re-tested every 12 hours`;
  $('score').innerHTML = Object.entries(b.tfs).map(([tf, t]) => {
    if (t.pending) return `<div class="sc"><div class="t">${TF[tf].label} · ${t.strategies.map(stratName).join(', ')}<span class="st off">${t.error ? 'ERROR' : 'TESTING'}</span></div><div class="n">${t.error ? esc(t.error) : 'Backtesting on real history…'}</div></div>`;
    return t.stats.map((s) => `<div class="sc" title="${esc(s.desc)}"><div class="t">${TF[tf].label} · ${esc(s.name)}<span class="st ${s.active ? 'on' : 'off'}">${s.active ? 'TRADING' : 'WATCH ONLY'}</span></div>
      <div class="n">${s.trades} trades in ${t.days} days · ${pct(s.winRate)} won · PF ${Number.isFinite(s.pf) ? s.pf.toFixed(2) : '∞'} · target ${s.rr}R</div>
      <div class="n">Average <span class="${s.expR >= 0 ? 'bull' : 'bear'}">${signed(s.expR)}R</span> · total <span class="${s.totalR >= 0 ? 'bull' : 'bear'}">${signed(s.totalR, 1)}R</span> · worst drop ${fmt(s.maxDD, 1)}R · recent 40% <span class="${s.outSample.expR >= 0 ? 'bull' : 'bear'}">${signed(s.outSample.expR)}R</span></div></div>`).join('');
  }).join('');
}

async function loadBots() {
  for (const m of state.cfg.markets) {
    try {
      state.bots[m.id] = await feed.bot(m.id);
    } catch { /* retried on the next pass */ }
  }
  renderHero();
  renderScore();
  renderHeader();
  renderBias();
  checkNewSignals();
  pushOverlay();
}

// ---- Order flow, whales, liquidity ------------------------------------------------

let flowKey = '';
function renderFlow() {
  const f = state.flow;
  const el = $('flow');
  if (!f) return;
  if (!f.available) {
    el.innerHTML = '<p class="empty">Order flow is off for this market.</p>';
    return;
  }
  $('flowMeta').textContent = f.source;
  if (!el.querySelector('.bar2')) {
    el.innerHTML = `<div><div class="labels"><span class="bull">Buyers <b id="buyPct"></b></span><span class="muted small" id="tapeSpan"></span><span class="bear">Sellers <b id="sellPct"></b></span></div><div class="bar2"><i id="buyBar" style="width:50%"></i></div></div>
      <div id="deltaChart"></div><div id="flowRows" class="stack" style="gap:4px"></div>`;
  }
  renderTapeSplit();
  const rows = f.delta.slice(-48);
  const last = rows[rows.length - 1];
  const key = `${state.market}:${state.tf}:${last?.time}:${last?.delta}`;
  if (key !== flowKey) {
    flowKey = key;
    $('deltaChart').innerHTML = deltaChart(rows, { h: 96 });
  }
  const trend = rows.length > 8 ? rows[rows.length - 1].cvd - rows[rows.length - 9].cvd : 0;
  const surge = (state.surges || []).filter((s) => s.index >= state.candles.length - 3).pop();
  $('flowRows').innerHTML = last ? `
    <div class="row"><span>Delta, this ${TF[state.tf].label} candle</span><b class="mono ${last.delta >= 0 ? 'bull' : 'bear'}">${signed(last.delta, 2)} ${esc(mk().unit)}</b></div>
    <div class="row"><span>Cumulative delta (8 candles)</span><b class="${trend >= 0 ? 'bull' : 'bear'}">${trend >= 0 ? 'Rising ▲' : 'Falling ▼'}</b></div>
    <div class="row"><span>Volume surge</span><b class="${surge ? (surge.side === 'buy' ? 'bull' : 'bear') : 'muted'}">${surge ? `${surge.side === 'buy' ? 'Buyers' : 'Sellers'} ${surge.mult.toFixed(1)}× average` : 'None now'}</b></div>` : '';
}

// Buyer/seller split: the last 60 s of the live stream, or the server's recent tape.
function renderTapeSplit() {
  if (!$('buyBar')) return;
  let bp;
  let label;
  const cut = Date.now() / 1000 - 60;
  state.tape = state.tape.filter((t) => t.time >= cut);
  if (state.streamOn && state.tape.length >= 5) {
    let buy = 0;
    let all = 0;
    for (const t of state.tape) {
      all += t.size;
      if (t.side === 'buy') buy += t.size;
    }
    bp = all ? buy / all : 0.5;
    label = `last 60 s · ${state.tape.length} trades`;
  } else if (state.flow?.tape) {
    bp = state.flow.tape.buyPct;
    label = state.flow.tape.from ? `last ${Math.max(1, Math.round((state.flow.tape.to - state.flow.tape.from) / 60))} min` : '';
  } else return;
  tween($('buyPct'), bp * 100, (v) => `${v.toFixed(0)}%`, 400);
  tween($('sellPct'), (1 - bp) * 100, (v) => `${v.toFixed(0)}%`, 400);
  $('buyBar').style.width = `${(bp * 100).toFixed(1)}%`;
  $('tapeSpan').textContent = label;
}

function addWhale(t, fresh) {
  const k = `${t.time}:${t.price}:${t.size}`;
  if (state.whaleList.some((w) => w.k === k)) return;
  state.whaleList.unshift({ ...t, k });
  state.whaleList.sort((a, b) => b.time - a.time);
  state.whaleList.length = Math.min(state.whaleList.length, 9);
  const max = Math.max(...state.whaleList.map((w) => w.size), 1);
  $('whales').innerHTML = state.whaleList.map((w) => {
    const d = 9 + (w.size / max) * 15;
    return `<li class="whale ${w.side} ${fresh && w.k === k ? 'fresh' : ''}"><u style="width:${d.toFixed(0)}px;height:${d.toFixed(0)}px"></u><b>${w.side.toUpperCase()}</b><span class="mono">${compact(w.size)} ${esc(mk().unit)} · $${compact(w.notional)}</span><time>${clock(w.time)}</time></li>`;
  }).join('');
}

function renderWhales() {
  const w = state.flow?.whales;
  if (!w) return;
  state.whaleMin[state.market] = w.threshold;
  $('whaleMeta').textContent = `≥ ${compact(w.threshold)} ${mk().unit} · top 2%`;
  const total = w.buyVol + w.sellVol;
  $('whaleSum').innerHTML = total ? `<div class="labels"><span class="bull">Whale buys ${pct(w.buyVol / total)}</span><span class="bear">Whale sells ${pct(w.sellVol / total)}</span></div><div class="bar2"><i style="width:${((w.buyVol / total) * 100).toFixed(1)}%"></i></div>` : '';
  const first = state.whaleList.length === 0;
  for (const t of w.list.slice().reverse()) addWhale(t, !first);
  if (!state.whaleList.length) $('whales').innerHTML = '<li class="empty">No large trades in the recent tape</li>';
}

function renderLiq() {
  const el = $('liq');
  const book = state.flow?.book;
  const r = state.result;
  const price = state.prices[state.market] ?? state.candles[state.candles.length - 1]?.close;
  let html = '';
  if (book) {
    $('liqMeta').textContent = 'order book';
    const asks = book.asks.slice(0, 6).reverse();
    const bids = book.bids.slice(0, 6);
    const max = Math.max(...[...asks, ...bids].map((l) => l.size), 1e-9);
    const walls = new Set([...book.bidWalls, ...book.askWalls].map((w) => w.price));
    const rung = (l, side) => `<div class="rung ${side} ${walls.has(l.price) ? 'wall' : ''}"><i style="width:${((l.size / max) * 100).toFixed(1)}%"></i><span>${fmt(l.price, 0)}</span><span>${compact(l.size)}</span></div>`;
    html += `<div><div class="labels"><span class="bull">Bids ${pct(book.imbalance)}</span><span class="bear">Asks ${pct(1 - book.imbalance)}</span></div><div class="bar2"><i style="width:${(book.imbalance * 100).toFixed(1)}%"></i></div></div>
      <div class="ladder">${asks.map((l) => rung(l, 'ask')).join('')}<div class="mid">${fmt(book.mid)}</div>${bids.map((l) => rung(l, 'bid')).join('')}</div>`;
  }
  if (r && price) {
    const above = r.pools.filter((p) => p.kind === 'EQH' && p.price > price).sort((a, b) => a.price - b.price)[0];
    const below = r.pools.filter((p) => p.kind === 'EQL' && p.price < price).sort((a, b) => b.price - a.price)[0];
    const rows = [];
    if (above) rows.push(['Buy stops above', above.price]);
    if (below) rows.push(['Sell stops below', below.price]);
    if (r.prevDay) rows.push(['Previous day high', r.prevDay.high], ['Previous day low', r.prevDay.low]);
    html += `<div class="stack" style="gap:4px">${rows.map(([k, p]) => `<div class="row"><span>${k}</span><b class="mono">${fmt(p)}</b></div>`).join('')}</div>`;
  }
  el.innerHTML = html || '<p class="empty">Loading…</p>';
}

async function loadFlow() {
  const { market, tf } = state;
  try {
    const f = await feed.flow(market, tf);
    if (market !== state.market || tf !== state.tf) return;
    state.flow = f;
  } catch {
    return;
  }
  renderFlow();
  renderWhales();
  renderLiq();
  drawWalls();
}

// ---- News ---------------------------------------------------------------------------

function countdown(t) {
  const s = Math.round(t - Date.now() / 1000);
  if (s <= 0) return 'now';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h >= 24 ? `in ${Math.floor(h / 24)}d ${h % 24}h` : h ? `in ${h}h ${m}m` : `in ${m}m ${s % 60}s`;
}

function renderNews() {
  const n = state.news;
  if (!n) return;
  const nk = `${state.market}:${n.ok}:${n.items.length}:${n.items[0]?.title}:${n.events[0]?.title}:${Math.floor(Date.now() / 30000)}`;
  if (nk === state.newsKey) return;
  state.newsKey = nk;
  $('newsMeta').textContent = n.demo ? 'demo headlines' : n.ok ? 'live · checked every few seconds' : 'connecting to feeds…';
  $('events').innerHTML = n.events.slice(0, 2).map((e) => `<div class="event"><span><b>${esc(e.title)}</b>${e.forecast ? ` · forecast ${esc(e.forecast)}` : ''}</span><b class="mono" style="color:var(--accent)">${countdown(e.time)}</b></div>`).join('');
  const items = n.items.filter((i) => i.markets.includes(state.market)).slice(0, 14);
  const prev = state.seenNews;
  $('news').innerHTML = items.map((i) => {
    const bias = i.bias?.[state.market];
    const fresh = prev && !prev.has(i.title);
    const title = i.link ? `<a href="${esc(i.link)}" target="_blank" rel="noopener noreferrer">${esc(i.title)}</a>` : esc(i.title);
    return `<li class="${fresh ? 'fresh' : ''}"><div class="hd"><em class="${i.impact}">${i.impact === 'high' ? 'HIGH' : i.impact === 'med' ? 'MED' : 'LOW'}</em>${esc(i.source)} · ${ago(i.seenAt)}${bias ? ` · <b class="${bias}">${bias === 'bull' ? 'bullish' : 'bearish'} ${esc(mk().label.toLowerCase())}</b>` : ''}</div>${title}</li>`;
  }).join('') || '<li class="empty">No headlines for this market yet</li>';
  if (prev) {
    for (const i of n.items) {
      if (!prev.has(i.title) && i.impact === 'high') {
        toast(`<b>High-impact news:</b> ${esc(i.title)}`);
        beep(520);
      }
    }
  }
  state.seenNews = new Set(n.items.map((i) => i.title));
}

async function loadNews() {
  try {
    state.news = await feed.news();
    renderNews();
  } catch { /* retried */ }
}

// ---- Auto-trader ----------------------------------------------------------------------

const form = $('botForm');

function renderPaper() {
  const p = state.paper;
  if (!p) return;
  if (!state.formDirty) {
    for (const k of ['startBalance', 'riskPct', 'maxOpen', 'dailyLossPct']) if (document.activeElement !== form.elements[k]) form.elements[k].value = p[k];
    $('riskOut').textContent = `${form.elements.riskPct.value}%`;
  }
  const st = $('botState');
  st.textContent = p.enabled ? 'RUNNING' : 'STOPPED';
  st.className = `state ${p.enabled ? 'on' : ''}`;
  $('botToggle').textContent = p.enabled ? 'Stop' : 'Start';
  $('kpis').innerHTML = `<div>${p.trades}<span>trades</span></div><div>${p.trades ? pct(p.winRate) : '—'}<span>won</span></div><div>${p.profitFactor != null ? p.profitFactor.toFixed(2) : '—'}<span>profit factor</span></div>`;
  const eq = p.equity.map((e) => e.v);
  const sk = `${eq.length}:${eq[eq.length - 1]}`;
  if (sk !== state.sparkKey) {
    state.sparkKey = sk;
    $('equitySpark').innerHTML = spark(eq.length > 1 ? eq : [p.startBalance, p.startBalance], { h: 52 });
  }
  renderPositions();
  $('botLog').innerHTML = p.log.slice(0, 8).map((l) => `<li><time>${clock(l.t)}</time><span>${esc(l.msg)}</span></li>`).join('') || '<li class="empty">No activity yet. Trades appear here as setups fire.</li>';
  $('history').innerHTML = p.history.map((h) => `<li><time>${new Date(h.exitTime * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time><span><b class="${h.dir}">${h.dir === 'bull' ? '▲' : '▼'}</b> ${esc(h.label)} ${esc(h.tf)} · ${esc(stratName(h.strategy))} · ${esc(h.reason)}</span><b class="mono ${h.pnl >= 0 ? 'bull' : 'bear'}">${money(h.pnl)} (${signed(h.r, 1)}R)</b></li>`).join('') || '<li class="empty">No closed trades yet</li>';
  if (state.seenLog != null) {
    for (const l of p.log) {
      if (l.t <= state.seenLog) break;
      if (/^(Opened|Closed)/.test(l.msg)) toast(`<b>Auto-trader:</b> ${esc(l.msg)}`);
    }
  }
  state.seenLog = p.log[0]?.t ?? 0;
}

function renderPositions() {
  const p = state.paper;
  if (!p) return;
  let unreal = 0;
  $('positions').innerHTML = p.positions.map((x) => {
    const price = state.prices[x.market];
    const pl = Number.isFinite(price) ? (x.dir === 'bull' ? 1 : -1) * (price - x.entry) * x.units : 0;
    unreal += pl;
    return `<li class="pos"><span><b class="${x.dir}">${x.dir === 'bull' ? '▲ LONG' : '▼ SHORT'}</b> ${esc(x.label)} ${esc(x.tf)}</span><b class="mono ${pl >= 0 ? 'bull' : 'bear'}">${money(pl)}</b><span class="det">${+x.units.toFixed(4)} @ ${fmt(x.entry)} · SL ${fmt(x.stop)} · TP ${fmt(x.target)}</span></li>`;
  }).join('') || '<li class="empty">No open trades</li>';
  const equity = p.balance + unreal;
  tween($('equity'), equity, (v) => money(v), 500);
  const pnl = equity - p.startBalance;
  $('pnl').textContent = `${pnl >= 0 ? '+' : '−'}$${fmt(Math.abs(pnl))}`;
  $('pnl').className = `mono pnl ${pnl >= 0 ? 'bull' : 'bear'}`;
  $('pnlPct').textContent = `${signed((equity / p.startBalance - 1) * 100)}% · today ${money(p.dayPnl)}`;
}

async function loadPaper() {
  try {
    state.paper = await feed.paper();
    renderPaper();
  } catch { /* retried */ }
}

async function paperAction(body, btn) {
  if (btn) btn.disabled = true;
  try {
    state.paper = await feed.paperAction(body, state.token);
    state.formDirty = false;
    renderPaper();
  } catch (e) {
    if (e.status === 401) {
      const tok = window.prompt('The auto-trader controls are protected. Enter the ADMIN_TOKEN set on the server:');
      if (tok) {
        state.token = tok;
        store.set('token', tok);
        if (btn) btn.disabled = false;
        return paperAction(body, btn);
      }
    } else toast(`<b>Auto-trader:</b> ${esc(e.message)}`);
  } finally {
    if (btn) btn.disabled = false;
  }
  return undefined;
}
const formConfig = () => ({ startBalance: +form.elements.startBalance.value, riskPct: +form.elements.riskPct.value, maxOpen: +form.elements.maxOpen.value, dailyLossPct: +form.elements.dailyLossPct.value });
form.addEventListener('input', (e) => {
  state.formDirty = true;
  if (e.target.name === 'riskPct') $('riskOut').textContent = `${e.target.value}%`;
});
form.addEventListener('change', () => paperAction({ config: formConfig() }));
$('botToggle').addEventListener('click', (e) => {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  paperAction(state.paper?.enabled ? { action: 'stop' } : { config: formConfig(), action: 'start' }, e.currentTarget);
});
$('botReset').addEventListener('click', (e) => {
  if (window.confirm('Reset the paper account? Its history will be cleared.')) paperAction({ action: 'reset', amount: +form.elements.startBalance.value }, e.currentTarget);
});
$('botClose').addEventListener('click', (e) => {
  if (window.confirm('Stop the auto-trader and close every open trade at the current price?')) paperAction({ action: 'stop', closeAll: true }, e.currentTarget);
});

// ---- Alerts ---------------------------------------------------------------------------

function toast(html) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = html;
  $('toasts').prepend(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 400);
  }, 7000);
  while ($('toasts').children.length > 4) $('toasts').lastChild.remove();
}

function beep(freq = 700) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(freq * 1.5, ctx.currentTime + 0.15);
    g.gain.setValueAtTime(0.07, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.45);
    o.onended = () => ctx.close();
  } catch { /* browsers block audio until the user interacts */ }
}

// ---- Boot -----------------------------------------------------------------------------

async function boot() {
  try {
    state.cfg = await feed.config();
  } catch (e) {
    $('banner').textContent = `Server not reachable: ${e.message}`;
    $('banner').hidden = false;
  }
  if (!state.cfg.markets.some((m) => m.id === state.market)) state.market = state.cfg.markets[0]?.id || 'gold';
  renderHeader();
  renderPills();
  if (state.view === 'tv') {
    $('tv').hidden = false;
    showTradingView();
  }
  load();
  loadDayOpen();
  loadBots();
  loadFlow();
  loadNews();
  loadPaper();
  const dot = $('liveDot');
  feed.subscribe((d) => {
    if (d.error) return;
    dot.className = 'live-dot on';
    dot.title = 'Live';
    if (!state.streamOn || d.m !== state.market) onPrice(d.m, d.p, d.t);
  }, () => {
    dot.className = 'live-dot err';
    dot.title = 'Reconnecting…';
  });
  feed.trades(Object.fromEntries(state.cfg.markets.map((m) => [m.id, m.stream])), onTrade, (on) => {
    state.streamOn = on;
    renderPills();
  });
  setInterval(() => {
    if (tapeDirty || !state.streamOn) renderTapeSplit();
    tapeDirty = false;
    renderPositions();
  }, 500);
  setInterval(loadBots, 5000);
  setInterval(loadFlow, 4000);
  setInterval(loadNews, 2000);
  setInterval(loadPaper, 3000);
  setInterval(() => load({ soft: true }), 60000);
  setInterval(loadDayOpen, 5 * 60000);
  setInterval(renderPills, 30000);
  setInterval(() => { if (state.news) $('events').querySelectorAll('.event b.mono').forEach((el, i) => { el.textContent = countdown(state.news.events[i].time); }); }, 1000);
}

boot();
