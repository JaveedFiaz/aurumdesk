import { createBinance } from './binance.js';
import { createTwelveData } from './twelvedata.js';
import { createDemo } from './demo.js';
import { createOanda } from './oanda.js';

export function createProvider(env = process.env) {
  const name = (env.PROVIDER || 'binance').toLowerCase();
  if (name === 'binance') {
    return createBinance({ base: env.BINANCE_BASE || undefined, symbol: env.BINANCE_SYMBOL || undefined });
  }
  if (name === 'twelvedata') {
    return createTwelveData({ apiKey: env.TWELVEDATA_API_KEY, symbol: env.TWELVEDATA_SYMBOL || undefined });
  }
  if (name === 'oanda') {
    return createOanda({ apiKey: env.OANDA_API_KEY, instrument: env.OANDA_INSTRUMENT || undefined, env: env.OANDA_ENV || undefined });
  }
  if (name === 'demo') return createDemo();
  throw new Error(`Unknown PROVIDER "${name}". Use binance, oanda, twelvedata or demo.`);
}
