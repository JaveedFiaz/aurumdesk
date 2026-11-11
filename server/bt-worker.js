// Runs a full-history backtest off the main thread, so prices, the auto-trader
// and the web server keep responding while it works.
import { parentPort } from 'node:worker_threads';
import { analyze } from '../shared/bot.js';

parentPort.on('message', ({ c, h, opts }) => {
  try {
    parentPort.postMessage({ ok: true, result: analyze(c, h, opts) });
  } catch (e) {
    parentPort.postMessage({ ok: false, error: e.message });
  }
});
