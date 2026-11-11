import { TF, bucketStart } from '/shared/timeframes.js';
import { analyze, vwap, vwapAnchor } from '/shared/analysis.js';
import { STRATEGY_BY_ID } from '/shared/strategies.js';
import { Overlay } from '/overlay.js';
import { sessionsNow } from '/sessions.js';
import { feed } from '/feed.js';
import { binance, goldPerp } from '/live.js';
import { deltaSeries, tradeFlow, whales as findWhales, bookStats } from '/shared/flow.js';
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
      const v = localStorage.getItem(`scalper4:${k}`);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(`scalper4:${k}`, JSON.stringify(v));
    } catch { /* storage unavailable */ }
  },
};

const LAYERS = [
  { id: 'signals', label: 'Setups & areas' },
  { id: 'levels', label: 'Key levels' },
  { id: 'surges', label: 'Volume surges' },
  { id: 'structure', label: 'Structure' },
  { id: 'zones', label: 'Zones' },
  { id: 'liq', label: 'Liquidity' },
  { id: 'walls', label: 'Book walls' },
  { id: 'vwap', label: 'VWAP' },
];
const DEFAULT_LAYERS = { signals: true, levels: true, surges: true, structure: false, zones: false, ob: false, liq: false, walls: true, vwap: true, htf: false, sr: false, profile: false };
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
  basis: {}, // market -> spot minus the traded market (gold: spot XAU minus PAXG)
  live: { stop: null, trades: [], book: null, deep: null, shift: 0, market: null, tf: null },
};
const mk = () => state.cfg.markets.find((m) => m.id === state.market) || { id: state.market, label: state.market, unit: '' };
const mkOf = (id) => state.cfg.markets.find((m) => m.id === id) || {};
// Gold is shown at spot prices while its candles, book and signals come from
// PAXG: everything from PAXG is shifted by the live spot-minus-PAXG gap.
const basisOf = (m = state.market) => (mkOf(m).spot ? state.basis[m] || 0 : 0);
const SHIFT_FIELDS = ['entry', 'stop', 'target', 'level', 'exit', 'top', 'bottom', 'price', 'open', 'high', 'low', 'close'];
function sh(o, k) {
  if (!k || !o) return o;
  const r = { ...o };
  for (const f of SHIFT_FIELDS) if (typeof r[f] === 'number') r[f] += k;
  return r;
}

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
  timeScale: { borderColor: 'rgba(255,255,255,0.16)', timeVisible: true, secondsVisible: false, rightOffset: 22 },
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
    const m = mk();
    if (m.spot && state.basis[market] == null) {
      try {
        const b = await feed.bot(market);
        if (b.basis) state.basis[market] = b.basis;
      } catch { /* shown unshifted until the stream sends it */ }
    }
    let raw = null;
    if (m.binance) {
      try {
        raw = await binance.candles(m.binance, tf, 600);
      } catch { /* fall back to the server */ }
    }
    // Gold: a real-time chart feed (gold perpetual, or spot-built candles).
    const goldReq = m.goldChart ? feed.gold(tf, 600).catch(() => null) : null;
    if (!raw) raw = await feed.candles(market, tf, 600);
    let gold = goldReq ? await goldReq : null;
    if (m.goldChart && !(gold && /perpetual/.test(gold.source)) && state.perpOk !== false) {
      try {
        const f = await goldPerp(tf, 600);
        const sp = state.prices[market];
        const shift = sp != null ? sp - f[f.length - 1].close : 0;
        gold = { source: 'Binance XAUUSDT perpetual', candles: f.map((c) => ({ ...c, open: c.open + shift, high: c.high + shift, low: c.low + shift, close: c.close + shift })) };
        state.perpOk = true;
      } catch {
        state.perpOk = false; // blocked here: stop asking
      }
    }
    if (seq !== state.seq) return;
    const k = basisOf(market);
    let candles = raw.map((c) => sh(c, k));
    state.live.perp = false;
    state.live.chartSource = null;
    if (gold && gold.candles.length > 30 && /perpetual/.test(gold.source)) {
      candles = gold.candles;
      state.live.perp = true;
      state.live.chartSource = gold.source;
    } else if (gold && gold.candles.length) {
      const byTime = new Map(gold.candles.map((c) => [c.time, c]));
      candles = candles.map((c) => {
        const g = byTime.get(c.time);
        return g ? { ...c, open: g.open, high: g.high, low: g.low, close: g.close } : c;
      });
      state.live.chartSource = gold.source;
    }
    // The open candle follows the spot price, not the thinner PAXG market.
    const sp = m.spot ? state.prices[market] : null;
    const last = candles[candles.length - 1];
    if (sp && last) {
      last.close = sp;
      last.high = Math.max(last.high, sp);
      last.low = Math.min(last.low, sp);
    }
    state.live.shift = k;
    const range = soft ? chart.timeScale().getVisibleLogicalRange() : null;
    state.candles = candles;
    state.surges = findSurges(candles);
    candleSeries.setData(candles.map(bar));
    volumeSeries.setData(volBars(candles, state.layers.surges ? state.surges : []));
    if (range) chart.timeScale().setVisibleLogicalRange(range);
    else chart.timeScale().setVisibleLogicalRange({ from: candles.length - 90, to: candles.length + 22 });
    runAnalysis();
    drawMarkers();
    $('banner').hidden = true;
    if (state.live.market !== market || state.live.tf !== tf) startLive();
  } catch (e) {
    if (seq === state.seq) {
      $('banner').textContent = `Could not load ${mk().label} ${TF[tf].label} candles: ${e.message}`;
      $('banner').hidden = false;
    }
  } finally {
    if (seq === state.seq) $('loading').hidden = true;
  }
}

