// The local OpenAI-compatible endpoint.
//
//   POST /v1/chat/completions   model "auto" walks the chain
//   GET  /v1/models             "auto" plus every model in the chain
//   GET  /status                JSON: chain, quota used today, parked models
//   GET  /                      a small dashboard in Persian

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { limitsFor } from './quota.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MAX_BODY = 20 * 1024 * 1024;

function send(res, status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json',
    'access-control-allow-origin': '*',
    ...headers,
  });
  res.end(text);
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function statusReport({ getCatalog, usage, cfg }) {
  const cat = getCatalog();
  const snap = usage.snapshot();
  const now = Date.now();
  const chain = cat.chain.map((c) => {
    const id = `${c.provider}/${c.model}`;
    const lim = limitsFor(c.def, c.model);
    const key = lim.scope === 'model' ? id : c.provider;
    const own = snap.counts[id] || { req: 0, tok: 0 };
    const quota = snap.counts[key] || { req: 0, tok: 0 };
    const check = usage.check(c);
    return {
      id,
      provider: c.provider,
      model: c.model,
      rank: c.rank,
      usedToday: own.req,
      quotaUsed: quota.req,
      limitPerDay: lim.rpd || null,
      sharedWith: lim.scope === 'model' ? null : c.provider,
      available: check.ok,
      reason: check.ok ? null : check.reason,
      until: check.until ? new Date(check.until).toISOString() : null,
    };
  });
  const providers = cfg.providers.map((p) => ({
    id: p.id,
    name: p.name,
    keyless: !!p.keyless,
    ...cat.status[p.id],
    privacy: p.privacy,
    note: p.note || null,
  }));
  return {
    day: snap.day,
    proxy: cfg.proxy ? cfg.proxy.url : null,
    refreshedAt: new Date(cat.at).toISOString(),
    available: chain.filter((c) => c.available).length,
    chain,
    providers,
    parked: Object.fromEntries(Object.entries(snap.parked).filter(([, v]) => v.until > now)),
  };
}

export function createServer({ router, getCatalog, usage, cfg, log = () => {} }) {
  const dashboard = fs.readFileSync(path.join(here, 'dashboard.html'), 'utf8');

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
        });
        return res.end();
      }

      if (cfg.apiKey && url.pathname.startsWith('/v1/')) {
        const auth = req.headers.authorization || '';
        if (auth !== `Bearer ${cfg.apiKey}`) {
          return send(res, 401, { error: { message: 'wrong or missing API key for this rayegan server', type: 'auth' } });
        }
      }

      if (req.method === 'GET' && url.pathname === '/') return send(res, 200, dashboard);
      if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, statusReport({ getCatalog, usage, cfg }));

      if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
        const created = Math.floor(Date.now() / 1000);
        const data = [{ id: 'auto', object: 'model', created, owned_by: 'rayegan' }];
        for (const c of getCatalog().chain) {
          data.push({ id: `${c.provider}/${c.model}`, object: 'model', created, owned_by: c.provider });
        }
        return send(res, 200, { object: 'list', data });
      }

      if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
        let body;
        try {
          body = JSON.parse(await readRequest(req));
        } catch (err) {
          return send(res, err.status || 400, { error: { message: err.status ? err.message : 'request body is not valid JSON', type: 'invalid_request_error' } });
        }
        if (!Array.isArray(body.messages)) {
          return send(res, 400, { error: { message: '"messages" must be an array', type: 'invalid_request_error' } });
        }
        const out = await router.chat(body);
        const meta = out.candidate
          ? { 'x-rayegan-provider': out.candidate.provider, 'x-rayegan-model': out.candidate.model }
          : {};
        meta['x-rayegan-attempts'] = String(out.attempts.filter((a) => a.sent).length);
        if (out.kind === 'stream') {
          res.writeHead(200, {
            'content-type': out.headers['content-type'] || 'text/event-stream',
            'cache-control': 'no-cache',
            'access-control-allow-origin': '*',
            ...meta,
          });
          out.stream.pipe(res);
          req.on('close', () => out.stream.destroy());
          log(`stream via ${out.candidate.provider}/${out.candidate.model}`);
          return;
        }
        if (out.candidate) log(`answered by ${out.candidate.provider}/${out.candidate.model}`);
        return send(res, out.status, out.json, meta);
      }

      return send(res, 404, { error: { message: `no route for ${req.method} ${url.pathname}`, type: 'not_found' } });
    } catch (err) {
      log(`internal error: ${err.stack || err.message}`);
      if (!res.headersSent) send(res, 500, { error: { message: err.message, type: 'internal' } });
      else res.destroy();
    }
  });
}
