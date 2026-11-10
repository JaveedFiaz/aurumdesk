// The auto-trader. You give it an amount; it takes trade-finder setups that
// meet your grade, sizes each one to your risk %, and manages stop and target
// on every price tick. Orders go through a broker object: today that is the
// paper broker (simulated fills, no money involved). A live broker (OANDA,
// MetaTrader) implements the same fill() call later.

const GRADE_RANK = { A: 0, B: 1, C: 2 };
const DAY = 86400;

// Simulated fills: you pay half the spread on the way in and half on the way out.
export function paperBroker({ cost = 0.4 } = {}) {
  return {
    name: 'paper',
    live: false,
    fill: (dir, price, opening) => {
      const adverse = (dir === 'bull') === opening ? 1 : -1;
      return price + (adverse * cost) / 2;
    },
  };
}

const DEFAULTS = {
  enabled: false,
  startBalance: 10000,
  balance: 10000,
  riskPct: 1,
  minGrade: 'C',
  maxOpen: 2,
  dailyLossPct: 3,
  maxHours: 16,
};

export const LIMITS = {
  startBalance: [100, 10_000_000],
  riskPct: [0.1, 5],
  maxOpen: [1, 5],
  dailyLossPct: [0.5, 20],
};

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
      return saved ? { ...DEFAULTS, ...saved } : null;
    } catch {
      return null;
    }
  }

  function save() {
    if (!storage) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        storage.save(state);
      } catch { /* storage full or read-only: keep running in memory */ }
    }, 500);
    saveTimer.unref?.();
  }

  function log(msg) {
    state.log.unshift({ t: Math.floor(now()), msg });
    state.log.length = Math.min(state.log.length, 100);
  }

  function unrealized(price) {
    if (!Number.isFinite(price)) return 0;
    return state.positions.reduce((s, p) => s + (p.dir === 'bull' ? 1 : -1) * (broker.fill(p.dir, price, false) - p.entry) * p.units, 0);
  }

  // Daily loss limit: no new trades once today's realized loss passes the limit.
  function dayGuard() {
    const key = Math.floor(now() / DAY);
    if (!state.day || state.day.key !== key) state.day = { key, start: state.balance };
    return state.balance - state.day.start > -(state.day.start * state.dailyLossPct) / 100;
  }

  function close(p, price, reason) {
    const exit = broker.fill(p.dir, price, false);
    const pnl = (p.dir === 'bull' ? 1 : -1) * (exit - p.entry) * p.units;
    state.balance += pnl;
    state.positions = state.positions.filter((x) => x !== p);
    state.history.unshift({ ...p, exit, exitTime: Math.floor(now()), reason, pnl, r: pnl / p.riskCash });
    state.history.length = Math.min(state.history.length, 500);
    log(`Closed ${p.dir === 'bull' ? 'LONG' : 'SHORT'} at ${exit.toFixed(2)} (${reason}): ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
  }

  return {
    broker: broker.name,

    snapshot(price) {
      const u = unrealized(price);
      const closed = state.history;
      const wins = closed.filter((h) => h.pnl > 0).length;
      const { taken, ...rest } = state;
      return {
        ...rest,
        broker: broker.name,
        live: broker.live,
        unrealized: u,
        equityNow: state.balance + u,
        returnPct: ((state.balance + u) / state.startBalance - 1) * 100,
        trades: closed.length,
        winRate: closed.length ? wins / closed.length : 0,
        limits: LIMITS,
      };
    },

    configure(patch = {}) {
      const num = (k) => {
        if (patch[k] == null) return;
        const v = +patch[k];
        if (!Number.isFinite(v)) throw Object.assign(new Error(`${k} must be a number`), { status: 400 });
        const [lo, hi] = LIMITS[k];
        if (v < lo || v > hi) throw Object.assign(new Error(`${k} must be between ${lo} and ${hi}`), { status: 400 });
        return v;
      };
      const amount = num('startBalance');
      if (amount != null && amount !== state.startBalance) {
        if (state.positions.length) throw Object.assign(new Error('Close open trades before changing the amount'), { status: 409 });
        const keep = { riskPct: state.riskPct, minGrade: state.minGrade, maxOpen: state.maxOpen, dailyLossPct: state.dailyLossPct, enabled: state.enabled };
        state = { ...fresh(amount), ...keep };
        log(`Account funded with $${amount.toLocaleString('en-US')}`);
      }
      for (const k of ['riskPct', 'maxOpen', 'dailyLossPct']) {
        const v = num(k);
        if (v != null) state[k] = k === 'maxOpen' ? Math.round(v) : v;
      }
      if (patch.minGrade != null) {
        if (!(patch.minGrade in GRADE_RANK)) throw Object.assign(new Error('minGrade must be A, B or C'), { status: 400 });
        state.minGrade = patch.minGrade;
      }
      save();
    },

    start() {
      state.enabled = true;
      log('Auto-trader started');
      save();
    },

    stop({ closeAll = false, price } = {}) {
      state.enabled = false;
      if (closeAll && Number.isFinite(price)) for (const p of [...state.positions]) close(p, price, 'manual');
      log(closeAll ? 'Stopped and closed all trades' : 'Auto-trader stopped (open trades keep their stop and target)');
      save();
    },

    reset(amount = state.startBalance) {
      state = fresh(amount);
      log(`Account reset to $${amount.toLocaleString('en-US')}`);
      save();
    },

    get enabled() {
      return state.enabled;
    },

    // New setups from the trade finder (signals whose entry is the next open).
    onSignals(signals, price) {
      if (!state.enabled || !Number.isFinite(price)) return;
      for (const s of signals) {
        const id = `${s.strategy}:${s.signalTime}`;
        if (s.status !== 'pending' || !s.active || state.taken.includes(id)) continue;
        state.taken.unshift(id);
        state.taken.length = Math.min(state.taken.length, 200);
        if (GRADE_RANK[s.grade] > GRADE_RANK[state.minGrade]) continue;
        if (state.positions.length >= state.maxOpen) {
          log(`Skipped ${s.strategy}: ${state.maxOpen} trades already open`);
          continue;
        }
        if (!dayGuard()) {
          log(`Skipped ${s.strategy}: daily loss limit reached`);
          continue;
        }
        const bull = s.dir === 'bull';
        const entry = broker.fill(s.dir, price, true);
        const risk = bull ? entry - s.stop : s.stop - entry;
        const reward = bull ? s.target - entry : entry - s.target;
        if (!(risk > 0) || reward / risk < 1.5) {
          log(`Skipped ${s.strategy}: price moved too far from the setup`);
          continue;
        }
        const riskCash = (state.balance * state.riskPct) / 100;
        const units = Math.floor((riskCash / risk) * 100) / 100; // ounces, 0.01 oz steps
        if (units <= 0) continue;
        state.positions.push({
          id, strategy: s.strategy, dir: s.dir, grade: s.grade, score: s.score,
          entry, stop: s.stop, target: s.target, units, lots: units / 100,
          riskCash: units * risk, openTime: Math.floor(now()), why: s.why,
        });
        log(`Opened ${bull ? 'LONG' : 'SHORT'} ${units.toFixed(2)} oz at ${entry.toFixed(2)} · grade ${s.grade} · risk $${(units * risk).toFixed(2)}`);
      }
      save();
    },

    // Every price tick: stops, targets, time stop, equity curve.
    onPrice(price) {
      if (!Number.isFinite(price)) return;
      let changed = false;
      for (const p of [...state.positions]) {
        const bull = p.dir === 'bull';
        if (bull ? price <= p.stop : price >= p.stop) close(p, p.stop, 'stop');
        else if (bull ? price >= p.target : price <= p.target) close(p, p.target, 'target');
        else if (now() - p.openTime > state.maxHours * 3600) close(p, price, 'time');
        else continue;
        changed = true;
      }
      const t = Math.floor(now());
      const last = state.equity[state.equity.length - 1];
      if (changed || !last || t - last.t >= 300) {
        state.equity.push({ t, v: Math.round((state.balance + unrealized(price)) * 100) / 100 });
        if (state.equity.length > 3000) state.equity.splice(0, state.equity.length - 3000);
        changed = true;
      }
      if (changed) save();
    },
  };
}
