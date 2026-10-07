// Counts what each provider and model has used today, and keeps a circuit
// breaker per model so a dead model is skipped instead of retried on every
// request.
//
// Lessons from running a free-model chain in production for a week:
//  - A removed model (404 "does not exist") is not a blip. Park it for a day.
//  - A 200 with no choices is a failure, not a success.
//  - Fixed short cooldowns turn one dead model into an alert every half hour.
//    Back off exponentially instead.

import fs from 'node:fs';
import path from 'node:path';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const BACKOFF = [30 * 1000, 2 * MIN, 10 * MIN, HOUR, 6 * HOUR];
const RATE_BACKOFF = [MIN, 5 * MIN, 30 * MIN, 2 * HOUR];

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function limitsFor(def, model) {
  const base = { ...(def.limits || {}) };
  for (const m of def.modelLimits || []) {
    if (new RegExp(m.match, 'i').test(model)) {
      const { match, ...rest } = m;
      return { ...base, ...rest };
    }
  }
  return base;
}

// What went wrong, from status code and error text. Returns how long to park
// the model or provider, and whether the failure belongs to the provider as a
// whole (a bad key affects every model behind it).
export function classify({ status, text = '', retryAfter, error }, strikes = 0) {
  const t = String(text).toLowerCase();
  if (error) return { kind: 'network', scope: 'model', ms: BACKOFF[Math.min(strikes, BACKOFF.length - 1)] };
  if (status === 404 || /does not exist|not found|no endpoints|model_not_found|decommissioned/.test(t)) {
    return { kind: 'gone', scope: 'model', ms: 24 * HOUR };
  }
  if (status === 401) return { kind: 'bad-key', scope: 'provider', ms: 24 * HOUR };
  if (status === 403) return { kind: 'blocked', scope: 'provider', ms: 6 * HOUR };
  if (status === 402) return { kind: 'paid-only', scope: 'model', ms: 24 * HOUR };
  if (status === 429) {
    const ra = Number(retryAfter);
    const ms = Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 24 * HOUR) : RATE_BACKOFF[Math.min(strikes, RATE_BACKOFF.length - 1)];
    return { kind: 'rate-limited', scope: 'model', ms };
  }
  if (status === 400 || status === 413 || status === 422) {
    // The request itself was wrong for this model (too long, unsupported
    // parameter). Try the next model, but do not punish this one.
    return { kind: 'rejected', scope: 'none', ms: 0 };
  }
  return { kind: 'error', scope: 'model', ms: BACKOFF[Math.min(strikes, BACKOFF.length - 1)] };
}

export class Usage {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.day = utcDay(now());
    this.counts = {}; // key -> { req, tok }
    this.parked = {}; // key -> { until, kind, strikes, detail }
    this.recent = {}; // key -> [timestamps] for per-minute limits, memory only
    this.load();
  }

  load() {
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (s.day === this.day) this.counts = s.counts || {};
      this.parked = s.parked || {};
    } catch {
      // A corrupt state file only costs us today's counters.
    }
  }

  save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ day: this.day, counts: this.counts, parked: this.parked }));
      fs.renameSync(tmp, this.file);
    } catch {
      // Losing a counter is better than failing a user's request.
    }
  }

  rollover() {
    const d = utcDay(this.now());
    if (d !== this.day) {
      this.day = d;
      this.counts = {};
    }
  }

  keys(c) {
    const lim = limitsFor(c.def, c.model);
    const modelKey = `${c.provider}/${c.model}`;
    return { lim, modelKey, limitKey: lim.scope === 'model' ? modelKey : c.provider };
  }

  // Can this candidate take one more request right now?
  check(c) {
    this.rollover();
    const t = this.now();
    const { lim, modelKey, limitKey } = this.keys(c);
    for (const key of [c.provider, modelKey]) {
      const p = this.parked[key];
      if (p && p.until > t) return { ok: false, reason: p.kind, until: p.until };
    }
    const used = this.counts[limitKey] || { req: 0, tok: 0 };
    if (lim.rpd && used.req >= lim.rpd) return { ok: false, reason: 'daily-limit' };
    if (lim.tpd && used.tok >= lim.tpd) return { ok: false, reason: 'daily-tokens' };
    if (lim.rpm) {
      const recent = (this.recent[limitKey] || []).filter((x) => x > t - MIN);
      this.recent[limitKey] = recent;
      if (recent.length >= lim.rpm) return { ok: false, reason: 'minute-limit' };
    }
    return { ok: true };
  }

  sent(c) {
    const { limitKey } = this.keys(c);
    (this.recent[limitKey] ||= []).push(this.now());
  }

  success(c, tokens = 0) {
    this.rollover();
    const { modelKey, limitKey } = this.keys(c);
    for (const key of new Set([limitKey, modelKey])) {
      const used = (this.counts[key] ||= { req: 0, tok: 0 });
      used.req += 1;
      used.tok += tokens || 0;
    }
    delete this.parked[modelKey];
    if (this.parked[c.provider]?.until <= this.now()) delete this.parked[c.provider];
    this.save();
  }

  failure(c, info) {
    const { modelKey, limitKey } = this.keys(c);
    const prev = this.parked[modelKey];
    const strikes = prev ? prev.strikes + 1 : 0;
    const v = classify(info, strikes);
    // A request that reached the provider and was answered counts against the
    // daily quota even if the answer was useless. A 429 usually does not.
    if (!info.error && info.status !== 429) {
      for (const key of new Set([limitKey, modelKey])) {
        (this.counts[key] ||= { req: 0, tok: 0 }).req += 1;
      }
    }
    if (v.scope !== 'none') {
      const key = v.scope === 'provider' ? c.provider : modelKey;
      this.parked[key] = {
        until: this.now() + v.ms,
        kind: v.kind,
        strikes: v.scope === 'provider' ? 0 : strikes,
        detail: String(info.text || info.error || '').slice(0, 160),
      };
    }
    this.save();
    return v;
  }

  snapshot() {
    this.rollover();
    return { day: this.day, counts: this.counts, parked: this.parked };
  }
}
