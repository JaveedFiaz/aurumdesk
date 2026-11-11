// Loads one play's history, backtests it and returns the result with only the
// recent candles the live scan needs. Running this in a worker keeps the big
// history out of the main process: when the worker exits, its memory is freed.
import { parentPort } from 'node:worker_threads';
import { loadAndAnalyze } from './play.js';
import { createProviders } from './providers/index.js';
import { binanceBlockedUntil } from './providers/binance.js';

parentPort.on('message', async ({ env, market, job }) => {
  try {
    const { providers } = createProviders(env);
    parentPort.postMessage({ ok: true, out: await loadAndAnalyze(providers[market], job) });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message, blockedUntil: binanceBlockedUntil() });
  }
});
