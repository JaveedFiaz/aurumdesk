import { TIMEFRAMES, TF, bucketStart } from '/shared/timeframes.js';
import { analyze, vwap, vwapAnchor } from '/shared/analysis.js';
import { STRATEGY_BY_ID } from '/shared/strategies.js';
import { Overlay, COLORS } from '/overlay.js';
import { sessionsNow, goldOpen } from '/sessions.js';
import { feed } from '/feed.js';
import {
  $, esc, fmt, money, signed, compact, pct, ago, clock, tween, flash, ring, animateRings, gauge, spark, deltaChart,
} from '/ui.js';

const LC = window.LightweightCharts;
const nowSec = () => Math.floor(Date.now() / 1000);
const stratName = (id) => STRATEGY_BY_ID[id]?.name || id;
const sigId = (t) => `${t.strategy}:${t.signalTime}`;

const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem(`pulse:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`pulse:${k}`, JSON.stringify(v));
    } catch { /* storage unavailable */ }
  },
};

const LAYERS = [
  { id: 'signals', label: 'Signals & buy/sell areas', color: '#f5c451' },
  { id: 'structure', label: 'Structure', color: COLORS.bull },
  { id: 'ob', label: 'Order blocks', color: COLORS.bear },
  { id: 'zones', label: 'Supply/Demand', color: 'rgb(34,211,238)' },
  { id: 'htf', label: 'HTF zones', color: 'rgb(167,139,250)' },
  { id: 'liq', label: 'Liquidity', color: COLORS.liq },
  { id: 'walls', label: 'Book walls', color: '#ffe08a' },
  { id: 'vwap', label: 'VWAP', color: '#f5c451' },
  { id: 'sr', label: 'S/R', color: COLORS.sr },
  { id: 'profile', label: 'Profile', color: COLORS.poc },
];
const DEFAULT_LAYERS = { signals: true, structure: true, ob: true, zones: true, htf: true, liq: true, walls: true, vwap: true, sr: false, profile: false, volume: true };
const HTF_OF = { M1: 'H1', M3: 'H1', M5: 'H1', M10: 'H4', M15: 'H1', M30: 'H4', M45: 'D1', H1: 'H4', H4: 'D1', D1: 'W1' };
const CHART_TFS = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1', 'W1'];

const state = {
  tf: CHART_TFS.includes(store.get('tf', 'M15')) ? store.get('tf', 'M15') : 'M15',
  layers: { ...DEFAULT_LAYERS, ...store.get('layers', {}) },
  token: store.get('token', ''),
  candles: [],
  result: null,
  htf: null,
  price: null,
  dayOpen: null,
  seq: 0,
  cfg: {},
  bot: null,
  flow: null,
  cot: null,
  paper: null,
  heroKey: null,
  seenSignals: null,
  seenWhales: new Set(),
  seenLog: null,
  formDirty: false,
  view: store.get('view', 'pulse') === 'tv' ? 'tv' : 'pulse',
};

// ---- Chart ------------------------------------------------------------------

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
  layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#8a94a8', fontFamily: 'Inter, system-ui, sans-serif' },
  grid: { vertLines: { color: 'rgba(255,255,255,0.035)' }, horzLines: { color: 'rgba(255,255,255,0.035)' } },
  rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
  timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false, rightOffset: 10 },
  crosshair: {
    mode: LC.CrosshairMode.Normal,
    vertLine: { color: 'rgba(245,196,81,0.45)', style: LC.LineStyle.Dashed, labelBackgroundColor: '#1a2133' },
    horzLine: { color: 'rgba(245,196,81,0.45)', style: LC.LineStyle.Dashed, labelBackgroundColor: '#1a2133' },
  },
  localization: { locale: safeLocale(), priceFormatter: (p) => p.toFixed(2) },
});
const candleSeries = chart.addCandlestickSeries({
  upColor: '#22e3a1', downColor: '#ff4d6d', borderVisible: false, wickUpColor: '#22e3a1', wickDownColor: '#ff4d6d',
  priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
});
candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.18 } });
const volumeSeries = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
const vwapSeries = chart.addLineSeries({ color: '#f5c451', lineWidth: 1, lineStyle: LC.LineStyle.Dotted, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
const overlay = new Overlay(chartEl.parentElement, $('overlay'), chart, candleSeries);

// Volume bars coloured by who was aggressive (taker delta) when that data exists.
const volBar = (c) => {
  const up = c.buyVolume != null ? c.buyVolume * 2 >= c.volume : c.close >= c.open;
  return { time: c.time, value: c.volume || 0, color: up ? 'rgba(34,227,161,0.32)' : 'rgba(255,77,109,0.32)' };
};
const bar = (c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close });

function closedCandles(candles, tfId) {
  const last = candles[candles.length - 1];
  return last && last.time === bucketStart(TF[tfId], nowSec()) ? candles.slice(0, -1) : candles;
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
    candleSeries.setData(candles.map(bar));
    volumeSeries.setData(candles.map(volBar));
    if (range) chart.timeScale().setVisibleLogicalRange(range);
    if (!soft) chart.timeScale().scrollToRealTime();
    runAnalysis();
    drawMarkers();
    hideBanner();
  } catch (e) {
    if (seq === state.seq) showBanner(`Could not load ${TF[tf].label} candles: ${e.message}`);
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
    renderBias();
    return;
  }
  try {
    const c = await feed.candles(htfId, 500);
    if (seq !== state.seq && HTF_OF[state.tf] !== htfId) return;
    const r = analyze(closedCandles(c, htfId), { tf: TF[htfId] });
    state.htf = r ? { tf: TF[htfId].label, zones: r.zones, trend: r.trend } : null;
  } catch {
    state.htf = null;
  }
  pushOverlay();
  renderBias();
}

function runAnalysis() {
  const tf = TF[state.tf];
  state.result = analyze(closedCandles(state.candles, state.tf), { tf });
  vwapSeries.setData(state.layers.vwap ? vwap(state.candles, vwapAnchor(tf)) : []);
  pushOverlay();
  renderBias();
  renderLiq();
}

function pushOverlay() {
  const b = state.bot;
  const trade = b ? { areas: b.areas, triggers: b.triggers, live: b.signals, history: b.recent.slice(-30) } : null;
  overlay.update({ candles: state.candles, result: state.result, htf: state.htf, layers: state.layers, trade });
}

function renderBias() {
  const r = state.result;
  const chip = (label, trend) => `<span class="chip ${trend || ''}">${label} ${trend === 'bull' ? '▲ Bullish' : trend === 'bear' ? '▼ Bearish' : '· Ranging'}</span>`;
  $('bias').innerHTML = [
    r ? chip(TF[state.tf].label, r.trend) : '',
    state.htf ? chip(state.htf.tf, state.htf.trend) : '',
    r ? `<span class="chip">ATR ${fmt(r.atr)}</span>` : '',
  ].join('');
}

// Bot entries on the trade finder's timeframe, labelled with grade and result.
function drawMarkers() {
  const b = state.bot;
  // With the signals layer on, trades are drawn as boxes instead of arrows.
  if (!b || state.tf !== b.tf || state.layers.signals) {
    candleSeries.setMarkers([]);
    return;
  }
  const first = state.candles[0]?.time ?? 0;
  const list = [...b.recent, ...b.signals, ...(b.watch || [])].filter((t) => t.entryTime && t.entryTime >= first);
  candleSeries.setMarkers(list.map((t) => {
    const long = t.dir === 'bull';
    const res = t.status === 'closed' ? ` ${t.r > 0 ? '+' : ''}${t.r.toFixed(1)}R` : ' live';
    return { time: t.entryTime, position: long ? 'belowBar' : 'aboveBar', color: long ? '#22e3a1' : '#ff4d6d', shape: long ? 'arrowUp' : 'arrowDown', text: `${t.grade || ''}${res}` };
  }).sort((x, y) => x.time - y.time));
}

let planLines = [];
function drawPlan(t) {
  planLines.forEach((l) => candleSeries.removePriceLine(l));
  planLines = [];
  if (!t) return;
  const add = (price, color, title, style = LC.LineStyle.Dashed) => planLines.push(candleSeries.createPriceLine({ price, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title }));
  add(t.entry, '#f5c451', `${t.dir === 'bull' ? 'LONG' : 'SHORT'} ${t.grade || ''}`, LC.LineStyle.Solid);
  add(t.stop, '#ff4d6d', 'SL');
  add(t.target, '#22e3a1', 'TP');
}

let wallLines = [];
function drawWalls() {
  wallLines.forEach((l) => candleSeries.removePriceLine(l));
  wallLines = [];
  const book = state.flow?.book;
  if (!book || !state.layers.walls) return;
  const top = (walls) => walls.slice().sort((a, b) => b.size - a.size).slice(0, 2);
  for (const w of top(book.bidWalls)) wallLines.push(candleSeries.createPriceLine({ price: w.price, color: 'rgba(34,227,161,0.55)', lineWidth: 2, lineStyle: LC.LineStyle.SparseDotted, axisLabelVisible: false, title: `bid wall ${compact(w.size)}` }));
  for (const w of top(book.askWalls)) wallLines.push(candleSeries.createPriceLine({ price: w.price, color: 'rgba(255,77,109,0.55)', lineWidth: 2, lineStyle: LC.LineStyle.SparseDotted, axisLabelVisible: false, title: `ask wall ${compact(w.size)}` }));
}

// ---- Toolbar ---------------------------------------------------------------------

function renderToolbar() {
  $('views').querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
  $('layers').hidden = state.view === 'tv';
  $('bias').hidden = state.view === 'tv';
  $('tfs').innerHTML = TIMEFRAMES.filter((t) => CHART_TFS.includes(t.id)).map((t) => `<button type="button" data-tf="${t.id}" aria-pressed="${t.id === state.tf}">${t.label}</button>`).join('');
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
  loadFlow();
  if (state.view === 'tv') showTradingView();
});

// ---- TradingView chart ------------------------------------------------------------

// TradingView's free Advanced Chart widget: their prices, chart and drawing tools.
const TV_INTERVAL = { M1: '1', M5: '5', M15: '15', M30: '30', H1: '60', H4: '240', D1: 'D', W1: 'W' };

function showTradingView() {
  const el = $('tv');
  el.innerHTML = '<div class="tradingview-widget-container"><div class="tradingview-widget-container__widget"></div></div>';
  let tz = 'Etc/UTC';
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone || tz;
  } catch { /* default */ }
  const s = document.createElement('script');
  s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';
  s.async = true;
  s.text = JSON.stringify({
    autosize: true,
    symbol: state.cfg.tvSymbol || 'OANDA:XAUUSD',
    interval: TV_INTERVAL[state.tf] || '15',
    timezone: tz === 'UTC' ? 'Etc/UTC' : tz,
    theme: 'dark',
    style: '1',
    locale: 'en',
    backgroundColor: '#05070d',
    gridColor: 'rgba(255, 255, 255, 0.04)',
    allow_symbol_change: true,
    save_image: true,
    calendar: false,
    support_host: 'https://www.tradingview.com',
  });
  s.onerror = () => {
    el.innerHTML = '<p class="banner tv-fail">Could not load the TradingView chart. Check your connection or ad blocker, or switch back to the Pulse chart.</p>';
  };
  el.firstChild.appendChild(s);
}

function setView(view) {
  state.view = view;
  store.set('view', view);
  $('tv').hidden = view !== 'tv';
  if (view === 'tv') showTradingView();
  else $('tv').innerHTML = '';
  renderToolbar();
}

$('views').addEventListener('click', (e) => {
  const v = e.target.closest('button')?.dataset.view;
  if (v && v !== state.view) setView(v);
});

$('layers').addEventListener('click', (e) => {
  const id = e.target.closest('button')?.dataset.layer;
  if (!id) return;
  state.layers[id] = !state.layers[id];
  store.set('layers', state.layers);
  renderToolbar();
  if (id === 'vwap') vwapSeries.setData(state.layers.vwap ? vwap(state.candles, vwapAnchor(TF[state.tf])) : []);
  if (id === 'walls') drawWalls();
  if (id === 'signals') drawMarkers();
  if (id === 'htf' && state.layers.htf && !state.htf) loadHTF(state.seq);
  pushOverlay();
});

// ---- Live price -----------------------------------------------------------------

let refreshTimer = null;
function onTick({ t, p }) {
  const prev = state.price;
  state.price = p;
  const el = $('price');
  el.textContent = fmt(p);
  if (prev != null && p !== prev) flash(el, p - prev);
  renderChange();
  const c = state.candles;
  const last = c[c.length - 1];
  if (last) {
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
      runAnalysis();
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        load({ soft: true });
        loadBot();
      }, 2000 + Math.random() * 2000);
    }
  }
  renderPositions();
}

function renderChange() {
  const ch = $('change');
  if (state.price == null || !state.dayOpen) return;
  const d = state.price - state.dayOpen;
  ch.textContent = `${signed(d)} (${signed((d / state.dayOpen) * 100)}%)`;
  ch.className = `chg ${d >= 0 ? 'up' : 'down'}`;
}

async function loadDayOpen() {
  try {
    const days = await feed.candles('D1', 5);
    state.dayOpen = days[days.length - 1]?.open ?? null;
    renderChange();
  } catch { /* header change stays blank */ }
}

function connect() {
  const dot = $('liveDot');
  feed.subscribe((d) => {
    if (d.error) {
      dot.className = 'live-dot err';
      dot.title = `Price feed error: ${d.error}`;
      return;
    }
    dot.className = 'live-dot on';
    dot.title = 'Live';
    onTick(d);
  }, () => {
    dot.className = 'live-dot err';
    dot.title = 'Reconnecting…';
  });
}

function renderSessions() {
  const list = sessionsNow();
  const gold = goldOpen();
  $('sessions').innerHTML = `<span class="sess ${gold ? 'open' : ''}">Gold ${gold ? 'open' : 'closed'}</span>`
    + list.map((s) => `<span class="sess ${s.open ? 'open' : ''} ${s.killzone ? 'kill' : ''}">${s.name}${s.killzone ? '<span class="kz">KILLZONE</span>' : ''}</span>`).join('');
}

// ---- Best setup -------------------------------------------------------------------

function candidates() {
  const b = state.bot;
  if (!b) return { list: [], tradable: false };
  const order = (a, z) => (a.status === 'pending' ? 0 : 1) - (z.status === 'pending' ? 0 : 1) || z.score - a.score || z.signalTime - a.signalTime;
  if (b.signals.length) return { list: b.signals.slice().sort(order), tradable: true };
  return { list: (b.watch || []).slice().sort(order), tradable: false };
}

function renderHero() {
  const b = state.bot;
  const el = $('hero');
  if (!b) return;
  const { list, tradable } = candidates();
  const best = list[0];
  const key = best ? `${sigId(best)}:${best.status}:${tradable}` : `none:${b.stats.some((s) => s.active)}:${JSON.stringify([b.areas, b.triggers])}:${b.recent.length}`;
  if (key === state.heroKey) return;
  state.heroKey = key;
  if (!best) {
    const nextClose = (Math.floor(nowSec() / 900) + 1) * 900;
    $('heroMeta').textContent = `next check ${clock(nextClose)}`;
    const waits = [
      ...(b.areas || []).map((a) => `<div class="wait ${a.dir}"><b>${a.dir === 'bull' ? 'BUY' : 'SELL'} AREA</b> ${fmt(a.bottom)}–${fmt(a.top)}<span>${esc(a.kind)} retest · SL ${fmt(a.stop)} · TP ${fmt(a.target)}</span></div>`),
      ...(b.triggers || []).map((g) => `<div class="wait ${g.dir}"><b>${g.dir === 'bull' ? 'BUY above' : 'SELL below'}</b> ${fmt(g.price)}<span>only on a high-volume breakout at the London/NY open</span></div>`),
    ].join('');
    const last = b.recent[b.recent.length - 1];
    el.innerHTML = `<div class="scan"><div class="radar"></div><h3>Waiting for price</h3>
      <p>${b.stats.some((s) => s.active) ? 'No signal right now. The strategies check every closed 15m candle and signal only at these levels:' : 'No strategy has proven an edge on the tested history yet, so nothing is signalled.'}</p></div>
      ${waits ? `<div class="waits">${waits}</div>` : ''}
      ${last ? `<div class="expect">Last signal: <b class="${last.dir}">${last.dir === 'bull' ? 'BUY' : 'SELL'}</b> ${esc(stratName(last.strategy))} at ${fmt(last.entry)}, ${ago(last.signalTime)}, closed <b class="${last.r > 0 ? 'bull' : 'bear'}">${signed(last.r)}R</b>.</div>` : ''}`;
    drawPlan(null);
    return;
  }
  const t = best;
  const long = t.dir === 'bull';
  const risk = Math.abs(t.entry - t.stop);
  const exp = t.expected;
  $('heroMeta').textContent = `found ${ago(t.signalTime + 900)}`;
  const tag = !tradable ? '<span class="tag watch">WATCH ONLY</span>' : t.status === 'pending' ? '<span class="tag new">NEW</span>' : '<span class="tag run">RUNNING</span>';
  el.innerHTML = `
    <div class="setup">
      ${ring(t.score)}
      <div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px"><span class="grade ${t.grade}" title="Confluence grade">${t.grade}</span>${tag}</div>
        <div class="dir ${t.dir}"><span class="arrow">${long ? '▲' : '▼'}</span>${long ? 'LONG' : 'SHORT'}</div>
        <div class="strat">${esc(stratName(t.strategy))}</div>
        <div class="why">${esc(t.why)}</div>
      </div>
    </div>
    <div class="levels">
      <div class="lv"><span>${t.status === 'open' ? 'Entered' : 'Entry ≈'}</span><b>${fmt(t.entry)}</b></div>
      <div class="lv sl"><span>Stop</span><b>${fmt(t.stop)}</b><i>−$${fmt(risk)}</i></div>
      <div class="lv tp"><span>Target</span><b>${fmt(t.target)}</b><i>+${fmt(Math.abs(t.target - t.entry) / risk, 1)}R</i></div>
    </div>
    ${exp && exp.trades ? `<div class="expect">In the backtest, grade <b>${t.grade}</b> setups won <b>${pct(exp.winRate)}</b> of <b>${exp.trades}</b> trades, averaging <b class="${exp.expR >= 0 ? 'bull' : 'bear'}">${signed(exp.expR)}R</b> each.${!tradable ? ' This strategy is not proven yet, so the auto-trader will not take it.' : ''}</div>` : ''}
    <ul class="factors">${t.factors.map((f, i) => `<li class="${f.ok ? 'ok' : 'no'}" style="--i:${i}"><span class="chk">${f.ok ? '✓' : '·'}</span>${esc(f.label)}<span class="w">+${f.weight}</span></li>`).join('')}</ul>
    ${list.length > 1 ? `<div class="others">${list.slice(1, 4).map((o) => `<div class="other"><span class="grade ${o.grade}" style="min-width:22px;height:22px;font-size:12px">${o.grade}</span><span class="${o.dir}">${o.dir === 'bull' ? '▲' : '▼'}</span>${esc(stratName(o.strategy))}<span class="muted" style="margin-left:auto">${o.score}</span></div>`).join('')}</div>` : ''}`;
  animateRings(el);
  drawPlan(t);
}

function checkNewSignals() {
  const b = state.bot;
  const ids = new Set(b.signals.map(sigId));
  const prev = state.seenSignals;
  state.seenSignals = ids;
  if (!prev) return;
  for (const t of b.signals) {
    if (prev.has(sigId(t)) || t.status !== 'pending') continue;
    toast(`<b>New ${t.grade} setup:</b> ${t.dir === 'bull' ? 'LONG' : 'SHORT'} · ${esc(stratName(t.strategy))} · entry ≈ ${fmt(t.entry)}`);
    beep();
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        new Notification(`Aurum Pulse · ${t.grade} ${t.dir === 'bull' ? 'LONG' : 'SHORT'}`, { body: `${stratName(t.strategy)} · entry ≈ ${fmt(t.entry)} · SL ${fmt(t.stop)} · TP ${fmt(t.target)}` });
      } catch { /* notifications need a service worker on some phones */ }
    }
  }
}

// ---- Accuracy ------------------------------------------------------------------------

function renderAccuracy() {
  const b = state.bot;
  if (!b) return;
  $('accMeta').textContent = `${b.days}-day backtest`;
  const mode = state.paper?.minGrade;
  $('grades').innerHTML = b.grades.map((g) => `
    <div class="grow ${g.grade === mode ? 'mode' : ''}" title="Grade ${g.grade}: confluence score ${g.min}+">
      <span class="grade ${g.grade}" style="min-width:26px;height:26px;font-size:13px">${g.grade}</span>
      <div class="track"><div class="fillbar ${g.expR < 0 ? 'neg' : ''}" data-w="${(g.winRate * 100).toFixed(1)}"></div></div>
      <div class="nums"><b>${g.trades ? pct(g.winRate) : '—'}</b> win · ${g.trades} trades · <span class="${g.expR >= 0 ? 'bull' : 'bear'}">${g.trades ? `${signed(g.expR)}R` : '—'}</span></div>
    </div>`).join('');
  requestAnimationFrame(() => requestAnimationFrame(() => $('grades').querySelectorAll('.fillbar').forEach((f) => { f.style.width = `${f.dataset.w}%`; })));
  $('strategies').innerHTML = b.stats.map((s) => `<div class="srow" title="${esc(s.desc)}"><span class="n">${esc(s.name)}</span><span class="v">${s.trades} tr</span><span class="v ${s.expR >= 0 ? 'bull' : 'bear'}">${signed(s.expR)}R</span><span class="st ${s.active ? 'on' : 'off'}">${s.active ? 'ACTIVE' : 'OFF'}</span></div>`).join('');
  $('recent').innerHTML = b.recent.slice().reverse().slice(0, 30).map((t) => `<li>
    <time>${new Date(t.signalTime * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>
    <span><span class="${t.dir}">${t.dir === 'bull' ? '▲' : '▼'}</span> ${esc(stratName(t.strategy))}</span>
    <span class="grade ${t.grade}" style="min-width:20px;height:20px;font-size:11px;border-radius:6px">${t.grade}</span>
    <span class="r ${t.r > 0 ? 'bull' : 'bear'}">${signed(t.r)}R</span></li>`).join('') || '<li class="empty">No closed setups yet</li>';
}

async function loadBot() {
  try {
    state.bot = await feed.bot();
  } catch (e) {
    $('hero').innerHTML = `<p class="bear small">Trade finder unavailable: ${esc(e.message)}</p>`;
    return;
  }
  renderHero();
  renderAccuracy();
  checkNewSignals();
  drawMarkers();
  pushOverlay();
}

// ---- Big players (COT) -------------------------------------------------------------

function renderCot() {
  const c = state.cot;
  const el = $('cot');
  if (!c) return;
  if (!c.available) {
    el.innerHTML = '<p class="muted small">The CFTC report could not be loaded. It will retry shortly.</p>';
    return;
  }
  const l = c.latest;
  $('cotMeta').textContent = `report ${new Date(l.date * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  const idx = l.specIndex;
  let insight;
  if (idx >= 85) insight = 'Funds are close to their most bullish positioning in three years. The long side is crowded, so sharp shakeouts get more likely.';
  else if (idx <= 15) insight = 'Funds are close to their most bearish positioning in three years. Historically that is a contrarian bullish setting.';
  else if (l.specChange > 0) insight = `Funds added ${compact(l.specChange)} net long contracts last week: big money is buying.`;
  else if (l.specChange < 0) insight = `Funds cut ${compact(-l.specChange)} net long contracts last week: big money is reducing exposure.`;
  else insight = 'Funds left their positioning unchanged last week.';
  const w = state.flow?.whales;
  const wt = w ? w.buyVol + w.sellVol : 0;
  el.innerHTML = `
    ${gauge(idx, { lo: '3-yr short', hi: '3-yr long' })}
    <div class="gauge-cap"><b id="cotIdx">0</b> <span class="muted small">COT index · hedge funds</span></div>
    <div class="stat-grid">
      <div class="stat"><span>Funds net long</span><b>${compact(l.specNet)}</b> <i class="${l.specChange >= 0 ? 'bull' : 'bear'}">${l.specChange >= 0 ? '▲' : '▼'} ${compact(Math.abs(l.specChange))}</i></div>
      <div class="stat"><span>Banks & producers net</span><b>${compact(l.commNet)}</b> <i class="${l.commChange >= 0 ? 'bull' : 'bear'}">${l.commChange >= 0 ? '▲' : '▼'} ${compact(Math.abs(l.commChange))}</i></div>
    </div>
    <div class="spark-wrap" title="Funds net position, 3 years">${spark(c.series.map((r) => r.specNet), { cls: 'gold' })}</div>
    <div class="insight">${insight}${wt ? ` Right now whales are <b class="${w.buyVol >= w.sellVol ? 'bull' : 'bear'}">${pct(Math.max(w.buyVol, w.sellVol) / wt)} ${w.buyVol >= w.sellVol ? 'buying' : 'selling'}</b> in large trades.` : ''}</div>`;
  requestAnimationFrame(() => requestAnimationFrame(() => el.querySelector('.needle')?.classList.add('set')));
  tween($('cotIdx'), idx, (v) => v.toFixed(0), 1400);
}

async function loadCot() {
  try {
    state.cot = await feed.cot();
    renderCot();
  } catch { /* retried on the next interval */ }
}

// ---- Order flow, liquidity, whales ----------------------------------------------------

let flowKey = null;
function renderFlow() {
  const f = state.flow;
  const el = $('flow');
  if (!f) return;
  if (!f.available) {
    el.innerHTML = '<p class="muted small">Order flow is off (FLOW_PROVIDER=none).</p>';
    return;
  }
  $('flowMeta').textContent = f.source;
  const rows = f.delta.slice(-48);
  const last = rows[rows.length - 1];
  const cvdTrend = rows.length > 8 ? rows[rows.length - 1].cvd - rows[rows.length - 9].cvd : 0;
  const key = `${last?.time}:${last?.delta}`;
  if (!el.querySelector('.split')) {
    el.innerHTML = `
      <div class="split"><div class="labels"><span class="bull">Buyers <b id="buyPct"></b></span><span class="muted small" id="tapeSpan"></span><span class="bear">Sellers <b id="sellPct"></b></span></div>
        <div class="bar2"><div class="b" id="buyBar" style="width:50%"></div><div class="s"></div></div></div>
      <div id="deltaChart"></div>
      <div class="legend"><span><i style="background:var(--bull)"></i>Delta per ${TF[state.tf].label} candle</span><span><i style="background:var(--gold)"></i>Cumulative delta</span></div>
      <div class="stat-grid" id="flowStats"></div>`;
  }
  const bp = f.tape.buyPct;
  tween($('buyPct'), bp * 100, (v) => `${v.toFixed(0)}%`);
  tween($('sellPct'), (1 - bp) * 100, (v) => `${v.toFixed(0)}%`);
  $('buyBar').style.width = `${(bp * 100).toFixed(1)}%`;
  $('tapeSpan').textContent = f.tape.from ? `last ${Math.max(1, Math.round((f.tape.to - f.tape.from) / 60))} min` : '';
  if (key !== flowKey) {
    flowKey = key;
    $('deltaChart').innerHTML = deltaChart(rows);
  }
  $('flowStats').innerHTML = last ? `
    <div class="stat"><span>Last candle delta</span><b class="${last.delta >= 0 ? 'bull' : 'bear'}">${signed(last.delta, 1)}</b> <i class="muted">${pct(last.buyPct)} buy</i></div>
    <div class="stat"><span>CVD, last 8 candles</span><b class="${cvdTrend >= 0 ? 'bull' : 'bear'}">${cvdTrend >= 0 ? 'Rising ▲' : 'Falling ▼'}</b></div>` : '';
}

function renderLiq() {
  const el = $('liq');
  const book = state.flow?.book;
  const r = state.result;
  const price = state.price ?? state.candles[state.candles.length - 1]?.close;
  let html = '';
  if (book) {
    $('liqMeta').textContent = `book ±1% · $1 levels`;
    const asks = book.asks.slice(0, 7).reverse();
    const bids = book.bids.slice(0, 7);
    const max = Math.max(...[...asks, ...bids].map((l) => l.size), 1);
    const walls = new Set([...book.bidWalls, ...book.askWalls].map((w) => w.price));
    const rung = (l, side) => `<div class="rung ${side} ${walls.has(l.price) ? 'wall' : ''}"><div class="fill" style="width:${((l.size / max) * 100).toFixed(1)}%"></div><span class="p">${fmt(l.price, 0)}</span><span class="q">${compact(l.size)}</span></div>`;
    html += `<div class="split"><div class="labels"><span class="bull">Bids ${pct(book.imbalance)}</span><span class="muted small">resting orders near price</span><span class="bear">Asks ${pct(1 - book.imbalance)}</span></div>
      <div class="bar2"><div class="b" style="width:${(book.imbalance * 100).toFixed(1)}%"></div><div class="s"></div></div></div>
      <div class="ladder">${asks.map((l) => rung(l, 'ask')).join('')}<div class="mid">${fmt(book.mid)} · spread ${fmt(book.spread)}</div>${bids.map((l) => rung(l, 'bid')).join('')}</div>`;
  }
  if (r && price) {
    const items = [];
    const above = r.pools.filter((p) => p.kind === 'EQH' && p.price > price).sort((a, b) => a.price - b.price)[0];
    const below = r.pools.filter((p) => p.kind === 'EQL' && p.price < price).sort((a, b) => b.price - a.price)[0];
    if (above) items.push(['Buy stops above (EQH)', above.price]);
    if (below) items.push(['Sell stops below (EQL)', below.price]);
    if (r.prevDay) items.push(['Previous day high', r.prevDay.high], ['Previous day low', r.prevDay.low]);
    const sw = r.sweeps[r.sweeps.length - 1];
    html += `<div class="sub-head" style="margin-top:4px">Stop-loss liquidity</div><ul class="pools">${items.map(([k, p]) => `<li><span class="k">${k}</span><span class="mono">${fmt(p)} <span class="${p > price ? 'bull' : 'bear'}">${signed(p - price)}</span></span></li>`).join('')}
      ${sw ? `<li><span class="k">Last liquidity grab</span><span class="mono">${sw.kind} ${fmt(sw.price)}</span></li>` : ''}</ul>`;
  }
  el.innerHTML = html || '<p class="muted small">Loading…</p>';
}

function renderWhales() {
  const w = state.flow?.whales;
  if (!w) return;
  $('whaleMeta').textContent = `≥ ${compact(w.threshold)} oz`;
  const total = w.buyVol + w.sellVol;
  $('whaleSummary').innerHTML = total ? `<div class="split"><div class="labels"><span class="bull">Whale buys ${pct(w.buyVol / total)}</span><span class="bear">Whale sells ${pct(w.sellVol / total)}</span></div>
    <div class="bar2"><div class="b" style="width:${((w.buyVol / total) * 100).toFixed(1)}%"></div><div class="s"></div></div></div>` : '';
  const maxSize = Math.max(...w.list.map((t) => t.size), 1);
  const first = state.seenWhales.size === 0;
  $('whales').innerHTML = w.list.map((t) => {
    const k = `${t.time}:${t.price}:${t.size}`;
    const fresh = !first && !state.seenWhales.has(k);
    state.seenWhales.add(k);
    const d = 10 + (t.size / maxSize) * 24;
    return `<li class="whale ${t.side} ${fresh ? 'fresh' : ''}"><span class="bubble"><i style="width:${d.toFixed(0)}px;height:${d.toFixed(0)}px"></i></span>
      <span class="sd">${t.side.toUpperCase()}</span><span><span class="sz">${compact(t.size)} oz</span> <span class="px">@ ${fmt(t.price)} · $${compact(t.notional)}</span></span><time>${clock(t.time)}</time></li>`;
  }).join('') || '<li class="empty">No large trades in the recent tape</li>';
  if (state.seenWhales.size > 2000) state.seenWhales = new Set([...state.seenWhales].slice(-500));
}

async function loadFlow() {
  try {
    state.flow = await feed.flow(state.tf);
  } catch {
    return;
  }
  renderFlow();
  renderLiq();
  renderWhales();
  drawWalls();
}

// ---- Auto-trader -----------------------------------------------------------------------

const form = $('botForm');

function fillForm(p) {
  if (state.formDirty) return;
  for (const k of ['startBalance', 'riskPct', 'minGrade', 'maxOpen', 'dailyLossPct']) {
    if (document.activeElement !== form.elements[k]) form.elements[k].value = p[k];
  }
  $('riskOut').textContent = `${form.elements.riskPct.value}%`;
}

function renderPaper() {
  const p = state.paper;
  if (!p) return;
  fillForm(p);
  const st = $('botState');
  st.textContent = p.enabled ? 'RUNNING' : 'STOPPED';
  st.className = `state ${p.enabled ? 'on' : ''}`;
  const btn = $('botToggle');
  btn.textContent = p.enabled ? 'Stop auto-trading' : 'Start auto-trading';
  btn.classList.toggle('running', p.enabled);
  $('botNote').textContent = `${p.live ? 'LIVE broker' : 'Paper mode'}: ${p.live ? 'real orders.' : 'simulated fills, no real money.'} ${p.trades} closed trades, ${pct(p.winRate)} won. Live broker execution plugs into the same engine later.`;
  const eq = p.equity.map((e) => e.v);
  const sk = `${eq.length}:${eq[eq.length - 1]}`;
  if (sk !== state.sparkKey) {
    state.sparkKey = sk;
    $('equitySpark').innerHTML = spark(eq.length > 1 ? eq : [p.startBalance, p.startBalance]);
  }
  renderPositions();
  const log = $('botLog');
  log.innerHTML = p.log.slice(0, 6).map((l) => `<li><time>${clock(l.t)}</time><span>${esc(l.msg)}</span></li>`).join('') || '<li class="empty">Nothing yet</li>';
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
  const price = state.price;
  let unreal = 0;
  $('positions').innerHTML = p.positions.map((x) => {
    const pl = Number.isFinite(price) ? (x.dir === 'bull' ? 1 : -1) * (price - x.entry) * x.units : 0;
    unreal += pl;
    return `<li class="pos"><span class="side ${x.dir}">${x.dir === 'bull' ? '▲ LONG' : '▼ SHORT'}</span><span>${esc(stratName(x.strategy))} <span class="grade ${x.grade}" style="min-width:18px;height:18px;font-size:10px;border-radius:5px">${x.grade}</span></span>
      <span class="pl ${pl >= 0 ? 'bull' : 'bear'}">${money(pl)}</span>
      <span class="det">${x.units.toFixed(2)} oz (${x.lots.toFixed(2)} lots) @ ${fmt(x.entry)} · SL ${fmt(x.stop)} · TP ${fmt(x.target)}</span></li>`;
  }).join('') || '<li class="empty">No open trades</li>';
  const equity = p.balance + unreal;
  tween($('equity'), equity, (v) => money(v));
  const pnl = equity - p.startBalance;
  const pnlEl = $('pnl');
  pnlEl.textContent = `${pnl >= 0 ? '+' : '−'}$${fmt(Math.abs(pnl))}`;
  pnlEl.className = `pnl ${pnl >= 0 ? 'bull' : 'bear'}`;
  $('pnlPct').textContent = `${signed((equity / p.startBalance - 1) * 100)}% since start`;
}

async function loadPaper() {
  try {
    state.paper = await feed.paper();
    renderPaper();
    renderAccuracy();
  } catch { /* retried */ }
}

function formConfig() {
  const v = (k) => form.elements[k].value;
  return { startBalance: +v('startBalance'), riskPct: +v('riskPct'), minGrade: v('minGrade'), maxOpen: +v('maxOpen'), dailyLossPct: +v('dailyLossPct') };
}

async function paperAction(body, btn) {
  if (btn) btn.disabled = true;
  try {
    state.paper = await feed.paperAction(body, state.token);
    state.formDirty = false;
    renderPaper();
    renderAccuracy();
  } catch (e) {
    if (e.status === 401) {
      const tok = window.prompt('This auto-trader is protected. Enter the ADMIN_TOKEN set on the server:');
      if (tok) {
        state.token = tok;
        store.set('token', tok);
        return paperAction(body, btn);
      }
    }
    toast(`<b>Auto-trader:</b> ${esc(e.message)}`);
  } finally {
    if (btn) btn.disabled = false;
  }
  return undefined;
}

form.addEventListener('input', (e) => {
  state.formDirty = true;
  if (e.target.name === 'riskPct') $('riskOut').textContent = `${e.target.value}%`;
});
form.addEventListener('change', () => {
  if (state.paper && !state.paper.enabled) return; // applied on Start
  paperAction({ config: formConfig() });
});
$('botToggle').addEventListener('click', (e) => {
  const on = state.paper?.enabled;
  if (!on && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  paperAction(on ? { action: 'stop' } : { config: formConfig(), action: 'start' }, e.currentTarget);
});
$('botReset').addEventListener('click', (e) => {
  if (!window.confirm('Reset the paper account? Its history will be cleared.')) return;
  paperAction({ action: 'reset', amount: +form.elements.startBalance.value }, e.currentTarget);
});
$('botClose').addEventListener('click', (e) => {
  if (!window.confirm('Stop the auto-trader and close every open trade at the current price?')) return;
  paperAction({ action: 'stop', closeAll: true }, e.currentTarget);
});

// ---- Alerts --------------------------------------------------------------------------

function toast(html) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.innerHTML = html;
  $('toasts').prepend(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 400);
  }, 6000);
  while ($('toasts').children.length > 4) $('toasts').lastChild.remove();
}

function beep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(660, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(990, ctx.currentTime + 0.15);
    g.gain.setValueAtTime(0.07, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    o.connect(g).connect(ctx.destination);
    o.start();
    o.stop(ctx.currentTime + 0.45);
    o.onended = () => ctx.close();
  } catch { /* browsers block audio until the user interacts */ }
}

function showBanner(msg) {
  const b = $('banner');
  b.textContent = msg;
  b.hidden = false;
}
function hideBanner() {
  $('banner').hidden = true;
}

// ---- Boot -------------------------------------------------------------------------------

async function boot() {
  renderToolbar();
  renderSessions();
  setInterval(renderSessions, 30000);
  try {
    const cfg = await feed.config();
    state.cfg = cfg;
    const src = $('srcPrice');
    src.textContent = cfg.demo ? 'DEMO PRICES' : `Prices · ${cfg.label}`;
    src.title = cfg.note;
    if (cfg.demo) src.classList.add('demo');
    $('srcFlow').textContent = cfg.flow ? `Order flow · ${cfg.flow}` : 'Order flow off';
    if (state.view === 'tv') setView('tv');
  } catch (e) {
    showBanner(`Server not reachable: ${e.message}`);
  }
  load();
  loadDayOpen();
  loadBot();
  loadFlow();
  loadCot();
  loadPaper();
  connect();
  setInterval(loadDayOpen, 5 * 60000);
  setInterval(() => load({ soft: true }), 60000);
  setInterval(loadBot, 60000);
  setInterval(loadFlow, 5000);
  setInterval(loadCot, 30 * 60000);
  setInterval(loadPaper, 3000);
  setInterval(() => {
    if (state.bot) {
      const m = $('heroMeta'); // refresh "found x min ago" without re-animating the card
      const best = candidates().list[0];
      if (best) m.textContent = `found ${ago(best.signalTime + 900)}`;
    }
  }, 60000);
}

boot();
