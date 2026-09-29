/**
 * UTOPIA · Rooms · Room 09 — Calendar Room (server).
 *
 * A local plan of dated events. This is not a system calendar connector: there is
 * no Google/Outlook integration, no invitation, no recurrence engine, no timezone
 * synchronization and no notification of any kind.
 */

import { randomUUID } from 'node:crypto';
import { createRouter, sendJson, sendNotFound } from '../../shared/http.mjs';
import {
  RoomValidationError,
  matchesQuery,
  normalizeText,
  now,
  optionalText,
  requireText,
} from '../../shared/room-kit.mjs';

export const CALENDAR_BUNDLE_FORMAT = 'utopia-rooms-calendar';
export const CALENDAR_SCHEMA_VERSION = 1;
export const MAX_TITLE_LENGTH = 200;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Today's local date key (YYYY-MM-DD). */
export function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function optionalTime(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const text = requireText(value, field);
  if (!TIME_PATTERN.test(text)) throw new RoomValidationError(`${field} must be HH:MM (24 hour)`);
  return text;
}

/** Validate event create/update input. */
export function normalizeEventInput(input, { partial = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RoomValidationError('event payload must be a JSON object');
  }
  const out = {};
  if (input.title !== undefined) out.title = requireText(input.title, 'title', { maxLength: MAX_TITLE_LENGTH });
  else if (!partial) throw new RoomValidationError('title is required');
  if (input.date !== undefined) {
    const date = requireText(input.date, 'date');
    if (!DATE_PATTERN.test(date)) throw new RoomValidationError('date must be YYYY-MM-DD');
    out.date = date;
  } else if (!partial) {
    throw new RoomValidationError('date is required');
  }
  if (input.startTime !== undefined) out.startTime = optionalTime(input.startTime, 'startTime');
  else if (!partial) out.startTime = null;
  if (input.endTime !== undefined) out.endTime = optionalTime(input.endTime, 'endTime');
  else if (!partial) out.endTime = null;
  if (input.label !== undefined) out.label = optionalText(input.label, 'label', { maxLength: 60 });
  else if (!partial) out.label = '';
  if (input.note !== undefined) out.note = optionalText(input.note, 'note', { maxLength: 20000 });
  else if (!partial) out.note = '';
  if (out.startTime && out.endTime && out.endTime < out.startTime) {
    throw new RoomValidationError('endTime must not be before startTime');
  }
  if (partial && Object.keys(out).length === 0) throw new RoomValidationError('update must change at least one field');
  return out;
}

function eventsOf(data) {
  if (!Array.isArray(data.events)) data.events = [];
  return data.events;
}

/** Chronological order: date, then start time, then title. */
export function bySchedule(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const left = a.startTime ?? '99:99';
  const right = b.startTime ?? '99:99';
  if (left !== right) return left < right ? -1 : 1;
  return a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1;
}

/** Split events into today and upcoming relative to a date key. */
export function splitByDay(events, dateKey = localDateKey()) {
  const sorted = [...events].sort(bySchedule);
  return {
    today: sorted.filter((event) => event.date === dateKey),
    upcoming: sorted.filter((event) => event.date > dateKey),
    past: sorted.filter((event) => event.date < dateKey).reverse(),
  };
}

/** Export bundle for this room. */
export function buildCalendarBundle(events, exportedAt = now()) {
  return {
    format: CALENDAR_BUNDLE_FORMAT,
    schemaVersion: CALENDAR_SCHEMA_VERSION,
    exportedAt,
    events: events.map((event) => ({ ...event })),
  };
}

