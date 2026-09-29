/**
 * UTOPIA · Knowledge Room (MECH-K0)
 * Durable local JSON store + deterministic search and tag filtering.
 *
 * Guarantees:
 * - schemaVersion is recorded on disk;
 * - writes go to a temporary file and are then renamed over the target, so a
 *   crash never leaves a half-written store;
 * - writes are serialized through a single promise chain (one process, one store);
 * - nothing outside the Knowledge Room runtime-data directory is ever read or written.
 */

import { readFile, rename, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  SCHEMA_VERSION,
  applyEntryUpdate,
  createEntry,
  normalizeQuery,
  normalizeTag,
  validateStoredEntry,
} from './model.mjs';

export const STORE_FILE_NAME = 'knowledge-v0.json';

/** Resolve the default runtime-data directory relative to this module. */
export function defaultDataDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'runtime-data');
}

/** Raised when the durable file is not a Knowledge Room store this build can read. */
export class StoreFormatError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StoreFormatError';
  }
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, entries: [] };
}

export class KnowledgeStore {
  /**
   * @param {{dataDir?: string, fileName?: string}} [options]
   */
  constructor(options = {}) {
    this.dataDir = options.dataDir ? resolve(options.dataDir) : defaultDataDir();
    this.filePath = join(this.dataDir, options.fileName ?? STORE_FILE_NAME);
    /** @type {{schemaVersion: number, entries: any[]}} */
    this.state = emptyState();
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  /** Read the durable file. Missing file is a valid empty store. */
  async load() {
    let text;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.state = emptyState();
        this.loaded = true;
        return this.state;
      }
      throw error;
    }
    if (!text.trim()) {
      this.state = emptyState();
      this.loaded = true;
      return this.state;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new StoreFormatError(`knowledge store is not valid JSON: ${error.message}`);
    }
    this.state = parseState(parsed);
    this.loaded = true;
    return this.state;
  }

  async ensureLoaded() {
    if (!this.loaded) await this.load();
  }

  /** Atomic write: temp file in the same directory, then rename over the target. */
  async persist() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = `${JSON.stringify(this.state, null, 2)}\n`;
    try {
      await writeFile(tempPath, payload, 'utf8');
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** Serialize a mutation so concurrent requests cannot interleave writes. */
  mutate(task) {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** @returns {any[]} a copy of all entries, newest updated first. */
  list() {
    return [...this.state.entries].sort(byUpdatedDesc);
  }

  get(id) {
    return this.state.entries.find((entry) => entry.id === id) ?? null;
  }

  count() {
    return this.state.entries.length;
  }

  async create(input) {
    return this.mutate(async () => {
      await this.ensureLoaded();
      const entry = createEntry(input);
      this.state.entries.push(entry);
      await this.persist();
      return entry;
    });
  }

  async update(id, input) {
    return this.mutate(async () => {
      await this.ensureLoaded();
      const index = this.state.entries.findIndex((entry) => entry.id === id);
      if (index === -1) return null;
      const updated = applyEntryUpdate(this.state.entries[index], input);
      this.state.entries[index] = updated;
      await this.persist();
      return updated;
    });
  }

  async delete(id) {
    return this.mutate(async () => {
      await this.ensureLoaded();
      const index = this.state.entries.findIndex((entry) => entry.id === id);
      if (index === -1) return false;
      this.state.entries.splice(index, 1);
      await this.persist();
      return true;
    });
  }

  /** Replace the entire store (used by IMPORT_MODE = REPLACE). */
  async replaceAll(entries) {
    return this.mutate(async () => {
      this.state = { schemaVersion: SCHEMA_VERSION, entries };
      this.loaded = true;
      await this.persist();
      return this.state.entries;
    });
  }

  /** Snapshot for export: a deep copy, safe to hand to the HTTP layer. */
  snapshot() {
    return {
      schemaVersion: SCHEMA_VERSION,
      entries: this.state.entries.map((entry) => ({ ...entry, tags: [...entry.tags] })),
    };
  }

  /**
   * Deterministic search across title, body and tags.
   * @param {{query?: string, tag?: string, tags?: string[]}} [options]
   */
  search(options = {}) {
    const query = normalizeQuery(options.query);
    const requested = [
      ...(options.tag ? [normalizeTag(options.tag)] : []),
      ...(Array.isArray(options.tags) ? options.tags.map(normalizeTag) : []),
    ].filter(Boolean);
    return this.list().filter((entry) => {
      if (requested.length > 0) {
        const own = new Set(entry.tags.map(normalizeTag));
        if (!requested.every((tag) => own.has(tag))) return false;
      }
      if (!query) return true;
      return (
        entry.title.toLowerCase().includes(query) ||
        entry.body.toLowerCase().includes(query) ||
        entry.tags.some((tag) => tag.toLowerCase().includes(query))
      );
    });
  }
}

function byUpdatedDesc(a, b) {
  if (a.updatedAt === b.updatedAt) return a.id < b.id ? 1 : -1;
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

/** Validate a parsed durable payload or import bundle body. */
export function parseState(parsed) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new StoreFormatError('knowledge store root must be a JSON object');
  }
  if (parsed.schemaVersion !== SCHEMA_VERSION) {
    throw new StoreFormatError(
      `unsupported schemaVersion ${JSON.stringify(parsed.schemaVersion)}; expected ${SCHEMA_VERSION}`,
    );
  }
  if (!Array.isArray(parsed.entries)) {
    throw new StoreFormatError('knowledge store entries must be an array');
  }
  const entries = parsed.entries.map((entry, index) => validateStoredEntry(entry, index));
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new StoreFormatError(`duplicate entry id ${entry.id}`);
    ids.add(entry.id);
  }
  return { schemaVersion: SCHEMA_VERSION, entries };
}

/** Create a store rooted at a data directory. */
export function createStore(options) {
  return new KnowledgeStore(options);
}
