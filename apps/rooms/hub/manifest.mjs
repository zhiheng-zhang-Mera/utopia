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

/**
 * Incubation lifecycle (MECH ROOM PACK §5.1).
 *
 * LOCAL_PRODUCT       — a finished local product room; never forced into city/
 * INCUBATING          — a donor room being proved inside the Room Pack
 * ACCEPTED_LOCAL      — the incubating room passed its own local acceptance
 * PROMOTION_CANDIDATE — accepted and queued for a city promotion
 * PROMOTED            — the live incubator implementation was removed and the
 *                       core now lives under city/<district>/<building>/<module>
 * REJECTED            — abandoned; kept only in Git history
 */
export const ROOM_LIFECYCLES = [
  'LOCAL_PRODUCT',
  'INCUBATING',
  'ACCEPTED_LOCAL',
  'PROMOTION_CANDIDATE',
  'PROMOTED',
  'REJECTED',
];

/** Lifecycles that no longer serve a live room surface. */
export const RETIRED_LIFECYCLES = ['PROMOTED', 'REJECTED'];

/** Default incubation metadata for a plain local product room. */
export function lifecycleDefaults(overrides = {}) {
  return {
    lifecycle: 'LOCAL_PRODUCT',
    targetCityPath: null,
    donorRepository: null,
    donorCommit: null,
    donorSourcePaths: [],
    ...overrides,
  };
}

function withLifecycle(room) {
  return { ...room, ...lifecycleDefaults(room) };
}