// ---- Live data straight from the exchange ----------------------------------------

let flowDirty = false;
let bookDirty = false;

function startLive() {
  state.live.stop?.();
  state.live.stop = null;
  const { market, tf } = state;
  const m = mk();
  state.live = { ...state.live, market, tf, trades: [], book: null, deep: null };
  if (!m.binance) {
    state.streamOn = false;
    renderPills();
    loadFlow();
    return;
  }
  const mine = () => state.live.market === market && state.live.tf === tf;
  binance.trades(m.binance).then((ts) => {
    if (!mine()) return;
    state.live.trades = ts.concat(state.live.trades);
    flowDirty = true;
    refreshFlow(true);
  }).catch(() => {});
  loadDeepBook();
  state.live.stop = binance.connect(m.binance, tf, {
    state: (on) => {
      state.streamOn = on;
      renderPills();
    },
    candle: (k) => mine() && onKline(k),
    trade: (t) => mine() && onLiveTrade(market, t),
    book: (b) => {
      if (!mine()) return;
      state.live.book = b;
      bookDirty = true;
    },
  });
}

// The top 20 levels stream 10 times a second; deeper levels (for walls) are
// refreshed from a snapshot every few seconds.
async function loadDeepBook() {
  const m = mk();
  if (!m.binance) return;
  try {
    const b = await binance.book(m.binance, 500);
    if (state.live.market === state.market) {
      state.live.deep = b;
      bookDirty = true;
    }
  } catch { /* the streamed top of book still shows */ }
}

function mergedBook() {
  const live = state.live.book;
  const deep = state.live.deep;
  if (!live && !deep) return null;
  if (!live) return deep;
  if (!deep) return live;
  const minBid = live.bids[live.bids.length - 1]?.price ?? Infinity;
  const maxAsk = live.asks[live.asks.length - 1]?.price ?? -Infinity;
  return {
    bids: live.bids.concat(deep.bids.filter((l) => l.price < minBid)),
    asks: live.asks.concat(deep.asks.filter((l) => l.price > maxAsk)),
  };
}

function volBar(c) {
  const up = c.buyVolume != null ? c.buyVolume * 2 >= c.volume : c.close >= c.open;
  return { time: c.time, value: c.volume || 0, color: up ? 'rgba(52,245,197,0.28)' : 'rgba(255,95,162,0.28)' };
}

