/**
 * UTOPIA · City · Project Foreman — the versioned, replay-safe recovery contract.
 *
 * A recovery descriptor is the whole of what a killed episode left behind: the
 * original request (workspace, goal, absolute deadline), the *complete* serialized
 * plan, a digest over that plan, the cursor that says how far the plan may be
 * trusted, the repository fingerprint, the mutations that were and were not
 * resolved, the off-volume scratch the episode registered, and the lifecycle state
 * the episode reached. Nothing here is learned: every rule is a gate, and every
 * gate is a refusal code rather than a repair.
 *
 * Two properties are enforced, not documented:
 *
 *  * **The plan is the plan.** The digest covers the whole embedded plan in a
 *    canonical form (keys sorted, `undefined` and functions dropped), so an edit
 *    that survived on disk cannot be replayed as if it had been authorized.
 *  * **The cursor is contiguous.** `nextStepIndex` may only sit after a prefix of
 *    steps that are each verified or *intentionally* skipped, and only optional
 *    steps may be restored as skipped. A cursor that jumps over unverified work is
 *    `CURSOR_UNVERIFIED`, never silently clamped.
 *
 * Donor provenance: DS-Hns `app/engineering/recovery-schema.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b, ported from CommonJS to ESM. Every
 * constant, regex, refusal code and refusal message is the donor's, byte-for-byte;
 * the only changes are `require` → `import` and `module.exports` → `export`.
 *
 * @module project-foreman/recovery-schema
 */

import crypto from 'node:crypto';
import path from 'node:path';

/** The descriptor format's version: a reader that does not know it must refuse. */
export const RECOVERY_DESCRIPTOR_VERSION = 1;
/** The plan format's version the descriptor embeds. */
export const RECOVERY_PLAN_VERSION = 1;
/** The executor generation a saved episode is replayable by. */
export const EXECUTOR_COMPATIBILITY = 'engineering-v1';
/** The lifecycle states a recovery descriptor may be in. */
export const RECOVERY_STATES = Object.freeze(['ACTIVE', 'RECOVERY_BLOCKED', 'COMPLETED', 'CANCELLED']);
/** The kinds of off-volume object an episode may register. */
const CROSS_VOLUME_TYPES = new Set(['file', 'directory']);
/** The purpose classes an off-volume registration may declare. */
const CROSS_VOLUME_PURPOSES = new Set(['clone', 'copy', 'unpack', 'build', 'cache', 'test', 'log', 'download', 'tool-scratch', 'other']);
/** The cleanup states an off-volume registration may be in. */
const CROSS_VOLUME_CLEANUP_STATES = new Set(['ACTIVE', 'DELETE_PENDING', 'DELETED', 'CLEANUP_BLOCKED']);
/** A plan step identifier: bounded, and never confusable with a path. */
const STEP_ID = /^[A-Za-z0-9][A-Za-z0-9:._#-]{0,255}$/;
/** The longest episode identifier a descriptor may carry. */
const EPISODE_ID_MAX = 512;

function isRecord(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value));
}

function canonicalPathKey(value) {
  const pathApi = path.win32.isAbsolute(value) ? path.win32 : path;
  const resolved = pathApi.normalize(value);
  return pathApi === path.win32 ? resolved.toLowerCase() : resolved;
}

function volumeKey(value) {
  const pathApi = path.win32.isAbsolute(value) ? path.win32 : path;
  return pathApi.parse(pathApi.resolve(value)).root.toLowerCase();
}

