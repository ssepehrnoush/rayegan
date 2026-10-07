// Tunnels through a local proxy without any dependency.
//
// Most developers in Iran already run v2ray, Xray or a similar client that
// exposes an HTTP proxy, a SOCKS5 proxy, or one "mixed" port that speaks both.
// Node's built-in fetch ignores HTTPS_PROXY on Node 18 to 22, so we open the
// tunnel ourselves and hand the raw socket to node:https.

import net from 'node:net';

export function parseProxy(value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value.includes('://') ? value : `http://${value}`);
  } catch {
    throw new Error(`invalid proxy URL: ${value}`);
  }
  const scheme = url.protocol.replace(':', '');
  let protocol;
  if (scheme === 'http' || scheme === 'https') protocol = 'http';
  else if (scheme === 'socks5' || scheme === 'socks5h' || scheme === 'socks') protocol = 'socks5';
  else throw new Error(`unsupported proxy scheme "${scheme}", use http:// or socks5://`);
  const port = Number(url.port) || (protocol === 'http' ? 8080 : 1080);
  const auth = url.username
    ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password) }
    : null;
  return { protocol, host: url.hostname, port, auth, url: `${scheme}://${url.hostname}:${port}` };
}

// Small helper: read exactly `n` bytes, or until `until` matches, from a
// socket that is still in paused/handshake mode.
function reader(socket) {
  let buf = Buffer.alloc(0);
  let waiting = null;
  let failed = null;

  const settle = () => {
    if (!waiting) return;
    if (failed) {
      const w = waiting;
      waiting = null;
      w.reject(failed);
      return;
    }
    const need = waiting.need(buf);
    if (need > 0 && buf.length >= need) {
      const out = buf.subarray(0, need);
      buf = buf.subarray(need);
      const w = waiting;
      waiting = null;
      w.resolve(out);
    }
  };
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    settle();
  };
  const onEnd = () => {
    failed = new Error('proxy closed the connection during handshake');
    settle();
  };
  const onError = (err) => {
    failed = err;
    settle();
  };
  socket.on('data', onData);
  socket.on('end', onEnd);
  socket.on('error', onError);

  return {
    // need(buf) returns the number of bytes to take, or 0 if not known yet.
    take(need) {
      return new Promise((resolve, reject) => {
        waiting = { need, resolve, reject };
        settle();
      });
    },
    exact(n) {
      return this.take((b) => (b.length >= n ? n : 0));
    },
    detach() {
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
      // Anything the proxy sent after the handshake belongs to the caller.
      if (buf.length) socket.unshift(buf);
    },
  };
}

function connect(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`proxy ${host}:${port} did not answer in ${timeoutMs} ms`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`cannot reach proxy ${host}:${port} (${err.code || err.message})`));
    });
  });
}

async function httpConnect(socket, proxy, host, port) {
  const r = reader(socket);
  const lines = [`CONNECT ${host}:${port} HTTP/1.1`, `Host: ${host}:${port}`];
  if (proxy.auth) {
    const token = Buffer.from(`${proxy.auth.user}:${proxy.auth.pass}`).toString('base64');
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  const head = await r.take((b) => {
    const i = b.indexOf('\r\n\r\n');
    return i === -1 ? 0 : i + 4;
  });
  r.detach();
  const status = head.toString('latin1').split('\r\n')[0];
  const code = Number(status.split(' ')[1]);
  if (code !== 200) throw new Error(`proxy refused CONNECT ${host}:${port}: ${status}`);
}

async function socks5Connect(socket, proxy, host, port) {
  const r = reader(socket);
  socket.write(Buffer.from(proxy.auth ? [5, 2, 0, 2] : [5, 1, 0]));
  const [ver, method] = await r.exact(2);
  if (ver !== 5) throw new Error('not a SOCKS5 proxy');
  if (method === 2) {
    if (!proxy.auth) throw new Error('SOCKS5 proxy wants a username and password');
    const u = Buffer.from(proxy.auth.user);
    const p = Buffer.from(proxy.auth.pass);
    socket.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
    const [, ok] = await r.exact(2);
    if (ok !== 0) throw new Error('SOCKS5 proxy rejected the username or password');
  } else if (method !== 0) {
    throw new Error('SOCKS5 proxy offered no usable auth method');
  }
  // Send the hostname, not a resolved IP, so DNS happens on the far side.
  // Local DNS in Iran often returns poisoned answers for blocked domains.
  const name = Buffer.from(host);
  const req = Buffer.concat([
    Buffer.from([5, 1, 0, 3, name.length]),
    name,
    Buffer.from([port >> 8, port & 0xff]),
  ]);
  socket.write(req);
  const head = await r.exact(4);
  if (head[1] !== 0) throw new Error(`SOCKS5 proxy could not reach ${host}:${port} (code ${head[1]})`);
  const atyp = head[3];
  let rest;
  if (atyp === 1) rest = 4 + 2;
  else if (atyp === 4) rest = 16 + 2;
  else if (atyp === 3) rest = (await r.exact(1))[0] + 2;
  else throw new Error('SOCKS5 proxy sent an unknown address type');
  await r.exact(rest);
  r.detach();
}

// Returns a plain TCP socket that is already connected to host:port through
// the proxy. The caller wraps it in TLS if needed.
export async function openTunnel(proxy, host, port, timeoutMs = 15000) {
  const socket = await connect(proxy.host, proxy.port, timeoutMs);
  const timer = setTimeout(() => socket.destroy(new Error('proxy handshake timed out')), timeoutMs);
  try {
    if (proxy.protocol === 'socks5') await socks5Connect(socket, proxy, host, port);
    else await httpConnect(socket, proxy, host, port);
    return socket;
  } catch (err) {
    socket.destroy();
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
