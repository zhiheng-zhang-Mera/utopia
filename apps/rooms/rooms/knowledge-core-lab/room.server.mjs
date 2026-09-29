/**
 * UTOPIA · Rooms · Room 13 — Knowledge Core Lab (server).
 *
 * Incubator for the Codex-Boss knowledge core: entries carry domain, shelf, tags,
 * trust, validity windows, supersession and conflict metadata; retrieval is
 * deterministic and stays inside a character budget. There is no embedding, no
 * vector store and no LLM.
 *
 * Donor: zhiheng-zhang-Mera/Codex-Boss @ 8df428eaa437a409368401e95194e40266b83080
 *        src/shared/knowledge.ts
 */

import { createRouter, sendJson } from '../../shared/http.mjs';
import { RoomValidationError } from '../../shared/room-kit.mjs';
import {
  DEFAULT_MAX_CHARS,
  TRUST_LEVELS,
  TRUST_ORDER,
  conflictReport,
  relevanceScore,
  retrieveReranked,
  retrieveWithinBudget,
  routeKnowledgeQuery,
  taxonomyOf,
} from './knowledge-core.mjs';

function requireObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RoomValidationError('payload must be a JSON object');
  }
  return payload;
}

function asStringArray(value, field) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map((item) => String(item).trim()).filter(Boolean);
}

/** Validate one entry coming from the room UI. */
export function normalizeEntry(input, index = 0) {
  const where = `entries[${index}]`;
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RoomValidationError(`${where} must be an object`);
  }
  const id = String(input.id ?? '').trim();
  if (!id) throw new RoomValidationError(`${where}.id must not be empty`);
  const domain = String(input.domain ?? '').trim();
  if (!domain) throw new RoomValidationError(`${where}.domain must not be empty`);
  const shelf = String(input.shelf ?? 'default').trim() || 'default';
  const title = String(input.title ?? '').trim();
  if (!title) throw new RoomValidationError(`${where}.title must not be empty`);
  const content = String(input.content ?? '');
  const trust = String(input.trust ?? 'UNVERIFIED').toUpperCase();
  if (!(trust in TRUST_ORDER)) {
    throw new RoomValidationError(`${where}.trust must be one of ${TRUST_LEVELS.join(', ')}`);
  }
  const validFrom = input.validFrom === undefined || input.validFrom === null || input.validFrom === '' ? undefined : String(input.validFrom);
  const validUntil = input.validUntil === undefined || input.validUntil === null || input.validUntil === '' ? undefined : String(input.validUntil);
  for (const [field, value] of [['validFrom', validFrom], ['validUntil', validUntil]]) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw new RoomValidationError(`${where}.${field} must be an ISO-8601 timestamp`);
    }
  }
  const now = new Date().toISOString();
  return {
    id,
    domain,
    shelf,
    tags: asStringArray(input.tags, `${where}.tags`),
    title,
    content,
    source: String(input.source ?? 'room'),
    trust,
    ...(validFrom === undefined ? {} : { validFrom }),
    ...(validUntil === undefined ? {} : { validUntil }),
    ...(input.supersedes ? { supersedes: String(input.supersedes) } : {}),
    ...(input.conflictGroup ? { conflictGroup: String(input.conflictGroup) } : {}),
    createdAt: input.createdAt ? String(input.createdAt) : now,
    updatedAt: input.updatedAt ? String(input.updatedAt) : now,
  };
}

/** Validate a query payload. */
export function normalizeQuery(input) {
  const payload = input === undefined || input === null ? {} : requireObject(input);
  const maxChars = payload.maxChars === undefined || payload.maxChars === null ? DEFAULT_MAX_CHARS : Number(payload.maxChars);
  if (!Number.isFinite(maxChars) || maxChars < 1 || maxChars > 1000000) {
    throw new RoomValidationError('maxChars must be between 1 and 1000000');
  }
  const trustAtLeast = payload.trustAtLeast === undefined || payload.trustAtLeast === '' ? undefined : String(payload.trustAtLeast).toUpperCase();
  if (trustAtLeast !== undefined && !(trustAtLeast in TRUST_ORDER)) {
    throw new RoomValidationError(`trustAtLeast must be one of ${TRUST_LEVELS.join(', ')}`);
  }
  return {
    ...(payload.domain ? { domain: String(payload.domain) } : {}),
    ...(payload.shelf ? { shelf: String(payload.shelf) } : {}),
    ...(asStringArray(payload.tags, 'tags').length ? { tags: asStringArray(payload.tags, 'tags') } : {}),
    ...(trustAtLeast === undefined ? {} : { trustAtLeast }),
    maxChars,
  };
}

