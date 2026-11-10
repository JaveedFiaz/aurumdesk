// npm run backtest [-- --bars 10000 --demo --json]
// Backtests every strategy on the configured provider and prints the ranking.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProvider } from './providers/index.js';
import { runBot } from '../shared/bot.js';
import { createCotSource } from './cot.js';
import { STRATEGIES, RETIRED } from '../shared/strategies.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const args = process.argv.slice(2);
const arg = (name, d) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : d;
};
if (args.includes('--demo')) process.env.PROVIDER = 'demo';

const provider = createProvider(process.env);
const history = +arg('bars', process.env.BOT_HISTORY || 70000);
const t0 = Date.now();
const cotSource = createCotSource({ demo: !!provider.demo });
const cot = await cotSource.get();
const include = args.includes('--all') ? [...STRATEGIES, ...RETIRED] : STRATEGIES;
const r = await runBot({ provider, history, cot, full: true, include });

if (args.includes('--json')) {
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
}

const d = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
const pad = (s, n) => String(s).padEnd(n);
const num = (v, dp = 2) => (Number.isFinite(v) ? v.toFixed(dp) : '∞');

console.log(`\nAurum Pulse backtest — ${r.provider}${r.demo ? ' (SYNTHETIC DEMO DATA)' : ''}`);
console.log(`15m with 1H confirmation · ${d(r.from)} → ${d(r.to)} UTC (${r.days} days) · London/NY sessions`);
console.log(`Targets: ${include.map((x) => `${x.name} ${x.rr ?? r.rules.rr}R`).join(', ')}\nCost $${r.rules.cost}/oz per trade · max ${r.rules.maxPerDay}/day per strategy · ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
console.log(`${pad('Strategy', 23)}${pad('Trades', 8)}${pad('Win %', 8)}${pad('PF', 7)}${pad('Avg R', 8)}${pad('Total R', 9)}${pad('Max DD', 8)}${pad('OOS R', 8)}Status`);
for (const s of r.stats) {
  console.log(`${pad(s.name, 23)}${pad(s.trades, 8)}${pad((s.winRate * 100).toFixed(0), 8)}${pad(num(s.pf), 7)}${pad(num(s.expR), 8)}${pad(num(s.totalR, 1), 9)}${pad(num(s.maxDD, 1), 8)}${pad(num(s.outSample.expR), 8)}${s.active ? 'ACTIVE' : 'off'}`);
}
// Every strategy split by confluence grade.
const cell = (list) => {
  if (!list.length) return pad('—', 22);
  const w = list.filter((t) => t.r > 0).length / list.length;
  const e = list.reduce((x, t) => x + t.r, 0) / list.length;
  return pad(`${list.length} · ${(w * 100).toFixed(0)}% · ${e >= 0 ? '+' : ''}${e.toFixed(2)}R`, 22);
};
console.log(`\nBy confluence grade (trades · win % · avg R)`);
console.log(`${pad('Strategy', 23)}${pad('Grade A (70+)', 22)}${pad('Grade B (50-69)', 22)}${pad('Grade C (<50)', 22)}`);
for (const st of include) {
  const mine = r.closed.filter((t) => t.strategy === st.id);
  console.log(`${pad(st.name, 23)}${['A', 'B', 'C'].map((g) => cell(mine.filter((t) => t.grade === g))).join('')}`);
}
console.log(`${pad('All strategies', 23)}${['A', 'B', 'C'].map((g) => cell(r.closed.filter((t) => t.grade === g))).join('')}`);
console.log(`\nData: candles ${r.provider}${r.orderFlow ? ' with order flow' : ' (no order flow: delta/CVD factors skipped)'} · COT ${cot ? cotSource.label : 'unavailable (factor skipped)'}`);
console.log(`\nActive = ${r.approval.minTrades}+ trades, profit factor ≥ ${r.approval.minPF}, avg ≥ ${r.approval.minExpR}R, and still profitable on the last ${r.approval.oosShare * 100}% of the period (OOS).`);
console.log('R = multiples of the amount risked. At 1% risk per trade, +10R ≈ +10% on the account.');
if (r.signals.length) {
  console.log('\nLive setups:');
  for (const t of r.signals) {
    console.log(`  ${t.status === 'pending' ? 'NEW ' : 'OPEN'} ${t.dir === 'bull' ? 'LONG ' : 'SHORT'} ${pad(t.strategy, 14)} entry ${num(t.entry)} SL ${num(t.stop)} TP ${num(t.target)}  ${t.why}`);
  }
} else {
  console.log('\nNo live setups from active strategies right now.');
}
console.log('\nPast results do not guarantee future results. Not financial advice.\n');
