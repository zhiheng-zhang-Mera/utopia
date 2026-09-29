/**
 * UTOPIA · Rooms · Room 10 — Decision Room (server).
 *
 * Records decisions: the question, the options that were considered, the choice
 * that was made and why. Status is deliberately limited to OPEN / DECIDED /
 * REVISIT. There is no voting, no approval workflow and no policy engine.
 */

import { randomUUID } from 'node:crypto';
import { createRouter, sendJson, sendNotFound } from '../../shared/http.mjs';
import {
  RoomValidationError,
  matchesQuery,
  matchesTags,
  normalizeTags,
  now,
  optionalText,
  requireText,
} from '../../shared/room-kit.mjs';

export const DECISION_BUNDLE_FORMAT = 'utopia-rooms-decisions';
export const DECISION_SCHEMA_VERSION = 1;
export const DECISION_STATUSES = ['OPEN', 'DECIDED', 'REVISIT'];
export const MAX_QUESTION_LENGTH = 500;

function decisionsOf(data) {
  if (!Array.isArray(data.decisions)) data.decisions = [];
  return data.decisions;
}

function findDecision(data, id) {
  return decisionsOf(data).find((decision) => decision.id === id) ?? null;
}

/** Validate the options array: [{ id?, text }]. */
export function normalizeOptions(input, existing = []) {
  if (input === undefined || input === null) return [];
  const list = Array.isArray(input) ? input : String(input).split('\n');
  const byText = new Map(existing.map((option) => [option.text, option.id]));
  const used = new Set();
  const out = [];
  for (const raw of list) {
    if (typeof raw === 'string') {
      const text = raw.trim();
      if (text) {
        const id = byText.get(text) ?? randomUUID();
        used.add(id);
        out.push({ id, text });
      }
      continue;
    }
    if (raw === null || typeof raw !== 'object') throw new RoomValidationError('each option must be a string or object');
    const text = requireText(raw.text ?? '', 'option.text', { maxLength: 2000 });
    // keep an explicitly supplied id only when it is not already taken, otherwise
    // fall back to the id of the option with the same text so references survive
    const candidate = typeof raw.id === 'string' && raw.id.trim() && !used.has(raw.id) ? raw.id : null;
    const id = candidate ?? byText.get(text) ?? randomUUID();
    used.add(id);
    out.push({ id, text });
  }
  return out;
}

/** Validate decision create/update input. */
export function normalizeDecisionInput(input, { partial = false, existingOptions = [] } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RoomValidationError('decision payload must be a JSON object');
  }
  const out = {};
  if (input.question !== undefined) out.question = requireText(input.question, 'question', { maxLength: MAX_QUESTION_LENGTH });
  else if (!partial) throw new RoomValidationError('question is required');
  if (input.context !== undefined) out.context = optionalText(input.context, 'context', { maxLength: 20000 });
  else if (!partial) out.context = '';
  if (input.options !== undefined) out.options = normalizeOptions(input.options, existingOptions);
  else if (!partial) out.options = [];
  if (input.decision !== undefined) out.decision = optionalText(input.decision, 'decision', { maxLength: 4000 });
  else if (!partial) out.decision = '';
  if (input.rationale !== undefined) out.rationale = optionalText(input.rationale, 'rationale', { maxLength: 20000 });
  else if (!partial) out.rationale = '';
  if (input.status !== undefined) {
    const status = String(input.status).toUpperCase();
    if (!DECISION_STATUSES.includes(status)) {
      throw new RoomValidationError(`status must be one of ${DECISION_STATUSES.join(', ')}`);
    }
    out.status = status;
  } else if (!partial) {
    out.status = 'OPEN';
  }
  if (input.tags !== undefined) out.tags = normalizeTags(input.tags);
  else if (!partial) out.tags = [];
  if (input.selectedOptionId !== undefined) {
    out.selectedOptionId = input.selectedOptionId === null || input.selectedOptionId === ''
      ? null
      : String(input.selectedOptionId);
  } else if (!partial) {
    out.selectedOptionId = null;
  }
  if (out.selectedOptionId && out.options && !out.options.some((option) => option.id === out.selectedOptionId)) {
    throw new RoomValidationError('selectedOptionId must reference one of the options');
  }
  if (partial && Object.keys(out).length === 0) throw new RoomValidationError('update must change at least one field');
  return out;
}

