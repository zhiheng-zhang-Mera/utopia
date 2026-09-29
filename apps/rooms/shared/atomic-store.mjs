/**
 * UTOPIA · Rooms — shared durable JSON store.
 *
 * One file per room, shape:
 *   { "schemaVersion": 1, "updatedAt": "...", "data": <room data> }
 *
 * Guarantees:
 * - writes go to a temporary file in the same directory and are renamed over the
 *   target, so an interrupted save can never leave a half-written room file;
 * - mutations are serialized through one promise chain per store, so concurrent
 *   requests cannot lose each other's changes;
 * - reads and writes stay inside the directory the store was created with.
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Durable schema version owned by the Room Pack. */
export const ROOM_SCHEMA_VERSION = 1;

/** Raised when a room file cannot be understood by this build. */
export class RoomStoreError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RoomStoreError';
  }
}

/** Default runtime directory: apps/rooms/.runtime-rooms */
export function defaultRuntimeDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '.runtime-rooms');
}

export class RoomStore {
  /**
   * @param {{runtimeDir?: string, fileName: string, initialData?: unknown}} options
   */
  constructor(options) {
    if (!options?.fileName) throw new RoomStoreError('a room store needs a fileName');
    this.runtimeDir = resolve(options.runtimeDir ?? defaultRuntimeDir());
    this.filePath = join(this.runtimeDir, options.fileName);
    // Always clone: two stores built from the same manifest default must never
    // share one live object, otherwise one room instance would mutate another's data.
    this.initialData = structuredClone(options.initialData ?? {});
    this.state = wrap(this.initialData, new Date().toISOString());
    this.loaded = false;
    this.writeQueue = Promise.resolve();
  }

  /** Read the room file. A missing file is a valid, empty room. */
  async load() {
    let text;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = wrap(structuredClone(this.initialData), new Date().toISOString());
      this.loaded = true;
      return this.state;
    }
    if (!text.trim()) {
      this.state = wrap(structuredClone(this.initialData), new Date().toISOString());
      this.loaded = true;
      return this.state;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new RoomStoreError(`${this.filePath} is not valid JSON: ${error.message}`);
    }
    this.state = unwrap(parsed, this.filePath);
    this.loaded = true;
    return this.state;
  }

  async ensureLoaded() {
    if (!this.loaded) await this.load();
    return this.state;
  }

  /** The room's own data (live object; treat as read-only outside mutations). */
  get data() {
    return this.state.data;
  }

  /** A structured clone safe to hand to HTTP responses. */
  snapshot() {
    return structuredClone(this.state.data);
  }

  /** Serialize a mutation and persist the result. */
  mutate(task) {
    const run = this.writeQueue.then(task, task);
    this.writeQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** Serialize a read that must observe a consistent state. */
  async read(task) {
    await this.ensureLoaded();
    return task(this.state.data);
  }

  /** Read-modify-write inside the write queue. */
  update(mutator) {
    return this.mutate(async () => {
      await this.ensureLoaded();
      const result = await mutator(this.state.data);
      this.state.updatedAt = new Date().toISOString();
      await this.persist();
      return result;
    });
  }

  /** Replace the whole data payload (used by import / replace flows). */
  replaceAll(data) {
    return this.mutate(async () => {
      this.state = wrap(data, new Date().toISOString());
      this.loaded = true;
      await this.persist();
      return this.snapshot();
    });
  }

  /** Wait for every queued write to settle. */
  async flushed() {
    await this.writeQueue;
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
}

function wrap(data, updatedAt) {
  return { schemaVersion: ROOM_SCHEMA_VERSION, updatedAt, data };
}

function unwrap(parsed, filePath) {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RoomStoreError(`${filePath} root must be a JSON object`);
  }
  if (parsed.schemaVersion !== ROOM_SCHEMA_VERSION) {
    throw new RoomStoreError(
      `${filePath} has unsupported schemaVersion ${JSON.stringify(parsed.schemaVersion)}; expected ${ROOM_SCHEMA_VERSION}`,
    );
  }
  return {
    schemaVersion: ROOM_SCHEMA_VERSION,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
    data: parsed.data === undefined ? {} : parsed.data,
  };
}

/** Create a store rooted at a runtime directory. */
export function createRoomStore(options) {
  return new RoomStore(options);
}
