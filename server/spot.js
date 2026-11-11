// Live spot gold (XAU/USD) from Swissquote's public quote feed: no key, quotes
// are fractions of a second old and sit within cents of TradingView's spot
// gold. The strategies still run on PAXG candles (that is the history they
// were tested on), so the server tracks the gap between spot and PAXG
// ("basis") and the browser shifts everything it draws onto spot prices.

const URL_XAU = 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD';

// Mid price from the feed's quotes: the median over its platforms and spread profiles.
export function parseSpot(rows) {
  const mids = [];
  for (const r of rows || []) {
    for (const p of r.spreadProfilePrices || []) {
      const mid = (+p.bid + +p.ask) / 2;
      if (Number.isFinite(mid) && mid > 0) mids.push(mid);
    }
  }
  if (!mids.length) return null;
  mids.sort((a, b) => a - b);
  return Math.round(mids[Math.floor(mids.length / 2)] * 100) / 100;
}

export function createSpotGold({ fetchImpl = (...a) => fetch(...a), pollMs = 1000, url = URL_XAU } = {}) {
  let timer = null;
  let price = null;
  let at = 0;
  let fails = 0;
  return {
    get price() {
      return Date.now() - at < 30000 ? price : null; // stale quotes are not used
    },
    start(onPrice) {
      const tick = async () => {
        try {
          const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'PulseScalper/1.0' } });
          if (!res.ok) throw new Error(`Swissquote ${res.status}`);
          const p = parseSpot(await res.json());
          if (p != null) {
            fails = 0;
            at = Date.now();
            if (p !== price) {
              price = p;
              onPrice(p);
            }
          }
        } catch {
          fails++;
        }
        // Back off while the feed is failing (weekends, outages), up to 30 s.
        timer = setTimeout(tick, Math.min(30000, pollMs * 2 ** Math.min(fails, 5)));
        timer.unref?.();
      };
      tick();
    },
    stop: () => clearTimeout(timer),
  };
}
