/**
 * UTOPIA · Rooms — shared local HTTP plumbing for the hub and its rooms.
 *
 * Local-only product implementation detail. This is not City Control Protocol
 * and must never be reused as one.
 */

import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { RoomValidationError } from './room-kit.mjs';
import { RoomStoreError } from './atomic-store.mjs';

/** Maximum accepted request body (bytes). */
export const MAX_BODY_BYTES = 8 * 1024 * 1024;

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

/** Send a JSON response. */
export function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** Send a plain text response. */
export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** Read the raw request body with a hard size cap. */
export async function readRawBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new RoomValidationError(`request body exceeds ${MAX_BODY_BYTES} bytes`, 413);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Read and parse a JSON request body. */
export async function readJsonBody(req) {
  const text = await readRawBody(req);
  if (!text.trim()) throw new RoomValidationError('request body must be JSON');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RoomValidationError(`request body is not valid JSON: ${error.message}`);
  }
}

/**
 * Serve a file from a static root.
 * Returns true when a response was sent, false when the file does not exist.
 */
export async function serveStatic(res, rootDir, urlPath) {
  const root = resolve(rootDir);
  const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const candidate = resolve(join(root, normalize(relative)));
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    sendText(res, 403, 'forbidden');
    return true;
  }
  let info;
  try {
    info = await stat(candidate);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  const body = await readFile(candidate);
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
    'content-length': body.length,
    'cache-control': 'no-store',
  });
  res.end(body);
  return true;
}

/**
 * Build a path matcher for a route pattern such as `/items/:id/toggle`.
 * Returns the captured params, or null when the path does not match.
 */
export function matchRoute(pattern, path) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = path.split('/').filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const expected = patternParts[index];
    const actual = pathParts[index];
    if (expected.startsWith(':')) {
      params[expected.slice(1)] = decodeURIComponent(actual);
    } else if (expected !== actual) {
      return null;
    }
  }
  return params;
}

/** Convert a thrown error into a local HTTP response. */
export function sendError(res, error) {
  if (error instanceof RoomValidationError) {
    sendJson(res, error.statusCode ?? 400, { error: 'invalid_payload', message: error.message });
    return;
  }
  if (error instanceof RoomStoreError) {
    sendJson(res, 500, { error: 'room_store_unreadable', message: error.message });
    return;
  }
  sendJson(res, 500, { error: 'internal_error', message: error?.message ?? 'unknown error' });
}

/** Standard 404 for an unknown room route. */
export function sendNotFound(res, message) {
  sendJson(res, 404, { error: 'not_found', message });
}

/**
 * Route table helper: handlers are checked in order; the first match wins.
 * @param {Array<{method: string, pattern: string, handle: Function}>} routes
 */
export function createRouter(routes) {
  return async function route(context) {
    for (const entry of routes) {
      if (entry.method !== context.method) continue;
      const params = matchRoute(entry.pattern, context.path);
      if (!params) continue;
      await entry.handle({ ...context, params });
      return true;
    }
    return false;
  };
}
