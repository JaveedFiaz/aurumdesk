// The trade finder: backtests every strategy on recent 15m history (with 1H
// confirmation), keeps the ones that held up, and reports their live setups.
// Runs on the server, in the CLI (npm run backtest) and in the hosted preview.

import { getCandles } from './candles.js';
import { DEFAULT_RULES, STRATEGIES, STRATEGY_BY_ID, buildContext, buildHtf, inSession, scanBar, tradeAreas } from './strategies.js';
import { GRADES, scoreSetup } from './confluence.js';
import { cotAt } from './cot.js';

export const BOT_TF = { id: 'M15', sec: 900 };
export const BOT_HTF = { id: 'H1', sec: 3600 };
const WINDOW = 300; // 15m bars each decision sees (about 3 days)
const HTF_WINDOW = 300;
const WARMUP = 120;

// A strategy is switched on only if it made money on enough trades overall
// AND on the later, unseen part of the history (out-of-sample).
export const APPROVAL = { minTrades: 20, minPF: 1.15, minExpR: 0.05, oosShare: 0.4 };

const dayKey = (t) => Math.floor(t / 86400);

function closeTrade(t, bar, price, reason, rules) {
  const sign = t.dir === 'bull' ? 1 : -1;
  t.exit = price;
  t.exitTime = bar.time;
  t.reason = reason;
  t.r = (sign * (price - t.entry) - rules.cost) / t.risk;
  t.status = 'closed';
}

// One bar of trade management. Stop is checked before target when both are
// inside the same candle, which is the conservative assumption.
export function manage(t, bar, rules) {
  const bull = t.dir === 'bull';
  if (bull ? bar.low <= t.stop : bar.high >= t.stop) return closeTrade(t, bar, t.stop, 'stop', rules);
  if (bull ? bar.high >= t.target : bar.low <= t.target) return closeTrade(t, bar, t.target, 'target', rules);
  t.bars += 1;
  if (t.bars >= rules.maxBars) closeTrade(t, bar, bar.close, 'time', rules);
  return undefined;
}

// c: closed 15m candles, h: closed 1H candles (both ascending).
// cot: weekly COT metrics (optional); each setup sees only reports already published.
export function backtest(c, h = [], { rules = DEFAULT_RULES, strategies = STRATEGIES.map((s) => s.id), cot = null, tfSec = BOT_TF.sec, htfSec = BOT_HTF.sec } = {}) {
  const trades = [];
  const live = new Map(); // strategy -> pending or open trade
  const perDay = new Map();
  let hIdx = 0;
  let htfKey = -1;
  let htf = null;

  for (let i = Math.min(WARMUP, c.length); i < c.length; i++) {
    const bar = c[i];

    for (const [id, t] of live) {
      if (t.status === 'pending') {
        const sign = t.dir === 'bull' ? 1 : -1;
        const risk = sign * (bar.open - t.stop);
        // Skip if the next open gapped through the stop or most of the way to target.
        if (!(risk > 0) || risk > t.plannedRisk * 1.5) {
          live.delete(id);
          t.status = 'skipped';
          continue;
        }
        t.entry = bar.open;
        t.entryTime = bar.time;
        t.risk = risk;
        t.target = bar.open + sign * (t.rr ?? rules.rr) * risk;
        t.status = 'open';
        t.bars = 0;
      }
      manage(t, bar, rules);
      if (t.status === 'closed') live.delete(id);
    }

    if (rules.sessionOnly && !inSession(bar.time)) continue;

    // 1H candles that had fully closed when this 15m bar closed.
    const closeAt = bar.time + tfSec;
    while (hIdx < h.length && h[hIdx].time + htfSec <= closeAt) hIdx++;
    if (hIdx !== htfKey) {
      htfKey = hIdx;
      htf = buildHtf(h.slice(Math.max(0, hIdx - HTF_WINDOW), hIdx));
    }

    const todo = strategies.filter((id) => !live.has(id) && (perDay.get(`${id}:${dayKey(bar.time)}`) || 0) < rules.maxPerDay);
    if (!todo.length) continue;
    const ctx = buildContext(c.slice(Math.max(0, i - WINDOW + 1), i + 1), htf);
    for (const s of scanBar(ctx, rules, todo)) {
      const key = `${s.strategy}:${dayKey(bar.time)}`;
      perDay.set(key, (perDay.get(key) || 0) + 1);
      const conf = scoreSetup(s, ctx, cot ? cotAt(cot, closeAt) : null);
      const t = { ...s, ...conf, status: 'pending', signalTime: bar.time, plannedRisk: Math.abs(s.entry - s.stop) };
      trades.push(t);
      live.set(s.strategy, t);
    }
  }
  return trades.filter((t) => t.status !== 'skipped');
}

