/**
 * UTOPIA · Knowledge Room (MECH-K0)
 * Local-only HTTP product server.
 *
 * Scope:
 * - binds to 127.0.0.1 only (never 0.0.0.0 by default);
 * - serves the plain HTML/CSS/JS product UI;
 * - serves the Knowledge Room local API described in the MECH-K0 workbook.
 *
 * The /local-kb/v0/* endpoints are a private implementation detail of this
 * product slice. They are NOT City Control Protocol v0 and must never be
 * promoted into contracts/city-control-v0/.
 */

import { createServer as createHttpServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, dirname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ValidationError } from './model.mjs';
import { KnowledgeStore, StoreFormatError } from './store.mjs';
import { buildBundle, parseImportBundle, serializeBundle } from './import-export.mjs';

/** Host is fixed: loopback only. */
export const HOST = '127.0.0.1';

/** Default port; override with KNOWLEDGE_ROOM_PORT. */
export const DEFAULT_PORT = 4317;

/** API base path for this product's local implementation detail. */
export const API_BASE = '/local-kb/v0';

/** Maximum accepted request body size (bytes). */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), 'public');

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, payload) {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new ValidationError(`request body exceeds ${MAX_BODY_BYTES} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) throw new ValidationError('request body must be JSON');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ValidationError(`request body is not valid JSON: ${error.message}`);
  }
}

async function readTextBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new ValidationError(`request body exceeds ${MAX_BODY_BYTES} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).replace(/^\/+/, '');
  const candidate = resolve(join(PUBLIC_DIR, normalize(relative)));
  if (candidate !== PUBLIC_DIR && !candidate.startsWith(PUBLIC_DIR + sep)) {
    sendText(res, 403, 'forbidden');
    return true;
  }
  try {
    const info = await stat(candidate);
    if (!info.isFile()) return false;
    const body = await readFile(candidate);
    res.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(candidate).toLowerCase()] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the Knowledge Room HTTP server without starting it.
 * @param {{store?: KnowledgeStore, dataDir?: string}} [options]
 */
export function createKnowledgeRoomServer(options = {}) {
  const store = options.store ?? new KnowledgeStore({ dataDir: options.dataDir });
  let ready = null;
  const ensureReady = () => {
    if (!ready) ready = store.ensureLoaded();
    return ready;
  };

  const server = createHttpServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url ?? '/', `http://${HOST}`);
    } catch {
      sendText(res, 400, 'bad request');
      return;
    }
    const path = url.pathname;
    const method = req.method ?? 'GET';

    try {
      if (path === '/health' && method === 'GET') {
        await ensureReady();
        sendJson(res, 200, {
          status: 'ok',
          product: 'utopia-knowledge-room',
          host: HOST,
          schemaVersion: store.state.schemaVersion,
          entries: store.count(),
        });
        return;
      }

      if (path === `${API_BASE}/entries` && method === 'GET') {
        await ensureReady();
        const query = url.searchParams.get('q');
        const tag = url.searchParams.get('tag');
        const entries = query || tag ? store.search({ query, tag }) : store.list();
        sendJson(res, 200, { schemaVersion: store.state.schemaVersion, total: entries.length, entries });
        return;
      }

      if (path === `${API_BASE}/entries` && method === 'POST') {
        await ensureReady();
        const payload = await readJsonBody(req);
        const entry = await store.create(payload);
        sendJson(res, 201, { entry });
        return;
      }

      if (path === `${API_BASE}/search` && method === 'GET') {
        await ensureReady();
        const entries = store.search({
          query: url.searchParams.get('q') ?? '',
          tags: url.searchParams.getAll('tag'),
        });
        sendJson(res, 200, { schemaVersion: store.state.schemaVersion, total: entries.length, entries });
        return;
      }

      if (path === `${API_BASE}/export` && method === 'GET') {
        await ensureReady();
        const bundle = buildBundle(store.snapshot());
        const text = serializeBundle(bundle);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="utopia-knowledge-room-${bundle.exportedAt.replace(/[:.]/g, '-')}.json"`,
          'content-length': Buffer.byteLength(text),
          'cache-control': 'no-store',
        });
        res.end(text);
        return;
      }

      if (path === `${API_BASE}/import` && method === 'POST') {
        await ensureReady();
        const contentType = String(req.headers['content-type'] ?? '');
        const raw = contentType.includes('application/json') ? await readJsonBody(req) : await readTextBody(req);
        const { entries, exportedAt } = await parseImportBundle(raw);
        await store.replaceAll(entries);
        sendJson(res, 200, { mode: 'replace', imported: entries.length, exportedAt, entries: store.list() });
        return;
      }

      const entryMatch = path.match(new RegExp(`^${API_BASE}/entries/([^/]+)$`));
      if (entryMatch) {
        await ensureReady();
        const id = decodeURIComponent(entryMatch[1]);
        if (method === 'GET') {
          const entry = store.get(id);
          if (!entry) {
            sendJson(res, 404, { error: 'not_found', message: `no knowledge entry with id ${id}` });
            return;
          }
          sendJson(res, 200, { entry });
          return;
        }
        if (method === 'PATCH' || method === 'PUT') {
          const payload = await readJsonBody(req);
          const entry = await store.update(id, payload);
          if (!entry) {
            sendJson(res, 404, { error: 'not_found', message: `no knowledge entry with id ${id}` });
            return;
          }
          sendJson(res, 200, { entry });
          return;
        }
        if (method === 'DELETE') {
          const removed = await store.delete(id);
          if (!removed) {
            sendJson(res, 404, { error: 'not_found', message: `no knowledge entry with id ${id}` });
            return;
          }
          sendJson(res, 200, { deleted: true, id });
          return;
        }
      }

      if (path.startsWith(API_BASE)) {
        sendJson(res, 404, { error: 'not_found', message: `unknown Knowledge Room route ${method} ${path}` });
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        const served = await serveStatic(res, path);
        if (served) return;
      }

      sendText(res, 404, 'not found');
    } catch (error) {
      if (error instanceof ValidationError) {
        sendJson(res, error.statusCode ?? 400, { error: 'invalid_payload', message: error.message });
        return;
      }
      if (error instanceof StoreFormatError) {
        sendJson(res, 500, { error: 'store_unreadable', message: error.message });
        return;
      }
      sendJson(res, 500, { error: 'internal_error', message: error.message });
    }
  });

  server.knowledgeRoom = { store, apiBase: API_BASE, host: HOST };
  return server;
}

/** Read configuration from the environment. */
export function resolveRuntimeConfig(env = process.env) {
  const rawPort = env.KNOWLEDGE_ROOM_PORT;
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_PORT : Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`KNOWLEDGE_ROOM_PORT must be an integer between 0 and 65535 (received ${rawPort})`);
  }
  return {
    host: HOST,
    port,
    dataDir: env.KNOWLEDGE_ROOM_DATA_DIR || undefined,
  };
}

/** Start the server on loopback. */
export async function startKnowledgeRoom(config = resolveRuntimeConfig()) {
  const server = createKnowledgeRoomServer({ dataDir: config.dataDir });
  await server.knowledgeRoom.store.ensureLoaded();
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.port, config.host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const url = `http://${config.host}:${address.port}/`;
  return { server, url, port: address.port, host: config.host, dataFile: server.knowledgeRoom.store.filePath };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    const started = await startKnowledgeRoom();
    process.stdout.write(
      [
        'UTOPIA · Knowledge Room (MECH-K0)',
        `  url   : ${started.url}`,
        `  bind  : ${started.host} (loopback only)`,
        `  data  : ${started.dataFile}`,
        `  node  : ${process.version}`,
        '  stop  : Ctrl+C',
        '',
      ].join('\n'),
    );
  } catch (error) {
    process.stderr.write(`Knowledge Room failed to start: ${error.message}\n`);
    process.exitCode = 1;
  }
}
