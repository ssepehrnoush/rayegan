#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { buildCatalog } from './catalog.js';
import { doctor } from './doctor.js';
import { start } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version;

const HELP = `rayegan ${VERSION}
One OpenAI-compatible endpoint on top of every free LLM tier you have.
The smartest model with quota left answers; when it runs out, the next one does.

Usage:
  rayegan [start]        start the server (default http://127.0.0.1:8787/v1)
  rayegan doctor         check which providers answer from this network
  rayegan doctor --chat  ...and send one tiny chat to each
  rayegan models         print the chain, smartest first

Options:
  --port <n>             port to listen on (default 8787)
  --host <addr>          address to bind (default 127.0.0.1)
  --proxy <url>          http://127.0.0.1:10808 or socks5://127.0.0.1:10808
                         ("none" ignores HTTPS_PROXY). Each provider is tried
                         directly first and only uses the proxy if blocked.
  --proxy-all            send every provider through the proxy
  --config <file>        config file (default ./rayegan.json or ~/.rayegan/config.json)
  -h, --help             show this help
  -v, --version          print the version

Keys come from environment variables (GROQ_API_KEY, GEMINI_API_KEY, ...)
or from "keys" in the config file. Without any key, keyless providers still work.`;

function parseArgs(argv) {
  const args = { cmd: null, flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') args.flags.help = true;
    else if (a === '-v' || a === '--version') args.flags.version = true;
    else if (a === '--chat') args.flags.chat = true;
    else if (a === '--proxy-all') args.flags.proxyMode = 'always';
    else if (['--port', '--host', '--proxy', '--config'].includes(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      args.flags[a.slice(2)] = v;
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (!args.cmd) args.cmd = a;
    else throw new Error(`unexpected argument ${a}`);
  }
  return args;
}

function stamp() {
  return new Date().toTimeString().slice(0, 8);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`rayegan: ${err.message}\n\n${HELP}\n`);
    return 2;
  }
  if (args.flags.help) {
    process.stdout.write(HELP + '\n');
    return 0;
  }
  if (args.flags.version) {
    process.stdout.write(VERSION + '\n');
    return 0;
  }
  const cmd = args.cmd || 'start';
  if (!['start', 'doctor', 'models'].includes(cmd)) {
    process.stderr.write(`rayegan: unknown command "${cmd}"\n\n${HELP}\n`);
    return 2;
  }

  const cfg = loadConfig({
    file: args.flags.config,
    overrides: { port: args.flags.port, host: args.flags.host, proxy: args.flags.proxy, proxyMode: args.flags.proxyMode },
  });

  if (cmd === 'doctor') {
    const usable = await doctor(cfg, { chat: !!args.flags.chat });
    return usable ? 0 : 1;
  }

  if (cmd === 'models') {
    const cat = await buildCatalog(cfg);
    if (!cat.chain.length) {
      process.stdout.write('No models available. Run: rayegan doctor\n');
      return 1;
    }
    cat.chain.forEach((c, i) => process.stdout.write(`${String(i + 1).padStart(3)}  ${c.provider}/${c.model}\n`));
    return 0;
  }

  const log = (s) => process.stdout.write(`${stamp()}  ${s}\n`);
  if (cfg.file) log(`config: ${cfg.file}`);
  log(`proxy: ${cfg.proxy ? cfg.proxy.url : 'none'}`);
  log('looking up free models...');
  const app = await start({ cfg, log });
  const cat = app.getCatalog();
  for (const [id, s] of Object.entries(cat.status)) {
    if (s.state === 'ok') log(`  ${id}: ${s.using} model(s), ${s.route}`);
    else if (s.state === 'needs-key') log(`  ${id}: skipped, set ${s.missing.join(', ')}`);
    else log(`  ${id}: ${s.state} (${s.error})`);
  }
  if (!cat.chain.length) log('no model is reachable yet; requests will fail until one is. Try: rayegan doctor');

  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(cfg.port, cfg.host, resolve);
  }).catch((err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`rayegan: port ${cfg.port} is busy, pick another with --port\n`);
      process.exit(1);
    }
    throw err;
  });
  const base = `http://${cfg.host.includes(':') ? `[${cfg.host}]` : cfg.host}:${cfg.port}`;
  log(`${cat.chain.length} model(s) in the chain, smartest first`);
  log(`ready: ${base}/v1   (model "auto")   dashboard: ${base}/`);
  if (cfg.host !== '127.0.0.1' && cfg.host !== 'localhost' && !cfg.apiKey) {
    log('warning: listening beyond this machine without apiKey; anyone on the network can spend your quota');
  }
  return null;
}

main().then(
  (code) => {
    if (code !== null) process.exit(code);
  },
  (err) => {
    process.stderr.write(`rayegan: ${err.message}\n`);
    process.exit(1);
  },
);
