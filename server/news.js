// News: free headline feeds (RSS) plus the weekly economic calendar. Feeds are
// polled every few seconds, so a headline shows up 1-5 s after the publisher
// puts it in the feed. Each headline is tagged with the market it matters to
// and a rough impact level from keywords.

const FEEDS = [
  { url: 'https://cointelegraph.com/rss', source: 'Cointelegraph' },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', source: 'CoinDesk' },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_marketpulse', source: 'MarketWatch' },
];
const CALENDAR = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

const HIGH = /\b(fed|fomc|powell|cpi|inflation|nfp|non-?farm|payrolls|rate (cut|hike|decision)|interest rates?|war|attack|sanction|tariff|sec |etf|hack|exploit|liquidat|crash|plunge|surge|soar|record high|all-time high|default|bank(ing)? crisis)\b/i;
const MED = /\b(gdp|pmi|jobless|unemployment|retail sales|treasury|yields?|dollar|dxy|ecb|boj|boe|central bank|opec|whale|outflow|inflow|halving|regulat)/i;
const GOLD = /\b(gold|xau|bullion|precious metal|fed|fomc|powell|cpi|inflation|payrolls|nfp|dollar|dxy|yields?|treasury|rate (cut|hike)|interest rates?|safe.haven|geopolit|war)\b/i;
const BTC = /\b(bitcoin|btc|crypto|ether|ethereum|etf|stablecoin|binance|coinbase|sec |miner|halving|fed|fomc|cpi|inflation)\b/i;
const BULL_GOLD = /\b(rate cut|dovish|weaker dollar|dollar (falls|slips|drops)|safe.haven|war|attack|inflation (rises|jumps|hot)|gold (rises|jumps|surges|gains|rallies))\b/i;
const BEAR_GOLD = /\b(rate (hike|increase)|hawkish|higher for longer|stronger than expected|stronger dollar|dollar (rises|climbs|jumps)|yields (rise|jump|climb)|gold (falls|drops|slips|slides|tumbles))\b/i;
const BULL_BTC = /\b(etf inflow|approv|rate cut|dovish|adopt|buys? (more )?bitcoin|bitcoin (rises|jumps|surges|gains|rallies)|record high|all-time high)\b/i;
const BEAR_BTC = /\b(hack|exploit|ban|lawsuit|sues|outflows?|liquidat\w*|rate (hike|increase)|hawkish|bitcoin (falls|drops|slips|slides|tumbles|plunges|declines)|declines|crash|low)\b/i;

const decode = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();

