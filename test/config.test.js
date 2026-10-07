import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { tmpDir } from './helpers.js';

const builtin = {
  checked: '2026-10-07',
  ranking: ['big', 'small'],
  exclude: ['auto'],
  providers: [
    { id: 'free', baseUrl: 'https://free.example/v1/', keyless: true, limits: { rpm: 10 } },
    { id: 'keyed', baseUrl: 'https://keyed.example/v1', keyEnv: 'KEYED_API_KEY', limits: { rpd: 50 } },
    { id: 'acct', baseUrl: 'https://cf.example/{ACCOUNT}/v1', keyEnv: 'ACCT_TOKEN', needs: ['ACCOUNT'] },
  ],
};

function load(env = {}, user = null) {
  const cwd = tmpDir();
  if (user) fs.writeFileSync(path.join(cwd, 'rayegan.json'), JSON.stringify(user));
  return loadConfig({ cwd, env: { RAYEGAN_HOME: path.join(cwd, 'home'), ...env }, builtin });
}

test('keyless providers work with no setup at all', () => {
  const cfg = load();
  const free = cfg.providers.find((p) => p.id === 'free');
  assert.deepEqual(free.missing, []);
  assert.equal(free.baseUrl, 'https://free.example/v1');
  assert.deepEqual(cfg.providers.find((p) => p.id === 'keyed').missing, ['KEYED_API_KEY']);
});

test('an environment key beats a key in the config file', () => {
  const cfg = load({ KEYED_API_KEY: 'from-env' }, { keys: { keyed: 'from-file' } });
  assert.equal(cfg.providers.find((p) => p.id === 'keyed').key, 'from-env');
  assert.equal(load({}, { keys: { keyed: 'from-file' } }).providers.find((p) => p.id === 'keyed').key, 'from-file');
});

test('URL placeholders are filled from env or vars, and reported when missing', () => {
  const ok = load({ ACCT_TOKEN: 't', ACCOUNT: 'abc' }).providers.find((p) => p.id === 'acct');
  assert.equal(ok.baseUrl, 'https://cf.example/abc/v1');
  assert.deepEqual(ok.missing, []);
  const bad = load({ ACCT_TOKEN: 't' }).providers.find((p) => p.id === 'acct');
  assert.deepEqual(bad.missing, ['ACCOUNT']);
});

test('the config file can disable a provider, raise a limit, and add a provider', () => {
  const cfg = load({}, {
    disable: ['acct'],
    providers: [
      { id: 'keyed', limits: { rpd: 1000 } },
      { id: 'mine', baseUrl: 'http://10.0.0.5:11434/v1', keyless: true, models: ['big-local'] },
    ],
  });
  assert.equal(cfg.providers.some((p) => p.id === 'acct'), false);
  assert.equal(cfg.providers.find((p) => p.id === 'keyed').limits.rpd, 1000);
  assert.equal(cfg.providers.find((p) => p.id === 'mine').models[0], 'big-local');
});

test('proxy comes from HTTPS_PROXY, and "none" turns it off', () => {
  assert.equal(load({ HTTPS_PROXY: 'http://127.0.0.1:10808' }).proxy.port, 10808);
  assert.equal(load({ HTTPS_PROXY: 'http://127.0.0.1:10808', RAYEGAN_PROXY: 'none' }).proxy, null);
  assert.equal(load({}, { proxy: 'socks5://127.0.0.1:1080' }).proxy.protocol, 'socks5');
});

test('the shipped provider list is valid', () => {
  const cfg = loadConfig({ cwd: tmpDir(), env: { RAYEGAN_HOME: tmpDir() } });
  assert.ok(cfg.providers.length >= 5);
  for (const p of cfg.providers) {
    assert.ok(p.id && p.baseUrl.startsWith('https://'), p.id);
    assert.ok(p.keyless || p.keyEnv, `${p.id} needs keyless or keyEnv`);
  }
  for (const r of cfg.ranking) new RegExp(r);
  assert.ok(cfg.providers.some((p) => p.keyless), 'at least one provider must work without a key');
});
