// The trade finder: backtests every strategy on recent 15m history (with 1H
// confirmation), keeps the ones that held up, and reports their live setups.
// Runs on the server, in the CLI (npm run backtest) and in the hosted preview.

import { getCandles } from './candles.js';
import { DEFAULT_RULES, STRATEGIES, buildContext, buildHtf, inSession, scanBar } from './strategies.js';

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
export function backtest(c, h = [], { rules = DEFAULT_RULES, strategies = STRATEGIES.map((s) => s.id) } = {}) {
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
        t.target = bar.open + sign * rules.rr * risk;
        t.status = 'open';
        t.bars = 0;
      }
      manage(t, bar, rules);
      if (t.status === 'closed') live.delete(id);
    }

    if (rules.sessionOnly && !inSession(bar.time)) continue;

    // 1H candles that had fully closed when this 15m bar closed.
    const closeAt = bar.time + BOT_TF.sec;
    while (hIdx < h.length && h[hIdx].time + BOT_HTF.sec <= closeAt) hIdx++;
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
      const t = { ...s, status: 'pending', signalTime: bar.time, plannedRisk: Math.abs(s.entry - s.stop) };
      trades.push(t);
      live.set(s.strategy, t);
    }
  }
  return trades.filter((t) => t.status !== 'skipped');
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

function dropForming(candles, sec, now) {
  const last = candles[candles.length - 1];
  return last && last.time + sec > now ? candles.slice(0, -1) : candles;
}

// Fetches history, backtests, ranks, and returns live setups from approved strategies.
export async function runBot({ provider, now = Date.now() / 1000, history = 10000, rules = DEFAULT_RULES } = {}) {
  const [c15, c60] = await Promise.all([
    getCandles(provider, BOT_TF.id, history, { maxCandles: history + 100 }),
    getCandles(provider, BOT_HTF.id, Math.ceil(history / 4) + HTF_WINDOW, { maxCandles: Math.ceil(history / 4) + HTF_WINDOW + 100 }),
  ]);
  const c = dropForming(c15, BOT_TF.sec, now);
  const h = dropForming(c60, BOT_HTF.sec, now);
  if (c.length < WARMUP + 50) throw new Error('Not enough 15m history for the trade finder');

  const trades = backtest(c, h, { rules });
  const from = c[Math.min(WARMUP, c.length - 1)].time;
  const to = c[c.length - 1].time + BOT_TF.sec;
  const splitTime = to - (to - from) * APPROVAL.oosShare;
  const stats = STRATEGIES.map((s) => ({ ...summarize(trades, s.id, splitTime), name: s.name, desc: s.desc }))
    .sort((a, b) => (b.active - a.active) || (b.expR - a.expR));
  const active = new Set(stats.filter((s) => s.active).map((s) => s.id));
  const strip = ({ plannedRisk, bars, ...t }) => ({ ...t, active: active.has(t.strategy) });

  return {
    provider: provider.label,
    demo: !!provider.demo,
    tf: BOT_TF.id,
    htf: BOT_HTF.id,
    from,
    to,
    days: Math.round((to - from) / 86400),
    rules,
    approval: APPROVAL,
    generatedAt: Math.floor(now),
    stats,
    // Setups waiting for the next bar's open, and trades still running.
    signals: trades.filter((t) => t.status !== 'closed' && active.has(t.strategy)).map(strip),
    recent: trades.filter((t) => t.status === 'closed').slice(-40).map(strip),
  };
}