export function parseRss(xml, source) {
  const out = [];
  for (const m of xml.matchAll(/<(item|entry)\b[\s\S]*?<\/\1>/g)) {
    const block = m[0];
    const pick = (tag) => block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`))?.[1];
    const title = decode(pick('title') || '');
    const when = Date.parse(decode(pick('pubDate') || pick('published') || pick('updated') || '')) / 1000;
    const link = decode(pick('link') || '') || block.match(/<link[^>]*href="([^"]+)"/)?.[1] || '';
    if (title) out.push({ title, time: Number.isFinite(when) ? when : null, link: /^https?:\/\//.test(link) ? link : '', source });
  }
  return out;
}

export function classify(title) {
  const gold = GOLD.test(title);
  const btc = BTC.test(title);
  const impact = HIGH.test(title) ? 'high' : MED.test(title) ? 'med' : 'low';
  const bias = {};
  if (gold) bias.gold = BULL_GOLD.test(title) ? 'bull' : BEAR_GOLD.test(title) ? 'bear' : null;
  if (btc) bias.btc = BULL_BTC.test(title) ? 'bull' : BEAR_BTC.test(title) ? 'bear' : null;
  return { markets: [gold && 'gold', btc && 'btc'].filter(Boolean), impact, bias };
}

export function parseCalendar(rows, now) {
  return rows
    .filter((r) => r.impact === 'High' && ['USD', 'All'].includes(r.country))
    .map((r) => ({ title: r.title, time: Date.parse(r.date) / 1000, forecast: r.forecast || '', previous: r.previous || '' }))
    .filter((e) => Number.isFinite(e.time) && e.time > now - 3600)
    .sort((a, b) => a.time - b.time);
}

export function createNews({ fetchImpl = fetch, now = () => Date.now() / 1000, pollMs = 5000, demo = false } = {}) {
  const feeds = FEEDS.map((f) => ({ ...f }));
  const seen = new Map(); // title -> item
  let events = [];
  let timer = null;
  let k = 0;
  let calAt = 0;
  let lastOk = 0;

  async function pollFeed(feed) {
    // Conditional request: an unchanged feed answers 304 with no body.
    const cond = feed.etag ? { 'If-None-Match': feed.etag } : feed.modified ? { 'If-Modified-Since': feed.modified } : {};
    const res = await fetchImpl(feed.url, { headers: { 'User-Agent': 'AurumPulse/1.0 (+news reader)', Accept: 'application/rss+xml, application/xml, text/xml', ...cond }, signal: AbortSignal.timeout(8000) });
    if (res.status === 304) {
      lastOk = now();
      return;
    }
    if (res.status === 429 || res.status === 403) feed.skipUntil = Date.now() + 5 * 60000; // asked to slow down
    if (!res.ok) throw new Error(`${feed.source} ${res.status}`);
    feed.etag = res.headers?.get?.('etag') || null;
    feed.modified = res.headers?.get?.('last-modified') || null;
    const first = lastOk === 0;
    for (const it of parseRss(await res.text(), feed.source)) {
      const key = it.title.toLowerCase();
      if (seen.has(key)) continue;
      const c = classify(it.title);
      if (!c.markets.length) continue;
      // On the very first load, "seen" time is the publish time; afterwards it is when we saw it.
      seen.set(key, { ...it, ...c, time: it.time || now(), seenAt: first ? (it.time || now()) : now() });
    }
    lastOk = now();
    if (seen.size > 400) for (const key of [...seen.keys()].slice(0, seen.size - 300)) seen.delete(key);
  }

  async function tick() {
    if (demo) return;
    const feed = feeds[k++ % feeds.length];
    if (!(feed.skipUntil > Date.now())) await pollFeed(feed).catch(() => {});
    if (Date.now() - calAt > 30 * 60000) {
      calAt = Date.now();
      try {
        const res = await fetchImpl(CALENDAR, { signal: AbortSignal.timeout(8000) });
        if (res.ok) events = parseCalendar(await res.json(), now());
      } catch { calAt = Date.now() - 25 * 60000; }
    }
  }

  return {
    start() {
      if (timer || demo) return;
      // One feed per tick, so each feed is re-read every pollMs × feeds.
      const loop = () => tick().finally(() => { timer = setTimeout(loop, pollMs / feeds.length); timer.unref?.(); });
      loop();
    },
    stop: () => clearTimeout(timer),
    tick,
    list(limit = 40) {
      const t = now();
      if (demo) {
        return {
          ok: true, demo: true,
          items: [
            { title: 'Demo headline: Fed speaker says rates to stay higher for longer', source: 'Demo', time: t - 20, seenAt: t - 20, impact: 'high', markets: ['gold', 'btc'], bias: { gold: 'bear', btc: null }, link: '' },
            { title: 'Demo headline: Bitcoin ETF inflows climb for a third day', source: 'Demo', time: t - 300, seenAt: t - 300, impact: 'med', markets: ['btc'], bias: { btc: 'bull' }, link: '' },
          ],
          events: [{ title: 'Demo: US CPI', time: t + 7200, forecast: '0.3%', previous: '0.2%' }],
        };
      }
      const items = [...seen.values()].sort((a, b) => b.seenAt - a.seenAt).slice(0, limit);
      return { ok: lastOk > 0, items, events: events.filter((e) => e.time > t - 1800).slice(0, 8) };
    },
    // A reason to hold new trades (major scheduled news within the window), or null.
    pauseReason(windowSec = 300) {
      const t = now();
      const e = events.find((x) => Math.abs(x.time - t) <= windowSec);
      return e ? `high-impact news (${e.title})` : null;
    },
  };
}
