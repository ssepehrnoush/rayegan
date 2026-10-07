// Builds the ordered chain of (provider, model) candidates.
//
// Model IDs on free tiers come and go every few weeks, so instead of a fixed
// list we ask each provider for its current models and keep the ones that
// match the ranking. The ranking is a list of patterns, smartest first; a
// model that matches no pattern is left out on purpose, so a new 1B toy model
// never sneaks to the front of the chain.

import { request, readJson } from './http.js';
import { chooseRoute } from './route.js';

export function rankOf(id, ranking) {
  for (let i = 0; i < ranking.length; i++) {
    if (new RegExp(ranking[i], 'i').test(id)) return i;
  }
  return -1;
}

function isFree(m) {
  if (/:free$/.test(m.id)) return true;
  const p = m.pricing;
  if (!p) return false;
  return Number(p.prompt) === 0 && Number(p.completion) === 0;
}

export function authHeaders(p) {
  return p.key ? { authorization: `Bearer ${p.key}` } : {};
}

export async function listModels(p, { proxy, timeoutMs = 15000, req = request } = {}) {
  const res = await req(`${p.baseUrl}/models`, { headers: authHeaders(p), proxy, timeoutMs });
  if (res.status !== 200) {
    res.stream.resume();
    const err = new Error(`GET /models returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  const body = await readJson(res);
  const list = Array.isArray(body) ? body : body.data || body.models || [];
  return list.map((m) => (typeof m === 'string' ? { id: m } : m)).filter((m) => m && m.id);
}

export function pickModels(p, models, { ranking, exclude }) {
  const strip = p.discover?.stripPrefix;
  const out = [];
  for (const m of models) {
    if (p.discover?.freeOnly && !isFree(m)) continue;
    const id = strip && m.id.startsWith(strip) ? m.id.slice(strip.length) : m.id;
    if (exclude.some((x) => new RegExp(x, 'i').test(id))) continue;
    if (rankOf(id, ranking) === -1) continue;
    out.push(id);
  }
  return [...new Set(out)];
}

export function orderChain(entries, ranking, providerOrder) {
  const chain = [];
  for (const { provider, models, proxy } of entries) {
    for (const model of models) {
      const r = rankOf(model, ranking);
      const c = { provider: provider.id, model, rank: r === -1 ? ranking.length : r, def: provider };
      if (proxy !== undefined) c.proxy = proxy;
      chain.push(c);
    }
  }
  chain.sort((a, b) => a.rank - b.rank || providerOrder.indexOf(a.provider) - providerOrder.indexOf(b.provider));
  return chain;
}

// Returns { chain, status } where status explains every provider that is not
// in the chain, so `rayegan doctor` and the dashboard can say why.
export async function buildCatalog(cfg, { req = request, log = () => {} } = {}) {
  const status = {};
  const entries = [];
  await Promise.all(
    cfg.providers.map(async (p) => {
      if (p.missing.length) {
        status[p.id] = { state: 'needs-key', missing: p.missing, signup: p.signup };
        return;
      }
      const route = await chooseRoute(p, cfg, { req });
      const via = { route: route.proxy ? 'proxy' : 'direct', routeWhy: route.why };
      let models = p.models ? [...p.models] : [];
      if (p.discover) {
        try {
          const found = await listModels(p, { proxy: route.proxy, req });
          models = [...new Set([...models, ...pickModels(p, found, cfg)])];
          status[p.id] = { state: 'ok', found: found.length, using: models.length, ...via };
        } catch (err) {
          const state = err.status === 401 ? 'bad-key' : err.status === 403 ? 'blocked' : 'unreachable';
          status[p.id] = { state, error: err.message, using: models.length, ...via };
          log(`${p.id}: model discovery failed (${err.message})`);
        }
      } else {
        status[p.id] = { state: 'ok', using: models.length, ...via };
      }
      if (models.length) entries.push({ provider: p, models, proxy: route.proxy });
    }),
  );
  const order = cfg.providers.map((p) => p.id);
  return { chain: orderChain(entries, cfg.ranking, order), status, at: Date.now() };
}
