// Data access for the hosted preview: everything runs in the browser on the
// demo provider, because a static page cannot reach outside price feeds.
// The auto-trader keeps its paper account in this browser's storage.

import { createDemo } from '../server/providers/demo.js';
import { getCandles } from '../shared/candles.js';
import { runBot } from '../shared/bot.js';
import { bookStats, deltaSeries, tradeFlow, whales } from '../shared/flow.js';
import { cotMetrics, demoCot } from '../shared/cot.js';
import { createAutoTrader } from '../shared/autotrader.js';

const provider = createDemo();
const cot = cotMetrics(demoCot(Date.now() / 1000));
let lastPrice = NaN;
let botCache = null;

const storage = {
  load: () => {
    try {
      return JSON.parse(localStorage.getItem('pulse:paper') || 'null');
    } catch {
      return null;
    }
  },
  save: (s) => {
    try {
      localStorage.setItem('pulse:paper', JSON.stringify(s));
    } catch { /* storage unavailable: memory only */ }
  },
};
const paper = createAutoTrader({ storage });

function bot() {
  const bucket = Math.floor(Date.now() / 900000);
  if (!botCache || botCache.bucket !== bucket) botCache = { bucket, promise: runBot({ provider, history: 6000, cot }) };
  return botCache.promise;
}

async function autoTrade() {
  if (!paper.enabled || !Number.isFinite(lastPrice)) return;
  paper.onSignals((await bot()).signals, lastPrice);
}
setInterval(autoTrade, 30000);

export const feed = {
  config: async () => ({ provider: provider.name, label: provider.label, note: provider.note, demo: true, flow: 'Demo data', cot: 'Demo COT (synthetic)' }),
  candles: (tf, limit) => getCandles(provider, tf, limit),
  bot,
  async flow(tf) {
    const [fc, trades, book] = await Promise.all([getCandles(provider, tf, 120), provider.fetchTrades(1000), provider.fetchBook(400)]);
    return { available: true, source: 'Demo data', basis: 0, delta: deltaSeries(fc), tape: tradeFlow(trades), whales: whales(trades), book: bookStats(book) };
  },
  cot: async () => ({ available: true, source: 'Demo COT (synthetic)', latest: cot[cot.length - 1], series: cot.slice(-156) }),
  paper: async () => paper.snapshot(lastPrice),
  async paperAction(b) {
    if (b.config) paper.configure(b.config);
    if (b.action === 'start') {
      paper.start();
      autoTrade();
    } else if (b.action === 'stop') paper.stop({ closeAll: !!b.closeAll, price: lastPrice });
    else if (b.action === 'reset') paper.reset(b.amount != null ? +b.amount : undefined);
    return paper.snapshot(lastPrice);
  },
  subscribe(onMessage) {
    const tick = async () => {
      lastPrice = await provider.fetchPrice();
      paper.onPrice(lastPrice);
      onMessage({ t: Math.floor(Date.now() / 1000), p: lastPrice });
    };
    tick();
    setInterval(tick, 1000);
  },
};
