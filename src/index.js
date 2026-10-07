import path from 'node:path';
import { loadConfig } from './config.js';
import { buildCatalog } from './catalog.js';
import { Usage } from './quota.js';
import { createRouter } from './router.js';
import { createServer } from './server.js';

export { loadConfig } from './config.js';
export { buildCatalog, rankOf, pickModels, orderChain } from './catalog.js';
export { Usage, classify } from './quota.js';
export { createRouter, hasAnswer, conversationKey } from './router.js';
export { createServer, statusReport } from './server.js';
export { doctor } from './doctor.js';
export { parseProxy } from './proxy.js';

const REFRESH_MS = 6 * 60 * 60 * 1000;

// Everything wired together. Returns the http.Server (not yet listening) and
// a stop() that clears the refresh timer.
export async function start(options = {}) {
  const cfg = options.cfg || loadConfig(options);
  const log = options.log || (() => {});
  const req = options.req;
  let catalog = await buildCatalog(cfg, { log, ...(req ? { req } : {}) });

  const usage = options.usage || new Usage({ file: options.stateFile === undefined ? path.join(cfg.home, 'usage.json') : options.stateFile });
  const getCatalog = () => catalog;
  const router = createRouter({ getChain: () => catalog.chain, usage, cfg, log, ...(req ? { req } : {}) });
  const server = createServer({ router, getCatalog, usage, cfg, log });

  // Free model lists change under us; re-discover a few times a day.
  const timer = setInterval(async () => {
    try {
      catalog = await buildCatalog(cfg, { log, ...(req ? { req } : {}) });
    } catch (err) {
      log(`refresh failed: ${err.message}`);
    }
  }, REFRESH_MS);
  timer.unref();

  return { server, cfg, usage, getCatalog, stop: () => clearInterval(timer) };
}
