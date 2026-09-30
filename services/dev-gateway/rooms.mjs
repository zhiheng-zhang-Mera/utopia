/**
 * UTOPIA · Gateway — Room Pack client.
 *
 * The Room Hub stays a loopback-only product of its own (it binds 127.0.0.1 and must
 * keep doing so). This module is how the *authenticated* Utopia product path reaches
 * it: the gateway talks to the hub over loopback, server to server, and republishes a
 * truthful availability view plus a bounded room API on `/api/v0/rooms…`.
 *
 * Two deliberate properties:
 *   - the hub's raw port is never handed to Android and never proxied to LAN; a client
 *     that cannot reach loopback simply sees `available: false` with a reason;
 *   - an unreachable hub is a *state*, not an error. `probe()` resolves, it does not throw,
 *     so the product can show UNAVAILABLE instead of a failure page.
 */

import { ROOMS as ROOM_CATALOG } from '../../apps/rooms/hub/manifest.mjs';

export const DEFAULT_ROOM_HUB_URL = 'http://127.0.0.1:4320';
export const ROOM_API_BASE = '/local-rooms/v1';

/** The static catalog the client shows even when the hub itself is down. */
export function roomCatalog() {
  return ROOM_CATALOG.map((room) => ({
    id: room.id,
    number: room.number,
    label: room.label,
    zh: room.zh,
    summary: room.summary,
    persistent: Boolean(room.dataFile),
    tags: [...room.tags],
    lifecycle: room.lifecycle,
  }));
}

/** Normalize any transport failure into a stable, reportable code. */
function transportError(error, timeoutMs) {
  if (error?.name === 'AbortError' || error?.code === 'ROOM_HUB_TIMEOUT') {
    const timedOut = new Error(`room hub did not answer within ${timeoutMs} ms`);
    timedOut.code = 'ROOM_HUB_TIMEOUT';
    return timedOut;
  }
  if (error?.code && error.code !== 'ROOM_HUB_ERROR') return error;
  const cause = error?.cause?.code ?? error?.code;
  const unreachable = new Error(`room hub is not reachable on loopback (${cause ?? error?.message ?? 'unknown'})`);
  unreachable.code = 'ROOM_HUB_UNREACHABLE';
  return unreachable;
}

/**
 * Create the Room Pack client.
 *
 * `baseUrl` is the hub's loopback origin. `fetchImpl` is injectable so tests can drive
 * the client without a real hub, and so a failing hub can be simulated honestly.
 */
export function createRoomPack({ baseUrl = DEFAULT_ROOM_HUB_URL, timeoutMs = 2000, fetchImpl, disabled = false } = {}) {
  const origin = String(baseUrl).replace(/\/+$/, '');
  const hubUrl = `${origin}/`;
  const doFetch = fetchImpl ?? globalThis.fetch;
  let lastProbe = null;

  async function request(path, { method = 'GET', body, timeout = timeoutMs } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await doFetch(`${origin}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = { message: text };
        }
      }
      if (!response.ok) {
        const failure = new Error(payload?.message ?? `room hub responded ${response.status}`);
        failure.code = payload?.error ?? 'ROOM_HUB_ERROR';
        failure.status = response.status;
        failure.payload = payload;
        throw failure;
      }
      return payload;
    } catch (error) {
      throw transportError(error, timeout);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Truthful availability: resolves for both states, never throws for a down hub. */
  async function probe() {
    const catalog = roomCatalog();
    if (disabled) {
      lastProbe = {
        available: false,
        hubUrl: null,
        reason: 'the Room Hub is disabled for this gateway process',
        code: 'ROOMS_DISABLED',
        checkedAt: new Date().toISOString(),
        count: catalog.length,
        loaded: [],
        product: 'utopia-room-pack',
        version: null,
        rooms: catalog,
      };
      return lastProbe;
    }
    try {
      const health = await request('/health');
      const payload = await request(`${ROOM_API_BASE}/rooms`);
      const rooms = Array.isArray(payload?.rooms) && payload.rooms.length > 0 ? payload.rooms : catalog;
      lastProbe = {
        available: true,
        hubUrl,
        reason: null,
        checkedAt: new Date().toISOString(),
        count: rooms.length,
        loaded: Array.isArray(payload?.loaded) ? payload.loaded : rooms.map((room) => room.id),
        product: health?.product ?? 'utopia-room-pack',
        version: health?.version ?? 'v1',
        rooms,
      };
    } catch (error) {
      lastProbe = {
        available: false,
        hubUrl: null,
        reason: error.message,
        code: error.code ?? 'ROOM_HUB_ERROR',
        checkedAt: new Date().toISOString(),
        count: catalog.length,
        loaded: [],
        product: 'utopia-room-pack',
        version: null,
        rooms: catalog,
      };
    }
    return lastProbe;
  }

  /**
   * Call a room's own API over loopback.
   *
   * This is the only way the product executes a room: the room keeps owning its data
   * model, and the gateway is a transport, not a second implementation of it.
   */
  function call(roomId, { method = 'GET', path = '/', body, timeout } = {}) {
    if (disabled) {
      const error = new Error('the Room Hub is disabled for this gateway process');
      error.code = 'ROOM_HUB_UNREACHABLE';
      error.status = 503;
      return Promise.reject(error);
    }
    const suffix = path && path !== '/' ? (path.startsWith('/') ? path : `/${path}`) : '';
    return request(`${ROOM_API_BASE}/${encodeURIComponent(roomId)}${suffix}`, { method, body, timeout });
  }

  return {
    hubUrl,
    catalog: roomCatalog,
    probe,
    call,
    last: () => lastProbe,
  };
}
