// api/[...slug].js — Market Intelligence Serverless API v4.0
// Vercel Serverless adapter — todas as rotas do ml-proxy.js em produção

const https  = require('https');
const crypto = require('crypto');

// Credenciais via Vercel Environment Variables (ou fallback hardcoded para dev)
const GOOGLE_API_KEY   = process.env.GOOGLE_API_KEY   || 'AIzaSyATu2oEjkZCKdYsM_5vpbh3QH5-w6qRdzY';
const GOOGLE_CSE_ID    = process.env.GOOGLE_CSE_ID    || 'd1c98e55988a1421c';
const ML_CLIENT_ID     = process.env.ML_CLIENT_ID     || '6479487697668843';
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'NITdkMVYDIrP7gbituIMxXhuV3ZBMTLV';
const TIKTOK_APP_KEY    = process.env.TIKTOK_APP_KEY    || '';
const TIKTOK_APP_SECRET = process.env.TIKTOK_APP_SECRET || '';

// Cache de token ML (persiste em instâncias Lambda quentes)
let mlToken  = null;
let mlExpiry = 0;
let tikTokAccessToken = process.env.TIKTOK_ACCESS_TOKEN || '';

// ── Helpers ───────────────────────────────────────────────────────────────────
function httpsGet(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(9000, () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

function httpsGetHtml(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        const u = new URL(loc.startsWith('http') ? loc : `https://${options.hostname}${loc}`);
        return resolve(httpsGetHtml({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers: options.headers }));
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, html: data }));
    });
    req.on('error', reject);
    req.setTimeout(9000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Accept-Encoding': 'identity',
};

function extractNextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// ── Mercado Livre ─────────────────────────────────────────────────────────────
async function getMlToken() {
  if (mlToken && Date.now() < mlExpiry) return mlToken;
  const body = `grant_type=client_credentials&client_id=${ML_CLIENT_ID}&client_secret=${ML_CLIENT_SECRET}`;
  const r = await httpsGet({
    hostname: 'api.mercadolibre.com', path: '/oauth/token', method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) }
  }, body);
  mlToken  = r.body.access_token;
  mlExpiry = Date.now() + ((r.body.expires_in || 3600) - 300) * 1000;
  return mlToken;
}

async function mlSearch(q, limit = 10, sort = 'sold_quantity_desc') {
  const token = await getMlToken();
  const r = await httpsGet({
    hostname: 'api.mercadolibre.com',
    path: `/sites/MLB/search?q=${encodeURIComponent(q)}&limit=${limit}&sort=${sort}`,
    method: 'GET', headers: { Authorization: `Bearer ${token}` }
  });
  return r.body;
}

async function mlTrends() {
  const token = await getMlToken();
  const r = await httpsGet({
    hostname: 'api.mercadolibre.com', path: '/trends/MLB', method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  });
  return r.body;
}

// ── Shopee Brasil ─────────────────────────────────────────────────────────────
async function shopeeSearch(q, limit = 10) {
  const qs = `keyword=${encodeURIComponent(q)}&limit=${limit}&newest=0&by=relevancy&order=desc&page_type=search&scenario=PAGE_GLOBAL_SEARCH&version=2`;
  const r = await httpsGet({
    hostname: 'shopee.com.br', path: `/api/v4/search/search_items?${qs}`, method: 'GET',
    headers: { 'User-Agent': BROWSER_HEADERS['User-Agent'], 'Referer': 'https://shopee.com.br/', 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'af-ac-enc-dat': '' }
  });
  if (r.status !== 200 || !r.body || !r.body.items) return { error: 'Shopee indisponível', status: r.status };
  const items = (r.body.items || []).map(item => {
    const i = item.item_basic || item;
    const price = i.price_min ? i.price_min / 100000 : (i.price ? i.price / 100000 : null);
    return { id: i.itemid, title: i.name, price, sold: i.sold || i.historical_sold || 0, url: `https://shopee.com.br/product/${i.shopid}/${i.itemid}`, condition: 'new' };
  });
  return { platform: 'shopee', total: r.body.total_count || items.length, items };
}

