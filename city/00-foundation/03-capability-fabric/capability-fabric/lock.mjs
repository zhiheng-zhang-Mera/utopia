/**
 * UTOPIA · City Service Network — composition lock and drift verification.
 *
 * The lock file pins *which* owners provide which capabilities, so a changed
 * composition is a reported fact rather than a silent surprise. It is
 * deliberately small: one shape, no options, and a strict parser that refuses
 * anything it does not understand instead of guessing.
 *
 * Three rules from the donor are load-bearing and are preserved exactly:
 *
 *  * **An absent lock is not drift.** With no lock file the installed set is the
 *    authority; reporting a missing pin as corruption would make the file
 *    mandatory by accident.
 *  * **An empty lock is refused.** A lock over nothing would silently permit
 *    anything, which is the opposite of a pin.
 *  * **Rendering is sorted**, so an unchanged composition produces a
 *    byte-identical file and the lock only changes when it must.
 *
 * Honest boundary, recorded in DONOR.json: the donor's "lockfile verification"
 * compares `id → version` strings only. It does **not** hash file contents —
 * there is no `node:crypto` import anywhere in the donor's lock module. Nothing
 * here invents a digest, because inventing verification the donor never had
 * would be a new capability rather than a migration.
 *
 * Donor provenance: DS-Hns `app/core/lockfile/index.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const LOCK_FILE = 'capability-fabric-lock.json';
export const LOCK_VERSION = 1;

export const LOCK_REASONS = Object.freeze({
  MISSING: 'FABRIC_LOCK_MISSING',
  INVALID: 'FABRIC_LOCK_INVALID',
  DRIFT: 'FABRIC_LOCK_DRIFT',
});

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Render a lock document.
 *
 * Entries are `{ capabilityId: { owner, version } }`; ids are sorted so an
 * unchanged composition cannot produce a changed file.
 */
export function renderLock(entries = {}) {
  const capabilities = Object.keys(entries).sort();
  const lines = ['{', `  "lockVersion": ${LOCK_VERSION},`, '  "capabilities": {'];
  capabilities.forEach((capabilityId, index) => {
    const entry = entries[capabilityId] ?? {};
    const owner = typeof entry.owner === 'string' ? entry.owner : '';
    const version = entry.version === undefined || entry.version === null ? '0.0.0' : String(entry.version);
    const comma = index === capabilities.length - 1 ? '' : ',';
    lines.push(`    ${JSON.stringify(capabilityId)}: { "owner": ${JSON.stringify(owner)}, "version": ${JSON.stringify(version)} }${comma}`);
  });
  lines.push('  }', '}');
  return `${lines.join('\n')}\n`;
}

/**
 * Parse a lock document.
 *
 * Every refusal names the offending capability so a human can act on it.
 */
export function parseLock(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return { ok: false, reason: `${LOCK_REASONS.INVALID}: the lock document is empty` };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `${LOCK_REASONS.INVALID}: the lock document is not valid JSON (${error.message})` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: `${LOCK_REASONS.INVALID}: the lock document must be an object` };
  }
  if (parsed.lockVersion !== LOCK_VERSION) {
    return { ok: false, reason: `${LOCK_REASONS.INVALID}: lockVersion must be ${LOCK_VERSION}` };
  }
  const capabilities = parsed.capabilities;
  if (capabilities === null || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    return { ok: false, reason: `${LOCK_REASONS.INVALID}: capabilities must be an object` };
  }
  const out = {};
  for (const capabilityId of Object.keys(capabilities)) {
    if (!ID_PATTERN.test(capabilityId)) {
      return { ok: false, reason: `${LOCK_REASONS.INVALID}: ${capabilityId} is not a capability id` };
    }
    const entry = capabilities[capabilityId];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { ok: false, reason: `${LOCK_REASONS.INVALID}: ${capabilityId} must be an object` };
    }
    if (typeof entry.owner !== 'string' || !entry.owner.trim()) {
      return { ok: false, reason: `${LOCK_REASONS.INVALID}: ${capabilityId} names no owner` };
    }
    if (entry.version !== undefined && typeof entry.version !== 'string') {
      return { ok: false, reason: `${LOCK_REASONS.INVALID}: ${capabilityId} version must be a string` };
    }
    out[capabilityId] = { owner: entry.owner, version: entry.version ?? '0.0.0' };
  }
  return { ok: true, capabilities: out, lockVersion: parsed.lockVersion };
}

/**
 * Compare a lock against the current composition.
 *
 * The comparison is an exact set diff over `owner` and `version`; no file
 * content, size, mtime or digest is read, because the donor read none.
 */
