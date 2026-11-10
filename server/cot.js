// Fetches the CFTC Commitments of Traders report for COMEX gold from the
// CFTC's public reporting API (no key needed) and caches it for six hours.

import { cotMetrics, demoCot, parseCot } from '../shared/cot.js';

const CFTC = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';
const GOLD = '088691';
const TTL = 6 * 3600 * 1000;

export function createCotSource({ demo = false, now = () => Date.now() / 1000 } = {}) {
  let cache = null;
  return {
    label: demo ? 'Demo COT (synthetic)' : 'CFTC Commitments of Traders · COMEX gold',
    demo,
    // Resolves to weekly metrics, or null when the CFTC API is unreachable.
    async get() {
      if (cache && Date.now() - cache.at < TTL) return cache.promise;
      const promise = (async () => {
        if (demo) return cotMetrics(demoCot(now()));
        const q = new URLSearchParams({
          $where: `cftc_contract_market_code='${GOLD}'`,
          $order: 'report_date_as_yyyy_mm_dd DESC',
          $limit: '400',
        });
        const res = await fetch(`${CFTC}?${q}`);
        if (!res.ok) throw new Error(`CFTC ${res.status}`);
        const rows = parseCot(await res.json());
        if (rows.length < 10) throw new Error('CFTC returned too few reports');
        return cotMetrics(rows);
      })().catch(() => null);
      cache = { at: Date.now(), promise };
      // Retry failures after a minute instead of six hours.
      promise.then((v) => {
        if (!v && cache?.promise === promise) cache.at = Date.now() - TTL + 60000;
      });
      return promise;
    },
  };
}
