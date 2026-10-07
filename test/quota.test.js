import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Usage, classify, limitsFor } from '../src/quota.js';
import { provider, tmpDir } from './helpers.js';

const HOUR = 3600 * 1000;

function cand(model, limits = {}, extra = {}) {
  const def = provider('p', 'http://x', { limits, ...extra });
  return { provider: 'p', model, def };
}

function clock(start = Date.UTC(2026, 9, 7, 10)) {
  let t = start;
  const now = () => t;
  now.add = (ms) => (t += ms);
  return now;
}

test('a removed model is parked for a day, not retried every minute', () => {
  assert.deepEqual(classify({ status: 404, text: '' }), { kind: 'gone', scope: 'model', ms: 24 * HOUR });
  assert.equal(classify({ status: 400, text: 'model "x" does not exist' }).kind, 'gone');
});

test('a bad key parks the whole provider', () => {
  assert.equal(classify({ status: 401 }).scope, 'provider');
  assert.equal(classify({ status: 403 }).kind, 'blocked');
});

test('429 honours Retry-After, and backs off when there is none', () => {
  assert.equal(classify({ status: 429, retryAfter: '42' }).ms, 42000);
  assert.ok(classify({ status: 429 }, 0).ms < classify({ status: 429 }, 2).ms);
});

test('400 tries the next model without punishing this one', () => {
  assert.equal(classify({ status: 400, text: 'context too long' }).scope, 'none');
});

test('daily request limit stops a model, and the next UTC day resets it', () => {
  const now = clock();
  const u = new Usage({ now });
  const c = cand('m', { rpd: 2 });
  u.success(c);
  u.success(c);
  assert.deepEqual(u.check(c), { ok: false, reason: 'daily-limit' });
  now.add(24 * HOUR);
  assert.equal(u.check(c).ok, true);
});

test('per-minute limit frees up after a minute', () => {
  const now = clock();
  const u = new Usage({ now });
  const c = cand('m', { rpm: 2 });
  u.sent(c);
  u.sent(c);
  assert.equal(u.check(c).reason, 'minute-limit');
  now.add(61 * 1000);
  assert.equal(u.check(c).ok, true);
});

test('provider-scoped limits are shared by every model of that provider', () => {
  const u = new Usage({ now: clock() });
  const a = cand('a', { rpd: 1 });
  const b = cand('b', { rpd: 1 });
  u.success(a);
  assert.equal(u.check(b).reason, 'daily-limit');
});

test('model-scoped limits are not shared', () => {
  const u = new Usage({ now: clock() });
  const a = cand('a', { scope: 'model', rpd: 1 });
  const b = cand('b', { scope: 'model', rpd: 1 });
  u.success(a);
  assert.equal(u.check(b).ok, true);
});

test('modelLimits override the provider default for matching models', () => {
  const def = provider('gemini', 'http://x', { limits: { scope: 'model', rpd: 20 }, modelLimits: [{ match: 'flash-lite', rpd: 500 }] });
  assert.equal(limitsFor(def, 'gemini-3.5-flash-lite').rpd, 500);
  assert.equal(limitsFor(def, 'gemini-3.5-flash').rpd, 20);
});

test('a parked model comes back when its time is up, and success clears strikes', () => {
  const now = clock();
  const u = new Usage({ now });
  const c = cand('m');
  const v = u.failure(c, { status: 500, text: 'boom' });
  assert.equal(u.check(c).ok, false);
  now.add(v.ms + 1);
  assert.equal(u.check(c).ok, true);
  u.failure(c, { status: 500 });
  u.success(c);
  assert.equal(u.parked['p/m'], undefined);
});

test('repeated failures back off further each time', () => {
  const now = clock();
  const u = new Usage({ now });
  const c = cand('m');
  const first = u.failure(c, { status: 503 }).ms;
  now.add(first + 1);
  const second = u.failure(c, { status: 503 }).ms;
  assert.ok(second > first);
});

test('a 429 does not count against the daily quota, a useless 200 does', () => {
  const u = new Usage({ now: clock() });
  const c = cand('m', { rpd: 10 });
  u.failure(c, { status: 429 });
  assert.equal(u.counts.p?.req ?? 0, 0);
  u.failure(c, { status: 200, text: 'empty answer' });
  assert.equal(u.counts.p.req, 1);
});

test('counters and parked models survive a restart on the same day', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'usage.json');
  const now = clock();
  const a = new Usage({ file, now });
  const c = cand('m', { rpd: 1 });
  a.success(c);
  a.failure(cand('dead'), { status: 404 });
  const b = new Usage({ file, now });
  assert.equal(b.check(c).reason, 'daily-limit');
  assert.equal(b.check(cand('dead')).reason, 'gone');
});