function requireEntries(payload) {
  if (!Array.isArray(payload.entries) || payload.entries.length === 0) {
    throw new RoomValidationError('entries must be a non-empty array');
  }
  if (payload.entries.length > 500) throw new RoomValidationError('at most 500 entries can be analysed at once');
  return payload.entries.map((entry, index) => normalizeEntry(entry, index));
}

/** Create the Knowledge Core Lab route handler (no durable store). */
export function createKnowledgeCoreRoom() {
  const route = createRouter([
    {
      method: 'GET',
      pattern: '/capabilities',
      handle: async ({ res }) => {
        sendJson(res, 200, {
          room: 'knowledge-core-lab',
          embeddings: false,
          donor: {
            repository: 'zhiheng-zhang-Mera/Codex-Boss',
            commit: '8df428eaa437a409368401e95194e40266b83080',
            sourcePaths: ['src/shared/knowledge.ts'],
            skippedSourcePaths: ['electron/knowledge/knowledge-store.ts'],
          },
          trustLevels: TRUST_LEVELS,
          limits: { defaultMaxChars: DEFAULT_MAX_CHARS, maxEntries: 500 },
        });
      },
    },
    {
      method: 'POST',
      pattern: '/taxonomy',
      handle: async ({ res, readJson }) => {
        const entries = requireEntries(requireObject(await readJson()));
        sendJson(res, 200, { total: entries.length, taxonomy: taxonomyOf(entries) });
      },
    },
    {
      method: 'POST',
      pattern: '/retrieve',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const entries = requireEntries(payload);
        const query = normalizeQuery(payload.query);
        const goal = typeof payload.goal === 'string' ? payload.goal.trim() : '';
        const retrieved = goal
          ? retrieveReranked(entries, query, goal)
          : retrieveWithinBudget(entries, query);
        const budgetUsed = retrieved.reduce((total, entry) => total + entry.content.length, 0);
        sendJson(res, 200, {
          mode: goal ? 'reranked' : 'trust',
          goal: goal || null,
          query,
          total: retrieved.length,
          characters: budgetUsed,
          budget: query.maxChars,
          withinBudget: budgetUsed <= query.maxChars,
          entries: retrieved.map((entry) => ({
            id: entry.id,
            domain: entry.domain,
            shelf: entry.shelf,
            tags: entry.tags,
            title: entry.title,
            trust: entry.trust,
            characters: entry.content.length,
            ...(goal ? { relevance: relevanceScore(entry, goal) } : {}),
          })),
        });
      },
    },
    {
      method: 'POST',
      pattern: '/route',
      handle: async ({ res, readJson }) => {
        const payload = requireObject(await readJson());
        const entries = requireEntries(payload);
        const goal = String(payload.goal ?? '').trim();
        if (!goal) throw new RoomValidationError('goal must not be empty');
        const query = routeKnowledgeQuery(goal, entries);
        const routed = retrieveWithinBudget(entries, { ...query, maxChars: DEFAULT_MAX_CHARS });
        sendJson(res, 200, {
          goal,
          query,
          taxonomy: taxonomyOf(entries),
          matches: routed.map((entry) => ({ id: entry.id, domain: entry.domain, tags: entry.tags, title: entry.title, trust: entry.trust })),
        });
      },
    },
    {
      method: 'POST',
      pattern: '/conflicts',
      handle: async ({ res, readJson }) => {
        const entries = requireEntries(requireObject(await readJson()));
        sendJson(res, 200, { total: entries.length, conflicts: conflictReport(entries) });
      },
    },
  ]);

  return { id: 'knowledge-core-lab', handle: (context) => route(context), persistent: false };
}

/** Re-exported for tests so they touch the same helpers as the room. */
export { conflictReport };
