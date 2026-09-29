/**
 * UTOPIA · Rooms · Room 02 — Bookmark Room (server).
 *
 * Local URL collection. The room never fetches, crawls, previews or downloads a
 * remote resource: a URL is only ever opened after an explicit user click in the
 * browser, and stored text is never rendered as HTML.
 */

import { randomUUID } from 'node:crypto';
import { createRouter, sendJson, sendNotFound } from '../../shared/http.mjs';
import {
  RoomValidationError,
  matchesQuery,
  matchesTags,
  normalizeTags,
  normalizeText,
  now,
  requireText,
} from '../../shared/room-kit.mjs';

export const BOOKMARK_BUNDLE_FORMAT = 'utopia-rooms-bookmarks';
export const BOOKMARK_SCHEMA_VERSION = 1;
export const MAX_TITLE_LENGTH = 200;
export const MAX_NOTE_LENGTH = 20000;

/** Validate and normalize an http(s) URL. */
export function normalizeUrl(value) {
  const raw = requireText(value, 'url');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new RoomValidationError('url must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new RoomValidationError('only http and https URLs are supported');
  }
  return parsed.toString();
}

/** Validate create/update input for one bookmark. */
export function normalizeBookmarkInput(input, { partial = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RoomValidationError('bookmark payload must be a JSON object');
  }
  const out = {};
  if (input.title !== undefined) out.title = requireText(input.title, 'title', { maxLength: MAX_TITLE_LENGTH });
  else if (!partial) out.title = '';
  if (input.url !== undefined) out.url = normalizeUrl(input.url);
  else if (!partial) throw new RoomValidationError('url is required');
  if (input.note !== undefined) {
    out.note = normalizeText(String(input.note));
    if (out.note.length > MAX_NOTE_LENGTH) {
      throw new RoomValidationError(`note must be at most ${MAX_NOTE_LENGTH} characters`);
    }
  } else if (!partial) {
    out.note = '';
  }
  if (input.tags !== undefined) out.tags = normalizeTags(input.tags);
  else if (!partial) out.tags = [];
  if (partial && Object.keys(out).length === 0) {
    throw new RoomValidationError('update must change at least one of title, url, note, tags');
  }
  return out;
}

function bookmarksOf(data) {
  if (!Array.isArray(data.bookmarks)) data.bookmarks = [];
  return data.bookmarks;
}

/** Export bundle for this room. */
export function buildBookmarkBundle(bookmarks, exportedAt = now()) {
  return {
    format: BOOKMARK_BUNDLE_FORMAT,
    schemaVersion: BOOKMARK_SCHEMA_VERSION,
    exportedAt,
    bookmarks: bookmarks.map((item) => ({ ...item, tags: [...item.tags] })),
  };
}

/** Validate an import payload completely, or reject it whole. */
export function parseBookmarkBundle(payload) {
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
  if (bundle.format !== BOOKMARK_BUNDLE_FORMAT) {
    throw new RoomValidationError(`import format must be "${BOOKMARK_BUNDLE_FORMAT}"`);
  }
  if (bundle.schemaVersion !== BOOKMARK_SCHEMA_VERSION) {
    throw new RoomValidationError(`import schemaVersion must be ${BOOKMARK_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(bundle.bookmarks)) throw new RoomValidationError('import bookmarks must be an array');
  const ids = new Set();
  const bookmarks = bundle.bookmarks.map((raw, index) => {
    const where = `bookmarks[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RoomValidationError(`${where} must be an object`);
    }
    const id = String(raw.id ?? '').trim();
    if (!id) throw new RoomValidationError(`${where}.id must not be empty`);
    if (ids.has(id)) throw new RoomValidationError(`duplicate bookmark id ${id}`);
    ids.add(id);
    const url = normalizeUrl(raw.url);
    const title = raw.title === undefined || String(raw.title).trim() === ''
      ? url
      : requireText(raw.title, `${where}.title`, { maxLength: MAX_TITLE_LENGTH });
    const note = raw.note === undefined ? '' : normalizeText(String(raw.note));
    const tags = normalizeTags(raw.tags);
    const createdAt = String(raw.createdAt ?? '');
    const updatedAt = String(raw.updatedAt ?? '');
    for (const [field, value] of [['createdAt', createdAt], ['updatedAt', updatedAt]]) {
      if (Number.isNaN(Date.parse(value))) {
        throw new RoomValidationError(`${where}.${field} must be an ISO-8601 timestamp`);
      }
    }
    return { id, title, url, note, tags, createdAt, updatedAt };
  });
  return { bookmarks, exportedAt: typeof bundle.exportedAt === 'string' ? bundle.exportedAt : null };
}

/** Create the Bookmark Room route handler. */
export function createBookmarkRoom({ store }) {
  if (!store) throw new Error('Bookmark Room requires a store');

  const route = createRouter([
    {
      method: 'GET',
      pattern: '/bookmarks',
      handle: async ({ res, url }) => {
        const query = url.searchParams.get('q') ?? '';
        const tags = url.searchParams.getAll('tag');
        const bookmarks = store.snapshot().bookmarks
          .slice()
          .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? 1 : -1) : a.updatedAt < b.updatedAt ? 1 : -1))
          .filter((item) => matchesQuery(item, ['title', 'url', 'note', 'tags'], query) && matchesTags(item, tags));
        sendJson(res, 200, { total: bookmarks.length, bookmarks });
      },
    },
    {
      method: 'POST',
      pattern: '/bookmarks',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const bookmark = await store.update((data) => {
          const fields = normalizeBookmarkInput(payload);
          const item = {
            id: randomUUID(),
            title: fields.title || fields.url,
            url: fields.url,
            note: fields.note,
            tags: fields.tags,
            createdAt: now(),
            updatedAt: now(),
          };
          bookmarksOf(data).push(item);
          return { ...item };
        });
        sendJson(res, 201, { bookmark });
      },
    },
    {
      method: 'PATCH',
      pattern: '/bookmarks/:id',
      handle: async ({ res, params, readJson }) => {
        const payload = await readJson();
        const bookmark = await store.update((data) => {
          const items = bookmarksOf(data);
          const index = items.findIndex((item) => item.id === params.id);
          if (index === -1) return null;
          const next = { ...items[index], ...normalizeBookmarkInput(payload, { partial: true }), updatedAt: now() };
          if (!next.title) next.title = next.url;
          items[index] = next;
          return { ...next };
        });
        if (!bookmark) return sendNotFound(res, `no bookmark with id ${params.id}`);
        sendJson(res, 200, { bookmark });
      },
    },
    {
      method: 'DELETE',
      pattern: '/bookmarks/:id',
      handle: async ({ res, params }) => {
        const removed = await store.update((data) => {
          const items = bookmarksOf(data);
          const index = items.findIndex((item) => item.id === params.id);
          if (index === -1) return false;
          items.splice(index, 1);
          return true;
        });
        if (!removed) return sendNotFound(res, `no bookmark with id ${params.id}`);
        sendJson(res, 200, { deleted: true, id: params.id });
      },
    },
    {
      method: 'GET',
      pattern: '/export',
      handle: async ({ res }) => sendJson(res, 200, buildBookmarkBundle(store.snapshot().bookmarks)),
    },
    {
      method: 'POST',
      pattern: '/import',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const { bookmarks, exportedAt } = parseBookmarkBundle(payload);
        await store.replaceAll({ bookmarks });
        sendJson(res, 200, { mode: 'replace', imported: bookmarks.length, exportedAt });
      },
    },
  ]);

  return { id: 'bookmarks', handle: (context) => route(context) };
}
