/**
 * OpiTv -> NuvioTV addon, running on Cloudflare Workers.
 *
 * NuvioTV speaks the Stremio addon protocol (manifest/catalog/meta/stream), so
 * this Worker implements exactly those routes. All catalog data was built
 * offline by build_worker_data.py and ships as static assets; this code only
 * slices and serves it, which keeps each request far inside the free tier's
 * 10 ms CPU budget.
 *
 * Routes:
 *   GET /manifest.json
 *   GET /catalog/{type}/{catalogId}.json           (+ /skip=N.json, /search=x.json)
 *   GET /meta/{type}/{id}.json
 *   GET /stream/{type}/{id}.json
 *   GET /health, /logo.svg
 */

const PAGE = 100;
const ID_PREFIX = 'opitv.';
const ADDON_ID = 'org.opitv.bdix';
const ADDON_NAME = 'OpiTv BDIX';
const ADDON_VERSION = '1.0.0';

/* Parsed assets are kept per isolate; without this every request would re-parse
   the same shard. Small LRU so an isolate cannot grow without bound. */
const MEM = new Map();
const MEM_MAX = 80;

function memGet(key) {
  if (!MEM.has(key)) return undefined;
  const val = MEM.get(key);
  MEM.delete(key);
  MEM.set(key, val);           // refresh recency
  return val;
}

function memSet(key, val) {
  MEM.set(key, val);
  if (MEM.size > MEM_MAX) MEM.delete(MEM.keys().next().value);
}

async function assetText(env, path) {
  const hit = memGet('t:' + path);
  if (hit !== undefined) return hit;
  const res = await env.ASSETS.fetch(new Request('https://assets.invalid' + path));
  if (!res.ok) return null;
  const text = await res.text();
  memSet('t:' + path, text);
  return text;
}

async function assetJSON(env, path) {
  const hit = memGet('j:' + path);
  if (hit !== undefined) return hit;
  const text = await assetText(env, path);
  if (text === null) return null;
  const obj = JSON.parse(text);
  memSet('j:' + path, obj);
  return obj;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });
}

/* ---------------------------------------------------------------- routing */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);

    try {
      if (path === '/' || path === '') return htmlResponse(url.origin);
      if (path === '/manifest.json') return await manifest(env, url.origin);
      if (path === '/logo.svg') return svgResponse();
      if (path === '/health') return await health(env);
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' },
        });
      }

      const parts = path.split('/').filter(Boolean);
      if (parts.length < 3) return jsonResponse({ error: 'not found' }, 404);
      const [kind, type, ...rest] = parts;

      if (kind === 'catalog') return await catalogRoute(env, type, rest);
      if (kind === 'meta' && rest.length === 1) return await metaRoute(env, type, rest[0]);
      if (kind === 'stream' && rest.length === 1) return await streamRoute(env, type, rest[0]);
      return jsonResponse({ error: 'not found' }, 404);
    } catch (err) {
      return jsonResponse({ error: String((err && err.message) || err) }, 500);
    }
  },
};

/* ---------------------------------------------------------------- manifest */

async function manifest(env, origin) {
  const rows = await assetJSON(env, '/rows.json');
  const catalogs = rows.order.map((cid) => ({
    type: rows.rows[cid].type,
    id: cid,
    name: rows.rows[cid].name,
    pageSize: PAGE,
    showInHome: true,
    extra: [
      { name: 'search', isRequired: false },
      { name: 'skip', isRequired: false },
    ],
  }));

  return jsonResponse({
    id: ADDON_ID,
    version: ADDON_VERSION,
    name: ADDON_NAME,
    description: `Your OpiTv BDIX catalogue as a NuvioTV addon: ${catalogs.length} rows.`,
    logo: origin + '/logo.svg',
    types: ['movie', 'series'],
    resources: ['catalog', 'meta', 'stream'],
    idPrefixes: [ID_PREFIX],
    catalogs,
    behaviorHints: { configurable: false },
  });
}

/* ----------------------------------------------------------------- catalog */

function parseExtras(tail) {
  const out = {};
  for (const chunk of tail.split('&')) {
    if (!chunk) continue;
    const eq = chunk.indexOf('=');
    if (eq === -1) out[chunk] = '';
    else out[chunk.slice(0, eq)] = chunk.slice(eq + 1);
  }
  return out;
}

async function catalogRoute(env, type, rest) {
  let cid;
  let extras = {};
  if (rest.length === 1 && rest[0].endsWith('.json')) {
    cid = rest[0].slice(0, -5);
  } else if (rest.length >= 2 && rest[rest.length - 1].endsWith('.json')) {
    cid = rest[0];
    extras = parseExtras(rest[rest.length - 1].slice(0, -5));
  } else {
    return jsonResponse({ error: 'bad catalog path' }, 404);
  }

  const rows = await assetJSON(env, '/rows.json');
  const row = rows.rows[cid];
  if (!row || row.type !== type) return jsonResponse({ metas: [] });

  let skip = parseInt(extras.skip || '0', 10);
  if (!Number.isFinite(skip) || skip < 0) skip = 0;

  if (extras.search) {
    const text = await assetText(env, `/c/${cid}/s.txt`);
    if (!text) return jsonResponse({ metas: [] });
    const needle = extras.search.toLowerCase();
    const metas = [];
    let seen = 0;
    for (const line of text.split('\n')) {
      if (!line) continue;
      const first = line.indexOf('\t');
      if (first === -1) continue;
      const second = line.indexOf('\t', first + 1);
      const names = line.slice(first + 1, second === -1 ? undefined : second);
      if (names.indexOf(needle) === -1) continue;
      if (seen++ < skip) continue;
      metas.push(JSON.parse(line.slice(second + 1)));
      if (metas.length >= PAGE) break;
    }
    return jsonResponse({ metas });
  }

  const page = Math.floor(skip / PAGE);
  const offset = skip % PAGE;
  const first = await assetJSON(env, `/c/${cid}/p${page}.json`);
  let metas = first ? first.metas : [];
  if (offset > 0) metas = metas.slice(offset);
  if (metas.length < PAGE && offset > 0) {
    const next = await assetJSON(env, `/c/${cid}/p${page + 1}.json`);
    if (next) metas = metas.concat(next.metas).slice(0, PAGE);
  }
  return jsonResponse({ metas });
}

