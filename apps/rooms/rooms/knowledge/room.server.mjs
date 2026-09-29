/**
 * UTOPIA · Rooms · Room 01 — Knowledge Room (server).
 *
 * Local knowledge entries: create / read / update / delete, deterministic
 * title+body search, tag filtering, full bundle export and replace import.
 * Data lives in .runtime-rooms/knowledge.json and nowhere else.
 */

import { randomUUID } from 'node:crypto';
import { createRouter, readRawBody, sendJson, sendNotFound } from '../../shared/http.mjs';
import {
  RoomValidationError,
  createCollection,
  matchesQuery,
  matchesTags,
  normalizeQuery,
  normalizeTags,
  normalizeText,
  now,
  requireText,
} from '../../shared/room-kit.mjs';

export const KNOWLEDGE_BUNDLE_FORMAT = 'utopia-rooms-knowledge';
export const KNOWLEDGE_SCHEMA_VERSION = 1;
export const MAX_TITLE_LENGTH = 200;
export const MAX_BODY_LENGTH = 200000;

/** Validate create/update input for one entry. */
export function normalizeEntryInput(input, { partial = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RoomValidationError('entry payload must be a JSON object');
  }
  const out = {};
  if (input.title !== undefined) {
    out.title = requireText(input.title, 'title', { maxLength: MAX_TITLE_LENGTH });
  } else if (!partial) {
    throw new RoomValidationError('title is required');
  }
  if (input.body !== undefined) {
    out.body = normalizeText(String(input.body));
    if (out.body.length > MAX_BODY_LENGTH) {
      throw new RoomValidationError(`body must be at most ${MAX_BODY_LENGTH} characters`);
    }
  } else if (!partial) {
    out.body = '';
  }
  if (input.tags !== undefined) out.tags = normalizeTags(input.tags);
  else if (!partial) out.tags = [];
  if (partial && Object.keys(out).length === 0) {
    throw new RoomValidationError('update must change at least one of title, body, tags');
  }
  return out;
}

function entriesOf(data) {
  if (!Array.isArray(data.entries)) data.entries = [];
  return data.entries;
}

/** Export bundle shape for this room. */
export function buildKnowledgeBundle(entries, exportedAt = now()) {
  return {
    format: KNOWLEDGE_BUNDLE_FORMAT,
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    exportedAt,
    entries: entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      body: entry.body,
      tags: [...entry.tags],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })),
  };
}

/** Validate an import payload completely, or reject it whole. */
export function parseKnowledgeBundle(payload) {
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
  if (bundle.format !== KNOWLEDGE_BUNDLE_FORMAT) {
    throw new RoomValidationError(`import format must be "${KNOWLEDGE_BUNDLE_FORMAT}"`);
  }
  if (bundle.schemaVersion !== KNOWLEDGE_SCHEMA_VERSION) {
    throw new RoomValidationError(`import schemaVersion must be ${KNOWLEDGE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(bundle.entries)) throw new RoomValidationError('import entries must be an array');
  const ids = new Set();
  const entries = bundle.entries.map((raw, index) => {
    const where = `entries[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RoomValidationError(`${where} must be an object`);
    }
    const id = String(raw.id ?? '').trim();
    if (!id) throw new RoomValidationError(`${where}.id must not be empty`);
    if (ids.has(id)) throw new RoomValidationError(`duplicate entry id ${id}`);
    ids.add(id);
    const title = requireText(raw.title, `${where}.title`);
    const body = raw.body === undefined ? '' : normalizeText(String(raw.body));
    const tags = normalizeTags(raw.tags);
    const createdAt = String(raw.createdAt ?? '');
    const updatedAt = String(raw.updatedAt ?? '');
    for (const [field, value] of [['createdAt', createdAt], ['updatedAt', updatedAt]]) {
      if (Number.isNaN(Date.parse(value))) {
        throw new RoomValidationError(`${where}.${field} must be an ISO-8601 timestamp`);
      }
    }
    return { id, title, body, tags, createdAt, updatedAt };
  });
  return { entries, exportedAt: typeof bundle.exportedAt === 'string' ? bundle.exportedAt : null };
}

