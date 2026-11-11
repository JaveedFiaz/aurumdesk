// One play = one market + timeframe. Fetches its full history, backtests it,
// and hands back the result plus short candle tails for live scanning.
import { analyze, dropFormingCandle } from '../shared/bot.js';
import { getCandles } from '../shared/candles.js';

export const TAIL = 1500; // candles of the play's timeframe kept in memory
export const HTF_TAIL = 700; // candles of its higher timeframe kept in memory

// job: { tf, htf, n, hn, costBps, opts } where opts are analyze() options.
export async function loadAndAnalyze(provider, job) {
  const now = Date.now() / 1000;
  const c = await getCandles(provider, job.tf.id, job.n, { maxCandles: job.n + 100 });
  const h = await getCandles(provider, job.htf.id, job.hn, { maxCandles: job.hn + 100 });
  const opts = { ...job.opts, tf: job.tf, htf: job.htf, now, label: provider.label };
  opts.rules = { ...opts.rules, cost: ((c.at(-1)?.close || 0) * job.costBps) / 10000 };
  const result = analyze(dropFormingCandle(c, job.tf.sec, now), dropFormingCandle(h, job.htf.sec, now), opts);
  return { result, c: c.slice(-TAIL), h: h.slice(-HTF_TAIL), loaded: c.length };
}
