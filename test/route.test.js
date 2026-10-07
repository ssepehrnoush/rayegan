import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chooseRoute, explicitRoute } from '../src/route.js';
import { buildCatalog } from '../src/catalog.js';
import { createRouter } from '../src/router.js';
import { Usage } from '../src/quota.js';
import { parseProxy } from '../src/proxy.js';
import { fakeProvider, provider, listen, close } from './helpers.js';

const PROXY = parseProxy('http://127.0.0.1:10808');

async function forbidden() {
  const srv = http.createServer((req, res) => res.writeHead(403).end('{"error":"Forbidden"}'));
  const url = await listen(srv);
  return { url, close: () => close(srv) };
}

test('auto: a provider that answers directly stays direct', async () => {
  const up = await fakeProvider(() => null);
  try {
    const r = await chooseRoute(provider('kilo', up.url), { proxy: PROXY, proxyMode: 'auto' });
    assert.equal(r.proxy, null);
  } finally {
    await up.close();
  }
});

test('auto: a provider that answers 403 directly goes behind the proxy', async () => {
  const geo = await forbidden();
  try {
    const r = await chooseRoute(provider('groq', geo.url), { proxy: PROXY, proxyMode: 'auto' });
    assert.equal(r.proxy, PROXY);
    assert.match(r.why, /403/);
  } finally {
    await geo.close();
  }
});

test('auto: a provider that cannot be reached directly goes behind the proxy', async () => {
  const r = await chooseRoute(provider('dead', 'http://127.0.0.1:1'), { proxy: PROXY, proxyMode: 'auto' });
  assert.equal(r.proxy, PROXY);
});

test('no proxy configured means everything is direct', async () => {
  const r = await chooseRoute(provider('x', 'http://127.0.0.1:1'), { proxy: null, proxyMode: 'auto' });
  assert.equal(r.proxy, null);
});

test('proxyMode always skips the probe', async () => {
  const r = await chooseRoute(provider('x', 'http://127.0.0.1:1'), { proxy: PROXY, proxyMode: 'always' });
  assert.equal(r.why, 'proxyMode always');
});

test('a per-provider "proxy" in the config wins over auto', () => {
  assert.equal(explicitRoute(provider('a', 'http://x', { proxy: 'none' })), null);
  assert.equal(explicitRoute(provider('a', 'http://x', { proxy: 'socks5://127.0.0.1:1080' })).protocol, 'socks5');
  assert.equal(explicitRoute(provider('a', 'http://x', { proxy: 'auto' })), undefined);
  assert.equal(explicitRoute(provider('a', 'http://x')), undefined);
});

test('the catalog records which route each provider took', async () => {
  const up = await fakeProvider(() => null, [{ id: 'gpt-oss-20b' }]);
  try {
    const cfg = { proxy: PROXY, proxyMode: 'auto', ranking: ['gpt-oss-20b'], exclude: [], providers: [provider('kilo', up.url, { discover: {} })] };
    const cat = await buildCatalog(cfg);
    assert.equal(cat.status.kilo.route, 'direct');
    assert.equal(cat.chain[0].proxy, null);
  } finally {
    await up.close();
  }
});

test('a direct provider that starts answering 403 is moved behind the proxy at once', async () => {
  const geo = await forbidden();
  const seen = [];
  // Stand-in for the network: the direct route is refused, the proxy works.
  const req = async (url, opts) => {
    seen.push(opts.proxy ? 'proxy' : 'direct');
    if (!opts.proxy) {
      const { request } = await import('../src/http.js');
      return request(`${geo.url}/chat/completions`, { method: 'POST', body: opts.body });
    }
    const { Readable } = await import('node:stream');
    const body = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok via proxy' } }] });
    return { status: 200, headers: {}, stream: Readable.from([Buffer.from(body)]) };
  };
  try {
    const def = provider('groq', 'https://groq.example');
    const chain = [
      { provider: 'groq', model: 'a', rank: 0, def, proxy: null },
      { provider: 'groq', model: 'b', rank: 1, def, proxy: null },
    ];
    const router = createRouter({ getChain: () => chain, usage: new Usage(), cfg: { proxy: PROXY, timeoutMs: 5000, maxAttempts: 6 }, req });
    const out = await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.status, 200);
    assert.equal(out.candidate.model, 'a');
    assert.deepEqual(seen, ['direct', 'proxy']);
    assert.equal(chain[1].proxy, PROXY, 'the rest of the provider moved too');
  } finally {
    await geo.close();
  }
});

test('doctor: blocked directly but open through the proxy is reported as such', async () => {
  const { probeWithoutKey } = await import('../src/doctor.js');
  const { Readable } = await import('node:stream');
  const req = async (url, opts) => ({ status: opts.proxy ? 401 : 403, headers: {}, stream: Readable.from([]) });
  const r = await probeWithoutKey(provider('groq', 'https://groq.example'), { proxy: PROXY }, req);
  assert.equal(r.result, 'needs key');
  assert.match(r.note, /blocked directly, reachable via proxy/);
  const both = async () => ({ status: 403, headers: {}, stream: Readable.from([]) });
  assert.equal((await probeWithoutKey(provider('x', 'https://x.example'), { proxy: PROXY }, both)).result, 'blocked here');
});