// ── Google Trends ─────────────────────────────────────────────────────────────
async function googleTrends(q) {
  const path = `/trends/api/explore?hl=pt-BR&tz=-180&req=%7B%22comparisonItem%22%3A%5B%7B%22keyword%22%3A%22${encodeURIComponent(q)}%22%2C%22geo%22%3A%22BR%22%2C%22time%22%3A%22today+12-m%22%7D%5D%2C%22category%22%3A0%2C%22property%22%3A%22%22%7D`;
  const r = await httpsGet({
    hostname: 'trends.google.com', path, method: 'GET',
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'pt-BR,pt;q=0.9' }
  });
  let raw = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
  raw = raw.replace(/^\)\]\}',?\n?/, '');
  try {
    const parsed = JSON.parse(raw);
    const tw = (parsed.widgets || []).find(w => w.id === 'TIMESERIES');
    return { platform: 'google-trends', query: q, token: tw?.token || null, title: tw?.title || null };
  } catch { return { error: 'Google Trends indisponível' }; }
}

// ── Buscape ───────────────────────────────────────────────────────────────────
async function buscapeSearch(q, limit = 10) {
  const r = await httpsGetHtml({ hostname: 'www.buscape.com.br', path: `/pesquisa?q=${encodeURIComponent(q)}`, method: 'GET', headers: { ...BROWSER_HEADERS, Referer: 'https://www.buscape.com.br/' } });
  const next = extractNextData(r.html);
  if (!next) return { error: 'Buscapé: sem dados' };
  const props = next?.props?.pageProps;
  const raw = props?.initialState?.search?.products || props?.products || [];
  if (!raw.length) return { error: 'Buscapé: nenhum produto' };
  const items = raw.slice(0, limit).map(p => { const price = p.offer?.price?.amount || p.price?.amount || null; return { title: p.name || p.title, price: price ? Number(price) : null, url: p.url ? `https://www.buscape.com.br${p.url}` : null, condition: 'new' }; });
  const prices = items.map(i => i.price).filter(Boolean);
  return { platform: 'buscape', total: raw.length, items, price_min: prices.length ? Math.min(...prices) : null, price_max: prices.length ? Math.max(...prices) : null, price_avg: prices.length ? prices.reduce((a,b)=>a+b,0)/prices.length : null };
}

// ── Zoom.com.br ───────────────────────────────────────────────────────────────
async function zoomSearch(q, limit = 10) {
  const r = await httpsGetHtml({ hostname: 'www.zoom.com.br', path: `/search?q=${encodeURIComponent(q)}`, method: 'GET', headers: { ...BROWSER_HEADERS, Referer: 'https://www.zoom.com.br/' } });
  const next = extractNextData(r.html);
  if (!next) return { error: 'Zoom: sem dados' };
  const props = next?.props?.pageProps;
  const raw = props?.initialState?.search?.products || props?.products || [];
  if (!raw.length) return { error: 'Zoom: nenhum produto' };
  const items = raw.slice(0, limit).map(p => { const price = p.offer?.price?.amount || p.price?.amount || null; return { title: p.name || p.title, price: price ? Number(price) : null, url: p.url ? `https://www.zoom.com.br${p.url}` : null, condition: 'new' }; });
  const prices = items.map(i => i.price).filter(Boolean);
  return { platform: 'zoom', total: raw.length, items, price_min: prices.length ? Math.min(...prices) : null, price_max: prices.length ? Math.max(...prices) : null, price_avg: prices.length ? prices.reduce((a,b)=>a+b,0)/prices.length : null };
}

// ── Google Shopping ───────────────────────────────────────────────────────────
async function googleShoppingSearch(q, limit = 10) {
  if (!GOOGLE_API_KEY) return { error: 'Google Shopping não configurado' };
  const qs = `key=${GOOGLE_API_KEY}&cx=${GOOGLE_CSE_ID}&q=${encodeURIComponent(q)}&num=${Math.min(limit,10)}&gl=br&hl=pt`;
  const r = await httpsGet({ hostname: 'www.googleapis.com', path: `/customsearch/v1?${qs}`, method: 'GET', headers: { Accept: 'application/json' } });
  if (r.status !== 200) return { error: `Google API: HTTP ${r.status}` };
  const items = (r.body.items || []).map(i => ({ title: i.title, price: i.pagemap?.offer?.[0]?.price ? parseFloat(i.pagemap.offer[0].price.replace(/[^0-9,.]/g,'').replace(',','.')) : null, url: i.link, seller: i.displayLink, condition: 'new' }));
  const prices = items.map(i => i.price).filter(Boolean);
  return { platform: 'google_shopping', total: r.body.searchInformation?.totalResults || items.length, items, price_min: prices.length ? Math.min(...prices) : null, price_max: prices.length ? Math.max(...prices) : null, price_avg: prices.length ? prices.reduce((a,b)=>a+b,0)/prices.length : null };
}

