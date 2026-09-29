/**
 * UTOPIA · Rooms · Room 03 — Checklist Room (server).
 *
 * Checklists and checklist items only. This room deliberately does NOT reuse the
 * City Control task model: there is no Task, no assignment, no scheduling and no
 * QUEUED/RUNNING/COMPLETED lifecycle. Items are simply open or done.
 */

import { randomUUID } from 'node:crypto';
import { createRouter, sendJson, sendNotFound } from '../../shared/http.mjs';
import {
  RoomValidationError,
  normalizeText,
  now,
  optionalText,
  requireText,
} from '../../shared/room-kit.mjs';

export const MAX_LIST_TITLE = 160;
export const MAX_ITEM_TEXT = 500;
export const MAX_NOTE = 2000;

function checklistsOf(data) {
  if (!Array.isArray(data.checklists)) data.checklists = [];
  return data.checklists;
}

function findList(data, id) {
  return checklistsOf(data).find((list) => list.id === id) ?? null;
}

/** Validate checklist create input. */
export function normalizeChecklistInput(input, { partial = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RoomValidationError('checklist payload must be a JSON object');
  }
  const out = {};
  if (input.title !== undefined) out.title = requireText(input.title, 'title', { maxLength: MAX_LIST_TITLE });
  else if (!partial) throw new RoomValidationError('title is required');
  if (input.note !== undefined) out.note = optionalText(input.note, 'note', { maxLength: MAX_NOTE });
  else if (!partial) out.note = '';
  if (partial && Object.keys(out).length === 0) throw new RoomValidationError('update must change title or note');
  return out;
}

/** Validate checklist item input. */
export function normalizeItemInput(input, { partial = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new RoomValidationError('item payload must be a JSON object');
  }
  const out = {};
  if (input.text !== undefined) out.text = requireText(input.text, 'text', { maxLength: MAX_ITEM_TEXT });
  else if (!partial) throw new RoomValidationError('text is required');
  if (input.note !== undefined) out.note = optionalText(input.note, 'note', { maxLength: MAX_NOTE });
  else if (!partial) out.note = '';
  if (input.dueDate !== undefined) {
    if (input.dueDate === null || input.dueDate === '') out.dueDate = null;
    else {
      const value = requireText(input.dueDate, 'dueDate');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RoomValidationError('dueDate must be YYYY-MM-DD');
      out.dueDate = value;
    }
  } else if (!partial) {
    out.dueDate = null;
  }
  if (input.done !== undefined) out.done = Boolean(input.done);
  if (partial && Object.keys(out).length === 0) throw new RoomValidationError('update must change at least one field');
  return out;
}

/** Progress summary for one checklist. */
export function checklistProgress(list) {
  const total = list.items.length;
  const done = list.items.filter((item) => item.done).length;
  return { total, done, open: total - done, ratio: total === 0 ? 0 : done / total };
}

