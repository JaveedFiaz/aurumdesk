// The auto-trader. It takes verified setups from every market and timeframe,
// sizes each one to the chosen risk %, and manages stop and target on every
// price tick. Orders go through a broker object: today that is the paper
// broker (simulated fills, no money involved). A live broker implements the
// same fill() call later.

const GRADE_RANK = { A: 0, B: 1, C: 2 };
const DAY = 86400;
const TF_SEC = { M1: 60, M5: 300, M15: 900 };

// Simulated fills: half the round-trip cost is paid on the way in, half on the way out.
export function paperBroker() {
  return {
    name: 'paper',
    live: false,
    fill: (dir, price, opening, cost = 0) => price + (((dir === 'bull') === opening ? 1 : -1) * cost) / 2,
  };
}

const DEFAULTS = {
  enabled: true,
  startBalance: 10000,
  balance: 10000,
  riskPct: 1,
  minGrade: 'C',
  maxOpen: 3, // per market
  dailyLossPct: 5,
  maxBars: 64, // time stop, in candles of the setup's timeframe
};

export const LIMITS = {
  startBalance: [100, 10_000_000],
  riskPct: [0.1, 5],
  maxOpen: [1, 5],
  dailyLossPct: [0.5, 20],
};

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

// storage: { load() -> saved state or null, save(state) }. Defaults to memory only.
export function createAutoTrader({ storage = null, broker = paperBroker(), now = () => Date.now() / 1000 } = {}) {
  let state = load() || fresh(DEFAULTS.startBalance);
  let saveTimer = null;

  function fresh(amount) {
    return { ...DEFAULTS, startBalance: amount, balance: amount, positions: [], history: [], equity: [{ t: Math.floor(now()), v: amount }], log: [], taken: [], day: null };
  }

  function load() {
    try {
      const saved = storage?.load();
      return saved && saved.v === 2 ? { ...DEFAULTS, ...saved } : null;
    } catch {
      return null;
    }
  }

  function save() {
    if (!storage) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        storage.save({ ...state, v: 2 });
      } catch { /* storage full or read-only: keep running in memory */ }
    }, 500);
    saveTimer.unref?.();
  }

  function log(msg) {
    state.log.unshift({ t: Math.floor(now()), msg });
    state.log.length = Math.min(state.log.length, 100);
  }

  const pnlAt = (p, price) => (p.dir === 'bull' ? 1 : -1) * (broker.fill(p.dir, price, false, p.cost) - p.entry) * p.units;

  function unrealized(prices = {}) {
    return state.positions.reduce((s, p) => s + (Number.isFinite(prices[p.market]) ? pnlAt(p, prices[p.market]) : 0), 0);
  }

  // Daily loss limit: no new trades once today's realized loss passes the limit.
  function dayGuard() {
    const key = Math.floor(now() / DAY);
    if (!state.day || state.day.key !== key) state.day = { key, start: state.balance };
    return state.balance - state.day.start > -(state.day.start * state.dailyLossPct) / 100;
  }

  function close(p, price, reason) {
    const exit = broker.fill(p.dir, price, false, p.cost);
    const pnl = (p.dir === 'bull' ? 1 : -1) * (exit - p.entry) * p.units;
    state.balance += pnl;
    state.positions = state.positions.filter((x) => x !== p);
    state.history.unshift({ ...p, exit, exitTime: Math.floor(now()), reason, pnl, r: pnl / p.riskCash });
    state.history.length = Math.min(state.history.length, 500);
    log(`Closed ${p.label} ${p.dir === 'bull' ? 'LONG' : 'SHORT'} at ${exit.toFixed(2)} (${reason}): ${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`);
  }

  return {
    broker: broker.name,

    snapshot(prices = {}) {
      const u = unrealized(prices);
      const closed = state.history;
      const wins = closed.filter((h) => h.pnl > 0);
      const gross = wins.reduce((s, h) => s + h.pnl, 0);
      const loss = -closed.filter((h) => h.pnl <= 0).reduce((s, h) => s + h.pnl, 0);
      const { taken, ...rest } = state;
      return {
        ...rest,
        history: closed.slice(0, 60),
        broker: broker.name,
        live: broker.live,
        unrealized: u,
        equityNow: state.balance + u,
        returnPct: ((state.balance + u) / state.startBalance - 1) * 100,
        trades: closed.length,
        winRate: closed.length ? wins.length / closed.length : 0,
        profitFactor: loss > 0 ? gross / loss : null,
        dayPnl: state.day && state.day.key === Math.floor(now() / DAY) ? state.balance - state.day.start : 0,
        limits: LIMITS,
      };
    },

    configure(patch = {}) {
      const num = (k) => {
        if (patch[k] == null) return undefined;
        const v = +patch[k];
        if (!Number.isFinite(v)) throw fail(`${k} must be a number`);
        const [lo, hi] = LIMITS[k];
        if (v < lo || v > hi) throw fail(`${k} must be between ${lo} and ${hi}`);
        return v;
      };
      const amount = num('startBalance');
      if (amount != null && amount !== state.startBalance) {
        if (state.positions.length) throw fail('Close open trades before changing the amount', 409);
        const keep = { riskPct: state.riskPct, minGrade: state.minGrade, maxOpen: state.maxOpen, dailyLossPct: state.dailyLossPct, enabled: state.enabled };
        state = { ...fresh(amount), ...keep };
        log(`Account funded with $${amount.toLocaleString('en-US')}`);
      }
      for (const k of ['riskPct', 'maxOpen', 'dailyLossPct']) {
        const v = num(k);
        if (v != null) state[k] = k === 'maxOpen' ? Math.round(v) : v;
      }
      if (patch.minGrade != null) {
        if (!(patch.minGrade in GRADE_RANK)) throw fail('minGrade must be A, B or C');
        state.minGrade = patch.minGrade;
      }
      save();
    },

    start() {
      state.enabled = true;
      log('Auto-trader started');
      save();
    },

    stop({ closeAll = false, prices = {} } = {}) {
      state.enabled = false;
      if (closeAll) for (const p of [...state.positions]) if (Number.isFinite(prices[p.market])) close(p, prices[p.market], 'manual');
      log(closeAll ? 'Stopped and closed all trades' : 'Auto-trader stopped (open trades keep their stop and target)');
      save();
    },

    reset(amount = state.startBalance) {
      const enabled = state.enabled;
      state = { ...fresh(amount), enabled };
      log(`Account reset to $${amount.toLocaleString('en-US')}`);
      save();
    },

    get enabled() {
      return state.enabled;
    },

    // New setups for one market. market: { id, label, costBps, step }.
    onSignals(signals, price, market, { pause = null } = {}) {
      if (!state.enabled || !Number.isFinite(price)) return;
      for (const s of signals) {
        const id = `${market.id}:${s.tf}:${s.strategy}:${s.signalTime}`;
        if (s.status !== 'pending' || !s.active || state.taken.includes(id)) continue;
        state.taken.unshift(id);
        state.taken.length = Math.min(state.taken.length, 400);
        if (GRADE_RANK[s.grade] > GRADE_RANK[state.minGrade]) continue;
        const name = `${market.label} ${s.tf} ${s.strategy}`;
        if (pause) {
          log(`Skipped ${name}: ${pause}`);
          continue;
        }
        if (state.positions.filter((p) => p.market === market.id).length >= state.maxOpen) {
          log(`Skipped ${name}: ${state.maxOpen} ${market.label} trades already open`);
          continue;
        }
        if (!dayGuard()) {
          log(`Skipped ${name}: daily loss limit reached`);
          continue;
        }
        const bull = s.dir === 'bull';
        const cost = (price * (market.costBps || 0)) / 10000;
        const entry = broker.fill(s.dir, price, true, cost);
        const risk = bull ? entry - s.stop : s.stop - entry;
        const reward = bull ? s.target - entry : entry - s.target;
        if (!(risk > 0) || reward / risk < 1.5) {
          log(`Skipped ${name}: price moved too far from the setup`);
          continue;
        }
        const step = market.step || 0.01;
        const units = Math.floor(((state.balance * state.riskPct) / 100 / risk) / step) * step;
        if (!(units > 0)) continue;
        state.positions.push({
          id, market: market.id, label: market.label, tf: s.tf, strategy: s.strategy, dir: s.dir, grade: s.grade, score: s.score,
          entry, stop: s.stop, target: s.target, units, cost, riskCash: units * risk,
          openTime: Math.floor(now()), maxSec: state.maxBars * (TF_SEC[s.tf] || 900), why: s.why,
        });
        log(`Opened ${market.label} ${bull ? 'LONG' : 'SHORT'} ${+units.toFixed(4)} @ ${entry.toFixed(2)} · ${s.tf} ${s.strategy} · risk $${(units * risk).toFixed(2)}`);
      }
      save();
    },

    // Every price tick of one market: stops, targets, time stop, equity curve.
    onPrice(price, marketId, prices = { [marketId]: price }) {
      if (!Number.isFinite(price)) return;
      let changed = false;
      for (const p of state.positions.filter((x) => x.market === marketId)) {
        const bull = p.dir === 'bull';
        if (bull ? price <= p.stop : price >= p.stop) close(p, p.stop, 'stop');
        else if (bull ? price >= p.target : price <= p.target) close(p, p.target, 'target');
        else if (now() - p.openTime > p.maxSec) close(p, price, 'time');
        else continue;
        changed = true;
      }
      const t = Math.floor(now());
      const last = state.equity[state.equity.length - 1];
      if (changed || !last || t - last.t >= 300) {
        state.equity.push({ t, v: Math.round((state.balance + unrealized(prices)) * 100) / 100 });
        if (state.equity.length > 3000) state.equity.splice(0, state.equity.length - 3000);
        changed = true;
      }
      if (changed) save();
    },
  };
}
