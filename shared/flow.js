// Order-flow analytics: who is aggressive (market buyers vs sellers), where the
// big players trade, and where resting liquidity sits in the order book.
// Pure functions, shared by the server, the browser and the backtest.

// Per-candle delta (market buys minus market sells) and cumulative delta (CVD).
// Needs candles with buyVolume (taker buy volume); returns [] otherwise.
export function deltaSeries(candles) {
  if (!candles.length || candles.every((c) => c.buyVolume == null)) return [];
  let cvd = 0;
  return candles.map((c) => {
    const buy = c.buyVolume ?? (c.volume || 0) / 2;
    const vol = c.volume || 0;
    const delta = 2 * buy - vol;
    cvd += delta;
    return { time: c.time, delta, cvd, buyPct: vol ? buy / vol : 0.5, volume: vol };
  });
}

// Delta of one candle as a share of its volume (-1 all selling … +1 all buying).
export function deltaRatio(c) {
  if (!c || c.buyVolume == null || !c.volume) return null;
  return (2 * c.buyVolume - c.volume) / c.volume;
}

function quantile(sorted, q) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[i];
}

// Large trades: the top 2% of recent trade sizes (and at least 5x the median).
export function whales(trades, { q = 0.98, minMultiple = 5, max = 30 } = {}) {
  if (!trades.length) return { threshold: 0, list: [], buyVol: 0, sellVol: 0 };
  const sizes = trades.map((t) => t.size).sort((a, b) => a - b);
  const threshold = Math.max(quantile(sizes, q), quantile(sizes, 0.5) * minMultiple);
  const big = trades.filter((t) => t.size >= threshold);
  return {
    threshold,
    list: big.slice(-max).reverse().map((t) => ({ ...t, notional: t.size * t.price })),
    buyVol: big.filter((t) => t.side === 'buy').reduce((s, t) => s + t.size, 0),
    sellVol: big.filter((t) => t.side === 'sell').reduce((s, t) => s + t.size, 0),
  };
}

// Aggressor split over a set of trades.
export function tradeFlow(trades) {
  let buy = 0;
  let sell = 0;
  for (const t of trades) {
    if (t.side === 'buy') buy += t.size;
    else sell += t.size;
  }
  const total = buy + sell;
  return { buy, sell, buyPct: total ? buy / total : 0.5, from: trades[0]?.time ?? null, to: trades[trades.length - 1]?.time ?? null };
}

// Order book: levels grouped into price buckets, the biggest resting orders
// ("walls"), and bid/ask imbalance near the price.
export function bookStats(book, { bucket = 1, range = 0.01, near = 0.0025, walls = 4 } = {}) {
  const bids = book?.bids || [];
  const asks = book?.asks || [];
  if (!bids.length || !asks.length) return null;
  const mid = (bids[0].price + asks[0].price) / 2;
  const group = (levels, dir) => {
    const map = new Map();
    for (const l of levels) {
      if (Math.abs(l.price - mid) > mid * range) continue;
      const key = dir < 0 ? Math.floor(l.price / bucket) * bucket : Math.ceil(l.price / bucket) * bucket;
      map.set(key, (map.get(key) || 0) + l.size);
    }
    return [...map].map(([price, size]) => ({ price, size })).sort((a, b) => (dir < 0 ? b.price - a.price : a.price - b.price));
  };
  const b = group(bids, -1);
  const a = group(asks, 1);
  const sizes = [...b, ...a].map((l) => l.size).sort((x, y) => x - y);
  const median = quantile(sizes, 0.5);
  const pick = (levels) => levels.filter((l) => l.size >= median * 2.5).sort((x, y) => y.size - x.size).slice(0, walls).sort((x, y) => x.price - y.price);
  const sum = (levels, lim) => levels.filter((l) => Math.abs(l.price - mid) <= mid * lim).reduce((s, l) => s + l.size, 0);
  const bidNear = sum(bids, near);
  const askNear = sum(asks, near);
  return {
    mid,
    spread: asks[0].price - bids[0].price,
    bids: b,
    asks: a,
    bidWalls: pick(b),
    askWalls: pick(a),
    imbalance: bidNear + askNear ? bidNear / (bidNear + askNear) : 0.5,
    maxSize: Math.max(...sizes, 0),
  };
}
