/**
 * UTOPIA · Rooms — the room catalog.
 *
 * One entry per room: identity, persistence and the hub's navigation metadata.
 * The order here (and in the hub UI) follows the construction order defined by
 * the Room Pack design: persistence rooms first, then the stateless tools, then
 * the time-based rooms, then Decision last.
 */

export const ROOM_API_BASE = '/local-rooms/v1';
export const ROOM_ASSET_BASE = '/rooms';

/** @type {Array<{id: string, number: string, label: string, zh: string, summary: string, dataFile: string|null, initialData: unknown, tags: string[]}>} */
export const ROOMS = [
  {
    id: 'knowledge',
    number: '01',
    label: 'Knowledge Room',
    zh: '本地知识室',
    summary: 'Plain-text knowledge entries with search, tags and replace import.',
    dataFile: 'knowledge.json',
    initialData: { entries: [] },
    tags: ['notes', 'search'],
  },
  {
    id: 'bookmarks',
    number: '02',
    label: 'Bookmark Room',
    zh: '收藏室',
    summary: 'Local URL collection with tags, notes and explicit open only.',
    dataFile: 'bookmarks.json',
    initialData: { bookmarks: [] },
    tags: ['links', 'search'],
  },
  {
    id: 'checklist',
    number: '03',
    label: 'Checklist Room',
    zh: '清单室',
    summary: 'Checklists and items with toggle, reorder and clear completed.',
    dataFile: 'checklist.json',
    initialData: { checklists: [] },
    tags: ['lists'],
  },
  {
    id: 'prompts',
    number: '04',
    label: 'Prompt Library',
    zh: '提示词库',
    summary: 'Reusable prompt templates with {{variable}} detection and fill-in.',
    dataFile: 'prompts.json',
    initialData: { prompts: [] },
    tags: ['templates'],
  },
  {
    id: 'text-workshop',
    number: '05',
    label: 'Text Workshop',
    zh: '文本工坊',
    summary: 'Counts, cleanup, sorting, dedupe, case changes and a line diff. No storage.',
    dataFile: null,
    initialData: null,
    tags: ['tools'],
  },
  {
    id: 'hash',
    number: '06',
    label: 'Hash Room',
    zh: '哈希室',
    summary: 'SHA-256 of a local file with size, name and expected-value comparison.',
    dataFile: null,
    initialData: null,
    tags: ['tools'],
  },
  {
    id: 'data-lab',
    number: '07',
    label: 'Data Lab',
    zh: '数据实验室',
    summary: 'JSON parse / pretty / minify / validate and a light CSV preview. No storage.',
    dataFile: null,
    initialData: null,
    tags: ['tools'],
  },
  {
    id: 'focus',
    number: '08',
    label: 'Focus Room',
    zh: '专注室',
    summary: 'Countdown timer with presets, pause/resume, session history and today total.',
    dataFile: 'focus.json',
    initialData: { sessions: [], active: null },
    tags: ['time'],
  },
  {
    id: 'calendar',
    number: '09',
    label: 'Calendar Room',
    zh: '日程室',
    summary: 'Local events with date, times, label and notes; today and upcoming views.',
    dataFile: 'calendar.json',
    initialData: { events: [] },
    tags: ['time', 'search'],
  },
  {
    id: 'decisions',
    number: '10',
    label: 'Decision Room',
    zh: '决策室',
    summary: 'Decision records with options, rationale and OPEN / DECIDED / REVISIT status.',
    dataFile: 'decisions.json',
    initialData: { decisions: [] },
    tags: ['records', 'search'],
  },
];

/** Look up a room definition by id. */
export function findRoom(id) {
  return ROOMS.find((room) => room.id === id) ?? null;
}

/** Rooms that own a durable file. */
export function persistentRooms() {
  return ROOMS.filter((room) => Boolean(room.dataFile));
}
