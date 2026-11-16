// Memecoin universe for the radar, found automatically from Binance:
//   - futures: USDT perpetuals whose underlying category (underlyingSubType) is "Meme";
//   - new: every USDT perpetual listed in the last NEW_DAYS days;
//   - spot: USDT pairs whose coin is a futures meme, tagged "Meme" on Binance's
//     product list, or on the fallback list.
// Plus a small proxy for futures data, for browsers that cannot reach Binance
// Futures directly.

const FAPI = 'https://fapi.binance.com';
const SPOT = 'https://data-api.binance.vision';
const PRODUCTS = 'https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true';
const NEW_DAYS = 21;
export const FALLBACK = ['DOGE', 'SHIB', 'PEPE', 'FLOKI', 'BONK', 'WIF', 'BOME', 'MEME', 'TURBO', 'NEIRO', 'PEOPLE', 'PNUT', 'ACT',
  '1000SATS', 'DOGS', 'TRUMP', '1000CAT', '1MBABYDOGE', 'PENGU', 'BROCCOLI714', '1000CHEEMS', 'TST', 'MUBARAK'];

// "1000PEPE" -> "PEPE", "1MBABYDOGE" -> "BABYDOGE", "1000000MOG" -> "MOG".
export const coinOf = (base) => base.replace(/^(1000000|1000|1M)(?=[A-Z])/, '');

export function buildUniverse({ spotInfo, futInfo, products, now = Date.now() }) {
  const spotPairs = new Map();
  for (const s of spotInfo?.symbols || []) {
    if (s.status === 'TRADING' && s.quoteAsset === 'USDT') spotPairs.set(s.baseAsset, s.symbol);
  }
  const perps = (futInfo?.symbols || []).filter((s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT');
  const isMeme = (s) => (s.underlyingSubType || []).some((t) => /meme/i.test(t));
  const futures = perps.filter(isMeme).map((s) => ({ symbol: s.symbol, name: s.baseAsset, coin: coinOf(s.baseAsset), onboard: s.onboardDate || null }));
  const fresh = perps.filter((s) => s.onboardDate && now - s.onboardDate < NEW_DAYS * 86400000)
    .map((s) => ({ symbol: s.symbol, name: s.baseAsset, coin: coinOf(s.baseAsset), onboard: s.onboardDate, meme: isMeme(s) }))
    .sort((a, b) => b.onboard - a.onboard);
  const memeCoins = new Set(futures.map((f) => f.coin));
  for (const p of products?.data || []) if (p.q === 'USDT' && (p.tags || []).some((t) => /meme/i.test(t))) memeCoins.add(coinOf(p.b));
  for (const b of FALLBACK) memeCoins.add(coinOf(b));
  const spot = [];
  for (const [base, symbol] of spotPairs) if (memeCoins.has(coinOf(base))) spot.push({ symbol, name: base, coin: coinOf(base) });
  return { at: now, spot, futures, fresh, sources: { spotInfo: !!spotInfo, futInfo: !!futInfo, products: !!products } };
}

export function createMemeUniverse({ fetchImpl = (...a) => fetch(...a), log = () => {} } = {}) {
  let cache = null;
  let pending = null;
  const get = async (url) => {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0 PulseScalper' } });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const small = new Map(); // proxy cache: url -> { at, data }

  return {
    async universe() {
      if (cache && Date.now() - cache.at < 30 * 60000) return cache;
      if (pending) return pending;
      pending = (async () => {
        const [spotInfo, futInfo, products] = await Promise.all([
          get(`${SPOT}/api/v3/exchangeInfo?permissions=SPOT`), get(`${FAPI}/fapi/v1/exchangeInfo`), get(PRODUCTS),
        ]);
        const u = buildUniverse({ spotInfo, futInfo, products });
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
