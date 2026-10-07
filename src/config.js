// Merges the built-in provider list with the user's config file and
// environment. Keys can live in either place; the environment wins so a key
// never has to be written to disk.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProxy } from './proxy.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function builtinProviders() {
  return JSON.parse(fs.readFileSync(path.join(here, 'providers.json'), 'utf8'));
}

export function homeDir(env = process.env) {
  return env.RAYEGAN_HOME || path.join(os.homedir(), '.rayegan');
}

function findConfigFile(explicit, cwd, env) {
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`config file not found: ${explicit}`);
    return explicit;
  }
  for (const p of [path.join(cwd, 'rayegan.json'), path.join(homeDir(env), 'config.json')]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read ${file}: ${err.message}`);
  }
}

export function loadConfig({ file, cwd = process.cwd(), env = process.env, overrides = {}, builtin } = {}) {
  const base = builtin || builtinProviders();
  const configFile = findConfigFile(file, cwd, env);
  const user = configFile ? readJsonFile(configFile) : {};

  const keys = { ...(user.keys || {}) };
  const vars = { ...(user.vars || {}) };
  const disabled = new Set(user.disable || []);
  const userProviders = user.providers || [];

  const providers = [];
  for (const def of [...base.providers, ...userProviders.filter((p) => !base.providers.some((b) => b.id === p.id))]) {
    const patch = userProviders.find((p) => p.id === def.id && def !== p) || {};
    const p = { ...def, ...patch, limits: { ...(def.limits || {}), ...(patch.limits || {}) } };
    if (disabled.has(p.id)) continue;

    const key = (p.keyEnv && env[p.keyEnv]) || keys[p.id] || null;
    let missing = [];
    let baseUrl = p.baseUrl;
    for (const name of p.needs || []) {
      const value = env[name] || vars[name];
      if (!value) missing.push(name);
      else baseUrl = baseUrl.replace(`{${name}}`, value);
    }
    if (!p.keyless && !key) missing = [p.keyEnv || `keys.${p.id}`, ...missing];
    providers.push({ ...p, baseUrl: baseUrl.replace(/\/+$/, ''), key, missing });
  }

  const proxyValue = overrides.proxy ?? user.proxy ?? env.RAYEGAN_PROXY ?? env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? null;

  return {
    file: configFile,
    providers,
    ranking: user.ranking || base.ranking,
    exclude: [...base.exclude, ...(user.exclude || [])],
    proxy: proxyValue && proxyValue !== 'none' ? parseProxy(proxyValue) : null,
    // "auto": try each provider directly, use the proxy only where direct
    // fails or answers 403. "always": everything through the proxy.
    proxyMode: overrides.proxyMode ?? user.proxyMode ?? env.RAYEGAN_PROXY_MODE ?? 'auto',
    port: Number(overrides.port ?? user.port ?? env.RAYEGAN_PORT ?? 8787),
    host: overrides.host ?? user.host ?? env.RAYEGAN_HOST ?? '127.0.0.1',
    apiKey: user.apiKey ?? env.RAYEGAN_API_KEY ?? null,
    timeoutMs: Number(user.timeoutMs ?? 60000),
    maxAttempts: Number(user.maxAttempts ?? 6),
    home: homeDir(env),
    checked: base.checked,
  };
}
