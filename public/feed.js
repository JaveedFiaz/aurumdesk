// Data access: the Node server's APIs, its price stream, and (for real-time
// whales and order flow) Binance's public trade stream straight from the browser.

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || `${res.status} ${res.statusText}`), { status: res.status });
  return j;
}

export const feed = {
  config: () => getJSON('/api/config'),
  candles: async (market, tf, limit) => (await getJSON(`/api/candles?market=${market}&tf=${tf}&limit=${limit}`)).candles,
  bot: (market) => getJSON(`/api/bot?market=${market}`),
  flow: (market, tf) => getJSON(`/api/flow?market=${market}&tf=${tf}`),
  news: () => getJSON('/api/news'),
  cot: () => getJSON('/api/cot'),
  paper: () => getJSON('/api/paper'),
  paperAction: (body, token) => getJSON('/api/paper', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Admin-Token': token } : {}) },
    body: JSON.stringify(body),
  }),
  subscribe(onMessage, onError) {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => onMessage(JSON.parse(e.data));
    es.onerror = onError;
  },
  // Every trade as it happens. streams: { marketId: 'BTCUSDT' }. Reconnects on its own.
  trades(streams, onTrade, onState) {
    const names = Object.entries(streams).filter(([, s]) => s);
    if (!names.length || !('WebSocket' in window)) return;
    const bySymbol = Object.fromEntries(names.map(([m, s]) => [s.toUpperCase(), m]));
    const url = `wss://data-stream.binance.vision/stream?streams=${names.map(([, s]) => `${s.toLowerCase()}@aggTrade`).join('/')}`;
    let delay = 1000;
    const open = () => {
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        return;
      }
      ws.onopen = () => { delay = 1000; onState(true); };
      ws.onmessage = (e) => {
        const d = JSON.parse(e.data).data;
        if (d && d.e === 'aggTrade') onTrade(bySymbol[d.s], { time: d.T / 1000, price: +d.p, size: +d.q, side: d.m ? 'sell' : 'buy' });
      };
      ws.onclose = () => { onState(false); setTimeout(open, delay); delay = Math.min(delay * 2, 30000); };
      ws.onerror = () => ws.close();
    };
    open();
  },
};