// The open candle from the exchange: volume and buyer volume always; prices
// too, except for spot-priced markets whose candle follows the spot ticks.
function onKline(k) {
  const c = state.candles;
  const last = c[c.length - 1];
  if (!last) return;
  const spot = mk().spot && state.prices[state.market] != null;
  const s = sh(k, state.live.shift);
  let cur;
  if (s.time === last.time) {
    cur = last;
    if (!spot) Object.assign(cur, { open: s.open, high: s.high, low: s.low, close: s.close });
  } else if (s.time > last.time) {
    const p = spot ? state.prices[state.market] : s.close;
    cur = spot ? { time: s.time, open: p, high: p, low: p, close: p } : { time: s.time, open: s.open, high: s.high, low: s.low, close: s.close };
    c.push(cur);
    if (c.length > 900) c.splice(0, c.length - 800);
    newCandle();
  } else return;
  if (!state.live.perp) {
    cur.volume = s.volume;
    cur.buyVolume = s.buyVolume;
  }
  candleSeries.update(bar(cur));
  volumeSeries.update(volBar(cur));
  flowDirty = true;
}

// The gold perpetual's volume for the latest candles (prices follow spot ticks).
async function refreshPerpVolume() {
  if (!state.live.perp || state.view === 'tv') return;
  const { market, tf } = state;
  try {
    const g = state.perpOk ? { candles: await goldPerp(tf, 3) } : await feed.gold(tf, 3);
    if (state.market !== market || state.tf !== tf) return;
    const byTime = new Map(state.candles.slice(-5).map((c) => [c.time, c]));
    for (const x of g.candles) {
      const c = byTime.get(x.time);
      if (!c) continue;
      c.volume = x.volume;
      c.buyVolume = x.buyVolume;
      volumeSeries.update(volBar(c));
    }
  } catch { /* next pass */ }
}

let refreshTimer = null;
// A candle closed: re-read structure and zones, and fetch new setups shortly after.
function newCandle() {
  state.surges = findSurges(state.candles);
  runAnalysis();
  drawMarkers();
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(loadBots, 2500);
}

function onLiveTrade(market, t) {
  if (!mkOf(market).spot) queuePrice(market, t.price, t.time);
  const tr = state.live.trades;
  tr.push(t);
  if (tr.length > 3000) tr.splice(0, tr.length - 2000);
  state.tape.push(t);
  tapeDirty = true;
  const min = state.whaleMin[market];
  if (min && t.size >= min) addWhale({ ...t, price: t.price + state.live.shift, notional: t.size * t.price }, true);
}

// Order flow, whales and book from the live data, in the shape the panels use.
function refreshFlow(force = false) {
  if (!mk().binance || (!flowDirty && !bookDirty && !force)) return;
  const k = state.live.shift;
  const tr = state.live.trades.slice(-1000).map((t) => ({ ...t, price: t.price + k }));
  const b = mergedBook();
  state.flow = {
    available: true,
    live: state.streamOn,
    source: `${mk().binance} · live`,
    basis: k,
    delta: deltaSeries(state.candles.slice(-120)),
    tape: tradeFlow(tr),
    whales: findWhales(tr),
    book: b ? bookStats({ bids: b.bids.map((l) => sh(l, k)), asks: b.asks.map((l) => sh(l, k)) }, { bucket: state.market === 'btc' ? 10 : 0.5, range: 0.004 }) : state.flow?.book || null,
  };
  if (flowDirty || force) {
    renderFlow();
    renderWhales();
  }
  renderLiq();
  flowDirty = false;
  bookDirty = false;
}

function runAnalysis() {
  const tf = TF[state.tf];
  state.result = analyze(closedCandles(), { tf });
  vwapSeries.setData(state.layers.vwap ? vwap(state.candles, vwapAnchor(tf)) : []);
  pushOverlay();
  renderBias();
  renderLiq();
  drawLevels();
}

