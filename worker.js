const GOLD_URLS = {
  k24: 'https://goldpricez.com/eg/24k/gram',
  k21: 'https://goldpricez.com/eg/21k/gram',
  k18: 'https://goldpricez.com/eg/18k/gram'
};
const CURRENCIES = {
  usd: 'USD', eur: 'EUR', gbp: 'GBP', sar: 'SAR', aed: 'AED', kwd: 'KWD'
};
const EGX_SYMBOLS = ['COMI','TMGH','SWDY','ETEL','EAST','HRHO','ABUK','MFPC','SKPC','ORAS'];
const GLOBAL_SYMBOLS = ['NVDA','AAPL','MSFT','GOOGL','AMZN','META','AVGO','TSLA','BRK-B','LLY','GC=F'];

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=45', ...extra }
});

async function cachedFetch(url, options = {}, ttl = 60) {
  const response = await fetch(url, { ...options, cf: { cacheTtl: ttl, cacheEverything: true, ...(options.cf || {}) } });
  if (!response.ok) throw new Error(`${new URL(url).hostname}: HTTP ${response.status}`);
  return response;
}

function extract(html, id) {
  const safe = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`id=["']${safe}["'][^>]*>\\s*([^<]+)`, 'i'),
    new RegExp(`id=["']${safe}["'][^>]*value=["']([^"']+)`, 'i')
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      const n = Number(String(m[1]).replace(/[^0-9.-]/g, ''));
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

