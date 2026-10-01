#!/usr/bin/env node
/**
 * UI-000 evidence helper — static server for the temporary candidate surface.
 *
 * The candidates are ES modules, so they cannot be opened over file:// (module
 * scripts are blocked by CORS on file URLs). This serves the repo root read-only
 * on loopback so the screenshot harness can drive them.
 *
 * This is EVIDENCE TOOLING for the UI-000 Owner gate. It is not a product
 * runtime and must be deleted together with apps/web/candidates/.
 *
 *   node scripts/ui-000/serve.mjs [port]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PORT = Number(process.argv[2] ?? process.env.UI000_PORT ?? 4330);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const target = normalize(join(ROOT, pathname));
    if (!target.startsWith(ROOT + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(target);
    if (!info.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`UI-000 candidate surface: http://127.0.0.1:${PORT}/apps/web/candidates/`);
});
