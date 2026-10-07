import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankOf, pickModels, orderChain, buildCatalog } from '../src/catalog.js';
import { builtinProviders } from '../src/config.js';
import { fakeProvider, provider } from './helpers.js';

const { ranking, exclude } = builtinProviders();
const cfg = { ranking, exclude };

test('ranking puts big models ahead of small ones', () => {
  assert.ok(rankOf('moonshotai/kimi-k3', ranking) < rankOf('openai/gpt-oss-120b', ranking));
  assert.ok(rankOf('openai/gpt-oss-120b', ranking) < rankOf('openai/gpt-oss-20b', ranking));
  assert.ok(rankOf('nvidia/nemotron-3-ultra-550b-a55b:free', ranking) < rankOf('stepfun/step-3.7-flash:free', ranking));
  assert.ok(rankOf('gemini-3.5-flash', ranking) < rankOf('gemini-3.5-flash-lite', ranking));
});

test('a model that matches no pattern is not ranked', () => {
  assert.equal(rankOf('liquid/lfm-2.5-2.6b:free', ranking), -1);
});

test('"ling-" does not match inkling (a real bug caught on a live gateway)', () => {
  assert.equal(rankOf('thinkingmachines/inkling-small:free', ranking), -1);
  assert.notEqual(rankOf('inclusionai/ling-3.1-flash', ranking), -1);
});

test('freeOnly keeps :free and zero-priced models, drops paid ones', () => {
  const p = provider('kilo', 'http://x', { discover: { freeOnly: true } });
  const got = pickModels(p, [
    { id: 'stepfun/step-3.7-flash:free' },
    { id: 'inclusionai/ling-3.1-flash', pricing: { prompt: '0', completion: '0' } },
    { id: 'moonshotai/kimi-k3', pricing: { prompt: '0.0000006', completion: '0.0000025' } },
  ], cfg);
  assert.deepEqual(got, ['stepfun/step-3.7-flash:free', 'inclusionai/ling-3.1-flash']);
});

test('auto routers, aliases and vision variants are excluded', () => {
  const p = provider('kilo', 'http://x', { discover: { freeOnly: true } });
  const got = pickModels(p, [
    { id: 'kilo-auto/free', pricing: { prompt: '0', completion: '0' } },
    { id: 'openrouter/free', pricing: { prompt: '0', completion: '0' } },
    { id: '~deepseek/deepseek-flash-latest:free' },
    { id: 'deepseek/deepseek-v4-flash-vision-exp:free' },
    { id: 'deepseek/deepseek-v4-flash:free' },
  ], cfg);
  assert.deepEqual(got, ['deepseek/deepseek-v4-flash:free']);
});

test('stripPrefix turns Gemini "models/x" into "x"', () => {
  const p = provider('gemini', 'http://x', { discover: { stripPrefix: 'models/' } });
  assert.deepEqual(pickModels(p, [{ id: 'models/gemini-3.5-flash' }, { id: 'models/text-embedding-004' }], cfg), ['gemini-3.5-flash']);
});

test('same rank is broken by provider order', () => {
  const a = provider('groq', 'http://a');
  const b = provider('cerebras', 'http://b');
  const chain = orderChain(
    [{ provider: b, models: ['gpt-oss-120b'] }, { provider: a, models: ['openai/gpt-oss-120b', 'llama-3.1-8b-instant'] }],
    ranking,
    ['groq', 'cerebras'],
  );
  assert.deepEqual(chain.map((c) => `${c.provider}/${c.model}`), ['groq/openai/gpt-oss-120b', 'cerebras/gpt-oss-120b', 'groq/llama-3.1-8b-instant']);
});

test('buildCatalog discovers live, skips providers without keys, and explains why', async () => {
  const up = await fakeProvider(() => null, [{ id: 'nvidia/nemotron-3-ultra-550b-a55b:free' }, { id: 'paid-model' }]);
  try {
    const conf = {
      ...cfg,
      proxy: null,
      providers: [
        provider('kilo', up.url, { discover: { freeOnly: true } }),
        provider('groq', 'http://127.0.0.1:1', { keyless: false, missing: ['GROQ_API_KEY'], signup: 'https://console.groq.com/keys' }),
        provider('dead', 'http://127.0.0.1:1', { discover: {}, models: ['gpt-oss-20b'] }),
      ],
    };
    const cat = await buildCatalog(conf);
    assert.deepEqual(cat.chain.map((c) => `${c.provider}/${c.model}`), ['kilo/nvidia/nemotron-3-ultra-550b-a55b:free', 'dead/gpt-oss-20b']);
    assert.equal(cat.status.groq.state, 'needs-key');
    assert.equal(cat.status.dead.state, 'unreachable');
    assert.equal(cat.status.kilo.state, 'ok');
  } finally {
    await up.close();
  }
});

test('doctor tells "blocked from this network" apart from "needs a key"', async () => {
  const { probeWithoutKey } = await import('../src/doctor.js');
  const reachable = await fakeProvider(() => null);
  const http = await import('node:http');
  const geo = http.createServer((req, res) => res.writeHead(403).end('Access denied by security policy.'));
  const { listen, close } = await import('./helpers.js');
  const geoUrl = await listen(geo);
  try {
    const cfg = { proxy: null };
    const open = await probeWithoutKey(provider('open', reachable.url), cfg);
    assert.equal(open.result, 'needs key');
    const shut = await probeWithoutKey(provider('shut', geoUrl), cfg);
    assert.equal(shut.result, 'blocked here');
    assert.match(shut.note, /--proxy/);
    assert.equal(await probeWithoutKey(provider('g', geoUrl, { probe: false }), cfg), null);
    assert.equal(await probeWithoutKey(provider('cf', 'https://x/{ACCOUNT}/v1'), cfg), null);
  } finally {
    await close(geo);
    await reachable.close();
  }
});