// ── TikTok Shop ───────────────────────────────────────────────────────────────
function tikTokSign(path, params, bodyStr = '') {
  const sorted = Object.keys(params).filter(k => k !== 'sign' && k !== 'access_token').sort().map(k => `${k}${params[k]}`).join('');
  return crypto.createHmac('sha256', TIKTOK_APP_SECRET).update(TIKTOK_APP_SECRET + path + sorted + bodyStr + TIKTOK_APP_SECRET).digest('hex').toUpperCase();
}

async function tikTokShopSearch(q, limit = 10) {
  if (!TIKTOK_APP_KEY || !TIKTOK_APP_SECRET) return { requires_credentials: true, name: 'TikTok Shop', color: '#7c3aed', info: 'Configure TIKTOK_APP_KEY e TIKTOK_APP_SECRET após aprovação em https://partner.tiktokshop.com' };
  if (!tikTokAccessToken) return { error: 'TikTok: access_token não configurado', requires_credentials: true };
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const path = '/product/202309/products/search';
  const params = { app_key: TIKTOK_APP_KEY, timestamp, access_token: tikTokAccessToken };
  const bodyStr = JSON.stringify({ keyword: q, page_size: Math.min(limit, 20), sort_type: 5, page_number: 1 });
  params.sign = tikTokSign(path, params, bodyStr);
  const qs = new URLSearchParams(params).toString();
  const r = await httpsGet({ hostname: 'open-api.tiktokglobal.com', path: `${path}?${qs}`, method: 'POST', headers: { 'Content-Type': 'application/json', 'x-tts-access-token': tikTokAccessToken } }, bodyStr);
  if (r.status !== 200 || r.body?.code !== 0) return { error: `TikTok API: ${r.body?.message || 'Erro'}` };
  const products = r.body?.data?.products || [];
  const items = products.map(p => { const price = p.skus?.[0]?.sale_price ? parseFloat(p.skus[0].sale_price.amount) : null; return { id: p.id, title: p.title, price, sold: p.sales_volume || 0, url: `https://www.tiktok.com/view/product/${p.id}`, condition: 'new' }; });
  const prices = items.map(i => i.price).filter(Boolean);
  return { platform: 'tiktok_shop', total: r.body?.data?.total_count || items.length, items, price_min: prices.length ? Math.min(...prices) : null, price_max: prices.length ? Math.max(...prices) : null, price_avg: prices.length ? prices.reduce((a,b)=>a+b,0)/prices.length : null };
}