function basic(done) {
  const wins = done.filter((t) => t.r > 0).length;
  const sumR = done.reduce((x, t) => x + t.r, 0);
  const gross = done.filter((t) => t.r > 0).reduce((x, t) => x + t.r, 0);
  const loss = -done.filter((t) => t.r <= 0).reduce((x, t) => x + t.r, 0);
  return {
    trades: done.length,
    winRate: done.length ? wins / done.length : 0,
    expR: done.length ? sumR / done.length : 0,
    totalR: sumR,
    pf: loss > 0 ? gross / loss : gross > 0 ? Infinity : 0,
  };
}

// Measured results per confluence grade, over every backtested trade.
export function gradeStats(trades) {
  const done = trades.filter((t) => t.status === 'closed');
  return GRADES.map((g) => ({ grade: g.id, min: g.min, ...basic(done.filter((t) => t.grade === g.id)) }));
}

export function summarize(trades, strategyId, splitTime) {
  const done = trades.filter((t) => t.strategy === strategyId && t.status === 'closed');
  const sum = (arr) => arr.reduce((s, t) => s + t.r, 0);
  const wins = done.filter((t) => t.r > 0);
  const gross = sum(wins);
  const loss = -sum(done.filter((t) => t.r <= 0));
  let eq = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of done) {
    eq += t.r;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
  }
  const oos = done.filter((t) => t.signalTime >= splitTime);
  const ins = done.filter((t) => t.signalTime < splitTime);
  const s = {
    id: strategyId,
    trades: done.length,
    winRate: done.length ? wins.length / done.length : 0,
    pf: loss > 0 ? gross / loss : gross > 0 ? Infinity : 0,
    expR: done.length ? sum(done) / done.length : 0,
    totalR: sum(done),
    maxDD,
    inSample: { trades: ins.length, expR: ins.length ? sum(ins) / ins.length : 0 },
    outSample: { trades: oos.length, expR: oos.length ? sum(oos) / oos.length : 0 },
  };
  s.active = s.trades >= APPROVAL.minTrades && s.pf >= APPROVAL.minPF && s.expR >= APPROVAL.minExpR
    && s.outSample.trades >= 5 && s.outSample.expR > 0;
  return s;
}

// Full history is downloaded once; later runs fetch only the latest candles
// and append them, so a 2-year backtest every 15 minutes stays cheap.
export async function loadHistory(provider, tfId, n, cache) {
  const prev = cache?.[tfId];
  if (prev && prev.length >= n * 0.9) {
    const fresh = await getCandles(provider, tfId, 500);
    if (fresh.length) {
      const merged = prev.filter((x) => x.time < fresh[0].time).concat(fresh);
      cache[tfId] = merged.slice(-n);
      return cache[tfId];
    }
  }
  const all = await getCandles(provider, tfId, n, { maxCandles: n + 100 });
  if (cache) cache[tfId] = all;
  return all;
}

function dropForming(candles, sec, now) {
  const last = candles[candles.length - 1];
  return last && last.time + sec > now ? candles.slice(0, -1) : candles;
}