const play = () => state.bots[state.market]?.tfs?.[state.tf];

// BUY / SELL labels on the chart at every signal candle of this timeframe.
function drawMarkers() {
  const b = play();
  if (!b || b.pending || !state.layers.signals || !state.candles.length) {
    candleSeries.setMarkers([]);
    return;
  }
  const first = state.candles[0].time;
  const list = [...b.recent, ...b.signals, ...b.watch].filter((t) => t.signalTime >= first);
  const seen = new Set();
  candleSeries.setMarkers(list.filter((t) => !seen.has(t.signalTime) && seen.add(t.signalTime)).sort((x, y) => x.signalTime - y.signalTime).map((t) => {
    const long = t.dir === 'bull';
    const res = t.status === 'closed' ? (t.r > 0 ? ' ✓' : ' ✗') : '';
    return { time: t.signalTime, position: long ? 'belowBar' : 'aboveBar', color: long ? UP : DN, shape: long ? 'arrowUp' : 'arrowDown', text: `${long ? 'BUY' : 'SELL'}${res}`, size: 1.4 };
  }));
}

// Buy and sell zones are always on the chart: the strategies' own areas, and
// otherwise the strongest fresh demand below and supply above price.
function withZones(areas) {
  const r = state.result;
  const c = state.candles;
  if (!r || !c.length) return areas;
  const price = c[c.length - 1].close;
  const out = [...areas];
  for (const dir of ['bull', 'bear']) {
    if (out.some((a) => a.dir === dir)) continue;
    const bull = dir === 'bull';
    const z = [...r.zones, ...r.orderBlocks]
      .filter((x) => x.side === dir && !x.broken && (bull ? x.top < price : x.bottom > price))
      .sort((x, y) => Math.abs((x.top + x.bottom) / 2 - price) - Math.abs((y.top + y.bottom) / 2 - price))[0];
    if (z) out.push({ dir, top: z.top, bottom: z.bottom, time: z.time, watch: true, kind: /OB/.test(z.kind) ? 'order block' : bull ? 'demand' : 'supply' });
  }
  return out;
}