function validCrossVolumeEntry(entry, episodeId, workRoot) {
  if (!isRecord(entry) || entry.episodeId !== episodeId || !isAbsolutePath(entry.path) ||
    !isAbsolutePath(entry.canonicalPath) || canonicalPathKey(entry.path) !== canonicalPathKey(entry.canonicalPath) ||
    !isAbsolutePath(entry.workRoot) || canonicalPathKey(entry.workRoot) !== canonicalPathKey(workRoot) ||
    typeof entry.workRootIdentity !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(entry.workRootIdentity) ||
    !CROSS_VOLUME_TYPES.has(entry.type) || !CROSS_VOLUME_PURPOSES.has(entry.purposeClass) || entry.createdByEpisode !== true ||
    !Number.isFinite(entry.registeredAt) || entry.registeredAt < 0 || !CROSS_VOLUME_CLEANUP_STATES.has(entry.cleanupState) ||
    volumeKey(entry.path) === volumeKey(workRoot)) return false;
  if (entry.type === 'directory') {
    const pathApi = path.win32.isAbsolute(entry.path) ? path.win32 : path;
    if (!isAbsolutePath(entry.markerPath) || canonicalPathKey(entry.markerPath) !== canonicalPathKey(pathApi.join(entry.canonicalPath, '.dshns-episode-owner.json'))) return false;
  } else if (!/^sha256:[a-f0-9]{64}$/.test(entry.contentDigest || '') || entry.markerPath !== undefined) {
    return false;
  }
  for (const field of ['cleanupError', 'cleanupReason']) {
    if (entry[field] !== undefined && entry[field] !== null && typeof entry[field] !== 'string') return false;
  }
  return true;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined && typeof value[key] !== 'function') output[key] = canonicalize(value[key]);
  }
  return output;
}

/**
 * The digest that binds a descriptor to the exact plan it was authorized with.
 *
 * @param {object} plan the complete serialized plan
 * @returns {string} `sha256:<64 hex>` over the canonical form of the plan
 */
