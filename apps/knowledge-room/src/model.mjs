/**
 * UTOPIA · Knowledge Room (MECH-K0)
 * KnowledgeEntry model + shared normalization rules.
 *
 * This module is the single source of truth for what a valid knowledge entry is.
 * It has no I/O and no dependencies: Node built-ins only.
 */

import { randomUUID } from 'node:crypto';

/** Durable store schema version owned by the Knowledge Room. */
export const SCHEMA_VERSION = 0;

/** Export/import bundle identifier. Not a City Control Protocol contract. */
export const BUNDLE_FORMAT = 'utopia-knowledge-room';

/** Longest accepted title length (characters). */
export const MAX_TITLE_LENGTH = 200;

/** Longest accepted body length (characters). */
export const MAX_BODY_LENGTH = 200000;

/** Longest accepted tag length (characters). */
export const MAX_TAG_LENGTH = 40;

/** Most tags allowed on a single entry. */
export const MAX_TAGS = 32;

/** Error carrying an HTTP-ready status code for payload problems. */
export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

/**
 * Normalize a tag: trim, collapse inner whitespace, lowercase.
 * Tags compare case-insensitively everywhere in the product.
 */
export function normalizeTag(raw) {
  return String(raw ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Normalize a list of tags: drop empties, dedupe (case-insensitive), keep order.
 */
export function normalizeTags(raw) {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
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

/** Normalize free text: normalize newlines, trim outer whitespace. */
export function normalizeText(raw) {
  return String(raw ?? '').replace(/\r\n?/g, '\n').trim();
}

/** Normalize a search query for the deterministic substring matcher. */
export function normalizeQuery(raw) {
  return String(raw ?? '').trim().toLowerCase();
}

function requireString(value, field) {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`);
  }
  return value;
}

/**
 * Validate create/update input.
 * @param {unknown} input
 * @param {{partial?: boolean}} [options]
 * @returns {{title?: string, body?: string, tags?: string[]}}
 */
export function normalizeEntryInput(input, options = {}) {
  const partial = options.partial === true;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ValidationError('entry payload must be a JSON object');
  }
  const out = {};

  if (input.title !== undefined) {
    const title = normalizeText(requireString(input.title, 'title'));
    if (!title) throw new ValidationError('title must not be empty');
    if (title.length > MAX_TITLE_LENGTH) {
      throw new ValidationError(`title must be at most ${MAX_TITLE_LENGTH} characters`);
    }
    out.title = title;
  } else if (!partial) {
    throw new ValidationError('title is required');
  }

  if (input.body !== undefined) {
    const body = normalizeText(requireString(input.body, 'body'));
    if (body.length > MAX_BODY_LENGTH) {
      throw new ValidationError(`body must be at most ${MAX_BODY_LENGTH} characters`);
    }
    out.body = body;
  } else if (!partial) {
    out.body = '';
  }

  if (input.tags !== undefined) {
    const tags = normalizeTags(input.tags);
    if (tags.length > MAX_TAGS) {
      throw new ValidationError(`at most ${MAX_TAGS} tags are allowed`);
    }
    const tooLong = tags.find((tag) => tag.length > MAX_TAG_LENGTH);
    if (tooLong) {
      throw new ValidationError(`tag must be at most ${MAX_TAG_LENGTH} characters`);
    }
    out.tags = tags;
  } else if (!partial) {
    out.tags = [];
  }

  if (partial && Object.keys(out).length === 0) {
    throw new ValidationError('update must change at least one of title, body, tags');
  }
  return out;
}

/** Build a fresh entry. */
export function createEntry(input, now = new Date().toISOString(), id = randomUUID()) {
  const fields = normalizeEntryInput(input);
  return {
    id,
    title: fields.title,
    body: fields.body,
    tags: fields.tags,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Strictly validate one entry coming from a durable file or import bundle.
 * Returns a normalized copy; throws ValidationError when malformed.
 */
export function validateStoredEntry(raw, index) {
  const where = Number.isInteger(index) ? `entries[${index}]` : 'entry';
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ValidationError(`${where} must be an object`);
  }
  const id = requireString(raw.id, `${where}.id`);
  if (!id.trim()) throw new ValidationError(`${where}.id must not be empty`);
  const title = normalizeText(requireString(raw.title, `${where}.title`));
  if (!title) throw new ValidationError(`${where}.title must not be empty`);
  const body = raw.body === undefined ? '' : normalizeText(requireString(raw.body, `${where}.body`));
  const tags = normalizeTags(raw.tags);
  const createdAt = requireString(raw.createdAt, `${where}.createdAt`);
  const updatedAt = requireString(raw.updatedAt, `${where}.updatedAt`);
  for (const [field, value] of [['createdAt', createdAt], ['updatedAt', updatedAt]]) {
    if (Number.isNaN(Date.parse(value))) {
      throw new ValidationError(`${where}.${field} must be an ISO-8601 timestamp`);
    }
  }
  return { id, title, body, tags, createdAt, updatedAt };
}

/** Apply an update to an existing entry, returning a new object. */
export function applyEntryUpdate(entry, input, now = new Date().toISOString()) {
  const fields = normalizeEntryInput(input, { partial: true });
  return {
    ...entry,
    ...fields,
    id: entry.id,
    createdAt: entry.createdAt,
    updatedAt: now,
  };
}
