/**
 * UTOPIA · Rooms — room registry.
 *
 * Wires the catalog to the room implementations: every room module exports a
 * `create<Name>Room({ store })` factory that returns `{ id, handle }`, where
 * `handle` serves the room's routes below /local-rooms/v1/<room-id>.
 */

import { RoomStore } from '../shared/atomic-store.mjs';
import { ROOMS } from './manifest.mjs';

const FACTORIES = {
  knowledge: { load: () => import('../rooms/knowledge/room.server.mjs'), name: 'createKnowledgeRoom' },
  bookmarks: { load: () => import('../rooms/bookmarks/room.server.mjs'), name: 'createBookmarkRoom' },
  checklist: { load: () => import('../rooms/checklist/room.server.mjs'), name: 'createChecklistRoom' },
  prompts: { load: () => import('../rooms/prompts/room.server.mjs'), name: 'createPromptRoom' },
  'text-workshop': { load: () => import('../rooms/text-workshop/room.server.mjs'), name: 'createTextWorkshopRoom' },
  hash: { load: () => import('../rooms/hash/room.server.mjs'), name: 'createHashRoom' },
  'data-lab': { load: () => import('../rooms/data-lab/room.server.mjs'), name: 'createDataLabRoom' },
  focus: { load: () => import('../rooms/focus/room.server.mjs'), name: 'createFocusRoom' },
  calendar: { load: () => import('../rooms/calendar/room.server.mjs'), name: 'createCalendarRoom' },
  decisions: { load: () => import('../rooms/decisions/room.server.mjs'), name: 'createDecisionRoom' },
  'skill-discovery-lab': { load: () => import('../rooms/skill-discovery-lab/room.server.mjs'), name: 'createSkillDiscoveryRoom' },
};

/**
 * Build every room: its store (when persistent) and its route handler.
 * @param {{runtimeDir?: string, only?: string[]}} [options]
 */
export async function createRoomRegistry(options = {}) {
  const definitions = options.only ? ROOMS.filter((room) => options.only.includes(room.id)) : ROOMS;
  const registry = [];
  for (const definition of definitions) {
    const factory = FACTORIES[definition.id];
    if (!factory) throw new Error(`no implementation registered for room ${definition.id}`);
    const module = await factory.load();
    const create = module[factory.name];
    if (typeof create !== 'function') {
      throw new Error(`room module for ${definition.id} does not export ${factory.name}`);
    }
    const store = definition.dataFile
      ? new RoomStore({
          runtimeDir: options.runtimeDir,
          fileName: definition.dataFile,
          initialData: definition.initialData,
        })
      : null;
    if (store) await store.ensureLoaded();
    registry.push({ definition, store, room: create({ store }) });
  }
  return registry;
}

/** Convenience: map of room id -> handler. */
export function indexRegistry(registry) {
  return new Map(registry.map((entry) => [entry.definition.id, entry]));
}
