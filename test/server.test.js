import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { start } from '../src/index.js';
import { request, readJson, readBody } from '../src/http.js';
import { fakeProvider, provider, listen, close } from './helpers.js';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.js');

async function boot(behave, extraCfg = {}) {
  const up = await fakeProvider(behave, [{ id: 'gpt-oss-120b:free' }, { id: 'gpt-oss-20b:free' }]);
  const cfg = {
    providers: [
      provider('kilo', up.url, { discover: { freeOnly: true }, limits: { rpd: 100 } }),
      provider('groq', 'https://groq.invalid', { keyless: false, missing: ['GROQ_API_KEY'] }),
    ],
    ranking: ['gpt-oss-120b', 'gpt-oss-20b'],
    exclude: [],
    proxy: null,
    timeoutMs: 5000,
    maxAttempts: 6,
    apiKey: null,
    ...extraCfg,
  };
  const app = await start({ cfg, stateFile: null });
  const base = await listen(app.server);
  return {
    base,
    up,
    async done() {
      app.stop();
      await close(app.server);
      await up.close();
    },
  };
}

test('POST /v1/chat/completions answers with the best model and says which', async () => {
  const s = await boot(() => null);
  try {
    const res = await request(`${s.base}/v1/chat/completions`, { method: 'POST', body: { model: 'auto', messages: [{ role: 'user', content: 'hi' }] } });
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-rayegan-model'], 'gpt-oss-120b:free');
    assert.equal(res.headers['x-rayegan-attempts'], '1');
    assert.equal((await readJson(res)).choices[0].message.content, 'hi from gpt-oss-120b:free');
  } finally {
    await s.done();
  }
});

test('GET /v1/models lists auto first, then the chain in order', async () => {
  const s = await boot(() => null);
  try {
    const body = await readJson(await request(`${s.base}/v1/models`));
    assert.deepEqual(body.data.map((m) => m.id), ['auto', 'kilo/gpt-oss-120b:free', 'kilo/gpt-oss-20b:free']);
  } finally {
    await s.done();
  }
});

test('GET /status reports usage, parked models and providers that need a key', async () => {
  const s = await boot((m) => (m === 'gpt-oss-120b:free' ? { status: 404, text: 'model does not exist' } : null));
  try {
    await readJson(await request(`${s.base}/v1/chat/completions`, { method: 'POST', body: { messages: [{ role: 'user', content: 'x' }] } }));
    const st = await readJson(await request(`${s.base}/status`));
    const [big, small] = st.chain;
    assert.equal(big.available, false);
    assert.equal(big.reason, 'gone');
    assert.equal(small.usedToday, 1);
    assert.equal(small.quotaUsed, 2); // the 404 also cost a request from the shared daily quota
    assert.equal(st.providers.find((p) => p.id === 'groq').state, 'needs-key');
  } finally {
    await s.done();
  }
});

test('bad input gets an OpenAI-shaped 400', async () => {
  const s = await boot(() => null);
  try {
    const res = await request(`${s.base}/v1/chat/completions`, { method: 'POST', body: 'not json' });
    assert.equal(res.status, 400);
    assert.equal((await readJson(res)).error.type, 'invalid_request_error');
    const res2 = await request(`${s.base}/v1/chat/completions`, { method: 'POST', body: { model: 'auto' } });
    assert.equal(res2.status, 400);
    await readBody(res2);
  } finally {
    await s.done();
  }
});

test('apiKey protects /v1 when the server is shared on a network', async () => {
  const s = await boot(() => null, { apiKey: 'secret' });
  try {
    const res = await request(`${s.base}/v1/models`);
    assert.equal(res.status, 401);
    await readBody(res);
    const ok = await request(`${s.base}/v1/models`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(ok.status, 200);
    await readBody(ok);
  } finally {
    await s.done();
  }
});

test('GET / serves the Persian dashboard', async () => {
  const s = await boot(() => null);
  try {
    const res = await request(`${s.base}/`);
    const html = await readBody(res);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(html, /dir="rtl"/);
  } finally {
    await s.done();
  }
});

test('cli: --help exits 0, a bad flag exits 2', () => {
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /rayegan doctor/);
  const bad = spawnSync(process.execPath, [cli, '--nope'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
  const cmd = spawnSync(process.execPath, [cli, 'fly'], { encoding: 'utf8' });
  assert.equal(cmd.status, 2);
});
