import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouter, hasAnswer, conversationKey } from '../src/router.js';
import { Usage } from '../src/quota.js';
import { readBody } from '../src/http.js';
import { fakeProvider, provider, answer } from './helpers.js';

const cfg = { proxy: null, timeoutMs: 5000, maxAttempts: 6 };
const ask = (content, extra = {}) => ({ model: 'auto', messages: [{ role: 'user', content }], ...extra });

async function setup(behave, models = ['smart', 'medium', 'small']) {
  const up = await fakeProvider(behave);
  const def = provider('p', up.url);
  const chain = models.map((model, rank) => ({ provider: 'p', model, rank, def }));
  const usage = new Usage();
  const router = createRouter({ getChain: () => chain, usage, cfg });
  return { up, usage, router };
}

test('the smartest model answers when it can', async () => {
  const { up, router } = await setup(() => null);
  try {
    const out = await router.chat(ask('hi'));
    assert.equal(out.status, 200);
    assert.equal(out.candidate.model, 'smart');
    assert.deepEqual(up.calls.map((c) => c.model), ['smart']);
  } finally {
    await up.close();
  }
});

test('429 on the first model hands the request to the next one', async () => {
  const { up, router, usage } = await setup((m) => (m === 'smart' ? { status: 429, json: { error: 'slow down' } } : null));
  try {
    const out = await router.chat(ask('hi'));
    assert.equal(out.candidate.model, 'medium');
    assert.equal(out.json.choices[0].message.content, 'hi from medium');
    assert.equal(usage.parked['p/smart'].kind, 'rate-limited');
    // The parked model is skipped on the next request without a network call.
    up.calls.length = 0;
    await router.chat(ask('again'));
    assert.deepEqual(up.calls.map((c) => c.model), ['medium']);
  } finally {
    await up.close();
  }
});

test('a 200 with no choices is treated as a failure', async () => {
  const { up, router } = await setup((m) => (m === 'smart' ? { status: 200, json: { id: 'x', choices: [] } } : null));
  try {
    const out = await router.chat(ask('hi'));
    assert.equal(out.candidate.model, 'medium');
    assert.equal(out.attempts[0].failed, 'empty');
  } finally {
    await up.close();
  }
});

test('a 200 whose answer is blank is treated as a failure', async () => {
  const { up, router } = await setup((m) => (m === 'smart' ? { status: 200, json: answer('   ') } : null));
  try {
    assert.equal((await router.chat(ask('hi'))).candidate.model, 'medium');
  } finally {
    await up.close();
  }
});

test('a 200 carrying an error object is treated as a failure', async () => {
  const { up, router } = await setup((m) => (m === 'smart' ? { status: 200, json: { error: { message: 'upstream overloaded' } } } : null));
  try {
    assert.equal((await router.chat(ask('hi'))).candidate.model, 'medium');
  } finally {
    await up.close();
  }
});

test('tool calls count as an answer even with empty content', () => {
  assert.equal(hasAnswer({ choices: [{ message: { content: null, tool_calls: [{ id: 't' }] } }] }), true);
  assert.equal(hasAnswer({ choices: [{ message: { content: null } }] }), false);
});

test('when everything fails the client gets a 503 that lists every attempt', async () => {
  const { up, router } = await setup(() => ({ status: 500, text: 'down' }));
  try {
    const out = await router.chat(ask('hi'));
    assert.equal(out.status, 503);
    assert.equal(out.json.error.type, 'rayegan_unavailable');
    assert.equal(out.json.error.attempts.length, 3);
  } finally {
    await up.close();
  }
});

test('a specific model name skips the chain', async () => {
  const { up, router } = await setup(() => null);
  try {
    const out = await router.chat(ask('hi', { model: 'small' }));
    assert.equal(out.candidate.model, 'small');
    const full = await router.chat(ask('hi', { model: 'p/medium' }));
    assert.equal(full.candidate.model, 'medium');
    const none = await router.chat(ask('hi', { model: 'nope' }));
    assert.equal(none.status, 404);
  } finally {
    await up.close();
  }
});

test('the upstream receives the real model name, not "auto"', async () => {
  const { up, router } = await setup(() => null);
  try {
    await router.chat(ask('hi', { temperature: 0.2 }));
    assert.equal(up.calls[0].body.model, 'smart');
    assert.equal(up.calls[0].body.temperature, 0.2);
  } finally {
    await up.close();
  }
});

test('a conversation stays on the model that started it', async () => {
  let smartUp = false;
  const { up, router, usage } = await setup((m) => (m === 'smart' && !smartUp ? { status: 503, text: 'busy' } : null));
  try {
    const first = [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }];
    const a = await router.chat({ model: 'auto', messages: first });
    assert.equal(a.candidate.model, 'medium');
    smartUp = true;
    delete usage.parked['p/smart'];
    // A new chat goes to smart again...
    assert.equal((await router.chat(ask('new chat'))).candidate.model, 'smart');
    // Same chat, next turn: stays on medium even though smart is back.
    const b = await router.chat({ model: 'auto', messages: [...first, { role: 'assistant', content: 'hello' }, { role: 'user', content: 'more' }] });
    assert.equal(b.candidate.model, 'medium');
  } finally {
    await up.close();
  }
});

test('conversationKey ignores later turns', () => {
  const head = [{ role: 'user', content: 'x' }];
  assert.equal(conversationKey(head), conversationKey([...head, { role: 'assistant', content: 'y' }]));
  assert.notEqual(conversationKey(head), conversationKey([{ role: 'user', content: 'z' }]));
});

test('streaming passes the provider stream through untouched', async () => {
  const chunk = JSON.stringify({ choices: [{ delta: { content: '\u0633\u0644\u0627\u0645' } }] }); // "salam"
  const { up, router } = await setup((m) => (m === 'smart' ? { status: 429 } : { sse: [chunk] }));
  try {
    const out = await router.chat(ask('hi', { stream: true }));
    assert.equal(out.kind, 'stream');
    assert.equal(out.candidate.model, 'medium');
    const text = await readBody({ stream: out.stream });
    assert.ok(text.includes(chunk));
    assert.ok(text.includes('[DONE]'));
  } finally {
    await up.close();
  }
});

test('maxAttempts caps how many providers one request can wake up', async () => {
  const up = await fakeProvider(() => ({ status: 500 }));
  try {
    const def = provider('p', up.url);
    const chain = Array.from({ length: 10 }, (_, i) => ({ provider: 'p', model: `m${i}`, rank: i, def }));
    const router = createRouter({ getChain: () => chain, usage: new Usage(), cfg: { ...cfg, maxAttempts: 3 } });
    await router.chat(ask('hi'));
    assert.equal(up.calls.length, 3);
  } finally {
    await up.close();
  }
});
