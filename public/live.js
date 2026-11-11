// Live market data straight from Binance, in the browser: candles, every trade,
// and the order book 10 times a second. Each viewer uses their own connection
// and IP, so nothing waits on the server or shares its rate limit.

const REST = 'https://data-api.binance.vision/api/v3';
const WS = 'wss://data-stream.binance.vision/stream?streams=';
const IV = { M1: '1m', M5: '5m', M15: '15m', H1: '1h', D1: '1d' };

const kline = (k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5], buyVolume: +k[9] });

async function get(path) {
  const res = await fetch(`${REST}${path}`);
  if (!res.ok) throw new Error(`Binance ${res.status}`);
  return res.json();
}

export const binance = {
  async candles(symbol, tf, limit = 600) {
    return (await get(`/klines?symbol=${symbol}&interval=${IV[tf]}&limit=${Math.min(1000, limit)}`)).map(kline);
  },
  async trades(symbol, limit = 1000) {
    return (await get(`/aggTrades?symbol=${symbol}&limit=${limit}`)).map((r) => ({ time: r.T / 1000, price: +r.p, size: +r.q, side: r.m ? 'sell' : 'buy' }));
  },
  async book(symbol, limit = 100) {
    const j = await get(`/depth?symbol=${symbol}&limit=${limit}`);
    const side = (rows) => rows.map(([p, q]) => ({ price: +p, size: +q }));
    return { bids: side(j.bids), asks: side(j.asks) };
  },

  // Streams the open candle, every trade, and the top 20 book levels for one
  // symbol + timeframe. Returns a function that closes the connection.
  // on: { candle(c), trade(t), book(b), state(connected) }
  connect(symbol, tf, on) {
    const s = symbol.toLowerCase();
    const url = `${WS}${s}@kline_${IV[tf]}/${s}@aggTrade/${s}@depth20@100ms`;
    let ws;
    let stopped = false;
    let delay = 1000;
    let timer;
    const open = () => {
      if (stopped) return;
      try {
        ws = new WebSocket(url);
      } catch {
        on.state?.(false);
        return;
      }
      ws.onopen = () => { delay = 1000; on.state?.(true); };
      ws.onmessage = (e) => {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        const d = m.data;
        if (!d) return;
        if (d.e === 'kline') {
          const k = d.k;
          on.candle?.({ time: Math.floor(k.t / 1000), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v, buyVolume: +k.V, closed: k.x });
        } else if (d.e === 'aggTrade') {
          on.trade?.({ time: d.T / 1000, price: +d.p, size: +d.q, side: d.m ? 'sell' : 'buy' });
        } else if (d.bids && d.asks) {
          const side = (rows) => rows.map(([p, q]) => ({ price: +p, size: +q }));
          on.book?.({ bids: side(d.bids), asks: side(d.asks) });
        }
      };
      ws.onclose = () => {
        if (stopped) return; // closed on purpose: a newer connection reports its own state
        on.state?.(false);
        timer = setTimeout(open, delay);
        delay = Math.min(delay * 2, 30000);
      };
      ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
    };
    open();
    return () => {
      stopped = true;
      clearTimeout(timer);
      try { ws?.close(); } catch { /* already closed */ }
    };
  },
};
