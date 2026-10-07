import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

export function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

// A fake OpenAI-compatible provider. `behave(model, body)` returns
// { status, json } or { status, sse: [chunks] } or { status, text }.
export async function fakeProvider(behave, models = []) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: models }));
      }
      const body = raw ? JSON.parse(raw) : {};
      calls.push({ model: body.model, body, headers: req.headers });
      const out = behave(body.model, body) || { status: 200, json: answer(`hi from ${body.model}`) };
      if (out.sse) {
        res.writeHead(out.status || 200, { 'content-type': 'text/event-stream' });
        for (const c of out.sse) res.write(`data: ${c}\n\n`);
        return res.end('data: [DONE]\n\n');
      }
      res.writeHead(out.status || 200, { 'content-type': 'application/json', ...(out.headers || {}) });
      res.end(out.text ?? JSON.stringify(out.json ?? {}));
    });
  });
  const url = await listen(server);
  return { url, calls, close: () => close(server) };
}

export function answer(content, usage = { total_tokens: 10 }) {
  return { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage };
}

export function provider(id, baseUrl, extra = {}) {
  return { id, name: id, baseUrl, keyless: true, key: null, missing: [], limits: {}, ...extra };
}

export function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rayegan-test-'));
}

// Tests address the fake provider as "rayegan.invalid", a name that only the
// test proxies resolve. A request that skipped the proxy fails on DNS instead
// of quietly reaching 127.0.0.1, which is how a Node 18 bypass once hid.
export const VIA_PROXY_ONLY = 'rayegan.invalid';
const dialable = (host) => (host === VIA_PROXY_ONLY || host === 'localhost' ? '127.0.0.1' : host);

// Minimal HTTP CONNECT proxy. Records every target it tunnels to.
export async function connectProxy() {
  const targets = [];
  const open = new Set();
  const server = http.createServer((req, res) => res.writeHead(405).end());
  server.on('connect', (req, client, head) => {
    targets.push(req.url);
    open.add(client);
    client.on('close', () => open.delete(client));
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), dialable(host), () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });
  const url = await listen(server);
  return {
    url,
    targets,
    openCount: () => open.size,
    close: () => {
      for (const c of open) c.destroy();
      return close(server);
    },
  };
}

// Minimal SOCKS5 proxy (no auth, domain-name and IPv4 targets).
export async function socksProxy() {
  const targets = [];
  const open = new Set();
  const server = net.createServer((client) => {
    open.add(client);
    client.on('close', () => open.delete(client));
    let stage = 0;
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0 && buf.length >= 2 && buf.length >= 2 + buf[1]) {
        buf = buf.subarray(2 + buf[1]);
        client.write(Buffer.from([5, 0]));
        stage = 1;
      }
      if (stage === 1 && buf.length >= 5) {
        let host;
        let end;
        if (buf[3] === 3) {
          const len = buf[4];
          if (buf.length < 5 + len + 2) return;
          host = buf.subarray(5, 5 + len).toString();
          end = 5 + len;
        } else if (buf[3] === 1) {
          if (buf.length < 10) return;
          host = [...buf.subarray(4, 8)].join('.');
          end = 8;
        } else return client.destroy();
        const port = buf.readUInt16BE(end);
        targets.push(`${host}:${port}`);
        client.off('data', onData);
        // Node 18 resolves "localhost" to ::1 first and does not fall back to
        // IPv4, while the fake provider only listens on 127.0.0.1.
        const upstream = net.connect(port, dialable(host), () => {
          client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
          upstream.pipe(client);
          client.pipe(upstream);
        });
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
        stage = 2;
      }
    };
    client.on('data', onData);
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  return {
    url: `socks5://127.0.0.1:${port}`,
    targets,
    close: () => {
      for (const c of open) c.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}
