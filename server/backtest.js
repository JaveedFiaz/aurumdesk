// npm run backtest [-- --demo --market gold|btc --tf M1|M5|M15 --costx 2]
// Backtests every play (market + timeframe + strategies) on real history and prints the results.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProviders } from './providers/index.js';
import { createCotSource } from './cot.js';
import { analyze, dropFormingCandle } from '../shared/bot.js';
import { getCandles } from '../shared/candles.js';
import { MARKETS } from '../shared/markets.js';
import { DEFAULT_RULES } from '../shared/strategies.js';
import { TF } from '../shared/timeframes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
const args = process.argv.slice(2);
const arg = (name, d) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : d);
if (args.includes('--demo')) process.env.PROVIDER = 'demo';

const { providers } = createProviders(process.env);
const cot = await createCotSource({ demo: !!providers.gold.demo }).get();
const costx = +arg('costx', 1);
const pad = (s, n) => String(s).padEnd(n);
const num = (v, dp = 2) => (Number.isFinite(v) ? v.toFixed(dp) : '∞');
const now = Date.now() / 1000;

console.log(`\nPulse Scalper backtest${providers.gold.demo ? ' (SYNTHETIC DEMO DATA)' : ''} · London/NY sessions · entry at next open · stop first on ties · cost ×${costx}\n`);
console.log(`${pad('Market', 9)}${pad('TF', 5)}${pad('Strategy', 20)}${pad('Days', 6)}${pad('Trades', 8)}${pad('Win %', 7)}${pad('PF', 7)}${pad('Avg R', 8)}${pad('Total R', 9)}${pad('Max DD', 8)}${pad('First 60%', 11)}${pad('Last 40%', 10)}Status`);
for (const m of MARKETS) {
  if (arg('market') && arg('market') !== m.id) continue;
  for (const [tf, play] of Object.entries(m.plays)) {
    if (arg('tf') && arg('tf') !== tf) continue;
    const p = providers[m.id];
    const hn = Math.ceil((play.history * TF[tf].sec) / TF[play.htf].sec) + 320;
    const c = dropFormingCandle(await getCandles(p, tf, play.history, { maxCandles: play.history + 100 }), TF[tf].sec, now);
    const h = dropFormingCandle(await getCandles(p, play.htf, hn, { maxCandles: hn + 100 }), TF[play.htf].sec, now);
    const cost = ((c.at(-1).close * m.costBps) / 10000) * costx;
    const r = analyze(c, h, { tf: { id: tf, sec: TF[tf].sec }, htf: { id: play.htf, sec: TF[play.htf].sec }, include: play.strategies, rules: { ...DEFAULT_RULES, cost, maxPerDay: tf === 'M15' ? 3 : 6 }, cot: m.id === 'gold' ? cot : null, now });
    for (const s of r.stats) {
      console.log(`${pad(m.label, 9)}${pad(TF[tf].label, 5)}${pad(`${s.name} ${s.rr}R`, 20)}${pad(r.days, 6)}${pad(s.trades, 8)}${pad((s.winRate * 100).toFixed(0), 7)}${pad(num(s.pf), 7)}${pad(num(s.expR), 8)}${pad(num(s.totalR, 1), 9)}${pad(num(s.maxDD, 1), 8)}${pad(`${num(s.inSample.expR)}R`, 11)}${pad(`${num(s.outSample.expR)}R`, 10)}${s.active ? 'TRADING' : 'watch only'}`);
    }
  }
}
console.log(`\nTRADING = ${20}+ trades, profit factor ≥ 1.15, average ≥ +0.05R, and profitable on the most recent 40% of the period.`);
console.log('R = multiples of the amount risked. Past results do not guarantee future results.\n');
