import test from 'node:test';
import assert from 'node:assert/strict';
import { createBinance, binanceBlockedUntil } from '../server/providers/binance.js';

test('after a 418 ban, no request is sent until the ban has passed', async () => {
  let calls = 0;
  const until = Date.now() + 120000;
  const fetchImpl = async () => {
    calls++;
    return { ok: false, status: 418, headers: { get: () => null }, text: async () => `{"code":-1003,"msg":"Way too much request weight used; IP banned until ${until}. Please use WebSocket Streams"}` };
  };
  const a = createBinance({ fetchImpl });
  const b = createBinance({ symbol: 'BTCUSDT', fetchImpl });
  await assert.rejects(() => a.fetchPrice(), /rate limit: paused/);
  assert.equal(calls, 1);
  assert.ok(binanceBlockedUntil() >= until);
  await assert.rejects(() => a.fetchCandles('1m', 10), /paused/);
  await assert.rejects(() => b.fetchBook(), /paused/); // the ban is per IP, so every symbol waits
  assert.equal(calls, 1, 'nothing else was sent');
});
