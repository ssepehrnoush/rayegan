// Which providers go through the proxy and which go direct.
//
// From Iran some providers answer 403 to Iranian IPs and need the proxy, while
// others (Kilo, Mistral, Cloudflare on 2026-10-07) work directly. Sending
// everything through a VPN costs its bandwidth and adds latency for nothing.
// In "auto" mode each provider is tried directly first, and only a 403 or a
// failed connection moves it behind the proxy.

import { request } from './http.js';
import { parseProxy } from './proxy.js';

const PROBE_MS = 6000;

// Explicit per-provider setting from the user's config: "none" forces direct,
// a URL forces that proxy, anything else means "decide".
export function explicitRoute(p) {
  if (p.proxy === undefined || p.proxy === null || p.proxy === 'auto') return undefined;
  if (p.proxy === 'none' || p.proxy === false) return null;
  return parseProxy(p.proxy);
}

export async function chooseRoute(p, cfg, { req = request } = {}) {
  const forced = explicitRoute(p);
  if (forced !== undefined) return { proxy: forced, why: forced ? 'forced proxy' : 'forced direct' };
  if (!cfg.proxy) return { proxy: null, why: 'no proxy configured' };
  if (cfg.proxyMode === 'always') return { proxy: cfg.proxy, why: 'proxyMode always' };
  if (p.baseUrl.includes('{')) return { proxy: cfg.proxy, why: 'not probed' };

  try {
    const res = await req(`${p.baseUrl}/models`, {
      headers: { authorization: `Bearer ${p.key || 'rayegan-probe-not-a-key'}` },
      timeoutMs: PROBE_MS,
    });
    res.stream.resume();
    if (res.status === 403) return { proxy: cfg.proxy, why: 'direct answered 403' };
    return { proxy: null, why: `direct answered ${res.status}` };
  } catch (err) {
    return { proxy: cfg.proxy, why: `direct failed: ${err.message}` };
  }
}

export async function chooseRoutes(providers, cfg, opts) {
  const out = {};
  await Promise.all(
    providers.map(async (p) => {
      out[p.id] = await chooseRoute(p, cfg, opts);
    }),
  );
  return out;
}
