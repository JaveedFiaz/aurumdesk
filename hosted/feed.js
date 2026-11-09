// Data access for the hosted preview: the demo provider runs in the browser,
// because the hosted page cannot reach outside price feeds.

import { createDemo } from '../server/providers/demo.js';
import { getCandles } from '../shared/candles.js';
import { runBot } from '../shared/bot.js';

const provider = createDemo();

export const feed = {
  config: async () => ({ provider: provider.name, label: provider.label, note: provider.note, demo: true, tvSymbol: 'OANDA:XAUUSD' }),
  bot: () => runBot({ provider, history: 6000 }),
  candles: (tf, limit) => getCandles(provider, tf, limit),
  subscribe(onMessage) {
    const tick = async () => onMessage({ t: Math.floor(Date.now() / 1000), p: await provider.fetchPrice() });
    tick();
    setInterval(tick, 1000);
  },
};