export function compareLock(lock, current = []) {
  const expected = lock && typeof lock === 'object' ? lock : {};
  const found = new Map();
  for (const provider of current) {
    if (!provider || typeof provider.capabilityId !== 'string') continue;
    found.set(provider.capabilityId, { owner: String(provider.owner ?? ''), version: String(provider.version ?? '0.0.0') });
  }
  const added = [];
  const removed = [];
  const changed = [];
  // `found` is a Map, so its keys must be spread: `Object.keys(map)` returns an
  // empty array and would report a clean comparison for any drift.
  for (const capabilityId of [...found.keys()].sort()) {
    if (!Object.hasOwn(expected, capabilityId)) {
      added.push({ capabilityId, found: found.get(capabilityId) });
      continue;
    }
    const want = expected[capabilityId];
    const have = found.get(capabilityId);
    if (want.owner !== have.owner || want.version !== have.version) {
      changed.push({ capabilityId, expected: want, found: have });
    }
  }
  for (const capabilityId of Object.keys(expected).sort()) {
    if (!found.has(capabilityId)) removed.push({ capabilityId, expected: expected[capabilityId], found: null });
  }
  const drift = added.length + removed.length + changed.length;
  const parts = [];
  if (added.length) parts.push(`${added.map((entry) => `${entry.capabilityId} (${entry.found.owner})`).join(', ')} added`);
  if (removed.length) parts.push(`${removed.map((entry) => `${entry.capabilityId} (${entry.expected.owner})`).join(', ')} missing`);
  if (changed.length) {
    parts.push(changed.map((entry) => `${entry.capabilityId} ${entry.expected.version} -> ${entry.found.version}`).join(', '));
  }
  return Object.freeze({
    ok: drift === 0,
    drift,
    added: Object.freeze(added.map(Object.freeze)),
    removed: Object.freeze(removed.map(Object.freeze)),
    changed: Object.freeze(changed.map(Object.freeze)),
    reason: drift === 0 ? 'the composition matches the lock' : parts.join('; '),
  });
}

/**
 * Verify the composition against a lock file on disk.
 *
 * @param {object} input
 * @param {string} input.root
 * @param {Array<object>} input.providers the live composition
 * @param {string} [input.file]
 * @param {boolean} [input.enforce] when true, drift is a refusal; when false it
 *   is a recorded fact. The donor defaulted to not enforcing, and so does this.
 */
export async function verifyLock({ root, providers = [], file, enforce = false }) {
  const path = file ?? join(resolve(root ?? '.'), LOCK_FILE);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return Object.freeze({ ok: true, locked: false, enforced: enforce, file: path, reason: 'no lock file is present, so the live composition is authoritative' });
    }
    return Object.freeze({ ok: false, code: LOCK_REASONS.INVALID, enforced: enforce, file: path, reason: `${LOCK_REASONS.INVALID}: the lock file could not be read (${error.message})` });
  }
  const parsed = parseLock(text);
  if (parsed.ok !== true) {
    return Object.freeze({ ok: false, code: LOCK_REASONS.INVALID, enforced: enforce, file: path, reason: parsed.reason });
  }
  const comparison = compareLock(parsed.capabilities, providers);
  if (comparison.ok) {
    return Object.freeze({ ok: true, locked: true, enforced: enforce, file: path, capabilities: Object.keys(parsed.capabilities).length, reason: comparison.reason });
  }
  return Object.freeze({
    ok: enforce ? false : true,
    locked: true,
    enforced: enforce,
    drifted: true,
    code: LOCK_REASONS.DRIFT,
    file: path,
    drift: comparison.drift,
    added: comparison.added,
    removed: comparison.removed,
    changed: comparison.changed,
    reason: `${LOCK_REASONS.DRIFT}: ${comparison.reason}`,
  });
}

/**
 * Write a lock document.
 *
 * An empty composition is refused for the donor's reason: a lock over nothing
 * would silently allow anything.
 */
export async function writeLock({ root, providers = [], file }) {
  const entries = {};
  for (const provider of providers) {
    if (!provider || typeof provider.capabilityId !== 'string') continue;
    entries[provider.capabilityId] = { owner: String(provider.owner ?? ''), version: provider.version === undefined || provider.version === null ? '0.0.0' : String(provider.version) };
  }
  if (Object.keys(entries).length === 0) {
    return Object.freeze({ ok: false, reason: 'refusing to write an empty lock: a lock over nothing would silently allow anything' });
  }
  const path = file ?? join(resolve(root ?? '.'), LOCK_FILE);
  await mkdir(dirname(path), { recursive: true });
  const text = renderLock(entries);
  await writeFile(path, text, 'utf8');
  return Object.freeze({ ok: true, file: path, capabilities: Object.keys(entries).length, text });
}