export function computePlanDigest(plan) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(canonicalize(plan)), 'utf8').digest('hex')}`;
}

function fail(code, reason) {
  return { ok: false, code, reason };
}

function uniqueKnownIds(value, stepIds, label) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !stepIds.has(id))) {
    return { ok: false, reason: `${label} must contain only known step identifiers` };
  }
  if (new Set(value).size !== value.length) return { ok: false, reason: `${label} must not contain duplicate identifiers` };
  return { ok: true, values: value };
}

/**
 * Validate one recovery descriptor against the whole replay-safety contract.
 *
 * @param {object} input the descriptor as read back from a checkpoint
 * @param {object} [options]
 * @param {string} [options.episodeId] the episode the enclosing checkpoint names
 * @param {string} [options.executorCompatibility] the executor this run is
 * @returns {{ok:boolean, descriptor?:object, code?:string, reason?:string}}
 */
export function validateRecoveryDescriptor(input, options = {}) {
  if (!isRecord(input)) return fail('RECOVERY_DESCRIPTOR_INVALID', 'the recovery descriptor must be an object');
  if (input.version !== RECOVERY_DESCRIPTOR_VERSION) {
    return fail('RECOVERY_VERSION_UNSUPPORTED', `recovery descriptor version ${String(input.version)} is not supported`);
  }
  if (typeof input.episodeId !== 'string' || !input.episodeId.trim() || input.episodeId.length > EPISODE_ID_MAX) {
    return fail('EPISODE_ID_INVALID', 'the recovery descriptor needs a bounded episode id');
  }
  if (options.episodeId !== undefined && input.episodeId !== String(options.episodeId)) {
    return fail('EPISODE_ID_MISMATCH', 'the recovery descriptor episode id does not match its checkpoint');
  }

  const request = input.request;
  if (!isRecord(request) || !isAbsolutePath(request.workspace) || typeof request.goal !== 'string' || !request.goal.trim() ||
    !isRecord(request.contract)) {
    return fail('REQUEST_INVALID', 'the original request must contain an absolute workspace, goal, time budget, and object contract');
  }
  if (!Number.isFinite(request.startedAt) || !Number.isFinite(request.deadlineAt) || request.deadlineAt <= request.startedAt) {
    return fail('REQUEST_DEADLINE_INVALID', 'the original absolute deadline must be after the original start time');
  }

  const plan = input.plan;
  if (!isRecord(plan) || plan.version !== RECOVERY_PLAN_VERSION) {
    return fail('PLAN_VERSION_UNSUPPORTED', `plan version ${String(plan && plan.version)} is not supported`);
  }
  if (typeof plan.id !== 'string' || !plan.id || typeof plan.goal !== 'string' ||
    typeof plan.intent !== 'string' || !Number.isFinite(plan.createdAt) || !Array.isArray(plan.steps) ||
    plan.steps.length > 1000 || !isRecord(plan.budget) || !Number.isInteger(plan.budget.maxSteps) ||
    plan.budget.maxSteps < plan.steps.length || !Array.isArray(plan.reasons) || plan.reasons.some((reason) => typeof reason !== 'string')) {
    return fail('PLAN_INVALID', 'the serialized plan is incomplete or outside the supported bounds');
  }
  if (plan.goal !== request.goal) return fail('PLAN_GOAL_MISMATCH', 'the serialized plan goal does not match the original request');
  const stepIds = new Set();
  for (const step of plan.steps) {
    if (!isRecord(step) || typeof step.id !== 'string' || !STEP_ID.test(step.id) || stepIds.has(step.id) ||
      typeof step.kind !== 'string' || (step.args !== undefined && (!Array.isArray(step.args) || step.args.some((arg) => typeof arg !== 'string')))) {
      return fail('PLAN_STEP_INVALID', 'every plan step must have a unique id, kind, and serializable argument list');
    }
    stepIds.add(step.id);
  }
  if (typeof input.planDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(input.planDigest) || computePlanDigest(plan) !== input.planDigest) {
    return fail('PLAN_DIGEST_MISMATCH', 'the saved plan digest does not match the complete embedded plan');
  }

  const cursor = input.cursor;
  if (!isRecord(cursor) || !Number.isInteger(cursor.nextStepIndex) || cursor.nextStepIndex < 0 || cursor.nextStepIndex > plan.steps.length ||
    !Number.isSafeInteger(cursor.checkpointSeq) || cursor.checkpointSeq < 1) {
    return fail('CURSOR_INVALID', 'the recovery cursor needs a bounded next-step index and positive checkpoint sequence');
  }
  const verified = uniqueKnownIds(cursor.verifiedStepIds, stepIds, 'verifiedStepIds');
  if (!verified.ok) return fail('CURSOR_INVALID', verified.reason);
  const skipped = uniqueKnownIds(cursor.skippedStepIds, stepIds, 'skippedStepIds');
  if (!skipped.ok) return fail('CURSOR_INVALID', skipped.reason);
  const verifiedIds = new Set(verified.values);
  const skippedIds = new Set(skipped.values);
  if ([...verifiedIds].some((id) => skippedIds.has(id))) return fail('CURSOR_INVALID', 'a step cannot be both verified and skipped');
  if ([...skippedIds].some((id) => plan.steps.find((step) => step.id === id).optional !== true)) {
    return fail('CURSOR_INVALID', 'only optional plan steps may be restored as skipped');
  }
  let safeNext = 0;
  while (safeNext < plan.steps.length) {
    const id = plan.steps[safeNext].id;
    if (!verifiedIds.has(id) && !skippedIds.has(id)) break;
    safeNext += 1;
  }
  if (cursor.nextStepIndex !== safeNext) return fail('CURSOR_UNVERIFIED', 'the cursor moves beyond the contiguous verified or intentionally skipped prefix');
  const lastVerified = cursor.lastVerifiedStepId;
  const expectedLastVerified = plan.steps.slice(0, safeNext).map((step) => step.id).reverse().find((id) => verifiedIds.has(id)) || null;
  if (lastVerified !== expectedLastVerified) {
    return fail('CURSOR_INVALID', 'lastVerifiedStepId must name a verified step before the next-step cursor');
  }

  if (input.fingerprint !== null && input.fingerprint !== undefined && !isRecord(input.fingerprint)) {
    return fail('FINGERPRINT_INVALID', 'the repository fingerprint must be an object when supplied');
  }
  for (const field of ['verifiedMutationIds', 'unresolvedMutationIds']) {
    if (!Array.isArray(input[field]) || input[field].some((id) => typeof id !== 'string' || !id)) {
      return fail('MUTATION_IDS_INVALID', `${field} must be an array of non-empty mutation identifiers`);
    }
    if (new Set(input[field]).size !== input[field].length) return fail('MUTATION_IDS_INVALID', `${field} must not contain duplicate identifiers`);
  }
  if (input.verifiedMutationIds.some((id) => input.unresolvedMutationIds.includes(id))) {
    return fail('MUTATION_IDS_INVALID', 'a mutation cannot be both verified and unresolved');
  }
  if (typeof input.executorCompatibility !== 'string' || !input.executorCompatibility.trim()) {
    return fail('EXECUTOR_COMPATIBILITY_INVALID', 'an explicit executor compatibility version is required');
  }
  if (options.executorCompatibility && input.executorCompatibility !== options.executorCompatibility) {
    return fail('EXECUTOR_COMPATIBILITY_MISMATCH', 'the saved episode belongs to a different executor compatibility version');
  }
  if (!isAbsolutePath(input.workRoot)) return fail('WORK_ROOT_INVALID', 'the selected work root must be an absolute path');
  if (!Array.isArray(input.crossVolumeTemp)) return fail('CROSS_VOLUME_REGISTRY_INVALID', 'crossVolumeTemp must be an array');
  if (input.crossVolumeTemp.length > 1000) return fail('CROSS_VOLUME_REGISTRY_INVALID', 'crossVolumeTemp exceeds the supported entry limit');
  const registeredPaths = new Set();
  for (const entry of input.crossVolumeTemp) {
    if (!validCrossVolumeEntry(entry, input.episodeId, input.workRoot)) {
      return fail('CROSS_VOLUME_REGISTRY_INVALID', 'a cross-volume registration is incomplete, mismatched, or unsafe');
    }
    const key = canonicalPathKey(entry.path);
    if (registeredPaths.has(key)) return fail('CROSS_VOLUME_REGISTRY_INVALID', 'crossVolumeTemp must not register the same canonical path twice');
    registeredPaths.add(key);
  }
  if (input.cleanupTerminalState !== undefined &&
    (!['COMPLETED', 'CANCELLED'].includes(input.cleanupTerminalState) || !['ACTIVE', 'RECOVERY_BLOCKED'].includes(input.lifecycleState))) {
    return fail('CLEANUP_TERMINAL_STATE_INVALID', 'a pending cleanup terminal state must be COMPLETED or CANCELLED on an active or cleanup-blocked episode');
  }
  if (!RECOVERY_STATES.includes(input.lifecycleState === undefined ? 'ACTIVE' : input.lifecycleState)) {
    return fail('LIFECYCLE_STATE_UNSUPPORTED', `lifecycle state ${String(input.lifecycleState)} is not supported`);
  }
  if (input.lifecycleState === 'RECOVERY_BLOCKED' && input.blockedReason !== undefined && typeof input.blockedReason !== 'string') {
    return fail('BLOCKED_REASON_INVALID', 'blockedReason must be text when supplied');
  }
  if (input.repairAuthorized !== undefined && typeof input.repairAuthorized !== 'boolean') {
    return fail('REPAIR_AUTHORIZATION_INVALID', 'repairAuthorized must be a boolean when supplied');
  }

  const descriptor = JSON.parse(JSON.stringify(input));
  if (descriptor.lifecycleState === undefined) descriptor.lifecycleState = 'ACTIVE';
  return { ok: true, descriptor };
}
