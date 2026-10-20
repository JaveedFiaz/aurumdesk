// Builds any timeframe from a provider's native candles. Used by the server,
// and by the hosted build, which runs a provider in the browser.

import { TF, aggregate, bucketStart, nominalSeconds, pickNative, sameInterval } from './timeframes.js';

export async function getCandles(provider, tfId, limit) {
  const tf = TF[tfId];
  if (!tf) throw Object.assign(new Error(`Unknown timeframe ${tfId}`), { status: 400 });
  const native = pickNative(tf, provider.natives);
  const same = sameInterval(tf, native);
  const factor = same ? 1 : Math.ceil(nominalSeconds(tf) / nominalSeconds(native));
  const raw = await provider.fetchCandles(native.id, Math.min(limit * factor + factor, provider.maxCandles || 5000));
  let out = raw;
  if (!same) {
    out = aggregate(raw, tf);
    // The oldest bucket is usually only partly covered by the fetched candles.
    if (raw.length && out.length > 1 && raw[0].time !== bucketStart(tf, raw[0].time)) out = out.slice(1);
  }
  return out.slice(-limit);
}