/** Export bundle for this room. */
export function buildDecisionBundle(decisions, exportedAt = now()) {
  return {
    format: DECISION_BUNDLE_FORMAT,
    schemaVersion: DECISION_SCHEMA_VERSION,
    exportedAt,
    decisions: decisions.map((decision) => ({
      ...decision,
      tags: [...decision.tags],
      options: decision.options.map((option) => ({ ...option })),
    })),
  };
}

/** Validate an import payload completely, or reject it whole. */
export function parseDecisionBundle(payload) {
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
  if (bundle.format !== DECISION_BUNDLE_FORMAT) {
    throw new RoomValidationError(`import format must be "${DECISION_BUNDLE_FORMAT}"`);
  }
  if (bundle.schemaVersion !== DECISION_SCHEMA_VERSION) {
    throw new RoomValidationError(`import schemaVersion must be ${DECISION_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(bundle.decisions)) throw new RoomValidationError('import decisions must be an array');
  const ids = new Set();
  const decisions = bundle.decisions.map((raw, index) => {
    const where = `decisions[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RoomValidationError(`${where} must be an object`);
    }
    const id = String(raw.id ?? '').trim();
    if (!id) throw new RoomValidationError(`${where}.id must not be empty`);
    if (ids.has(id)) throw new RoomValidationError(`duplicate decision id ${id}`);
    ids.add(id);
    const fields = normalizeDecisionInput(raw);
    const createdAt = String(raw.createdAt ?? '');
    const decidedAt = raw.decidedAt === undefined || raw.decidedAt === null ? null : String(raw.decidedAt);
    const updatedAt = String(raw.updatedAt ?? '');
    for (const [field, value] of [['createdAt', createdAt], ['updatedAt', updatedAt]]) {
      if (Number.isNaN(Date.parse(value))) {
        throw new RoomValidationError(`${where}.${field} must be an ISO-8601 timestamp`);
      }
    }
    if (decidedAt !== null && Number.isNaN(Date.parse(decidedAt))) {
      throw new RoomValidationError(`${where}.decidedAt must be an ISO-8601 timestamp or null`);
    }
    return { id, ...fields, createdAt, updatedAt, decidedAt };
  });
  return { decisions, exportedAt: typeof bundle.exportedAt === 'string' ? bundle.exportedAt : null };
}