/** Validate an import payload completely, or reject it whole. */
export function parseCalendarBundle(payload) {
  let bundle = payload;
  if (typeof payload === 'string') {
    try {
      bundle = JSON.parse(payload);
    } catch (error) {
      throw new RoomValidationError(`import payload is not valid JSON: ${error.message}`);
    }
  }
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new RoomValidationError('import payload must be a JSON object');
  }
  if (bundle.format !== CALENDAR_BUNDLE_FORMAT) {
    throw new RoomValidationError(`import format must be "${CALENDAR_BUNDLE_FORMAT}"`);
  }
  if (bundle.schemaVersion !== CALENDAR_SCHEMA_VERSION) {
    throw new RoomValidationError(`import schemaVersion must be ${CALENDAR_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(bundle.events)) throw new RoomValidationError('import events must be an array');
  const ids = new Set();
  const events = bundle.events.map((raw, index) => {
    const where = `events[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RoomValidationError(`${where} must be an object`);
    }
    const id = String(raw.id ?? '').trim();
    if (!id) throw new RoomValidationError(`${where}.id must not be empty`);
    if (ids.has(id)) throw new RoomValidationError(`duplicate event id ${id}`);
    ids.add(id);
    const fields = normalizeEventInput(raw);
    const createdAt = String(raw.createdAt ?? '');
    const updatedAt = String(raw.updatedAt ?? '');
    for (const [field, value] of [['createdAt', createdAt], ['updatedAt', updatedAt]]) {
      if (Number.isNaN(Date.parse(value))) {
        throw new RoomValidationError(`${where}.${field} must be an ISO-8601 timestamp`);
      }
    }
    return { id, ...fields, createdAt, updatedAt };
  });
  return { events, exportedAt: typeof bundle.exportedAt === 'string' ? bundle.exportedAt : null };
}

/** Create the Calendar Room route handler. */
export function createCalendarRoom({ store }) {
  if (!store) throw new Error('Calendar Room requires a store');

  const route = createRouter([
    {
      method: 'GET',
      pattern: '/events',
      handle: async ({ res, url }) => {
        const query = url.searchParams.get('q') ?? '';
        const scope = url.searchParams.get('scope') ?? 'all';
        const events = store.snapshot().events.filter((event) => matchesQuery(event, ['title', 'note', 'label'], query));
        const groups = splitByDay(events);
        const payload = scope === 'today' ? groups.today : scope === 'upcoming' ? groups.upcoming : [...groups.today, ...groups.upcoming, ...groups.past];
        sendJson(res, 200, { total: payload.length, today: groups.today.length, upcoming: groups.upcoming.length, events: payload });
      },
    },
    {
      method: 'POST',
      pattern: '/events',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const event = await store.update((data) => {
          const item = { id: randomUUID(), ...normalizeEventInput(payload), createdAt: now(), updatedAt: now() };
          eventsOf(data).push(item);
          return { ...item };
        });
        sendJson(res, 201, { event });
      },
    },
    {
      method: 'PATCH',
      pattern: '/events/:id',
      handle: async ({ res, params, readJson }) => {
        const payload = await readJson();
        const event = await store.update((data) => {
          const items = eventsOf(data);
          const index = items.findIndex((item) => item.id === params.id);
          if (index === -1) return null;
          const next = { ...items[index], ...normalizeEventInput(payload, { partial: true }), updatedAt: now() };
          if (next.startTime && next.endTime && next.endTime < next.startTime) {
            throw new RoomValidationError('endTime must not be before startTime');
          }
          items[index] = next;
          return { ...next };
        });
        if (!event) return sendNotFound(res, `no event with id ${params.id}`);
        sendJson(res, 200, { event });
      },
    },
    {
      method: 'DELETE',
      pattern: '/events/:id',
      handle: async ({ res, params }) => {
        const removed = await store.update((data) => {
          const items = eventsOf(data);
          const index = items.findIndex((item) => item.id === params.id);
          if (index === -1) return false;
          items.splice(index, 1);
          return true;
        });
        if (!removed) return sendNotFound(res, `no event with id ${params.id}`);
        sendJson(res, 200, { deleted: true, id: params.id });
      },
    },
    {
      method: 'GET',
      pattern: '/export',
      handle: async ({ res }) => sendJson(res, 200, buildCalendarBundle(store.snapshot().events)),
    },
    {
      method: 'POST',
      pattern: '/import',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const { events, exportedAt } = parseCalendarBundle(payload);
        await store.replaceAll({ events });
        sendJson(res, 200, { mode: 'replace', imported: events.length, exportedAt });
      },
    },
  ]);

  return { id: 'calendar', handle: (context) => route(context) };
}

/** Re-exported so tests and the UI share one normalization rule. */
export const normalizeEventNote = (value) => normalizeText(String(value ?? ''));
