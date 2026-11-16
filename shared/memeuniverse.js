// Finds the memecoins to watch from Binance's own lists (shared by the server
// and the browser):
//   - futures: USDT perpetuals whose underlying category (underlyingSubType) is "Meme";
//   - new: every USDT perpetual listed in the last NEW_DAYS days;
//   - spot: USDT pairs whose coin is a futures meme, tagged "Meme" on Binance's
//     product list, or on the fallback list.

export const NEW_DAYS = 21;
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