function parseGoldPagePrice(html) {
  const byId = extract(html, 'priceGram');
  if (byId) return byId;
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ');
  const match = text.match(/Open:\s*([0-9,]+(?:\.[0-9]+)?)\s*EGP/i)
    || text.match(/Current Price\s*[:|]?\s*([0-9,]+(?:\.[0-9]+)?)/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function getGold() {
  const entries = await Promise.all(Object.entries(GOLD_URLS).map(async ([key, url]) => {
    const html = await (await cachedFetch(url, { headers: { 'user-agent': 'Mozilla/5.0 EGY-PRICE/1.0', accept: 'text/html' } }, 120)).text();
    const price = parseGoldPagePrice(html);
    const bid = extract(html, 'bidGram');
    const ask = extract(html, 'askGram');
    const ounce = extract(html, 'priceOunce');
    if (!price) throw new Error(`Gold source parse failed (${key})`);
    return [key, { price, bid, ask, ounce }];
  }));
  const prices = Object.fromEntries(entries);
  const k24 = prices.k24;
  return {
    k24: k24.price,
    k21: prices.k21.price,
    k18: prices.k18.price,
    coin: prices.k21.price * 8,
    usdOunceEGP: k24.ounce,
    source: 'GoldPriceZ',
    updatedAt: new Date().toISOString()
  };
}

async function getCurrencies() {
  const symbols = ['EGP', ...Object.values(CURRENCIES)].join(',');
  const url = `https://api.frankfurter.dev/v1/latest?base=USD&symbols=${symbols}`;
  const data = await (await cachedFetch(url, {}, 3600)).json();
  const egpPerUsd = data.rates?.EGP;
  if (!egpPerUsd) throw new Error('FX source did not return EGP');
  const rates = {};
  for (const [key, code] of Object.entries(CURRENCIES)) {
    const unitsPerUsd = code === 'USD' ? 1 : data.rates?.[code];
    if (unitsPerUsd) rates[key] = {
      rate: egpPerUsd / unitsPerUsd,
      source: 'Frankfurter · reference rate',
      updatedAt: data.date || new Date().toISOString()
    };
  }
  return rates;
}

async function getBitcoin() {
  const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_last_updated_at=true';
  const data = await (await cachedFetch(url, {}, 60)).json();
  const value = data.bitcoin?.usd;
  if (!value) throw new Error('CoinGecko returned no BTC price');
  return { bitcoin: value, source: 'CoinGecko', updatedAt: data.bitcoin.last_updated_at ? new Date(data.bitcoin.last_updated_at * 1000).toISOString() : new Date().toISOString() };
}

async function yahooQuote(symbol) {
  const encoded = encodeURIComponent(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?range=1d&interval=5m&includePrePost=false`;
  const data = await (await cachedFetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } }, 90)).json();
  const result = data.chart?.result?.[0];
  const price = result?.meta?.regularMarketPrice;
  if (!Number.isFinite(price)) throw new Error(`No Yahoo quote for ${symbol}`);
  const previous = result.meta.chartPreviousClose ?? result.meta.previousClose ?? price;
  return { price, change: price - previous, source: 'Yahoo Finance · delayed', updatedAt: new Date((result.meta.regularMarketTime || Date.now()/1000) * 1000).toISOString() };
}

async function getGlobal() {
  const pairs = await Promise.all(GLOBAL_SYMBOLS.map(async symbol => {
    try { return [symbol.replace('-', '.'), await yahooQuote(symbol)]; }
    catch (e) { return [symbol.replace('-', '.'), { error: String(e.message || e) }]; }
  }));
  return Object.fromEntries(pairs);
}

async function getEGX() {
  const url = 'https://scanner.tradingview.com/egypt/scan';
  const response = await cachedFetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'origin': 'https://www.tradingview.com', 'referer': 'https://www.tradingview.com/' },
    body: JSON.stringify({
      symbols: { tickers: EGX_SYMBOLS.map(s => `EGX:${s}`), query: { types: [] } },
      columns: ['name', 'close', 'change', 'change_abs', 'volume']
    })
  }, 90);
  const data = await response.json();
  const out = {};
  for (const row of (data.data || [])) {
    const symbol = String(row.s || '').split(':').pop();
    const values = row.d || [];
    const price = Number(values[1]);
    if (symbol && Number.isFinite(price) && price > 0) out[symbol] = {
      price, change: Number(values[2]) || 0,
      source: 'TradingView · delayed / unofficial', updatedAt: new Date().toISOString()
    };
  }
  return out;
}

async function marketResponse() {
  const tasks = await Promise.allSettled([getGold(), getCurrencies(), getBitcoin(), getGlobal(), getEGX()]);
  const [gold, currencies, crypto, global, egx] = tasks;
  const value = item => item.status === 'fulfilled' ? item.value : null;
  const notices = [];
  const labels = ['الذهب', 'العملات', 'البيتكوين', 'الأسهم العالمية', 'الأسهم المصرية'];
  tasks.forEach((item, i) => { if (item.status === 'rejected') notices.push(`${labels[i]}: ${item.reason?.message || 'المصدر غير متاح'}`); });
  const g = value(gold);
  const fx = value(currencies) || {};
  const btc = value(crypto);
  const globalQuotes = value(global) || {};
  const goldFuture = globalQuotes['GC=F'];
  if (goldFuture?.price) {
    g && (g.usdOunce = goldFuture.price);
    g && (g.usdSource = 'Yahoo Finance · Gold Futures');
  }
  const egxQuotes = value(egx) || {};
  if (!Object.keys(egxQuotes).length) notices.push('الأسهم المصرية: لا توجد قراءة متاحة حاليًا من الماسح العام.');
  if (!Object.keys(globalQuotes).some(k => globalQuotes[k]?.price)) notices.push('الأسهم العالمية: المصدر لم يرجع أسعارًا في هذه المحاولة.');
  return {
    generatedAt: new Date().toISOString(),
    gold: g,
    currencies: fx,
    crypto: btc,
    global: globalQuotes,
    egx: egxQuotes,
    notices
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/health') return json({ ok: true, service: 'EGY PRICE', time: new Date().toISOString() });
    if (url.pathname === '/api/market') {
      try {
        const data = await marketResponse();
        return json(data);
      } catch (error) {
        return json({ error: String(error?.message || error) }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