function pushOverlay() {
  const b = play();
  const k = basisOf();
  const first = state.candles[0]?.time ?? 0;
  const trade = b && !b.pending ? {
    areas: withZones(b.areas.map((a) => sh(a, k))),
    triggers: b.triggers.map((g) => sh(g, k)),
    live: [...b.signals, ...b.watch].map((t) => sh(t, k)),
    history: b.recent.filter((t) => t.entryTime >= first).slice(-25).map((t) => sh(t, k)),
    surges: state.layers.surges ? (state.surges || []).slice(-3) : [],
  } : { areas: withZones([]), surges: state.layers.surges ? (state.surges || []).slice(-3) : [] };
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

// Exact key levels on the price axis: previous day high/low, today's high/low,
// and the nearest resting liquidity above and below.
let levelLines = [];
function drawLevels() {
  levelLines.forEach((l) => candleSeries.removePriceLine(l));
  levelLines = [];
  const r = state.result;
  const c = state.candles;
  if (!state.layers.levels || !r || !c.length) return;
  const price = c[c.length - 1].close;
  const day = Math.floor(c[c.length - 1].time / 86400) * 86400;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = c.length - 1; i >= 0 && c[i].time >= day; i--) {
    hi = Math.max(hi, c[i].high);
    lo = Math.min(lo, c[i].low);
  }
  const lines = [];
  if (r.prevDay) lines.push([r.prevDay.high, 'PDH', '#ffd27a'], [r.prevDay.low, 'PDL', '#ffd27a']);
  if (Number.isFinite(hi)) lines.push([hi, 'Day high', '#c4b5fd'], [lo, 'Day low', '#c4b5fd']);
  const above = r.pools.filter((p) => p.kind === 'EQH' && p.price > price).sort((a, b) => a.price - b.price)[0];
  const below = r.pools.filter((p) => p.kind === 'EQL' && p.price < price).sort((a, b) => b.price - a.price)[0];
  if (above) lines.push([above.price, 'Buy stops', '#7af0c6']);
  if (below) lines.push([below.price, 'Sell stops', '#ff9dc4']);
  const used = [];
  for (const [p, title, color] of lines) {
    if (used.some((u) => Math.abs(u - p) < r.atr * 0.15)) continue; // no stacked labels
    used.push(p);
    levelLines.push(candleSeries.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: LC.LineStyle.Dashed, axisLabelVisible: true, title }));
  }
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
    state.cfg.demo ? '<span class="pill demo">DEMO DATA</span>' : `<span class="pill on" title="Price shown in the header and on the chart">${esc(m.spotSource || m.binance || m.source || '')}</span>`,
    `<span class="pill ${state.streamOn ? 'on' : ''}" title="Candles, trades and order book">${state.streamOn ? '● Live stream' : m.binance ? 'Connecting…' : 'Refreshing every 4 s'}</span>`,
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
  state.live.stop?.();
  state.live = { ...state.live, stop: null, market: null, tf: null, trades: [], book: null, deep: null };
  renderHeader();
  renderPills();
  renderChange();
  load();
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
  if (id === 'signals') drawMarkers();
  if (id === 'levels') drawLevels();
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
    const fresh = { time: b, open: p, high: p, low: p, close: p, volume: 0, buyVolume: 0 };
    c.push(fresh);
    candleSeries.update(bar(fresh));
    newCandle();
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
      const days = m.binance ? await binance.candles(m.binance, 'D1', 2) : await feed.candles(m.id, 'D1', 3);
      const o = days[days.length - 1]?.open;
      state.dayOpen[m.id] = o != null ? o + basisOf(m.id) : null;
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
  const k = basisOf();
  const waits = Object.entries(b.tfs).flatMap(([tf, t]) => (t.pending ? [] : [
    ...t.areas.map((a) => sh(a, k)).map((a) => `<div class="wait ${a.dir}">${TF[tf].label} · ${a.dir === 'bull' ? 'BUY' : 'SELL'} AREA ${fmt(a.bottom)}–${fmt(a.top)}<span>${esc(a.kind)} retest · SL ${fmt(a.stop)} · TP ${fmt(a.target)}</span></div>`),
    ...t.triggers.map((g) => sh(g, k)).map((g) => `<div class="wait ${g.dir}">${TF[tf].label} · ${g.dir === 'bull' ? 'BUY above' : 'SELL below'} ${fmt(g.price)}<span>on a high-volume breakout at the London/NY open</span></div>`),
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
  const t = sh(best, k);
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

// The guide in the corner of the chart: what to do right now.
// The guide card can be dragged anywhere on the chart; the spot is remembered.
function setGuide(el, html, cls) {
  const full = html ? `<div class="grip" title="Drag to move">⠿ drag</div>${html}` : '';
  if (el.className.replace(' dragging', '') !== cls) el.className = cls;
  if (full !== el._html) {
    el._html = full;
    el.innerHTML = full;
  }
}

function initGuideDrag() {
  const el = $('guide');
  const wrap = el.parentElement;
  const place = (p) => {
    if (!p) return;
    const maxX = Math.max(0, wrap.clientWidth - el.offsetWidth - 4);
    const maxY = Math.max(0, wrap.clientHeight - el.offsetHeight - 30);
    el.style.left = `${Math.max(4, Math.min(maxX, p.x))}px`;
    el.style.top = `${Math.max(4, Math.min(maxY, p.y))}px`;
  };
  place(store.get('guidePos', null));
  let start = null;
  el.addEventListener('pointerdown', (e) => {
    start = { x: e.clientX, y: e.clientY, l: el.offsetLeft, t: el.offsetTop };
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
  });
  el.addEventListener('pointermove', (e) => {
    if (!start) return;
    place({ x: start.l + e.clientX - start.x, y: start.t + e.clientY - start.y });
  });
  const end = () => {
    if (!start) return;
    start = null;
    el.classList.remove('dragging');
    store.set('guidePos', { x: el.offsetLeft, y: el.offsetTop });
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

function renderGuide() {
  const el = $('guide');
  const b = state.bots[state.market];
  if (!b || state.view === 'tv') {
    setGuide(el, '', 'guide');
    return;
  }
  const k = basisOf();
  const price = state.prices[state.market] ?? state.candles[state.candles.length - 1]?.close;
  const plays = Object.entries(b.tfs).filter(([, t]) => !t.pending);
  const active = plays.flatMap(([, t]) => t.signals).sort((x, y) => y.signalTime - x.signalTime)[0];
  if (active && Number.isFinite(price)) {
    const t = sh(active, k);
    // Zoom the chart onto a new trade so its box is large and readable.
    const fk = `${state.market}:${state.tf}:${sigId(active)}`;
    if (fk !== state.focusKey && active.tf === state.tf && state.candles.length > 80) {
      state.focusKey = fk;
      const n = state.candles.length;
      chart.timeScale().setVisibleLogicalRange({ from: n - 70, to: n + 22 });
    }
    const bull = t.dir === 'bull';
    const sign = bull ? 1 : -1;
    const risk = Math.abs(t.entry - t.stop);
    const r = (sign * (price - t.entry)) / risk;
    const steps = Math.max(1, Math.round(Math.abs(t.target - t.entry) / risk));
    const span = Math.abs(t.target - t.stop);
    const pos = Math.max(0, Math.min(1, (sign * (price - t.stop)) / span));
    const away = (p) => `${signed(p - price)}`;
    setGuide(el, `<div class="gh"><span class="${t.dir}">${bull ? '▲ LONG' : '▼ SHORT'} ${esc(mk().label)}</span><span class="gs">${TF[t.tf].label} · ${t.status === 'open' ? 'IN TRADE' : 'ENTER NOW'}</span></div>
      <div class="muted">${esc(stratName(t.strategy))}</div>
      <div class="gr"><span>TARGET</span><b class="bull">${fmt(t.target)}</b><i>${away(t.target)}</i></div>
      ${Array.from({ length: steps - 1 }, (_, n) => `<div class="gr"><span>TP${n + 1}</span><b class="bull">${fmt(t.entry + sign * (n + 1) * risk)}</b><i>${away(t.entry + sign * (n + 1) * risk)}</i></div>`).join('')}
      <div class="gr"><span>ENTRY</span><b>${fmt(t.entry)}</b><i>${away(t.entry)}</i></div>
      <div class="gr"><span>STOP</span><b class="bear">${fmt(t.stop)}</b><i>${away(t.stop)}</i></div>
      <div class="prog" style="--e:${((1 / (steps + 1)) * 100).toFixed(1)}%"><b style="left:${(pos * 100).toFixed(1)}%"></b></div>
      <div class="gr"><span>NOW</span><b>${fmt(price)}</b><i class="${r >= 0 ? 'bull' : 'bear'}" style="font-weight:800">${r >= 0 ? '+' : ''}${r.toFixed(2)}R</i></div>`, `guide active ${t.dir}`);
    return;
  }
  const waits = plays.flatMap(([tf, t]) => [
    ...t.areas.map((a) => sh(a, k)).map((a) => ({ tf, dir: a.dir, text: `${a.dir === 'bull' ? 'BUY ZONE' : 'SELL ZONE'} ${fmt(a.bottom)}–${fmt(a.top)}`, at: (a.top + a.bottom) / 2 })),
    ...t.triggers.map((g) => sh(g, k)).map((g) => ({ tf, dir: g.dir, text: `${g.dir === 'bull' ? 'BUY above' : 'SELL below'} ${fmt(g.price)}`, at: g.price })),
    ...(tf === state.tf ? withZones([]).map((a) => ({ tf, dir: a.dir, text: `${a.dir === 'bull' ? 'BUY ZONE' : 'SELL ZONE'} ${fmt(a.bottom)}–${fmt(a.top)}`, at: (a.top + a.bottom) / 2 })) : []),
  ]).filter((w) => Number.isFinite(price)).sort((x, y) => Math.abs(x.at - price) - Math.abs(y.at - price)).slice(0, 3);
  setGuide(el, `<div class="gh"><span>Waiting for a setup</span><span class="gs">${esc(mk().label)}</span></div>
    ${waits.length ? `<div class="muted">Next possible trades, nearest first:</div>${waits.map((w) => `<div class="wz ${w.dir}"><span>${TF[w.tf].label} · ${w.text}</span><span class="muted">${signed(w.at - price)}</span></div>`).join('')}` : '<div class="muted">No zone or breakout level nearby. A box appears here and on the chart the moment a verified setup forms.</div>'}`, 'guide');
}

function flashSignal(s) {
  const el = $('flashSig');
  const bull = s.dir === 'bull';
  el.className = `flash-sig ${s.dir}`;
  el.innerHTML = `${bull ? '▲ LONG' : '▼ SHORT'}<small>${esc(mkOf(s.market).label || '')} ${TF[s.tf].label} · entry ${fmt(s.entry)} · stop ${fmt(s.stop)} · target ${fmt(s.target)}</small>`;
  el.hidden = false;
  clearTimeout(flashSignal.t);
  flashSignal.t = setTimeout(() => { el.hidden = true; }, 3300);
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
    Object.assign(s, sh(s, basisOf(s.market)));
    toast(`<b>New ${esc(m?.label || s.market)} ${TF[s.tf].label} setup:</b> ${s.dir === 'bull' ? 'BUY' : 'SELL'} · ${esc(stratName(s.strategy))} · entry ≈ ${fmt(s.entry)}`);
    beep();
    if (s.market === state.market) flashSignal(s);
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
  await Promise.all(state.cfg.markets.map(async (m) => {
    try {
      state.bots[m.id] = await feed.bot(m.id);
    } catch { /* retried on the next pass */ }
  }));
  renderHero();
  renderScore();
  renderTrack();
  renderHeader();
  renderBias();
  checkNewSignals();
  pushOverlay();
  drawMarkers();
  renderGuide();
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
  if (first || !state.streamOn) for (const t of w.list.slice().reverse()) addWhale(t, !first);
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
  if (mk().binance && state.streamOn) return;
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
  $('botLog').innerHTML = p.log.slice(0, 8).map((l) => `<li><time>${clock(l.t)}</time><span>${esc(l.msg)}</span></li>`).join('') || `<li class="empty">No trades since ${p.equity[0] ? new Date(p.equity[0].t * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'the server started'}. The auto-trader opens a trade the moment a proven strategy fires (none has since). The free server restarts the paper account when it redeploys, so the Track record below shows the strategies' last 30 days.</li>`;
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
  $('positions').innerHTML = p.positions.map((x0) => {
    let x = x0;
    const kk = basisOf(x.market);
    const price = state.prices[x.market];
    const pl = Number.isFinite(price) ? (x.dir === 'bull' ? 1 : -1) * (price - kk - x.entry) * x.units : 0;
    x = sh(x, kk);
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

// Every trade the proven strategies took over the last 30 days, both markets,
// replayed as a $10,000 account risking 1% per trade. The paper account below
// only counts trades since the server last started; this shows the longer record.
let trackKey = '';
function renderTrack() {
  const all = [];
  for (const [mid, b] of Object.entries(state.bots)) {
    for (const t of Object.values(b?.tfs || {})) {
      if (t.pending) continue;
      for (const x of t.recent) if (x.active && x.status === 'closed') all.push({ ...x, market: mid });
    }
  }
  const from = nowSec() - 30 * 86400;
  const list = all.filter((x) => x.exitTime >= from).sort((a, z) => a.exitTime - z.exitTime);
  const key = `${list.length}:${list[list.length - 1]?.exitTime}`;
  if (key === trackKey) return;
  trackKey = key;
  if (!list.length) {
    $('trackMeta').textContent = '';
    $('track').innerHTML = `<div class="empty">${Object.keys(state.bots).length ? 'No closed trades from the proven strategies in the last 30 days.' : 'Loading the strategy results…'}</div>`;
    return;
  }
  let eq = 10000;
  const curve = [eq];
  for (const x of list) {
    eq += eq * 0.01 * x.r;
    curve.push(eq);
  }
  const wins = list.filter((x) => x.r > 0);
  const gw = wins.reduce((a, x) => a + x.r, 0);
  const gl = -list.filter((x) => x.r <= 0).reduce((a, x) => a + x.r, 0);
  const totalR = list.reduce((a, x) => a + x.r, 0);
  const week = list.filter((x) => x.exitTime >= nowSec() - 7 * 86400);
  const weekR = week.reduce((a, x) => a + x.r, 0);
  $('trackMeta').textContent = 'last 30 days · proven strategies · both markets · $10,000 at 1% risk';
  $('track').innerHTML = `<div class="track-top">
    <div class="track-eq"><div class="big mono ${eq >= 10000 ? 'bull' : 'bear'}">${money(eq)}</div><div class="muted small">${signed((eq / 100 - 100))}% · ${signed(totalR, 1)}R</div></div>
    <div class="kpis"><div>${list.length}<span>trades</span></div><div>${pct(wins.length / list.length)}<span>won</span></div><div>${gl ? (gw / gl).toFixed(2) : '∞'}<span>profit factor</span></div><div class="${weekR >= 0 ? 'bull' : 'bear'}">${signed(weekR, 1)}R<span>last 7 days</span></div></div>
  </div>
  <div class="spark-wrap">${spark(curve, { h: 60 })}</div>
  <ol class="history">${list.slice(-12).reverse().map((h) => `<li><time>${new Date(h.exitTime * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time><span><b class="${h.dir}">${h.dir === 'bull' ? '▲ LONG' : '▼ SHORT'}</b> ${esc(mkOf(h.market).label)} ${esc(TF[h.tf]?.label || h.tf)} · ${esc(stratName(h.strategy))} · ${esc(h.reason || '')}</span><b class="mono ${h.r >= 0 ? 'bull' : 'bear'}">${signed(h.r, 1)}R</b></li>`).join('')}</ol>`;
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
  initGuideDrag();
  loadBots();
  load(); // fetches the spot-gold basis itself when it is not known yet
  loadDayOpen();
  loadNews();
  loadPaper();
  const dot = $('liveDot');
  feed.subscribe((d) => {
    if (d.error) return;
    dot.className = 'live-dot on';
    dot.title = 'Live';
    if (d.basis != null) state.basis[d.m] = d.basis;
    // Spot-priced markets (gold) take every spot tick from the server; others
    // take their price from the exchange stream while it is connected.
    if (d.spot != null) queuePrice(d.m, d.spot, d.t);
    else if (!(state.streamOn && d.m === state.market)) queuePrice(d.m, d.p, d.t);
  }, () => {
    dot.className = 'live-dot err';
    dot.title = 'Reconnecting…';
  });
  setInterval(() => {
    if (tapeDirty || !state.streamOn) renderTapeSplit();
    tapeDirty = false;
    renderPositions();
    renderGuide();
  }, 500);
  setInterval(() => refreshFlow(), 400); // live book, delta and whales
  setInterval(loadDeepBook, 4000);
  setInterval(refreshPerpVolume, 3000);
  setInterval(loadBots, 5000);
  setInterval(loadFlow, 4000); // only used when a market has no direct exchange feed
  setInterval(loadNews, 2000);
  setInterval(loadPaper, 3000);
  setInterval(() => load({ soft: true }), 60000);
  setInterval(loadDayOpen, 5 * 60000);
  setInterval(renderPills, 30000);
  setInterval(() => { if (state.news) $('events').querySelectorAll('.event b.mono').forEach((el, i) => { el.textContent = countdown(state.news.events[i].time); }); }, 1000);
}

boot();
