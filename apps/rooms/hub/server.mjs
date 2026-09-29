/**
 * UTOPIA · Rooms — Room Hub.
 *
 * Responsibilities (and nothing more):
 *   listen on 127.0.0.1, serve the hub shell and room assets, provide local
 *   navigation, route /local-rooms/v1/<room>/…, expose /health.
 *
 * Explicitly NOT here: City Control routing, gateway proxying, node discovery,
 * task scheduling, authentication, permissions, multi-user, LAN exposure, sync.
 */

import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRuntimeDir } from '../shared/atomic-store.mjs';
import {
  createRouter,
  matchRoute,
  readJsonBody,
  sendError,
  sendJson,
  sendNotFound,
  sendText,
  serveStatic,
} from '../shared/http.mjs';
import { createRoomRegistry } from './registry.mjs';
import { ALL_ROOMS, ROOMS, ROOM_API_BASE, ROOM_ASSET_BASE } from './manifest.mjs';
import { crossCheckPromotions, loadPromotionRecords } from './promotions.mjs';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 4320;

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const ROOMS_ROOT = resolve(HERE, '..');

/** Build the hub HTTP server without starting it. */
export async function createRoomHubServer(options = {}) {
  const runtimeDir = options.runtimeDir ?? defaultRuntimeDir();
  const registry = await createRoomRegistry({ runtimeDir, only: options.only });
  const byId = new Map(registry.map((entry) => [entry.definition.id, entry]));

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
        sendJson(res, 200, {
          status: 'ok',
          product: 'utopia-room-pack',
          version: 'v1',
          host: HOST,
          runtimeDir,
          rooms: registry.map((entry) => ({
            id: entry.definition.id,
            label: entry.definition.label,
            persistent: Boolean(entry.definition.dataFile),
          })),
        });
        return;
      }

      if (path === `${ROOM_API_BASE}/rooms` && method === 'GET') {
        sendJson(res, 200, {
          apiBase: ROOM_API_BASE,
          assetBase: ROOM_ASSET_BASE,
          rooms: ROOMS.map((room) => ({
            id: room.id,
            number: room.number,
            label: room.label,
            zh: room.zh,
            summary: room.summary,
            persistent: Boolean(room.dataFile),
            tags: room.tags,
            lifecycle: room.lifecycle,
            targetCityPath: room.targetCityPath,
            donorRepository: room.donorRepository,
            donorCommit: room.donorCommit,
            donorSourcePaths: room.donorSourcePaths,
          })),
          loaded: registry.map((entry) => entry.definition.id),
        });
        return;
      }

      if (path === `${ROOM_API_BASE}/promotions` && method === 'GET') {
        const records = await loadPromotionRecords();
        const inFlight = records.map((record) => record.roomId);
        const problems = crossCheckPromotions(records, ALL_ROOMS, ROOMS, inFlight);
        sendJson(res, 200, {
          total: records.length,
          consistent: problems.length === 0,
          problems,
          promotions: records.map(({ file, ...record }) => ({ ...record, record: file })),
        });
        return;
      }

      const roomApi = matchRoute(`${ROOM_API_BASE}/:roomId`, path) ??
        matchRoute(`${ROOM_API_BASE}/:roomId/:rest*`, path) ??
        (path.startsWith(`${ROOM_API_BASE}/`) ? { roomId: path.slice(ROOM_API_BASE.length + 1).split('/')[0] } : null);
      if (roomApi) {
        const entry = byId.get(roomApi.roomId);
        if (!entry) {
          sendNotFound(res, `unknown room ${roomApi.roomId}`);
          return;
        }
        const prefix = `${ROOM_API_BASE}/${roomApi.roomId}`;
        const rest = path.length > prefix.length ? path.slice(prefix.length) : '/';
        const handled = await entry.room.handle({
          method,
          path: rest.startsWith('/') ? rest : `/${rest}`,
          url,
          req,
          res,
          store: entry.store,
          definition: entry.definition,
          readJson: () => readJsonBody(req),
          roomPath: prefix,
        });
        if (handled === false) {
          sendNotFound(res, `unknown ${entry.definition.label} route ${method} ${path}`);
        }
        return;
      }

      if (path.startsWith(ROOM_API_BASE)) {
        sendNotFound(res, `unknown Room Pack route ${method} ${path}`);
        return;
      }

      if (method === 'GET' || method === 'HEAD') {
        if (path === '/') {
          if (await serveStatic(res, resolve(HERE, 'public'), '/index.html')) return;
        }
        if (path.startsWith(`${ROOM_ASSET_BASE}/`)) {
          const [roomId, ...fileParts] = path.slice(ROOM_ASSET_BASE.length + 1).split('/');
          if (fileParts.length > 0) {
            const roomDir = resolve(ROOMS_ROOT, 'rooms', roomId);
            if (await serveStatic(res, roomDir, `/${fileParts.join('/')}`)) return;
          }
        }
        if (path.startsWith('/hub/')) {
          if (await serveStatic(res, resolve(HERE, 'public'), path.slice('/hub'.length))) return;
        }
        if (path.startsWith('/shared/')) {
          if (await serveStatic(res, resolve(ROOMS_ROOT, 'shared'), path.slice('/shared'.length))) return;
        }
        if (await serveStatic(res, resolve(HERE, 'public'), path)) return;
      }

      sendText(res, 404, 'not found');
    } catch (error) {
      sendError(res, error);
    }
  });

  server.roomHub = { registry, byId, runtimeDir, apiBase: ROOM_API_BASE, assetBase: ROOM_ASSET_BASE };
  return server;
}

/** Read hub configuration from the environment. */
export function resolveHubConfig(env = process.env) {
  const raw = env.ROOMS_PORT;
  const port = raw === undefined || raw === '' ? DEFAULT_PORT : Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`ROOMS_PORT must be an integer between 0 and 65535 (received ${raw})`);
  }
  return { host: HOST, port, runtimeDir: env.ROOMS_RUNTIME_DIR || undefined };
}

/** Start the hub on loopback. */
export async function startRoomHub(config = resolveHubConfig()) {
  const server = await createRoomHubServer({ runtimeDir: config.runtimeDir });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(config.port, config.host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  return {
    server,
    host: config.host,
    port: address.port,
    url: `http://${config.host}:${address.port}/`,
    runtimeDir: server.roomHub.runtimeDir,
    rooms: server.roomHub.registry.map((entry) => entry.definition.id),
  };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  try {
    const started = await startRoomHub();
    process.stdout.write(
      [
        'UTOPIA · Room Pack V1 · Room Hub',
        `  url     : ${started.url}`,
        `  bind    : ${started.host} (loopback only)`,
        `  runtime : ${started.runtimeDir}`,
        `  rooms   : ${started.rooms.length}`,
        `  node    : ${process.version}`,
        '  stop    : Ctrl+C',
        '',
      ].join('\n'),
    );
  } catch (error) {
    process.stderr.write(`Room Hub failed to start: ${error.message}\n`);
    process.exitCode = 1;
  }
}