// Pure analysis of one market + timeframe ("play"). c and h are closed candles.
// With `prior` (an earlier full result) only the recent tail is scanned for
// live setups and the statistics are carried over, which is cheap enough to
// run on every closed candle. Without it the whole history is backtested.
export function analyze(c, h, { tf = BOT_TF, htf = BOT_HTF, include = STRATEGIES, rules = DEFAULT_RULES, cot = null, now = Date.now() / 1000, prior = null, full = false, label = '' } = {}) {
  if (c.length < WARMUP + 50) throw new Error(`Not enough ${tf.id} history`);
  const ids = include.map((x) => x.id);
  rules = { ...rules, rrBy: { ...Object.fromEntries(include.filter((x) => x.rr).map((x) => [x.id, x.rr])), ...rules.rrBy } };
  const opts = { rules, cot, strategies: ids, tfSec: tf.sec, htfSec: htf.sec };
  const tail = 900;
  const trades = prior ? backtest(c.slice(-tail), h.slice(-(HTF_WINDOW + Math.ceil((tail * tf.sec) / htf.sec) + 5)), opts) : backtest(c, h, opts);
  const from = prior ? prior.from : c[Math.min(WARMUP, c.length - 1)].time;
  const to = c[c.length - 1].time + tf.sec;
  const splitTime = to - (to - from) * APPROVAL.oosShare;
  const stats = prior ? prior.stats : include.map((s) => ({ ...summarize(trades, s.id, splitTime), name: STRATEGY_BY_ID[s.id]?.name || s.id, desc: STRATEGY_BY_ID[s.id]?.desc || '', rr: rules.rrBy[s.id] ?? rules.rr }))
    .sort((a, b) => (b.active - a.active) || (b.expR - a.expR));
  const active = new Set(stats.filter((s) => s.active).map((s) => s.id));
  const grades = prior ? prior.grades : gradeStats(trades);
  const byGrade = Object.fromEntries(grades.map((g) => [g.grade, g]));
  const strip = ({ plannedRisk, bars, ...t }) => ({
    ...t,
    tf: tf.id,
    active: active.has(t.strategy),
    expected: byGrade[t.grade] ? { winRate: byGrade[t.grade].winRate, expR: byGrade[t.grade].expR, trades: byGrade[t.grade].trades } : null,
  });
  let recent = trades.filter((t) => t.status === 'closed').map(strip);
  if (prior) {
    const seen = new Set(prior.recent.map((t) => `${t.strategy}:${t.signalTime}`));
    const cutoff = prior.recent.length ? prior.recent[prior.recent.length - 1].signalTime : 0;
    recent = prior.recent.concat(recent.filter((t) => t.signalTime > cutoff && !seen.has(`${t.strategy}:${t.signalTime}`)));
  }
  return {
    provider: label,
    tf: tf.id,
    htf: htf.id,
    from,
    to,
    days: Math.round((to - from) / 86400),
    rules,
    approval: APPROVAL,
    generatedAt: Math.floor(now),
    testedAt: prior ? prior.testedAt : Math.floor(now),
    stats,
    grades,
    orderFlow: c.some((x) => x.buyVolume != null),
    cot: !!cot,
    // Where the strategies would act next (drawn as buy/sell areas on the chart).
    ...tradeAreas(buildContext(c.slice(-WINDOW), buildHtf(h.slice(-HTF_WINDOW))), rules, ids),
    // Setups waiting for the next bar's open, and trades still running.
    signals: trades.filter((t) => t.status !== 'closed' && active.has(t.strategy)).map(strip),
    // The same from strategies that have not proven an edge: shown, never traded.
    watch: trades.filter((t) => t.status !== 'closed' && !active.has(t.strategy)).map(strip),
    recent: recent.slice(-120),
    ...(full ? { closed: trades.filter((t) => t.status === 'closed').map(strip) } : {}),
  };
}

export function dropFormingCandle(candles, sec, now) {
  return dropForming(candles, sec, now);
}

// Fetches history for a 15m/1H play and analyses it (used by the CLI and tests).
export async function runBot({ provider, now = Date.now() / 1000, history = 70000, rules = DEFAULT_RULES, cot = null, full = false, cache = null, include = STRATEGIES, tf = BOT_TF, htf = BOT_HTF } = {}) {
  const [c0, h0] = await Promise.all([
    loadHistory(provider, tf.id, history, cache),
    loadHistory(provider, htf.id, Math.ceil((history * tf.sec) / htf.sec) + HTF_WINDOW, cache),
  ]);
  const r = analyze(dropForming(c0, tf.sec, now), dropForming(h0, htf.sec, now), { tf, htf, include, rules, cot, now, full, label: provider.label });
  return { ...r, demo: !!provider.demo };
}
