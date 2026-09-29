/**
 * UTOPIA · Rooms · promotion records (MECH ROOM PACK §5.3).
 *
 * When an incubator room is promoted into city/<district>/<building>/<module>,
 * the live incubator implementation is removed from the final tree and a JSON
 * record is kept here. The record is the durable trace of what moved where, from
 * which donor commit, and at which room commit it was accepted.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Directory holding one JSON record per promoted room. */
export const PROMOTIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'promotions');

/** Promotion records must declare exactly this status. */
export const PROMOTION_STATUS = 'PROMOTED';

/** Incubation lifecycle values a promotion may appear alongside. */
export const PROMOTION_LIFECYCLES = ['PROMOTED'];

export class PromotionRecordError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PromotionRecordError';
  }
}

function requireString(value, field, file) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new PromotionRecordError(`${file}: ${field} must be a non-empty string`);
  }
  return value;
}

/** Validate one promotion record (parsed object) and return a normalized copy. */
export function normalizePromotionRecord(raw, file = 'promotion record') {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PromotionRecordError(`${file}: record root must be a JSON object`);
  }
  const roomId = requireString(raw.roomId, 'roomId', file);
  const targetCityPath = requireString(raw.targetCityPath, 'targetCityPath', file);
  if (!targetCityPath.startsWith('city/')) {
    throw new PromotionRecordError(`${file}: targetCityPath must live under city/`);
  }
  if (raw.status !== PROMOTION_STATUS) {
    throw new PromotionRecordError(`${file}: status must be ${PROMOTION_STATUS}`);
  }
  const acceptedRoomCommit = requireString(raw.acceptedRoomCommit, 'acceptedRoomCommit', file);
  const promotedAtCommit = requireString(raw.promotedAtCommit, 'promotedAtCommit', file);
  for (const [field, value] of [['acceptedRoomCommit', acceptedRoomCommit], ['promotedAtCommit', promotedAtCommit]]) {
    if (!/^[0-9a-f]{7,40}$/i.test(value)) {
      throw new PromotionRecordError(`${file}: ${field} must be a git commit SHA`);
    }
  }
  const donor = raw.donor ?? null;
  let normalizedDonor = null;
  if (donor !== null) {
    if (typeof donor !== 'object' || Array.isArray(donor)) {
      throw new PromotionRecordError(`${file}: donor must be an object or null`);
    }
    const repository = requireString(donor.repository, 'donor.repository', file);
    const commit = requireString(donor.commit, 'donor.commit', file);
    if (!/^[0-9a-f]{7,40}$/i.test(commit)) {
      throw new PromotionRecordError(`${file}: donor.commit must be a git commit SHA`);
    }
    const sourcePaths = Array.isArray(donor.sourcePaths) ? donor.sourcePaths.map(String) : [];
    normalizedDonor = { repository, commit, sourcePaths };
  }
  return {
    roomId,
    acceptedRoomCommit,
    promotedAtCommit,
    targetCityPath,
    donor: normalizedDonor,
    status: PROMOTION_STATUS,
  };
}

/** Load and validate every promotion record, sorted by roomId. */
export async function loadPromotionRecords(directory = PROMOTIONS_DIR) {
  let files;
  try {
    files = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const file of files.filter((name) => name.endsWith('.json')).sort()) {
    const text = await readFile(join(directory, file), 'utf8');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new PromotionRecordError(`${file}: not valid JSON (${error.message})`);
    }
    records.push({ file, ...normalizePromotionRecord(parsed, file) });
  }
  return records;
}

/**
 * Cross-check records against the room catalog:
 * - a promoted room must still be known in Git history;
 * - it must no longer serve a live surface, except while the promotion commit
 *   itself is still in flight (a room id listed in `inFlight`);
 * - the record's targetCityPath must match the manifest when the room declares one.
 *
 * @param {Array<object>} records
 * @param {Array<object>} allRooms
 * @param {Array<object>} activeRooms
 * @param {string[]} [inFlight] room ids allowed to stay active while their record lands
 */
export function crossCheckPromotions(records, allRooms, activeRooms, inFlight = []) {
  const problems = [];
  for (const record of records) {
    const known = allRooms.find((room) => room.id === record.roomId);
    if (!known) {
      problems.push(`${record.file}: roomId ${record.roomId} is not a known room`);
      continue;
    }
    const stillActive = activeRooms.some((room) => room.id === record.roomId);
    if (stillActive && !inFlight.includes(record.roomId)) {
      problems.push(`${record.file}: ${record.roomId} is still in the active catalog`);
    }
    if (!stillActive && known.lifecycle !== 'PROMOTED') {
      problems.push(`${record.file}: ${record.roomId} lifecycle is ${known.lifecycle}, expected PROMOTED`);
    }
    if (known.targetCityPath && known.targetCityPath !== record.targetCityPath) {
      problems.push(
        `${record.file}: targetCityPath ${record.targetCityPath} does not match the manifest ${known.targetCityPath}`,
      );
    }
  }
  return problems;
}
