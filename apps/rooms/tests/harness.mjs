/**
 * Shared test harness: a real Room Hub on 127.0.0.1 with a throwaway runtime
 * directory. Nothing here touches apps/rooms/.runtime-rooms/.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HOST, createRoomHubServer } from '../hub/server.mjs';

/** Start a hub on an ephemeral loopback port. */
export async function startTestHub() {
  const runtimeDir = await mkdtemp(join(tmpdir(), 'rooms-test-'));
  const server = await createRoomHubServer({ runtimeDir });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, HOST, resolveListen);
  });
  const base = `http://${HOST}:${server.address().port}`;
  // A listening socket must never keep the test process alive on its own.
  server.unref();
  return {
    server,
    runtimeDir,
    base,
    async stop() {
      await new Promise((done) => {
        server.close(() => done());
        server.closeIdleConnections?.();
      });
      await rm(runtimeDir, { recursive: true, force: true });
    },
    async api(method, path, body) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      let payload = null;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = { raw: text };
      }
      return { status: response.status, payload, headers: response.headers };
    },
    get: (path) => fetch(`${base}${path}`),
  };
}