// ── Agregador multi-plataforma ────────────────────────────────────────────────
async function platformsSearch(q, limit = 10) {
  const [ml, shopee, buscape, zoom, gshop, tiktok] = await Promise.allSettled([
    mlSearch(q, limit), shopeeSearch(q, limit), buscapeSearch(q, limit),
    zoomSearch(q, limit), googleShoppingSearch(q, limit), tikTokShopSearch(q, limit),
  ]);

  function normalizePlatform(name, color, settled) {
    if (settled.status === 'fulfilled' && !settled.value.error && settled.value.items?.length) {
      const d = settled.value;
      const prices = d.items.map(p => p.price).filter(Boolean);
      return { name, color, total: d.total || d.items.length, count: d.items.length, price_avg: prices.length ? prices.reduce((a,b)=>a+b,0)/prices.length : 0, price_min: d.price_min || 0, price_max: d.price_max || 0, sold_total: d.items.reduce((s,p) => s+(p.sold||0), 0), top3: d.items.slice(0,3).map(p => ({ title: p.title, price: p.price, sold: p.sold||0, url: p.url, condition: p.condition||'new' })) };
    }
    return { name, color, error: settled.value?.error || settled.reason?.message || `${name} indisponível` };
  }

  const result = { query: q, platforms: {} };

  result.platforms.mercadolivre = (() => {
    if (ml.status === 'fulfilled' && ml.value.results) {
      const r = ml.value.results; const prices = r.map(p => p.price).filter(Boolean);
      return { name: 'Mercado Livre', color: '#dc2626', total: ml.value.paging?.total || 0, count: r.length, price_avg: prices.length ? prices.reduce((a,b)=>a+b,0)/prices.length : 0, price_min: prices.length ? Math.min(...prices) : 0, price_max: prices.length ? Math.max(...prices) : 0, sold_total: r.reduce((s,p) => s+(p.sold_quantity||0), 0), top3: r.slice(0,3).map(p => ({ title: p.title, price: p.price, sold: p.sold_quantity||0, url: p.permalink, condition: p.condition })) };
    }
    return { name: 'Mercado Livre', color: '#dc2626', error: ml.reason?.message || 'Erro ao consultar ML' };
  })();

  result.platforms.shopee = (() => {
    if (shopee.status === 'fulfilled' && shopee.value.items) {
      const it = shopee.value.items; const prices = it.map(p => p.price).filter(Boolean);
      return { name: 'Shopee', color: '#ea580c', total: shopee.value.total || 0, count: it.length, price_avg: prices.length ? prices.reduce((a,b)=>a+b,0)/prices.length : 0, price_min: prices.length ? Math.min(...prices) : 0, price_max: prices.length ? Math.max(...prices) : 0, sold_total: it.reduce((s,p) => s+(p.sold||0), 0), top3: it.slice(0,3).map(p => ({ title: p.title, price: p.price, sold: p.sold||0, url: p.url, condition: 'new' })) };
    }
    return { name: 'Shopee', color: '#ea580c', error: shopee.value?.error || 'Shopee indisponível' };
  })();

  result.platforms.buscape   = normalizePlatform('Buscapé',         '#16a34a', buscape);
  result.platforms.zoom      = normalizePlatform('Zoom.com.br',     '#0ea5e9', zoom);
  result.platforms.gshop     = normalizePlatform('Google Shopping', '#1d4ed8', gshop);

  result.platforms.tiktok_shop = (tiktok.status === 'fulfilled' && tiktok.value.items)
    ? normalizePlatform('TikTok Shop', '#7c3aed', tiktok)
    : (tiktok.value?.requires_credentials ? tiktok.value : { name: 'TikTok Shop', color: '#7c3aed', requires_credentials: true, info: 'Requer aprovação como parceiro. Acesse: https://partner.tiktokshop.com' });

  result.platforms.amazon = { name: 'Amazon Brasil', color: '#f59e0b', requires_credentials: true, info: 'Requer conta de associado. Acesse: https://associados.amazon.com.br' };

  return result;
}

// ── Vercel Serverless Handler ─────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  // Parse endpoint from URL path (req.query.slug unreliable in nested api dirs)
  const _path = new URL(req.url, 'https://x').pathname; // e.g. /api/api/api/status
  const _parts = _path.split('/').filter(p => p && p !== 'api'); // skip all 'api' segments
  const endpoint = '/' + _parts.join('/');
  const slugArr = _parts;
  const q     = req.query.q || 'tenis masculino';
  const limit = parseInt(req.query.limit || '10');

  try {
    let result;
    switch (endpoint) {
      case '/status':
        result = { status: 'ok', version: '4.0-serverless', time: new Date().toISOString(), sources: { mercadolivre: 'ativo', shopee: 'ativo', buscape: 'ativo', zoom: 'ativo', google_shopping: GOOGLE_API_KEY ? 'ativo' : 'inativo', tiktok_shop: TIKTOK_APP_KEY ? (tikTokAccessToken ? 'ativo' : 'pendente token') : 'pendente credenciais' } };
        break;
      case '/search':
        result = await mlSearch(q, limit, req.query.sort || 'sold_quantity_desc');
        break;
      case '/shopee':
        result = await shopeeSearch(q, limit);
        break;
      case '/buscape':
        result = await buscapeSearch(q, limit);
        break;
      case '/zoom':
        result = await zoomSearch(q, limit);
        break;
      case '/google-shopping':
        result = await googleShoppingSearch(q, limit);
        break;
      case '/trends':
        result = await mlTrends();
        break;
      case '/google-trends':
        result = await googleTrends(q);
        break;
      case '/platforms':
        result = await platformsSearch(q, limit);
        break;
      case '/tiktok':
        result = await tikTokShopSearch(q, limit);
        break;
      default:
        res.status(404).json({ error: 'Endpoint não encontrado', endpoint, available: ['/status','/search','/shopee','/platforms','/trends','/google-trends','/tiktok'] });
        return;
    }
    res.status(200).json(result);
  } catch(e) {
    console.error(`[API ERRO] ${endpoint}:`, e.message);
    res.status(500).json({ error: e.message });
  }
};
