/**
 * UTOPIA · Rooms · Room 08 — Focus Room (server).
 *
 * Local focus timer sessions. The countdown itself runs in the page; this room
 * records what actually happened: which labels were focused on, for how long and
 * when. There are no OS notifications, no background daemon and no calendar link.
 *
 * Crash safety: a running session is written to .runtime-rooms/focus.json as soon as it
 * starts, then finalized in place. A session still marked running at load time is
 * reported as interrupted instead of being silently invented into a completed one.
 */

import { randomUUID } from 'node:crypto';
import { createRouter, sendJson, sendNotFound } from '../../shared/http.mjs';
import { RoomValidationError, now, optionalText, requireText } from '../../shared/room-kit.mjs';

export const FOCUS_PRESETS = [5, 15, 25, 50];
export const MAX_LABEL_LENGTH = 80;

function sessionsOf(data) {
  if (!Array.isArray(data.sessions)) data.sessions = [];
  return data.sessions;
}

/** Today's local date key (YYYY-MM-DD). */
export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Verify a session has a consistent, sane shape. */
export function normalizeSessionInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RoomValidationError('session payload must be a JSON object');
  }
  const label = input.label === undefined || String(input.label).trim() === ''
    ? 'focus'
    : requireText(input.label, 'label', { maxLength: MAX_LABEL_LENGTH });
  const plannedRaw = input.plannedMinutes === undefined ? 25 : Number(input.plannedMinutes);
  if (!Number.isFinite(plannedRaw) || plannedRaw <= 0 || plannedRaw > 24 * 60) {
    throw new RoomValidationError('plannedMinutes must be between 1 and 1440');
  }
  const elapsedRaw = input.elapsedSeconds === undefined ? 0 : Number(input.elapsedSeconds);
  if (!Number.isFinite(elapsedRaw) || elapsedRaw < 0 || elapsedRaw > 24 * 60 * 60) {
    throw new RoomValidationError('elapsedSeconds must be between 0 and 86400');
  }
  const startedAt = input.startedAt === undefined || input.startedAt === '' ? now() : String(input.startedAt);
  if (Number.isNaN(Date.parse(startedAt))) throw new RoomValidationError('startedAt must be an ISO-8601 timestamp');
  const note = optionalText(input.note, 'note', { maxLength: 2000 });
  return {
    label,
    note,
    plannedMinutes: Math.round(plannedRaw),
    elapsedSeconds: Math.round(elapsedRaw),
    startedAt: new Date(startedAt).toISOString(),
  };
}

/** Summary used by the room UI. */
export function focusSummary(sessions, dateKey = localDateKey()) {
  const today = sessions.filter((session) => localDateKey(new Date(session.startedAt)) === dateKey);
  const minutes = Math.round(today.reduce((total, session) => total + session.elapsedSeconds, 0) / 60);
  return {
    date: dateKey,
    sessionsToday: today.length,
    minutesToday: minutes,
    sessionsTotal: sessions.length,
    minutesTotal: Math.round(sessions.reduce((total, session) => total + session.elapsedSeconds, 0) / 60),
  };
}

/** Create the Focus Room route handler. */
export function createFocusRoom({ store }) {
  if (!store) throw new Error('Focus Room requires a store');

  const reconcile = () => {
    const data = store.data;
    if (data.active) {
      data.active = { ...data.active, interrupted: true };
    }
    return data.active ?? null;
  };

  const route = createRouter([
    {
      method: 'GET',
      pattern: '/state',
      handle: async ({ res }) => {
        const active = reconcile();
        const sessions = store.snapshot().sessions;
        sendJson(res, 200, {
          presets: FOCUS_PRESETS,
          active,
          sessions: sessions.slice().sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1)),
          summary: focusSummary(sessions),
        });
      },
    },
    {
      method: 'POST',
      pattern: '/sessions/start',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const active = await store.update((data) => {
          const session = { id: randomUUID(), ...normalizeSessionInput(payload), completedAt: null, interrupted: false };
          data.active = session;
          return { ...session };
        });
        sendJson(res, 201, { active });
      },
    },
    {
      method: 'POST',
      pattern: '/sessions/complete',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const result = await store.update((data) => {
          const current = data.active;
          if (!current) return null;
          const finished = {
            ...current,
            ...normalizeSessionInput({ ...current, ...payload, startedAt: current.startedAt }),
            completedAt: now(),
            interrupted: false,
          };
          sessionsOf(data).push(finished);
          data.active = null;
          return { session: finished, summary: focusSummary(data.sessions) };
        });
        if (!result) throw new RoomValidationError('there is no running session to complete');
        sendJson(res, 200, result);
      },
    },
    {
      method: 'POST',
      pattern: '/sessions/abandon',
      handle: async ({ res }) => {
        const result = await store.update((data) => {
          if (!data.active) return null;
          const abandoned = { ...data.active, completedAt: now(), interrupted: true };
          sessionsOf(data).push(abandoned);
          data.active = null;
          return { session: abandoned, summary: focusSummary(data.sessions) };
        });
        if (!result) throw new RoomValidationError('there is no running session to abandon');
        sendJson(res, 200, result);
      },
    },
    {
      method: 'DELETE',
      pattern: '/sessions/:id',
      handle: async ({ res, params }) => {
        const removed = await store.update((data) => {
          const sessions = sessionsOf(data);
          const index = sessions.findIndex((session) => session.id === params.id);
          if (index === -1) return false;
          sessions.splice(index, 1);
          return true;
        });
        if (!removed) return sendNotFound(res, `no session with id ${params.id}`);
        sendJson(res, 200, { deleted: true, id: params.id });
      },
    },
    {
      method: 'GET',
      pattern: '/export',
      handle: async ({ res }) =>
        sendJson(res, 200, {
          format: 'utopia-rooms-focus',
          schemaVersion: 1,
          exportedAt: now(),
          sessions: store.snapshot().sessions,
        }),
    },
  ]);

  return { id: 'focus', handle: (context) => route(context) };
}