/** Create the Checklist Room route handler. */
export function createChecklistRoom({ store }) {
  if (!store) throw new Error('Checklist Room requires a store');

  const route = createRouter([
    {
      method: 'GET',
      pattern: '/checklists',
      handle: async ({ res }) => {
        const checklists = store.snapshot().checklists
          .slice()
          .sort((a, b) => (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1))
          .map((list) => ({ ...list, progress: checklistProgress(list) }));
        sendJson(res, 200, { total: checklists.length, checklists });
      },
    },
    {
      method: 'POST',
      pattern: '/checklists',
      handle: async ({ res, readJson }) => {
        const payload = await readJson();
        const list = await store.update((data) => {
          const item = {
            id: randomUUID(),
            ...normalizeChecklistInput(payload),
            items: [],
            createdAt: now(),
            updatedAt: now(),
          };
          checklistsOf(data).push(item);
          return { ...item, progress: checklistProgress(item) };
        });
        sendJson(res, 201, { checklist: list });
      },
    },
    {
      method: 'PATCH',
      pattern: '/checklists/:id',
      handle: async ({ res, params, readJson }) => {
        const payload = await readJson();
        const list = await store.update((data) => {
          const target = findList(data, params.id);
          if (!target) return null;
          Object.assign(target, normalizeChecklistInput(payload, { partial: true }), { updatedAt: now() });
          return { ...target, progress: checklistProgress(target) };
        });
        if (!list) return sendNotFound(res, `no checklist with id ${params.id}`);
        sendJson(res, 200, { checklist: list });
      },
    },
    {
      method: 'DELETE',
      pattern: '/checklists/:id',
      handle: async ({ res, params }) => {
        const removed = await store.update((data) => {
          const lists = checklistsOf(data);
          const index = lists.findIndex((list) => list.id === params.id);
          if (index === -1) return false;
          lists.splice(index, 1);
          return true;
        });
        if (!removed) return sendNotFound(res, `no checklist with id ${params.id}`);
        sendJson(res, 200, { deleted: true, id: params.id });
      },
    },
    {
      method: 'POST',
      pattern: '/checklists/:id/items',
      handle: async ({ res, params, readJson }) => {
        const payload = await readJson();
        const result = await store.update((data) => {
          const target = findList(data, params.id);
          if (!target) return null;
          const item = { id: randomUUID(), done: false, ...normalizeItemInput(payload), createdAt: now(), updatedAt: now() };
          target.items.push(item);
          target.updatedAt = now();
          return { item: { ...item }, checklist: { ...target, progress: checklistProgress(target) } };
        });
        if (!result) return sendNotFound(res, `no checklist with id ${params.id}`);
        sendJson(res, 201, result);
      },
    },
    {
      method: 'PATCH',
      pattern: '/checklists/:id/items/:itemId',
      handle: async ({ res, params, readJson }) => {
        const payload = await readJson();
        const result = await store.update((data) => {
          const target = findList(data, params.id);
          if (!target) return null;
          const index = target.items.findIndex((item) => item.id === params.itemId);
          if (index === -1) return null;
          const next = { ...target.items[index], ...normalizeItemInput(payload, { partial: true }), updatedAt: now() };
          target.items[index] = next;
          target.updatedAt = now();
          return { item: { ...next }, checklist: { ...target, progress: checklistProgress(target) } };
        });
        if (!result) return sendNotFound(res, `no item ${params.itemId} in checklist ${params.id}`);
        sendJson(res, 200, result);
      },
    },
    {
      method: 'DELETE',
      pattern: '/checklists/:id/items/:itemId',
      handle: async ({ res, params }) => {
        const result = await store.update((data) => {
          const target = findList(data, params.id);
          if (!target) return null;
          const index = target.items.findIndex((item) => item.id === params.itemId);
          if (index === -1) return null;
          target.items.splice(index, 1);
          target.updatedAt = now();
          return { checklist: { ...target, progress: checklistProgress(target) } };
        });
        if (!result) return sendNotFound(res, `no item ${params.itemId} in checklist ${params.id}`);
        sendJson(res, 200, { deleted: true, ...result });
      },
    },
    {
      method: 'POST',
      pattern: '/checklists/:id/items/:itemId/move',
      handle: async ({ res, params, readJson }) => {
        const payload = await readJson();
        const direction = payload?.direction === 'up' ? -1 : payload?.direction === 'down' ? 1 : null;
        if (direction === null) throw new RoomValidationError('direction must be "up" or "down"');
        const result = await store.update((data) => {
          const target = findList(data, params.id);
          if (!target) return null;
          const index = target.items.findIndex((item) => item.id === params.itemId);
          if (index === -1) return null;
          const targetIndex = index + direction;
          if (targetIndex < 0 || targetIndex >= target.items.length) {
            return { checklist: { ...target, progress: checklistProgress(target) }, moved: false };
          }
          const [moved] = target.items.splice(index, 1);
          target.items.splice(targetIndex, 0, moved);
          target.updatedAt = now();
          return { checklist: { ...target, progress: checklistProgress(target) }, moved: true };
        });
        if (!result) return sendNotFound(res, `no item ${params.itemId} in checklist ${params.id}`);
        sendJson(res, 200, result);
      },
    },
    {
      method: 'POST',
      pattern: '/checklists/:id/clear-completed',
      handle: async ({ res, params }) => {
        const result = await store.update((data) => {
          const target = findList(data, params.id);
          if (!target) return null;
          const before = target.items.length;
          target.items = target.items.filter((item) => !item.done);
          target.updatedAt = now();
          return { removed: before - target.items.length, checklist: { ...target, progress: checklistProgress(target) } };
        });
        if (!result) return sendNotFound(res, `no checklist with id ${params.id}`);
        sendJson(res, 200, result);
      },
    },
  ]);

  return { id: 'checklist', handle: (context) => route(context) };
}

/** Normalize a free-form note helper re-exported for tests. */
export const normalizeChecklistNote = (value) => normalizeText(String(value ?? ''));