/** Create the Knowledge Room route handler. */
export function createKnowledgeRoom({ store }) {
  if (!store) throw new Error('Knowledge Room requires a store');

  const route = createRouter([
    {
      method: 'GET',
      pattern: '/entries',
      handle: async ({ res, url }) => {
        const query = url.searchParams.get('q') ?? '';
        const tags = url.searchParams.getAll('tag').concat(url.searchParams.get('tags') ?? []);
        const entries = store.snapshot().entries
          .slice()
          .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? 1 : -1) : a.updatedAt < b.updatedAt ? 1 : -1))
          .filter((entry) => matchesQuery(entry, ['title', 'body', 'tags'], query) && matchesTags(entry, tags));
        sendJson(res, 200, { total: entries.length, query: normalizeQuery(query), tags: normalizeTags(tags), entries });
      },
    },
    {
      method: 'POST',
      pattern: '/entries',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const entry = await store.update((data) => {
          const entries = entriesOf(data);
          const item = {
            id: randomUUID(),
            ...normalizeEntryInput(payload),
            createdAt: now(),
            updatedAt: now(),
          };
          entries.push(item);
          return { ...item };
        });
        sendJson(res, 201, { entry });
      },
    },
    {
      method: 'GET',
      pattern: '/entries/:id',
      handle: async ({ res, params }) => {
        const entry = store.snapshot().entries.find((item) => item.id === params.id);
        if (!entry) return sendNotFound(res, `no knowledge entry with id ${params.id}`);
        sendJson(res, 200, { entry });
      },
    },
    {
      method: 'PATCH',
      pattern: '/entries/:id',
      handle: async ({ res, params, readJson }) => {
        const payload = await readJson();
        const entry = await store.update((data) => {
          const entries = entriesOf(data);
          const index = entries.findIndex((item) => item.id === params.id);
          if (index === -1) return null;
          const next = { ...entries[index], ...normalizeEntryInput(payload, { partial: true }), updatedAt: now() };
          entries[index] = next;
          return { ...next };
        });
        if (!entry) return sendNotFound(res, `no knowledge entry with id ${params.id}`);
        sendJson(res, 200, { entry });
      },
    },
    {
      method: 'DELETE',
      pattern: '/entries/:id',
      handle: async ({ res, params }) => {
        const removed = await store.update((data) => {
          const entries = entriesOf(data);
          const index = entries.findIndex((item) => item.id === params.id);
          if (index === -1) return false;
          entries.splice(index, 1);
          return true;
        });
        if (!removed) return sendNotFound(res, `no knowledge entry with id ${params.id}`);
        sendJson(res, 200, { deleted: true, id: params.id });
      },
    },
    {
      method: 'GET',
      pattern: '/export',
      handle: async ({ res }) => {
        const bundle = buildKnowledgeBundle(store.snapshot().entries);
        sendJson(res, 200, bundle);
      },
    },
    {
      method: 'POST',
      pattern: '/import',
      handle: async ({ res, req, readJson }) => {
        const contentType = String(req.headers['content-type'] ?? '');
        const payload = contentType.includes('application/json') ? await readJson() : await readRawBody(req);
        const { entries, exportedAt } = parseKnowledgeBundle(payload);
        await store.replaceAll({ entries });
        sendJson(res, 200, { mode: 'replace', imported: entries.length, exportedAt, total: entries.length });
      },
    },
  ]);

  return {
    id: 'knowledge',
    handle: (context) => route(context),
    /** Exposed for tests and acceptance tooling. */
    collection: createCollection({
      store,
      collection: 'entries',
      normalize: (input, { partial }) => normalizeEntryInput(input, { partial }),
    }),
  };
}
