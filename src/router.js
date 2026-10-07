// Sends one chat completion down the chain: the smartest model that still has
// quota goes first, and any failure hands the request to the next one.

import crypto from 'node:crypto';
import { request, readBody } from './http.js';
import { authHeaders } from './catalog.js';

export const AUTO = new Set(['auto', 'rayegan', 'free', 'default', '']);
const STICKY_TTL = 2 * 60 * 60 * 1000;
const STICKY_MAX = 2000;

// A conversation is identified by everything up to and including its first
// user message. Later turns of the same chat produce the same key, so the
// chat stays on one model instead of changing voice mid-conversation.
export function conversationKey(messages) {
  if (!Array.isArray(messages) || !messages.length) return null;
  const i = messages.findIndex((m) => m && m.role === 'user');
  const head = messages.slice(0, i === -1 ? 1 : i + 1);
  return crypto.createHash('sha1').update(JSON.stringify(head)).digest('hex');
}

// A 200 is only a success if there is something in it.
export function hasAnswer(json) {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  if (!choice) return false;
  const msg = choice.message || {};
  if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return true;
  if (typeof msg.content === 'string') return msg.content.trim().length > 0;
  if (Array.isArray(msg.content)) return msg.content.length > 0;
  return false;
}

export function createRouter({ getChain, usage, cfg, req = request, log = () => {} }) {
  const sticky = new Map(); // key -> { id, at }

  function remember(key, c) {
    if (!key) return;
    if (sticky.size >= STICKY_MAX) sticky.delete(sticky.keys().next().value);
    sticky.set(key, { id: `${c.provider}/${c.model}`, at: Date.now() });
  }

  function candidatesFor(body) {
    const chain = getChain();
    const wanted = String(body.model ?? '').trim();
    let list;
    if (AUTO.has(wanted.toLowerCase())) list = chain;
    else list = chain.filter((c) => c.model === wanted || `${c.provider}/${c.model}` === wanted);
    const key = conversationKey(body.messages);
    const s = key && sticky.get(key);
    if (s && Date.now() - s.at < STICKY_TTL) {
      const i = list.findIndex((c) => `${c.provider}/${c.model}` === s.id);
      if (i > 0) list = [list[i], ...list.slice(0, i), ...list.slice(i + 1)];
    }
    return { list, key, wanted };
  }

  async function chat(body) {
    const { list, key, wanted } = candidatesFor(body);
    const attempts = [];
    if (!list.length) {
      return errorResult(404, `no model called "${wanted}" is available. Use "auto" or GET /v1/models.`, attempts);
    }
    for (const c of list) {
      if (attempts.filter((a) => a.sent).length >= cfg.maxAttempts) break;
      const ok = usage.check(c);
      if (!ok.ok) {
        attempts.push({ id: `${c.provider}/${c.model}`, skipped: ok.reason });
        continue;
      }
      const id = `${c.provider}/${c.model}`;
      const upstream = { ...body, model: c.model };
      usage.sent(c);
      let res;
      try {
        res = await req(`${c.def.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { ...authHeaders(c.def), accept: body.stream ? 'text/event-stream' : 'application/json' },
          body: upstream,
          proxy: cfg.proxy,
          timeoutMs: cfg.timeoutMs,
        });
      } catch (err) {
        const v = usage.failure(c, { error: err.message });
        attempts.push({ id, sent: true, failed: v.kind, detail: err.message });
        log(`${id}: ${err.message}`);
        continue;
      }

      if (res.status !== 200) {
        let text = '';
        try {
          text = (await readBody(res, 64 * 1024)).slice(0, 2000);
        } catch {
          // ignore, the status code is enough
        }
        const v = usage.failure(c, { status: res.status, text, retryAfter: res.headers['retry-after'] });
        attempts.push({ id, sent: true, failed: v.kind, status: res.status });
        log(`${id}: HTTP ${res.status} -> ${v.kind}`);
        continue;
      }

      if (body.stream) {
        // Once bytes start flowing we cannot switch models, so streaming
        // trusts the 200. Non-streaming requests get the content check.
        usage.success(c, 0);
        remember(key, c);
        attempts.push({ id, sent: true, ok: true });
        return { kind: 'stream', status: 200, stream: res.stream, headers: res.headers, candidate: c, attempts };
      }

      let json;
      try {
        json = JSON.parse(await readBody(res));
      } catch (err) {
        const v = usage.failure(c, { status: 200, text: 'unparseable body' });
        attempts.push({ id, sent: true, failed: v.kind, detail: 'unparseable body' });
        continue;
      }
      if (json.error || !hasAnswer(json)) {
        const detail = json.error ? JSON.stringify(json.error).slice(0, 300) : 'empty answer';
        const v = usage.failure(c, { status: json.error?.code === 429 ? 429 : 200, text: detail });
        attempts.push({ id, sent: true, failed: v.kind === 'error' ? 'empty' : v.kind, detail });
        log(`${id}: 200 without an answer`);
        continue;
      }
      usage.success(c, json.usage?.total_tokens || 0);
      remember(key, c);
      attempts.push({ id, sent: true, ok: true });
      return { kind: 'json', status: 200, json, candidate: c, attempts };
    }
    return errorResult(503, 'every free model in the chain is out of quota or failing right now. See GET /status.', attempts);
  }

  return { chat, candidatesFor };
}

function errorResult(status, message, attempts) {
  return {
    kind: 'json',
    status,
    json: { error: { message, type: 'rayegan_unavailable', attempts } },
    attempts,
  };
}
