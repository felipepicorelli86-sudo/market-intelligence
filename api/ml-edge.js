export const config = { runtime: 'edge' };

const ML_API = 'https://api.mercadolibre.com';
const ML_CLIENT_ID = process.env.ML_CLIENT_ID || '6479487697668843';
const ML_CLIENT_SECRET = process.env.ML_CLIENT_SECRET || 'NITdkMVYDIrP7gbituIMxXhuV3ZBMTLV';

async function getMlToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: ML_CLIENT_ID,
    client_secret: ML_CLIENT_SECRET
  });
  const r = await fetch(ML_API + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body: body.toString()
  });
  const data = await r.json();
  return data.access_token;
}

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (req.method === 'OPTIONS') return new Response(null, { status: 200, headers: cors });

  try {
    const url = new URL(req.url);
    const q = url.searchParams.get('q') || '';
    const limit = url.searchParams.get('limit') || '20';
    const sort = url.searchParams.get('sort') || 'sold_quantity_desc';
    if (!q) return new Response(JSON.stringify({ error: 'q required', results: [], paging: { total: 0 } }), { status: 400, headers: cors });

    const token = await getMlToken();
    const searchUrl = ML_API + '/sites/MLB/search?q=' + encodeURIComponent(q) + '&limit=' + limit + '&sort=' + sort;
    const r = await fetch(searchUrl, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
    const data = await r.json();

    return new Response(JSON.stringify({
      results: data.results || [],
      paging: data.paging || { total: 0 },
      source: r.ok ? 'edge' : 'blocked',
      http_status: r.status,
      error: data.error || null
    }), { status: 200, headers: cors });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message, results: [], paging: { total: 0 }, source: 'exception' }), { status: 500, headers: cors });
  }
}
