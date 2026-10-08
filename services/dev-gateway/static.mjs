/**
 * UTOPIA · Gateway — static serving for the Web control surface.
 *
 * The shell used to be an explicit path→file map, which meant every new product page
 * needed a gateway edit. That is now a containment-checked file server rooted at
 * `apps/web`, so the product can grow its own UI without the transport having to know
 * the page list. Path traversal is refused, `/` and `/pairing` both resolve to the shell,
 * and unknown paths fall through (returning false) so callers keep their own 404.
 */

import { readFile, stat } from 'node:fs/promises';
import { extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_ROOT = resolve(fileURLToPath(import.meta.url), '../../../apps/web');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Routes that render the single-page shell rather than a file of their own. */
const SHELL_ROUTES = new Set(['/', '/pairing']);

export const webRoot = WEB_ROOT;

/**
 * Serve one Web asset. Returns true when a response was sent, false when the caller
 * should continue (unknown path or a directory).
 */
export async function serveWeb(res, urlPath) {
  const requested = SHELL_ROUTES.has(urlPath) ? '/index.html' : urlPath;
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch {
    return false;
  }
  const sharedLabels = decoded === '/contracts/device-platform/labels.mjs';
  const candidate = sharedLabels ? resolve(WEB_ROOT, '../../contracts/device-platform/labels.mjs') : resolve(WEB_ROOT, normalize(decoded).replace(/^([/\\])+/, ''));
  if (!sharedLabels && candidate !== WEB_ROOT && !candidate.startsWith(WEB_ROOT + sep)) return false;

  let info;
  try {
    info = await stat(candidate);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const body = await readFile(candidate);
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
  return true;
}
