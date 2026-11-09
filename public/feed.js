// Data access for the self-hosted app: the Node server's APIs and price stream.

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(j.error || `${res.status} ${res.statusText}`), { status: res.status });
  return j;
}

export const feed = {
  config: () => getJSON('/api/config'),
  candles: async (tf, limit) => (await getJSON(`/api/candles?tf=${tf}&limit=${limit}`)).candles,
  bot: () => getJSON('/api/bot'),
  flow: (tf) => getJSON(`/api/flow?tf=${tf}`),
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
};
