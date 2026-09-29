/**
 * UTOPIA · Rooms — shared room utilities.
 *
 * Deliberately small: ids, timestamps, text normalization, tag handling,
 * validation errors, list search and a tiny collection CRUD helper.
 * Every helper here is actually used by several rooms; nothing is speculative.
 */

import { randomUUID } from 'node:crypto';

/** Error carrying an HTTP-ready status code for payload problems. */
export class RoomValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'RoomValidationError';
    this.statusCode = statusCode;
  }
}

/** Generate a new room item id. */
export function newId() {
  return randomUUID();
}

/** Current ISO-8601 timestamp. */
export function now() {
  return new Date().toISOString();
}

/** Normalize free text: normalize newlines and trim outer whitespace. */
export function normalizeText(value) {
  return String(value ?? '').replace(/\r\n?/g, '\n').trim();
}

/** Normalize a single tag: trim, collapse inner whitespace, lowercase. */
export function normalizeTag(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Normalize a tag list: split on commas, drop empties, dedupe, keep order. */
export function normalizeTags(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const tag = normalizeTag(item);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

/** Normalize a search query. */
export function normalizeQuery(value) {
  return String(value ?? '').trim().toLowerCase();
}

/** Require a string field. */
export function requireString(value, field) {
  if (typeof value !== 'string') throw new RoomValidationError(`${field} must be a string`);
  return value;
}

/** Require a non-empty normalized text field. */
export function requireText(value, field, { maxLength } = {}) {
  const text = normalizeText(requireString(value, field));
  if (!text) throw new RoomValidationError(`${field} must not be empty`);
  if (maxLength && text.length > maxLength) {
    throw new RoomValidationError(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

/** Optional ISO-8601 timestamp field; returns null when absent/empty. */
export function optionalTimestamp(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const text = requireString(value, field);
  if (Number.isNaN(Date.parse(text))) {
    throw new RoomValidationError(`${field} must be an ISO-8601 timestamp`);
  }
  return new Date(text).toISOString();
}

/** Optional normalized text field. */
export function optionalText(value, field, { maxLength } = {}) {
  if (value === undefined || value === null) return '';
  const text = normalizeText(requireString(value, field));
  if (maxLength && text.length > maxLength) {
    throw new RoomValidationError(`${field} must be at most ${maxLength} characters`);
  }
  return text;
}

/** Case-insensitive substring test over several fields of an item. */
export function matchesQuery(item, fields, query) {
  const needle = normalizeQuery(query);
  if (!needle) return true;
  return fields.some((field) => String(item[field] ?? '').toLowerCase().includes(needle));
}

/** Every requested tag must be present (exact, normalized match). */
export function matchesTags(item, requested) {
  const wanted = (Array.isArray(requested) ? requested : String(requested ?? '').split(',')).map(normalizeTag).filter(Boolean);
  if (wanted.length === 0) return true;
  const own = new Set((item.tags ?? []).map(normalizeTag));
  return wanted.every((tag) => own.has(tag));
}

/** Sort newest-updated first with a stable id tiebreak. */
export function byUpdatedDesc(a, b) {
  if (a.updatedAt === b.updatedAt) return a.id < b.id ? 1 : -1;
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

/**
 * Generic create/read/update/delete over a named array inside a room store.
 *
 * @param {object} options
 * @param {import('./atomic-store.mjs').RoomStore} options.store
 * @param {string} options.collection property name holding the array
 * @param {(input: unknown, mode: {partial: boolean}) => object} options.normalize
 * @param {(item: object) => object} [options.onCreate]
 * @param {(item: object, input: unknown) => object} [options.onUpdate]
 * @param {(a: object, b: object) => number} [options.sort]
 */
export function createCollection(options) {
  const {
    store,
    collection,
    normalize,
    onCreate = (item) => item,
    onUpdate,
    sort = byUpdatedDesc,
  } = options;

  const ensure = (data) => {
    if (!Array.isArray(data[collection])) data[collection] = [];
    return data[collection];
  };

  return {
    collection,
    list() {
      return store.snapshot()[collection].slice().sort(sort);
    },
    get(id) {
      return store.snapshot()[collection].find((item) => item.id === id) ?? null;
    },
    create(input) {
      return store.update((data) => {
        const items = ensure(data);
        const item = onCreate({ id: newId(), ...normalize(input, { partial: false }) });
        items.push(item);
        return { ...item };
      });
    },
    update(id, input) {
      return store.update((data) => {
        const items = ensure(data);
        const index = items.findIndex((item) => item.id === id);
        if (index === -1) return null;
        const next = onUpdate
          ? onUpdate(items[index], input)
          : { ...items[index], ...normalize(input, { partial: true }), updatedAt: now() };
        items[index] = next;
        return { ...next };
      });
    },
    remove(id) {
      return store.update((data) => {
        const items = ensure(data);
        const index = items.findIndex((item) => item.id === id);
        if (index === -1) return false;
        items.splice(index, 1);
        return true;
      });
    },
    /** Search with an optional text query over fields plus tag filtering. */
    search({ query = '', tags = [], fields = ['title'] } = {}) {
      return this.list().filter((item) => matchesQuery(item, fields, query) && matchesTags(item, tags));
    },
  };
}
