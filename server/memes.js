// Memecoin universe for the radar, found automatically from Binance:
//   - futures: USDT perpetuals whose underlying category (underlyingSubType) is "Meme";
//   - new: every USDT perpetual listed in the last NEW_DAYS days;
//   - spot: USDT pairs whose coin is a futures meme, tagged "Meme" on Binance's
//     product list, or on the fallback list.
// Plus a small proxy for futures data, for browsers that cannot reach Binance
// Futures directly.

import { buildUniverse } from '../shared/memeuniverse.js';

export { buildUniverse, coinOf, FALLBACK } from '../shared/memeuniverse.js';

const FAPI = 'https://fapi.binance.com';
const SPOT = 'https://data-api.binance.vision';
const PRODUCTS = 'https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true';
export function createMemeUniverse({ fetchImpl = (...a) => fetch(...a), log = () => {} } = {}) {
  let cache = null;
  let pending = null;
  const errors = {};
  const get = async (url) => {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(25000), headers: { 'User-Agent': 'Mozilla/5.0 PulseScalper' } });
      if (!res.ok) {
        errors[url.split('?')[0]] = `HTTP ${res.status}`;
        return null;
      }
      return await res.json();
    } catch (e) {
      errors[url.split('?')[0]] = e.message;
      return null;
    }
  };
  const small = new Map(); // proxy cache: url -> { at, data }

  return {
    async universe() {
      // A full list is kept 30 minutes; one with a missing source is retried after 2.
      if (cache && Date.now() - cache.at < (cache.complete ? 30 * 60000 : 2 * 60000)) return cache;
      if (pending) return pending;
      pending = (async () => {
        const [spotInfo, futInfo, products] = await Promise.all([
          get(`${SPOT}/api/v3/exchangeInfo?permissions=SPOT`), get(`${FAPI}/fapi/v1/exchangeInfo`), get(PRODUCTS),
        ]);
        const u = buildUniverse({ spotInfo, futInfo, products });
        u.complete = !!(spotInfo && futInfo);
        u.errors = { ...errors };
        // Keep the last good futures list if Binance Futures did not answer this time.
        if (!futInfo && cache) Object.assign(u, { futures: cache.futures, fresh: cache.fresh });
        log(`Memecoin universe: ${u.spot.length} spot, ${u.futures.length} futures, ${u.fresh.length} new listings`);
        cache = u;
        pending = null;
        return u;
      })();
      return pending;
    },
    // Read-only futures data for browsers that cannot reach Binance Futures.
    async futures(kind, q) {
      const sym = String(q.get('symbol') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      let url;
      let ttl = 5000;
      if (kind === 'klines') url = `${FAPI}/fapi/v1/klines?symbol=${sym}&interval=1m&limit=${Math.min(120, +q.get('limit') || 90)}`;
      else if (kind === 'premium') {
        url = `${FAPI}/fapi/v1/premiumIndex`;
        ttl = 30000;
      } else if (kind === 'ticker') {
        url = `${FAPI}/fapi/v1/ticker/24hr`;
        ttl = 30000;
      } else if (kind === 'oi') {
        url = `${FAPI}/futures/data/openInterestHist?symbol=${sym}&period=5m&limit=13`;
        ttl = 60000;
      } else throw Object.assign(new Error('Unknown futures data'), { status: 400 });
      if ((kind === 'klines' || kind === 'oi') && !sym) throw Object.assign(new Error('symbol required'), { status: 400 });
      const hit = small.get(url);
      if (hit && Date.now() - hit.at < ttl) return hit.data;
      const data = await get(url);
      if (data == null) throw Object.assign(new Error('Binance Futures did not answer'), { status: 502 });
      small.set(url, { at: Date.now(), data });
      if (small.size > 500) small.delete(small.keys().next().value);
      return data;
    },
  };
}