/** The ten original local product rooms. */
const LOCAL_ROOMS = [
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

/**
 * Donor incubator rooms (MECH ROOM PACK §8).
 *
 * A donor room starts as INCUBATING and only becomes part of the active catalog
 * once its local product surface really exists. A room that was promoted to city/
 * keeps its entry here with lifecycle PROMOTED: it no longer serves a surface and
 * is therefore dropped from the active catalog, while its donor provenance, its
 * Git history and its promotions/*.json record stay traceable.
 *
 * `skill-intake-lab` (D1) was promoted into
 * city/02-engineering/02-worker-gateway/skill-intake.
 */
const INCUBATOR_ROOMS = [
  {
    id:'theme-builder-lab',number:'D9',label:'Theme Builder Lab',zh:'主题构建实验室',
    summary:'Offline prompt, observed plan, sandbox package, preview and pixel validation.',
    dataFile:null,initialData:null,tags:['theme','donor'],lifecycle:'PROMOTION_CANDIDATE',
    targetCityPath:'city/11-entertainment/01-entertainment-centre/theme-engine',
    donorRepository:'zhiheng-zhang-Mera/DS-Hns',donorCommit:'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b',
    donorSourcePaths:['builder.js','designer.js','assets/planner.js','assets/generator.js','assets/processor.js','assets/validator.js','assets/fallback.js'].map(p=>'app/extensions/mega/theme/'+p),
  },
  {
    id: 'evidence-engine-lab',
    number: 'D8',
    label: 'Evidence Engine Lab',
    zh: '证据引擎实验室',
    summary: 'Promoted to city/06-research/01-research-institute/evidence-engine; no live surface here.',
    dataFile: null,
    initialData: null,
    tags: ['promoted', 'donor'],
    lifecycle: 'PROMOTED',
    targetCityPath: 'city/06-research/01-research-institute/evidence-engine',
    donorRepository: 'zhiheng-zhang-Mera/Codex-Boss',
    donorCommit: '8df428eaa437a409368401e95194e40266b83080',
    donorSourcePaths: ['electron/evidence-engine.ts'],
  },
  {
    id: 'document-readers-lab',
    number: 'D7b',
    label: 'Document Readers Lab',
    zh: '文档读取实验室',
    summary: 'Promoted to city/09-planning-knowledge/02-document-intake/document-readers; no live surface here.',
    dataFile: null,
    initialData: null,
    tags: ['promoted', 'donor'],
    lifecycle: 'PROMOTED',
    targetCityPath: 'city/09-planning-knowledge/02-document-intake/document-readers',
    donorRepository: 'zhiheng-zhang-Mera/Codex-Boss',
    donorCommit: '8df428eaa437a409368401e95194e40266b83080',
    donorSourcePaths: [
      'electron/ingestion/docx-reader.ts',
      'electron/ingestion/xlsx-reader.ts',
      'electron/ingestion/pdf-reader.ts',
    ],
  },
  {
    id: 'yaml-intake-lab',
    number: 'D7a',
    label: 'YAML Intake Lab',
    zh: 'YAML 接入实验室',
    summary: 'Promoted to city/09-planning-knowledge/02-document-intake/ingestion-core; no live surface here.',
    dataFile: null,
    initialData: null,
    tags: ['promoted', 'donor'],
    lifecycle: 'PROMOTED',
    targetCityPath: 'city/09-planning-knowledge/02-document-intake/ingestion-core',
    donorRepository: 'zhiheng-zhang-Mera/Codex-Boss',
    donorCommit: '8df428eaa437a409368401e95194e40266b83080',
    donorSourcePaths: ['electron/ingestion/text-parsers.ts'],
  },
  {
    id: 'theme-package-lab',
    number: 'D6',
    label: 'Theme Package Lab',
    zh: '主题包实验室',
    summary: 'Promoted to city/11-entertainment/01-entertainment-centre/theme-engine; no live surface here.',
    dataFile: null,
    initialData: null,
    tags: ['promoted', 'donor'],
    lifecycle: 'PROMOTED',
    targetCityPath: 'city/11-entertainment/01-entertainment-centre/theme-engine',
    donorRepository: 'zhiheng-zhang-Mera/DS-Hns',
    donorCommit: 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b',
    donorSourcePaths: [
      'app/extensions/mega/theme/contract.js',
      'app/extensions/mega/theme/surface.js',
      'app/extensions/mega/theme/validator.js',
      'app/extensions/mega/theme/asset-factory.js',
    ],
  },
  {
    id: 'skill-discovery-lab',
    number: 'D5',
    label: 'Skill Discovery Lab',
    zh: '技能发现实验室',
    summary: 'Promoted to city/02-engineering/02-worker-gateway/skill-intake; no live surface here.',
    dataFile: null,
    initialData: null,
    tags: ['promoted', 'donor'],
    lifecycle: 'PROMOTED',
    targetCityPath: 'city/02-engineering/02-worker-gateway/skill-intake',
    donorRepository: 'zhiheng-zhang-Mera/DS-Hns',
    donorCommit: 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b',
    donorSourcePaths: ['app/extensions/mega/skills/skill-source.js', 'app/extensions/mega/skills/skill-catalog.js'],
  },
  {
    id: 'document-intake-lab',
    number: 'D4',
    label: 'Document Intake Lab',
    zh: '文档接入实验室',
    summary: 'Promoted to city/09-planning-knowledge/02-document-intake/ingestion-core; no live surface here.',
    dataFile: null,
    initialData: null,
    tags: ['promoted', 'donor'],
    lifecycle: 'PROMOTED',
    targetCityPath: 'city/09-planning-knowledge/02-document-intake/ingestion-core',
    donorRepository: 'zhiheng-zhang-Mera/Codex-Boss',
    donorCommit: '8df428eaa437a409368401e95194e40266b83080',
    donorSourcePaths: ['electron/ingestion/xml-text.ts', 'electron/ingestion/text-parsers.ts'],
  },
  {
    id: 'knowledge-core-lab',
    number: 'D3',
    label: 'Knowledge Core Lab',
    zh: '知识内核实验室',
    summary: 'Promoted to city/09-planning-knowledge/01-knowledge-service/knowledge-core; no live surface here.',
    dataFile: null,
    initialData: null,
    tags: ['promoted', 'donor'],
    lifecycle: 'PROMOTED',
    targetCityPath: 'city/09-planning-knowledge/01-knowledge-service/knowledge-core',
    donorRepository: 'zhiheng-zhang-Mera/Codex-Boss',
    donorCommit: '8df428eaa437a409368401e95194e40266b83080',
    donorSourcePaths: ['src/shared/knowledge.ts'],
  },
  {
    id: 'theme-engine-lab',
    number: 'D2',
    label: 'Theme Engine Lab',
    zh: '主题引擎实验室',
    summary: 'Promoted to city/11-entertainment/01-entertainment-centre/theme-engine; no live surface here.',
    dataFile: null,
    initialData: null,
    tags: ['promoted', 'donor'],
    lifecycle: 'PROMOTED',
    targetCityPath: 'city/11-entertainment/01-entertainment-centre/theme-engine',
    donorRepository: 'zhiheng-zhang-Mera/DS-Hns',
    donorCommit: 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b',
    donorSourcePaths: [
      'app/extensions/mega/theme/color.js',
      'app/extensions/mega/theme/png.js',
    ],
  },
  {
    id: 'skill-intake-lab',
    number: 'D1',
    label: 'Skill Intake Lab',
    zh: '技能接入实验室',
    summary: 'Promoted to city/02-engineering/02-worker-gateway/skill-intake; no live surface here.',
    dataFile: null,
    initialData: null,
    tags: ['promoted', 'donor'],
    lifecycle: 'PROMOTED',
    targetCityPath: 'city/02-engineering/02-worker-gateway/skill-intake',
    donorRepository: 'zhiheng-zhang-Mera/DS-Hns',
    donorCommit: 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b',
    donorSourcePaths: [
      'app/extensions/mega/skills/skill-format.js',
      'app/extensions/mega/skills/tar.js',
    ],
  },
];

/** Every room the codebase knows about, active or retired. */
export const ALL_ROOMS = [...LOCAL_ROOMS, ...INCUBATOR_ROOMS].map(withLifecycle);

/** The active catalog: rooms that still serve a surface. */
export const ROOMS = ALL_ROOMS.filter((room) => !RETIRED_LIFECYCLES.includes(room.lifecycle));

/** Look up any known room definition by id. */
export function findRoom(id) {
  return ALL_ROOMS.find((room) => room.id === id) ?? null;
}

/** Look up an active room definition by id. */
export function findActiveRoom(id) {
  return ROOMS.find((room) => room.id === id) ?? null;
}

/** Rooms that own a durable file. */
export function persistentRooms() {
  return ROOMS.filter((room) => Boolean(room.dataFile));
}

/** Rooms still being incubated towards a city promotion. */
export function incubatingRooms() {
  return ROOMS.filter((room) => room.lifecycle !== 'LOCAL_PRODUCT');
}

/** Shape a room definition into the incubation metadata contract of §5.2. */
export function roomIncubationMetadata(room) {
  return {
    id: room.id,
    label: room.label,
    lifecycle: room.lifecycle,
    targetCityPath: room.targetCityPath,
    donorRepository: room.donorRepository,
    donorCommit: room.donorCommit,
    donorSourcePaths: [...room.donorSourcePaths],
  };
}