/** Create the Decision Room route handler. */
export function createDecisionRoom({ store }) {
  if (!store) throw new Error('Decision Room requires a store');

  const sort = (a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? 1 : -1) : a.updatedAt < b.updatedAt ? 1 : -1);

  const route = createRouter([
    {
      method: 'GET',
      pattern: '/decisions',
      handle: async ({ res, url }) => {
        const query = url.searchParams.get('q') ?? '';
        const tags = url.searchParams.getAll('tag');
        const status = url.searchParams.get('status');
        if (status && !DECISION_STATUSES.includes(status.toUpperCase())) {
          throw new RoomValidationError(`status must be one of ${DECISION_STATUSES.join(', ')}`);
        }
        const decisions = store.snapshot().decisions
          .slice()
          .sort(sort)
          .filter((decision) => matchesQuery(decision, ['question', 'context', 'decision', 'rationale', 'tags'], query))
          .filter((decision) => matchesTags(decision, tags))
          .filter((decision) => (status ? decision.status === status.toUpperCase() : true));
        sendJson(res, 200, { total: decisions.length, statuses: DECISION_STATUSES, decisions });
      },
    },
    {
      method: 'POST',
      pattern: '/decisions',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const decision = await store.update((data) => {
          const fields = normalizeDecisionInput(payload);
          const item = {
            id: randomUUID(),
            ...fields,
            createdAt: now(),
            updatedAt: now(),
            decidedAt: fields.status === 'DECIDED' ? now() : null,
          };
          decisionsOf(data).push(item);
          return { ...item };
        });
        sendJson(res, 201, { decision });
      },
    },
    {
      method: 'PATCH',
      pattern: '/decisions/:id',
      handle: async ({ res, params, readJson }) => {
        const payload = await readJson();
        const decision = await store.update((data) => {
          const target = findDecision(data, params.id);
          if (!target) return null;
          const fields = normalizeDecisionInput(payload, { partial: true, existingOptions: target.options ?? [] });
          if (fields.selectedOptionId) {
            const options = fields.options ?? target.options ?? [];
            if (!options.some((option) => option.id === fields.selectedOptionId)) {
              throw new RoomValidationError('selectedOptionId must reference one of the options');
            }
          }
          const next = { ...target, ...fields, updatedAt: now() };
          if (fields.status === 'DECIDED' && !next.decidedAt) next.decidedAt = now();
          if (fields.status && fields.status !== 'DECIDED') next.decidedAt = next.decidedAt ?? null;
          return { ...next };
        });
        if (!decision) return sendNotFound(res, `no decision with id ${params.id}`);
        sendJson(res, 200, { decision });
      },
    },
    {
      method: 'POST',
      pattern: '/decisions/:id/options',
      handle: async ({ res, params, readJson }) => {
        const payload = await readJson();
        const result = await store.update((data) => {
          const target = findDecision(data, params.id);
          if (!target) return null;
          const [option] = normalizeOptions([payload], target.options);
          target.options.push(option);
          target.updatedAt = now();
          return { decision: { ...target } };
        });
        if (!result) return sendNotFound(res, `no decision with id ${params.id}`);
        sendJson(res, 201, result);
      },
    },
    {
      method: 'POST',
      pattern: '/decisions/:id/decide',
      handle: async ({ res, params, readJson }) => {
        const payload = await readJson();
        const result = await store.update((data) => {
          const target = findDecision(data, params.id);
          if (!target) return null;
          const fields = normalizeDecisionInput(payload ?? {}, { partial: true });
          const optionId = fields.selectedOptionId ?? target.selectedOptionId ?? null;
          if (optionId && !target.options.some((option) => option.id === optionId)) {
            throw new RoomValidationError('selectedOptionId must reference one of the options');
          }
          const chosen = target.options.find((option) => option.id === optionId) ?? null;
          const explicit = fields.decision ?? target.decision ?? '';
          const decision = {
            ...target,
            ...fields,
            selectedOptionId: optionId,
            decision: explicit.trim() ? explicit : (chosen?.text ?? ''),
            status: 'DECIDED',
            decidedAt: now(),
            updatedAt: now(),
          };
          const index = data.decisions.findIndex((item) => item.id === params.id);
          data.decisions[index] = decision;
          return { decision: { ...decision } };
        });
        if (!result) return sendNotFound(res, `no decision with id ${params.id}`);
        sendJson(res, 200, result);
      },
    },
    {
      method: 'POST',
      pattern: '/decisions/:id/revisit',
      handle: async ({ res, params }) => {
        const result = await store.update((data) => {
          const target = findDecision(data, params.id);
          if (!target) return null;
          const decision = { ...target, status: 'REVISIT', updatedAt: now() };
          const index = data.decisions.findIndex((item) => item.id === params.id);
          data.decisions[index] = decision;
          return { decision: { ...decision } };
        });
        if (!result) return sendNotFound(res, `no decision with id ${params.id}`);
        sendJson(res, 200, result);
      },
    },
    {
      method: 'DELETE',
      pattern: '/decisions/:id',
      handle: async ({ res, params }) => {
        const removed = await store.update((data) => {
          const items = decisionsOf(data);
          const index = items.findIndex((item) => item.id === params.id);
          if (index === -1) return false;
          items.splice(index, 1);
          return true;
        });
        if (!removed) return sendNotFound(res, `no decision with id ${params.id}`);
        sendJson(res, 200, { deleted: true, id: params.id });
      },
    },
    {
      method: 'GET',
      pattern: '/export',
      handle: async ({ res }) => sendJson(res, 200, buildDecisionBundle(store.snapshot().decisions)),
    },
    {
      method: 'POST',
      pattern: '/import',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const { decisions, exportedAt } = parseDecisionBundle(payload);
        await store.replaceAll({ decisions });
        sendJson(res, 200, { mode: 'replace', imported: decisions.length, exportedAt });
      },
    },
  ]);

  return { id: 'decisions', handle: (context) => route(context) };
}