/* ----------------------------------------------------- id resolution (m/s) */

async function resolveId(env, type, id, allowEpisode) {
  const key = type === 'movie' ? 'movie' : 'series';
  if (id.startsWith(ID_PREFIX)) {
    const bits = id.split('.');
    const n = parseInt(bits[2], 10);
    if (!Number.isFinite(n)) return null;
    return { kind: key, n, base: bits.slice(0, 3).join('.'), season: bits[3], episode: bits[4] };
  }
  const alias = await assetJSON(env, '/alias.json');
  const mapped = alias[key][id];
  if (!mapped) {
    if (!allowEpisode) return null;
    // imdb:season:episode style (Nuvio's own metadata ids)
    const m = /^(.+):(\d+):(\d+)$/.exec(id);
    if (!m) return null;
    const base = alias[key][m[1]];
    if (!base) return null;
    const bits = base.split('.');
    return { kind: key, n: parseInt(bits[2], 10), base, season: m[2], episode: m[3] };
  }
  const bits = mapped.split('.');
  return { kind: key, n: parseInt(bits[2], 10), base: mapped };
}

async function shardFor(env, ref, id) {
  const shards = await assetJSON(env, '/shards.json');
  const cfg = ref.kind === 'movie' ? shards.movie : shards.series;
  let idx;
  if (cfg.map) {
    // series are packed by size, so the shard comes from an explicit map.
    // Episode requests carry a video id ("opitv.s.7.1.2") while the map is
    // keyed by the series id, so look up ref.base and fall back to id.
    const mapped = cfg.map[ref.base || id];
    if (mapped === undefined) return null;
    idx = mapped;
  } else {
    idx = Math.floor(ref.n / cfg.size);
  }
  return assetJSON(env, `/${ref.kind === 'movie' ? 'm' : 's'}/${idx}.json`);
}

/* -------------------------------------------------------------------- meta */

async function metaRoute(env, type, file) {
  if (!file.endsWith('.json')) return jsonResponse({ error: 'bad path' }, 404);
  const id = file.slice(0, -5);
  const ref = await resolveId(env, type, id, false);
  if (!ref) return jsonResponse({ meta: null }, 404);
  const item = pickById(await shardFor(env, ref, id), ref, id);
  if (!item) return jsonResponse({ meta: null }, 404);
  return jsonResponse({ meta: item.meta });
}

function pickById(shard, ref, id) {
  if (!shard) return null;
  if (shard[id]) return shard[id];
  for (const k of Object.keys(shard)) {
    if (parseInt(k.split('.')[2], 10) === ref.n) return shard[k];
  }
  return null;
}

/* ------------------------------------------------------------------ stream */

async function streamRoute(env, type, file) {
  if (!file.endsWith('.json')) return jsonResponse({ error: 'bad path' }, 404);
  const id = file.slice(0, -5);

  if (type === 'movie') {
    const ref = await resolveId(env, 'movie', id, false);
    if (!ref) return jsonResponse({ streams: [] });
    const item = pickById(await shardFor(env, ref, id), ref, id);
    return jsonResponse({ streams: item ? item.streams || [] : [] });
  }

  const ref = await resolveId(env, 'series', id, true);
  if (!ref) return jsonResponse({ streams: [] });
  const item = pickById(await shardFor(env, ref, id), ref, id);
  if (!item) return jsonResponse({ streams: [] });
  if (ref.season && ref.episode) {
    return jsonResponse({ streams: (item.episodes && item.episodes[`${ref.season}:${ref.episode}`]) || [] });
  }
  return jsonResponse({ streams: item.streams || [] });
}

/* ------------------------------------------------------------------- misc */

async function health(env) {
  const rows = await assetJSON(env, '/rows.json');
  const catalogs = {};
  let movies = 0;
  let series = 0;
  for (const cid of rows.order) {
    catalogs[cid] = rows.rows[cid].count;
    if (cid === 'opitv-movies') movies = rows.rows[cid].count;
    if (cid === 'opitv-series') series = rows.rows[cid].count;
  }
  return jsonResponse({ ok: true, movies, series, catalogs });
}

function svgResponse() {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
    + '<rect width="512" height="512" rx="112" fill="#0b0d12"/>'
    + '<circle cx="256" cy="256" r="132" fill="none" stroke="#4f8cff" stroke-width="16"/>'
    + '<path d="M222 186 L222 326 L342 256 Z" fill="#4f8cff"/></svg>';
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml' } });
}

function htmlResponse(origin) {
  const body = `<!doctype html><meta charset="utf-8"><title>OpiTv addon</title>
<style>body{background:#0b0d12;color:#e8ecf4;font:16px system-ui;padding:40px}
code{background:#1a1f2b;padding:2px 6px;border-radius:6px}</style>
<h2>OpiTv BDIX addon is running</h2>
<p>Add this URL in NuvioTV &rarr; Settings &rarr; Addons:</p>
<p><code>${origin}/manifest.json</code></p>`;
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}
