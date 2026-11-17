// Memecoins market: a chart for any Binance memecoin with the one strategy that
// held up on memecoins (shared/memeplays.js), plus a scanner that checks every
// memecoin for that setup each time a 15-minute candle closes. Runs entirely in
// the browser on Binance spot data (the data the strategy was tested on).

import { backtest, confRatio } from '../shared/bot.js';
import { analyze } from '../shared/analysis.js';
import { DEFAULT_RULES, STRATEGY_BY_ID } from '../shared/strategies.js';
import { MEME_PLAY } from '../shared/memeplays.js';
import { Overlay } from './overlay.js';

const REST = 'https://data-api.binance.vision/api/v3';
const WS = 'wss://data-stream.binance.vision/ws/';
const IV = { M5: '5m', M15: '15m', H1: '1h' };
const SEC = { M5: 300, M15: 900, H1: 3600 };
const UP = '#16c784';
const DN = '#ea3943';

const kline = (k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], buyVolume: +k[9] });
async function klines(symbol, tf, limit) {
  const res = await fetch(`${REST}/klines?symbol=${symbol}&interval=${IV[tf]}&limit=${limit}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  return (await res.json()).map(kline);
}
const closed = (c, sec) => (c.length && c[c.length - 1].time + sec > Date.now() / 1000 ? c.slice(0, -1) : c);
export const decimalsFor = (p) => (p >= 100 ? 2 : p >= 1 ? 4 : Math.min(10, Math.max(4, Math.ceil(-Math.log10(p)) + 3)));

const RULES = {
  ...DEFAULT_RULES,
  ...MEME_PLAY.rules,
  rrBy: Object.fromEntries(MEME_PLAY.strategies.map((s) => [s.id, s.rr])),
  allHours: MEME_PLAY.strategies.map((s) => s.id),
};
const GATE = Object.fromEntries(MEME_PLAY.strategies.map((s) => [s.id, s.gate]));

// The strategy on one coin: live setups (pending / running) and closed trades.
export async function scanCoin(symbol) {
  const [c, h] = await Promise.all([klines(symbol, 'M15', 1000), klines(symbol, 'H1', 500)]);
  const trades = backtest(closed(c, 900), closed(h, 3600), { rules: RULES, strategies: Object.keys(GATE), tfSec: 900, htfSec: 3600 })
    .filter((t) => confRatio(t) >= GATE[t.strategy] - 1e-9);
  return {
    live: trades.filter((t) => t.status !== 'closed'),
    history: trades.filter((t) => t.status === 'closed'),
    last: c[c.length - 1]?.close,
  };
}

export function createMemeMarket({ LC, locale, onSignal, getCoins }) {
  const $ = (id) => document.getElementById(id);
  const el = $('mmChart');
  const chart = LC.createChart(el, {
    autoSize: true,
    layout: { background: { type: 'solid', color: 'transparent' }, textColor: '#c3bde0', fontFamily: 'Inter, system-ui, sans-serif' },
    grid: { vertLines: { color: 'rgba(255,255,255,0.05)' }, horzLines: { color: 'rgba(255,255,255,0.05)' } },
    rightPriceScale: { borderColor: 'rgba(255,255,255,0.16)' },
    timeScale: { borderColor: 'rgba(255,255,255,0.16)', timeVisible: true, secondsVisible: false, rightOffset: 22 },
    crosshair: { mode: LC.CrosshairMode.Normal },
    localization: { locale },
  });
  const series = chart.addCandlestickSeries({ upColor: UP, downColor: DN, borderVisible: false, wickUpColor: UP, wickDownColor: DN });
  series.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.2 } });
  const vol = chart.addHistogramSeries({ priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.85, bottom: 0 } });
  const overlay = new Overlay(el.parentElement, $('mmOverlay'), chart, series);

  const st = { symbol: null, name: null, tf: 'M15', candles: [], ws: null, scan: null, seq: 0, found: new Map(), scanning: false };
  const volBar = (x) => ({ time: x.time, value: x.volume, color: x.buyVolume * 2 >= x.volume ? 'rgba(22,199,132,0.35)' : 'rgba(234,57,67,0.35)' });
  const fmt = (p) => (p == null ? '—' : p.toFixed(decimalsFor(p)));

  // Fresh demand below and supply above, from this chart (zones ahead of price).
  function zonesAhead(result, price) {
    if (!result) return [];
    const out = [];
    for (const dir of ['bull', 'bear']) {
      const bull = dir === 'bull';
      [...result.zones, ...result.orderBlocks]
        .filter((z) => z.side === dir && !z.broken && (bull ? z.top < price : z.bottom > price) && z.top - z.bottom <= 2.5 * result.atr && (z.score == null || z.score >= 50))
        .sort((a, b) => Math.abs((a.top + a.bottom) / 2 - price) - Math.abs((b.top + b.bottom) / 2 - price))
        .slice(0, 2)
        .forEach((z, n) => {
          const entry = bull ? z.top : z.bottom;
          const stop = bull ? z.bottom - 0.25 * result.atr : z.top + 0.25 * result.atr;
          out.push({ dir, top: z.top, bottom: z.bottom, time: z.createdTime ?? z.time, watch: true, strong: z.score >= 70, score: z.score, kind: /OB/.test(z.kind) ? 'order block' : bull ? 'demand' : 'supply', src: st.tf === 'M15' ? '15m' : st.tf === 'M5' ? '5m' : '1h', plan: { entry, stop, target: entry + (bull ? 2 : -2) * Math.abs(entry - stop) }, primary: n === 0, near: Math.abs(price - entry) <= result.atr });
        });
    }
    return out;
  }

  function draw() {
    const c = st.candles;
    if (!c.length) return;
    const result = c.length > 40 ? analyze(c.slice(0, -1), { tf: { id: st.tf, sec: SEC[st.tf] } }) : null;
    const sc = st.scan;
    overlay.decimals = decimalsFor(c[c.length - 1].close);
    overlay.update({
      candles: c,
      result,
      htf: null,
      layers: { signals: true },
      trade: {
        areas: zonesAhead(result, c[c.length - 1].close),
        triggers: [],
        live: sc ? sc.live.map((t) => ({ ...t, q: true })) : [],
        history: [], // only live setups: past ones would be a backtest replay
        surges: [],
      },
    });
    renderPanel();
  }

  function renderPanel() {
    const sc = st.scan;
    const price = st.candles[st.candles.length - 1]?.close;
    const s = MEME_PLAY.stats;
    const t = sc?.live[0];
    let html;
    if (t) {
      const bull = t.dir === 'bull';
      const risk = Math.abs(t.entry - t.stop);
      const r = price != null ? ((bull ? 1 : -1) * (price - t.entry)) / risk : 0;
      const passed = t.factors.filter((f) => f.ok).length;
      html = `<div class="mm-sig ${t.dir}"><div class="gh"><span class="${t.dir}">${bull ? '▲ LONG' : '▼ SHORT'} ${st.name}</span><span class="gs">15m · ${t.status === 'open' ? 'IN TRADE' : 'ENTER NOW'}</span></div>
        <div class="muted">${STRATEGY_BY_ID[t.strategy]?.name || t.strategy} · ${t.why || ''}</div>
        <div class="gr"><span>TARGET</span><b class="bull">${fmt(t.target)}</b></div>
        <div class="gr"><span>ENTRY</span><b>${fmt(t.entry)}</b></div>
        <div class="gr"><span>STOP</span><b class="bear">${fmt(t.stop)}</b></div>
        <div class="gr"><span>NOW</span><b>${fmt(price)}</b><i class="${r >= 0 ? 'bull' : 'bear'}">${r >= 0 ? '+' : ''}${r.toFixed(2)}R</i></div>
        <div class="gconf"><b>Confluence ${passed}/${t.factors.length} ✓</b><ul>${t.factors.map((f) => `<li class="${f.ok ? 'ok' : 'no'}">${f.ok ? '✓' : '✗'} ${f.label}</li>`).join('')}</ul></div></div>`;
    } else {
      html = `<div class="mm-sig"><div class="gh"><span>No setup on ${st.name || '—'}</span><span class="gs">15m</span></div>
        <div class="muted">A long or short appears here (and as a box on the chart) when a trap with order flow and 6 of 8 confluence checks forms. Watch the buy and sell zones meanwhile.</div></div>`;
    }
    $('mmSignal').innerHTML = `${html}<div class="mm-stats"><b>Strategy record</b> (${s.period}, 23 memecoins): ${s.trades} trades, ${(s.winRate * 100).toFixed(0)}% won, profit factor ${s.pf}, ${s.totalR >= 0 ? '+' : ''}${s.totalR}R, profitable on ${s.coins} coins. About 1–2 signals a week across all memecoins. Every other strategy lost money on memecoins and is not used.</div>`;
  }

  function stream() {
    st.ws?.close();
    const { symbol, tf } = st;
    const ws = new WebSocket(`${WS}${symbol.toLowerCase()}@kline_${IV[tf]}`);
    st.ws = ws;
    ws.onmessage = (e) => {
      if (st.symbol !== symbol || st.tf !== tf) return;
      const k = JSON.parse(e.data).k;
      const b = { time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, buyVolume: +k.V };
      const c = st.candles;
      const last = c[c.length - 1];
      if (!last || b.time < last.time) return;
      if (b.time === last.time) c[c.length - 1] = b;
      else {
        c.push(b);
        if (c.length > 1200) c.splice(0, 200);
        draw();
        if (tf === 'M15' || b.time % 900 === 0) refreshScan();
      }
      series.update(b);
      vol.update(volBar(b));
      renderPanel();
    };
    ws.onclose = () => {
      if (st.ws === ws) setTimeout(() => st.ws === ws && stream(), 3000);
    };
  }

  async function refreshScan() {
    const symbol = st.symbol;
    try {
      const sc = await scanCoin(symbol);
      if (symbol !== st.symbol) return;
      st.scan = sc;
      draw();
    } catch { /* next candle */ }
  }

  async function select(symbol, name, tf = st.tf) {
    const seq = ++st.seq;
    st.symbol = symbol;
    st.name = name;
    st.tf = tf;
    st.scan = null;
    $('mmLoading').hidden = false;
    $('mmTitle').textContent = `${name} / USDT`;
    document.querySelectorAll('#mmTfs button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tf === tf)));
    try {
      const [c, sc] = await Promise.all([klines(symbol, tf, 500), scanCoin(symbol).catch(() => null)]);
      if (seq !== st.seq) return;
      st.candles = c;
      st.scan = sc;
      const dp = decimalsFor(c[c.length - 1].close);
      series.applyOptions({ priceFormat: { type: 'price', precision: dp, minMove: 10 ** -dp } });
      series.setData(c.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
      vol.setData(c.map(volBar));
      chart.timeScale().setVisibleLogicalRange({ from: c.length - 100, to: c.length + 22 });
      draw();
      stream();
    } catch (e) {
      $('mmSignal').innerHTML = `<div class="mm-sig"><div class="muted">Could not load ${name}: ${e.message}</div></div>`;
    } finally {
      if (seq === st.seq) $('mmLoading').hidden = true;
    }
  }

  // Scanner: every memecoin, after each 15-minute close.
  async function scanAll() {
    if (st.scanning) return;
    st.scanning = true;
    const list = getCoins().slice();
    const queue = [...list];
    const now = Date.now() / 1000;
    const worker = async () => {
      while (queue.length) {
        const x = queue.shift();
        try {
          const sc = await scanCoin(x.symbol);
          const t = sc.live[0];
          const key = x.symbol;
          if (t) {
            const was = st.found.get(key);
            const id = `${t.strategy}:${t.signalTime}`;
            st.found.set(key, { ...x, t, id, price: sc.last });
            if ((!was || was.id !== id) && now - t.signalTime < 3 * 900) onSignal?.(x, t);
          } else st.found.delete(key);
        } catch { /* skip this pass */ }
        renderScan();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    st.scanning = false;
    $('mmScanMeta').textContent = `${list.length} coins checked · ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`;
    renderScan();
  }

  function renderScan() {
    const rows = [...st.found.values()].sort((a, b) => b.t.signalTime - a.t.signalTime);
    $('mmScan').innerHTML = rows.map((x) => {
      const bull = x.t.dir === 'bull';
      return `<li><button type="button" class="mm-pick" data-s="${x.symbol}" data-n="${x.name}"><b class="${x.t.dir}">${bull ? '▲ LONG' : '▼ SHORT'}</b> ${x.name}
        <span class="muted small">${x.t.status === 'open' ? 'running' : 'enter now'} · entry ${fmt(x.t.entry)} · SL ${fmt(x.t.stop)} · TP ${fmt(x.t.target)}</span></button></li>`;
    }).join('') || '<li class="empty">No memecoin setup right now. The scanner checks every coin after each 15-minute candle closes.</li>';
    $('mmTabBadge').textContent = rows.length ? String(rows.length) : '';
  }

  function renderCoins(filter = '') {
    const list = getCoins().filter((x) => !filter || x.name.toLowerCase().includes(filter.toLowerCase()));
    $('mmCoins').innerHTML = list.slice(0, 200).map((x) => `<button type="button" class="mm-pick" data-s="${x.symbol}" data-n="${x.name}" aria-pressed="${x.symbol === st.symbol}">${x.name}${st.found.has(x.symbol) ? ` <i class="${st.found.get(x.symbol).t.dir}">●</i>` : ''}</button>`).join('');
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('.mm-pick');
    if (!b) return;
    select(b.dataset.s, b.dataset.n);
    renderCoins($('mmSearch').value);
  });
  $('mmTfs').addEventListener('click', (e) => {
    const tf = e.target.closest('button')?.dataset.tf;
    if (tf && st.symbol) select(st.symbol, st.name, tf);
  });
  $('mmSearch').addEventListener('input', (e) => renderCoins(e.target.value));

  let started = false;
  return {
    start(first) {
      if (!started) {
        started = true;
        scanAll();
        // After every 15-minute close (+20 s for Binance to publish it).
        const next = () => {
          const ms = 900000 - (Date.now() % 900000) + 20000;
          setTimeout(() => { scanAll(); next(); }, ms);
        };
        next();
      }
      renderCoins($('mmSearch').value);
      if (!st.symbol && first) select(first.symbol, first.name);
      setTimeout(() => chart.timeScale().applyOptions({}), 50);
    },
    renderCoins: () => renderCoins($('mmSearch').value),
    scanAll,
  };
}
