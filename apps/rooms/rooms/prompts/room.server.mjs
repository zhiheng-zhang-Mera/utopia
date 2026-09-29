/**
 * UTOPIA · Rooms · Room 04 — Prompt Library (server).
 *
 * Manages reusable prompt templates with {{variable}} placeholders and renders a
 * final prompt locally. This room never calls an AI provider: there is no model
 * routing, no conversation history and no network dependency of any kind.
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
  optionalText,
  requireText,
} from '../../shared/room-kit.mjs';

export const PROMPT_BUNDLE_FORMAT = 'utopia-rooms-prompts';
export const PROMPT_SCHEMA_VERSION = 1;
export const MAX_TEMPLATE_LENGTH = 100000;
export const MAX_TITLE_LENGTH = 200;

const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_.\- ]+?)\s*\}\}/g;

/** Detect the distinct {{variable}} names used by a template, in order. */
export function detectVariables(template) {
  const seen = new Set();
  const out = [];
  for (const match of String(template ?? '').matchAll(VARIABLE_PATTERN)) {
    const name = match[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

/**
 * Render a template with variable values.
 * Unknown variables are left in place so the user can see what is still missing.
 */
export function renderPrompt(template, values = {}) {
  return String(template ?? '').replace(VARIABLE_PATTERN, (whole, rawName) => {
    const name = rawName.trim();
    if (Object.prototype.hasOwnProperty.call(values, name)) return String(values[name] ?? '');
    return whole;
  });
}

/** Variables that still have no value. */
export function missingVariables(template, values = {}) {
  return detectVariables(template).filter((name) => !Object.prototype.hasOwnProperty.call(values, name) || String(values[name] ?? '') === '');
}

function promptsOf(data) {
  if (!Array.isArray(data.prompts)) data.prompts = [];
  return data.prompts;
}

/** Validate prompt create/update input. */
export function normalizePromptInput(input, { partial = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RoomValidationError('prompt payload must be a JSON object');
  }
  const out = {};
  if (input.title !== undefined) out.title = requireText(input.title, 'title', { maxLength: MAX_TITLE_LENGTH });
  else if (!partial) throw new RoomValidationError('title is required');
  if (input.template !== undefined) {
    const template = normalizeText(String(input.template));
    if (template.length > MAX_TEMPLATE_LENGTH) {
      throw new RoomValidationError(`template must be at most ${MAX_TEMPLATE_LENGTH} characters`);
    }
    out.template = template;
  } else if (!partial) {
    throw new RoomValidationError('template is required');
  }
  if (input.note !== undefined) out.note = optionalText(input.note, 'note', { maxLength: 20000 });
  else if (!partial) out.note = '';
  if (input.tags !== undefined) out.tags = normalizeTags(input.tags);
  else if (!partial) out.tags = [];
  if (input.values !== undefined) {
    if (input.values === null || typeof input.values !== 'object' || Array.isArray(input.values)) {
      throw new RoomValidationError('values must be an object of variable names to strings');
    }
    out.values = Object.fromEntries(Object.entries(input.values).map(([key, value]) => [String(key), String(value ?? '')]));
  } else if (!partial) {
    out.values = {};
  }
  if (partial && Object.keys(out).length === 0) {
    throw new RoomValidationError('update must change at least one of title, template, note, tags, values');
  }
  return out;
}

/** Export bundle for this room. */
export function buildPromptBundle(prompts, exportedAt = now()) {
  return {
    format: PROMPT_BUNDLE_FORMAT,
    schemaVersion: PROMPT_SCHEMA_VERSION,
    exportedAt,
    prompts: prompts.map((prompt) => ({ ...prompt, tags: [...prompt.tags], values: { ...prompt.values } })),
  };
}

/** Validate an import payload completely, or reject it whole. */
export function parsePromptBundle(payload) {
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
  if (bundle.format !== PROMPT_BUNDLE_FORMAT) {
    throw new RoomValidationError(`import format must be "${PROMPT_BUNDLE_FORMAT}"`);
  }
  if (bundle.schemaVersion !== PROMPT_SCHEMA_VERSION) {
    throw new RoomValidationError(`import schemaVersion must be ${PROMPT_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(bundle.prompts)) throw new RoomValidationError('import prompts must be an array');
  const ids = new Set();
  const prompts = bundle.prompts.map((raw, index) => {
    const where = `prompts[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new RoomValidationError(`${where} must be an object`);
    }
    const id = String(raw.id ?? '').trim();
    if (!id) throw new RoomValidationError(`${where}.id must not be empty`);
    if (ids.has(id)) throw new RoomValidationError(`duplicate prompt id ${id}`);
    ids.add(id);
    const fields = normalizePromptInput(raw);
    const createdAt = String(raw.createdAt ?? '');
    const updatedAt = String(raw.updatedAt ?? '');
    for (const [field, value] of [['createdAt', createdAt], ['updatedAt', updatedAt]]) {
      if (Number.isNaN(Date.parse(value))) {
        throw new RoomValidationError(`${where}.${field} must be an ISO-8601 timestamp`);
      }
    }
    return { id, ...fields, createdAt, updatedAt };
  });
  return { prompts, exportedAt: typeof bundle.exportedAt === 'string' ? bundle.exportedAt : null };
}

/** Create the Prompt Library route handler. */
export function createPromptRoom({ store }) {
  if (!store) throw new Error('Prompt Library requires a store');

  const withDerived = (prompt) => ({
    ...prompt,
    variables: detectVariables(prompt.template),
  });

  const route = createRouter([
    {
      method: 'GET',
      pattern: '/prompts',
      handle: async ({ res, url }) => {
        const query = url.searchParams.get('q') ?? '';
        const tags = url.searchParams.getAll('tag');
        const prompts = store.snapshot().prompts
          .slice()
          .sort((a, b) => (a.updatedAt === b.updatedAt ? (a.id < b.id ? 1 : -1) : a.updatedAt < b.updatedAt ? 1 : -1))
          .filter((prompt) => matchesQuery(prompt, ['title', 'template', 'note', 'tags'], query) && matchesTags(prompt, tags))
          .map(withDerived);
        sendJson(res, 200, { total: prompts.length, prompts });
      },
    },
    {
      method: 'POST',
      pattern: '/prompts',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const prompt = await store.update((data) => {
          const item = { id: randomUUID(), ...normalizePromptInput(payload), createdAt: now(), updatedAt: now() };
          promptsOf(data).push(item);
          return withDerived(item);
        });
        sendJson(res, 201, { prompt });
      },
    },
    {
      method: 'PATCH',
      pattern: '/prompts/:id',
      handle: async ({ res, params, readJson }) => {
        const payload = await readJson();
        const prompt = await store.update((data) => {
          const items = promptsOf(data);
          const index = items.findIndex((item) => item.id === params.id);
          if (index === -1) return null;
          const next = { ...items[index], ...normalizePromptInput(payload, { partial: true }), updatedAt: now() };
          items[index] = next;
          return withDerived(next);
        });
        if (!prompt) return sendNotFound(res, `no prompt with id ${params.id}`);
        sendJson(res, 200, { prompt });
      },
    },
    {
      method: 'DELETE',
      pattern: '/prompts/:id',
      handle: async ({ res, params }) => {
        const removed = await store.update((data) => {
          const items = promptsOf(data);
          const index = items.findIndex((item) => item.id === params.id);
          if (index === -1) return false;
          items.splice(index, 1);
          return true;
        });
        if (!removed) return sendNotFound(res, `no prompt with id ${params.id}`);
        sendJson(res, 200, { deleted: true, id: params.id });
      },
    },
    {
      method: 'POST',
      pattern: '/prompts/:id/render',
      handle: async ({ res, params, readJson }) => {
        const payload = await readJson().catch(() => ({}));
        const prompt = store.snapshot().prompts.find((item) => item.id === params.id);
        if (!prompt) return sendNotFound(res, `no prompt with id ${params.id}`);
        const values = payload?.values && typeof payload.values === 'object' ? payload.values : prompt.values;
        sendJson(res, 200, {
          variables: detectVariables(prompt.template),
          missing: missingVariables(prompt.template, values),
          rendered: renderPrompt(prompt.template, values),
        });
      },
    },
    {
      method: 'GET',
      pattern: '/export',
      handle: async ({ res }) => sendJson(res, 200, buildPromptBundle(store.snapshot().prompts)),
    },
    {
      method: 'POST',
      pattern: '/import',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const { prompts, exportedAt } = parsePromptBundle(payload);
        await store.replaceAll({ prompts });
        sendJson(res, 200, { mode: 'replace', imported: prompts.length, exportedAt });
      },
    },
  ]);

  return { id: 'prompts', handle: (context) => route(context) };
}
