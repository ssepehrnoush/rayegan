// One request function for everything that leaves this process, with or
// without a proxy. It returns the raw response stream so streaming chat
// completions can be piped straight to the client.

import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { openTunnel } from './proxy.js';

const LOCAL = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export async function request(url, opts = {}) {
  const { method = 'GET', headers = {}, body, proxy, timeoutMs = 60000, proxyLocal = false } = opts;
  const u = new URL(url);
  const secure = u.protocol === 'https:';
  const port = Number(u.port) || (secure ? 443 : 80);
  const hdrs = { ...headers };
  let payload;
  if (body !== undefined) {
    payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    if (!hdrs['content-type']) hdrs['content-type'] = 'application/json';
    hdrs['content-length'] = Buffer.byteLength(payload);
  }

  let socket = null;
  if (proxy && (proxyLocal || !LOCAL.has(u.hostname))) {
    const raw = await openTunnel(proxy, u.hostname, port, Math.min(timeoutMs, 20000));
    socket = secure ? tls.connect({ socket: raw, servername: u.hostname, ALPNProtocols: ['http/1.1'] }) : raw;
    // One tunnel per request. Without this the provider keeps the tunnel
    // alive and every proxied request leaks a socket.
    hdrs.connection = 'close';
  }

  const mod = secure ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port,
        path: u.pathname + u.search,
        method,
        headers: hdrs,
        timeout: timeoutMs,
        ...(socket ? { agent: false, createConnection: () => socket } : {}),
      },
      (res) => {
        if (socket) res.once('close', () => socket.destroy());
        resolve({ status: res.statusCode, headers: res.headers, stream: res });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`no answer from ${u.hostname} in ${timeoutMs} ms`)));
    req.on('error', (err) => {
      if (socket) socket.destroy();
      reject(err);
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export async function readBody(res, limit = 8 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.stream) {
    size += chunk.length;
    if (size > limit) {
      res.stream.destroy();
      throw new Error('response too large');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function readJson(res, limit) {
  const text = await readBody(res, limit);
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error(`not JSON: ${text.slice(0, 200)}`);
    err.text = text;
    throw err;
  }
}
