// Data access for the self-hosted app: the Node server's candle API and price stream.

async function getJSON(url) {
  const res = await fetch(url);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `${res.status} ${res.statusText}`);
  return j;
}

export const feed = {
  config: () => getJSON('/api/config'),
  candles: async (tf, limit) => (await getJSON(`/api/candles?tf=${tf}&limit=${limit}`)).candles,
  subscribe(onMessage, onError) {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => onMessage(JSON.parse(e.data));
    es.onerror = onError;
  },
};
