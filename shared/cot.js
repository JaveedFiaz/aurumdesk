// Commitments of Traders (CFTC), gold futures on COMEX (contract code 088691).
// Published every Friday for positions held on the Tuesday before. It is the
// only public view of what the biggest players hold:
//  - large speculators (hedge funds, CTAs): "non-commercial"
//  - commercials (producers, bullion banks, hedgers)

const DAY = 86400;
// Tuesday positions are released Friday 15:30 New York, about 3 days 20 hours later.
export const COT_DELAY = 3 * DAY + 20 * 3600;

// Rows from the CFTC public reporting API (legacy futures-only report).
export function parseCot(rows) {
  return rows
    .map((r) => {
      const date = Date.parse(`${String(r.report_date_as_yyyy_mm_dd).slice(0, 10)}T00:00:00Z`) / 1000;
      const specLong = +r.noncomm_positions_long_all;
      const specShort = +r.noncomm_positions_short_all;
      const commLong = +r.comm_positions_long_all;
      const commShort = +r.comm_positions_short_all;
      return {
        date,
        availableAt: date + COT_DELAY,
        specLong,
        specShort,
        specNet: specLong - specShort,
        commLong,
        commShort,
        commNet: commLong - commShort,
        openInterest: +r.open_interest_all,
      };
    })
    .filter((r) => Number.isFinite(r.date) && Number.isFinite(r.specNet) && Number.isFinite(r.commNet))
    .sort((a, b) => a.date - b.date);
}

// COT index: where the current net position sits in its range over the
// lookback (0 = most bearish in 3 years, 100 = most bullish).
function index(values, i, lookback) {
  const win = values.slice(Math.max(0, i - lookback + 1), i + 1);
  const lo = Math.min(...win);
  const hi = Math.max(...win);
  return hi > lo ? ((values[i] - lo) / (hi - lo)) * 100 : 50;
}

export function cotMetrics(series, { lookback = 156 } = {}) {
  const spec = series.map((r) => r.specNet);
  const comm = series.map((r) => r.commNet);
  return series.map((r, i) => ({
    ...r,
    specIndex: index(spec, i, lookback),
    commIndex: index(comm, i, lookback),
    specChange: i ? r.specNet - series[i - 1].specNet : 0,
    commChange: i ? r.commNet - series[i - 1].commNet : 0,
  }));
}

// Funds adding to longs (net rising) is bullish pressure; cutting is bearish.
export function cotBias(row) {
  if (!row) return null;
  if (row.specChange > 0) return 'bull';
  if (row.specChange < 0) return 'bear';
  return null;
}

// Latest report that had been published by time t.
export function cotAt(metrics, t) {
  let lo = 0;
  let hi = metrics.length - 1;
  let ans = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (metrics[mid].availableAt <= t) {
      ans = metrics[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

// Synthetic weekly reports for the demo feed. Not real CFTC data.
export function demoCot(now, weeks = 160) {
  const lastTue = Math.floor((now - COT_DELAY - 5 * DAY) / (7 * DAY)) * 7 * DAY + 5 * DAY;
  const rows = [];
  for (let k = weeks - 1; k >= 0; k--) {
    const date = lastTue - k * 7 * DAY;
    const w = date / (7 * DAY);
    const specNet = Math.round(160000 + 90000 * Math.sin(w / 9) + 25000 * Math.sin(w / 2.3));
    const specShort = 60000 + Math.round(10000 * Math.cos(w / 5));
    const commNet = Math.round(-specNet * 1.08 + 8000 * Math.sin(w / 3));
    const commShort = 300000;
    rows.push({
      report_date_as_yyyy_mm_dd: new Date(date * 1000).toISOString().slice(0, 10),
      noncomm_positions_long_all: specNet + specShort,
      noncomm_positions_short_all: specShort,
      comm_positions_long_all: commShort + commNet,
      comm_positions_short_all: commShort,
      open_interest_all: 520000 + Math.round(30000 * Math.sin(w / 7)),
    });
  }
  return parseCot(rows);
}
