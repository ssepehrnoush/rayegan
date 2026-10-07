import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { parseProxy, openTunnel } from '../src/proxy.js';
import { request, readJson } from '../src/http.js';
import { fakeProvider, connectProxy, socksProxy } from './helpers.js';

test('parseProxy understands the forms v2ray users paste', () => {
  assert.equal(parseProxy('http://127.0.0.1:10808').protocol, 'http');
  assert.equal(parseProxy('127.0.0.1:10809').port, 10809);
  assert.equal(parseProxy('socks5://127.0.0.1:10808').protocol, 'socks5');
  assert.equal(parseProxy('socks5h://127.0.0.1:1080').protocol, 'socks5');
  assert.deepEqual(parseProxy('http://u:p%40ss@h:1').auth, { user: 'u', pass: 'p@ss' });
  assert.throws(() => parseProxy('ftp://x:1'), /unsupported proxy scheme/);
  assert.equal(parseProxy(''), null);
});

test('requests travel through an HTTP CONNECT proxy', async () => {
  const up = await fakeProvider(() => null);
  const px = await connectProxy();
  try {
    const res = await request(`${up.url}/chat/completions`, {
      method: 'POST',
      body: { model: 'm', messages: [] },
      proxy: parseProxy(px.url),
      proxyLocal: true,
    });
    assert.equal(res.status, 200);
    assert.equal((await readJson(res)).choices[0].message.content, 'hi from m');
    assert.equal(px.targets.length, 1);
    assert.equal(px.targets[0], new URL(up.url).host);
  } finally {
    await px.close();
    await up.close();
  }
});

test('a finished request closes its tunnel instead of leaking it', async () => {
  const up = await fakeProvider(() => null);
  const px = await connectProxy();
  try {
    for (let i = 0; i < 3; i++) {
      const res = await request(`${up.url}/models`, { proxy: parseProxy(px.url), proxyLocal: true });
      await readJson(res);
    }
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(px.targets.length, 3);
    assert.equal(px.openCount(), 0);
  } finally {
    await px.close();
    await up.close();
  }
});

test('requests travel through a SOCKS5 proxy, which receives the hostname', async () => {
  const up = await fakeProvider(() => null);
  const px = await socksProxy();
  try {
    const port = new URL(up.url).port;
    const res = await request(`http://localhost:${port}/chat/completions`, {
      method: 'POST',
      body: { model: 'm', messages: [] },
      proxy: parseProxy(px.url),
      proxyLocal: true,
    });
    assert.equal(res.status, 200);
    await readJson(res);
    // The name, not a locally resolved IP: local DNS in Iran is not trusted.
    assert.equal(px.targets[0], `localhost:${port}`);
  } finally {
    await px.close();
    await up.close();
  }
});

test('localhost bypasses the proxy by default', async () => {
  const up = await fakeProvider(() => null);
  const px = await connectProxy();
  try {
    const res = await request(`${up.url}/models`, { proxy: parseProxy(px.url) });
    await readJson(res);
    assert.equal(px.targets.length, 0);
  } finally {
    await px.close();
    await up.close();
  }
});

test('a dead proxy gives a clear error, not a hang', async () => {
  const srv = net.createServer();
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  await new Promise((r) => srv.close(r));
  await assert.rejects(openTunnel(parseProxy(`http://127.0.0.1:${port}`), 'example.com', 443, 2000), /cannot reach proxy/);
});

test('a proxy that refuses CONNECT is reported', async () => {
  const srv = net.createServer((s) => s.once('data', () => s.end('HTTP/1.1 403 Forbidden\r\n\r\n')));
  const port = await new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));
  try {
    await assert.rejects(openTunnel(parseProxy(`http://127.0.0.1:${port}`), 'example.com', 443, 2000), /refused CONNECT/);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});
