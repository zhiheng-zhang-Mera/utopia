/**
 * UTOPIA · Knowledge Room (MECH-K0)
 * Export / import of the complete local knowledge bundle.
 *
 * V0 policy is fixed: IMPORT_MODE = REPLACE.
 * The whole bundle replaces the current Knowledge Room data — there is no merge,
 * no conflict resolution and no partial import. If the payload does not validate
 * completely, nothing is written.
 */

import { createHash } from 'node:crypto';
import { BUNDLE_FORMAT, SCHEMA_VERSION, ValidationError, validateStoredEntry } from './model.mjs';

/** The one and only import strategy in V0. */
export const IMPORT_MODE = 'replace';

/** Build an export bundle from a store snapshot. */
export function buildBundle(snapshot, exportedAt = new Date().toISOString()) {
  return {
    format: BUNDLE_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt,
    entries: snapshot.entries.map((entry) => ({
      id: entry.id,
      title: entry.title,
      body: entry.body,
      tags: [...entry.tags],
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })),
  };
}

/** Serialize a bundle the way the export endpoint and the UI download it. */
export function serializeBundle(bundle) {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** SHA-256 of the exact exported bytes — recorded as acceptance evidence. */
export function bundleSha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Validate an import payload and return the entries to store.
 * Rejects: wrong format, wrong schemaVersion, non-array entries, malformed entries.
 * @param {unknown} payload parsed JSON (object or raw JSON string)
 * @returns {Promise<{entries: any[], exportedAt: string|null}>}
 */
export async function parseImportBundle(payload) {
  let bundle = payload;
  if (typeof payload === 'string') {
    try {
      bundle = JSON.parse(payload);
    } catch (error) {
      throw new ValidationError(`import payload is not valid JSON: ${error.message}`);
    }
  }
  if (bundle === null || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new ValidationError('import payload must be a JSON object');
  }
  if (bundle.format !== BUNDLE_FORMAT) {
    throw new ValidationError(
      `import payload format must be "${BUNDLE_FORMAT}" (received ${JSON.stringify(bundle.format)})`,
    );
  }
  if (bundle.schemaVersion !== SCHEMA_VERSION) {
    throw new ValidationError(
      `import payload schemaVersion must be ${SCHEMA_VERSION} (received ${JSON.stringify(bundle.schemaVersion)})`,
    );
  }
  if (!Array.isArray(bundle.entries)) {
    throw new ValidationError('import payload entries must be an array');
  }
  const entries = bundle.entries.map((entry, index) => validateStoredEntry(entry, index));
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new ValidationError(`import payload has duplicate entry id ${entry.id}`);
    ids.add(entry.id);
  }
  return {
    entries,
    exportedAt: typeof bundle.exportedAt === 'string' ? bundle.exportedAt : null,
  };
}

/**
 * Semantically compare two bundles: identical entry ids, titles, bodies, tags and
 * timestamps, in the same order-independent set. `exportedAt` is deliberately ignored.
 */
export function bundlesAreEquivalent(a, b) {
  const key = (bundle) =>
    bundle.entries
      .map((entry) =>
        JSON.stringify([entry.id, entry.title, entry.body, [...entry.tags].sort(), entry.createdAt, entry.updatedAt]),
      )
      .sort();
  const left = key(a);
  const right = key(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
