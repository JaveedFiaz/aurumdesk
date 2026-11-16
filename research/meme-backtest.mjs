// Memecoin backtest: every strategy on one coin. Data: data/<COIN>.m15.json, .m5.json, .h1.json
// (python ../tradingview/download.py <COIN>USDT 15m <start> data/<COIN>.m15.json, etc.)
// Usage: node meme-backtest.mjs data <COIN> M15 out/<COIN>.M15.json
// Backtests every strategy on each memecoin and writes the closed trades.
import fs from 'node:fs';
import { analyze } from '../shared/bot.js';
import { DEFAULT_RULES, CHECKS } from '../shared/strategies.js';
import { TF } from '../shared/timeframes.js';
const [D, coin, tf, out] = process.argv.slice(2);
const load = (f) => JSON.parse(fs.readFileSync(`${D}/${coin}.${f}.json`)).map(([t, o, h, l, c, v, b]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v, buyVolume: b }));
const c = load(tf === 'M15' ? 'm15' : 'm5');
const h = load('h1');
const ids = Object.keys(CHECKS);
const rules = { ...DEFAULT_RULES, cost: 0, costPct: 0.001, sessionOnly: false, maxPerDay: tf === 'M15' ? 3 : 6 };
const r = analyze(c.slice(0, -1), h.slice(0, -1), { tf: { id: tf, sec: TF[tf].sec }, htf: { id: 'H1', sec: 3600 }, include: ids.map((id) => ({ id, allHours: true })), rules, now: Date.now() / 1000, full: true });
fs.writeFileSync(out, JSON.stringify(r.closed.map((t) => ({ coin, s: t.strategy, t: t.signalTime, d: t.dir, r: t.r, f: t.factors.filter((x) => x.ok).length, n: t.factors.length }))));
console.log(coin, tf, r.closed.length);
