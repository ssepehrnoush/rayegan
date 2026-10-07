// `rayegan doctor`: which providers answer from *this* network, right now.
//
// Whether a provider is reachable from Iran depends on the ISP, the day, and
// whether a VPN is on. A table in a README cannot know that; a live check can.

import { listModels, pickModels, authHeaders, rankOf } from './catalog.js';
import { request, readBody } from './http.js';

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function tryChat(p, model, cfg, req) {
  const t0 = Date.now();
  const res = await req(`${p.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: authHeaders(p),
    body: { model, messages: [{ role: 'user', content: 'Reply with the single word: ok' }], max_tokens: 16 },
    proxy: cfg.proxy,
    timeoutMs: 45000,
  });
  const text = await readBody(res, 256 * 1024);
  if (res.status !== 200) return { ok: false, detail: `HTTP ${res.status} ${text.slice(0, 80).replace(/\s+/g, ' ')}` };
  return { ok: true, detail: `${model} answered in ${Date.now() - t0} ms` };
}

// Before anyone signs up for a key, tell them whether the provider is even
// open from this network. From Iran several providers answer 403 to every
// request, valid key or not. A fake key separates that from "reachable, needs
// a key" (401). Providers whose answer to a fake key is ambiguous opt out with
// "probe": false.
export async function probeWithoutKey(p, cfg, req = request) {
  if (p.probe === false || p.baseUrl.includes('{')) return null;
  const t0 = Date.now();
  try {
    const res = await req(`${p.baseUrl}/models`, {
      headers: { authorization: 'Bearer rayegan-probe-not-a-key' },
      proxy: cfg.proxy,
      timeoutMs: 15000,
    });
    res.stream.resume();
    const ms = Date.now() - t0;
    if (res.status === 403) {
      return { result: 'blocked here', ms, note: cfg.proxy ? 'refused from this proxy too; ' : 'refused from this network, needs --proxy; then ' };
    }
    return { result: 'needs key', ms, note: 'reachable; ' };
  } catch (err) {
    return { result: 'unreachable', ms: Date.now() - t0, note: `${err.message}; ` };
  }
}

export async function doctor(cfg, { chat = false, out = (s) => process.stdout.write(s + '\n'), req = request } = {}) {
  out(`proxy: ${cfg.proxy ? cfg.proxy.url : 'none (set --proxy or HTTPS_PROXY if providers time out)'}`);
  out('');
  out(`${pad('provider', 12)}${pad('result', 14)}${pad('time', 9)}${pad('models', 8)}detail`);
  out('-'.repeat(78));

  let usable = 0;
  let unreachable = 0;
  for (const p of cfg.providers) {
    if (p.missing.length) {
      const how = `set ${p.missing.join(', ')}${p.signup ? `  ${p.signup}` : ''}`;
      const probe = await probeWithoutKey(p, cfg, req);
      if (!probe) {
        out(`${pad(p.id, 12)}${pad('needs key', 14)}${pad('-', 9)}${pad('-', 8)}${how}`);
      } else {
        out(`${pad(p.id, 12)}${pad(probe.result, 14)}${pad(`${probe.ms} ms`, 9)}${pad('-', 8)}${probe.note}${how}`);
      }
      continue;
    }
    const t0 = Date.now();
    let models = p.models ? [...p.models] : [];
    let result = 'ok';
    let detail = p.keyless ? 'no key needed' : 'key set';
    try {
      if (p.discover) {
        const found = await listModels(p, { proxy: cfg.proxy, req, timeoutMs: 15000 });
        models = [...new Set([...models, ...pickModels(p, found, cfg)])];
        detail += `, ${found.length} listed`;
      }
    } catch (err) {
      result = err.status === 401 ? 'bad key' : err.status === 403 ? 'blocked 403' : 'unreachable';
      detail = err.status === 403 ? 'forbidden: region or account block is likely' : err.message;
      if (result === 'unreachable') unreachable++;
    }
    const ms = Date.now() - t0;
    if (result === 'ok' && chat && models.length) {
      // Free models hit 429 all the time; one busy model does not make the
      // provider unusable, so try a few in chain order.
      const ranked = [...models].sort((a, b) => rankOf(a, cfg.ranking) - rankOf(b, cfg.ranking));
      result = 'chat failed';
      for (const model of ranked.slice(0, 3)) {
        try {
          const r = await tryChat(p, model, cfg, req);
          detail = r.detail;
          if (r.ok) {
            result = 'ok';
            break;
          }
        } catch (err) {
          detail = err.message;
        }
      }
    }
    if (result === 'ok' && models.length) usable++;
    out(`${pad(p.id, 12)}${pad(result, 14)}${pad(`${ms} ms`, 9)}${pad(models.length, 8)}${detail}`);
  }

  out('');
  if (usable) {
    out(`${usable} provider(s) usable. Start the server with: rayegan`);
  } else {
    out('No provider is usable from this network.');
    if (unreachable && !cfg.proxy) out('Most failures are timeouts. Try again with a proxy, for example: rayegan doctor --proxy http://127.0.0.1:10808');
  }
  return usable;
}
