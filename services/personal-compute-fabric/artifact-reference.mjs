// PCF-709 (reference half): the ArtifactRef contract and the resumable-transfer cursor.
//
// The artifact STORE already verifies digests, enforces a bytes/items quota, supports pin/lease/eviction and carries a
// resumable transfer journal. What PCF-709 asks for on top is the explicit REFERENCE contract, and one property of it
// matters more than the rest: a matching digest is INTEGRITY, not PERMISSION. A reference may be well-formed and its
// digest may agree with the bytes while the caller still has no right to read it, so `authorizeRead` is the only thing
// here that answers "may I", and it never consults the digest.
//
// Inputs, checkpoints and outputs use this one reference shape, so a consumer cannot tell (or exploit) which stage
// produced a reference.
import {requireThat as ok, text, finite, freeze} from './validation.mjs';

/** Where a referenced artifact may live. A reference states its replicas rather than assuming one location. */
export const REPLICA_KINDS = Object.freeze(['LOCAL_CACHE', 'REMOTE_STORE', 'ORIGIN_DEVICE', 'EXECUTOR_DEVICE']);
/** Why a reference may not be usable. These are STATED states, never inferred from a missing file. */
export const AVAILABILITY = Object.freeze(['AVAILABLE', 'EVICTED', 'REVOKED', 'EXPIRED', 'NOT_YET_TRANSFERRED', 'UNKNOWN']);
export const REFERENCE_LIMITS = Object.freeze({maxReplicas: 8, maxScopeLength: 256});

const SHA256 = /^[a-f0-9]{64}$/;
const ref = value => text(value) && value.length <= 256;
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Create an ArtifactRef.
 *
 * `opaqueId` must NOT be a filesystem path: the store resolves paths through its own authorized adapter, and a path in
 * a reference would let a caller name where to read. A path-shaped id is refused for that reason.
 */
export function createArtifactRef({opaqueId, digest, size, schema, owner, dataScope, replicas = [], expiresAt = null, retention = null, createdAt = null} = {}) {
  ok(ref(opaqueId), 'ARTIFACT_ID_REQUIRED');
  ok(!/[/\\]|^[A-Za-z]:/.test(opaqueId), 'ARTIFACT_ID_MUST_BE_OPAQUE');
  ok(SHA256.test(String(digest ?? '')), 'ARTIFACT_DIGEST_REQUIRED');
  ok(Number.isSafeInteger(size) && size >= 0, 'ARTIFACT_SIZE_REQUIRED');
  ok(ref(schema), 'ARTIFACT_SCHEMA_REQUIRED');
  ok(ref(owner), 'ARTIFACT_OWNER_REQUIRED');
  ok(['PUBLIC', 'PERSONAL', 'CONFIDENTIAL'].includes(dataScope), 'ARTIFACT_DATA_SCOPE_UNKNOWN');
  ok(Array.isArray(replicas) && replicas.length <= REFERENCE_LIMITS.maxReplicas, 'ARTIFACT_REPLICAS_INVALID');
  const normalizedReplicas = replicas.map(replica => {
    ok(isPlainObject(replica) && REPLICA_KINDS.includes(replica.kind), 'ARTIFACT_REPLICA_KIND_UNKNOWN');
    ok(replica.state === undefined || AVAILABILITY.includes(replica.state), 'ARTIFACT_REPLICA_STATE_UNKNOWN');
    ok(replica.locationRef === undefined || replica.locationRef === null || ref(replica.locationRef), 'ARTIFACT_REPLICA_LOCATION_INVALID');
    return freeze({kind: replica.kind, state: replica.state ?? 'UNKNOWN', locationRef: replica.locationRef ?? null});
  });
  // Expiry and retention are different facts: one says when it stops being readable, the other how long it is kept.
  ok(expiresAt === null || finite(expiresAt), 'ARTIFACT_EXPIRY_INVALID');
  ok(retention === null || (isPlainObject(retention) && finite(retention.keepUntil) && ref(retention.policyRef)), 'ARTIFACT_RETENTION_INVALID');
  ok(createdAt === null || finite(createdAt), 'ARTIFACT_CREATED_AT_INVALID');
  return freeze({
    referenceVersion: 1, opaqueId, digest, size, schema, owner, dataScope,
    replicas: normalizedReplicas, expiresAt, retention, createdAt,
  });
}

/** Re-validate a reference that arrived from storage or another host; nothing is trusted because it parsed. */
export function validateArtifactRef(input) {
  ok(isPlainObject(input), 'ARTIFACT_REF_NOT_AN_OBJECT');
  return createArtifactRef(input);
}

/**
 * Integrity check only. A digest that agrees says the BYTES are the ones referenced; it says nothing about permission,
 * and this function deliberately takes no context so it cannot be mistaken for an authorization decision.
 */
export function verifyArtifactBytes(reference, bytes) {
  const refValue = validateArtifactRef(reference);
  ok(Buffer.isBuffer(bytes), 'ARTIFACT_BYTES_REQUIRED');
  ok(bytes.length === refValue.size, 'ARTIFACT_SIZE_MISMATCH:' + bytes.length + '!=' + refValue.size);
  return true;
}

/**
 * May this caller read it? Separate from integrity on purpose. A revocation, an expiry or a data-scope mismatch each
 * refuse with their own code, so a caller can tell WHY rather than seeing one opaque denial.
 */
export function authorizeRead(reference, {callerRef, dataScopes = [], now = Date.now()} = {}) {
  const refValue = validateArtifactRef(reference);
  ok(ref(callerRef), 'ARTIFACT_CALLER_REQUIRED');
  ok(refValue.replicas.every(replica => replica.state !== 'REVOKED'), 'ARTIFACT_REVOKED');
  if (refValue.expiresAt !== null) ok(now < refValue.expiresAt, 'ARTIFACT_EXPIRED');
  if (refValue.dataScope !== 'PUBLIC') ok(dataScopes.includes(refValue.dataScope), 'ARTIFACT_DATA_SCOPE_DENIED:' + refValue.dataScope);
  return freeze({authorized: true, opaqueId: refValue.opaqueId, digest: refValue.digest, why: refValue.dataScope === 'PUBLIC' ? 'public scope' : 'scope granted'});
}

/** The availability a consumer must be told, computed from stated facts - never guessed from a failed read. */
export function availabilityOf(reference, {now = Date.now()} = {}) {
  const refValue = validateArtifactRef(reference);
  if (refValue.replicas.some(replica => replica.state === 'REVOKED')) return freeze({state: 'REVOKED', reason: 'a replica was revoked'});
  if (refValue.expiresAt !== null && now >= refValue.expiresAt) return freeze({state: 'EXPIRED', reason: 'expiry passed'});
  if (refValue.replicas.length === 0) return freeze({state: 'UNKNOWN', reason: 'no replica is declared'});
  if (refValue.replicas.every(replica => replica.state === 'EVICTED')) return freeze({state: 'EVICTED', reason: 'every replica was evicted'});
  if (refValue.replicas.some(replica => replica.state === 'AVAILABLE')) return freeze({state: 'AVAILABLE', reason: 'at least one replica is available'});
  if (refValue.replicas.some(replica => replica.state === 'NOT_YET_TRANSFERRED')) return freeze({state: 'NOT_YET_TRANSFERRED', reason: 'transfer has not completed'});
  return freeze({state: 'UNKNOWN', reason: 'no replica state supports a stronger answer'});
}

/**
 * The resume cursor. A resume is legitimate ONLY when the digest and the version both match: a cursor whose digest
 * disagrees is a different artifact's progress and must not be applied, which is the failure this exists to prevent.
 */
export function createResumeCursor({opaqueId, digest, referenceVersion = 1, completedBytes = 0, completedItems = 0, partialOutputVisible} = {}) {
  ok(ref(opaqueId), 'CURSOR_ID_REQUIRED');
  ok(SHA256.test(String(digest ?? '')), 'CURSOR_DIGEST_REQUIRED');
  ok(Number.isSafeInteger(referenceVersion) && referenceVersion > 0, 'CURSOR_VERSION_REQUIRED');
  ok(Number.isSafeInteger(completedBytes) && completedBytes >= 0 && Number.isSafeInteger(completedItems) && completedItems >= 0, 'CURSOR_PROGRESS_INVALID');
  // A partial file must never be presented as usable content. The flag is REQUIRED as soon as any progress exists; a
  // fresh cursor has nothing partial to describe, so an absent flag there is not an error.
  const progressed = completedBytes > 0 || completedItems > 0;
  if (progressed) ok(typeof partialOutputVisible === 'boolean', 'CURSOR_PARTIAL_FLAG_REQUIRED');
  else ok(partialOutputVisible === undefined || typeof partialOutputVisible === 'boolean', 'CURSOR_PARTIAL_FLAG_INVALID');
  return freeze({cursorVersion: 1, opaqueId, digest, referenceVersion, completedBytes, completedItems, partialOutputVisible: partialOutputVisible === true});
}

export function canResume(reference, cursor, {now = Date.now()} = {}) {
  const refValue = validateArtifactRef(reference);
  ok(isPlainObject(cursor), 'CURSOR_REQUIRED');
  if (cursor.digest !== refValue.digest) return freeze({resume: false, reason: 'DIGEST_MISMATCH', detail: 'the cursor belongs to different bytes'});
  if (cursor.referenceVersion !== refValue.referenceVersion) return freeze({resume: false, reason: 'VERSION_MISMATCH', detail: 'the reference contract version differs'});
  if (refValue.expiresAt !== null && now >= refValue.expiresAt) return freeze({resume: false, reason: 'EXPIRED', detail: 'the reference expired'});
  if (cursor.completedBytes > refValue.size) return freeze({resume: false, reason: 'CURSOR_AHEAD', detail: 'the cursor claims more bytes than the artifact has'});
  return freeze({resume: true, reason: null, detail: null, fromBytes: cursor.completedBytes, remainingBytes: refValue.size - cursor.completedBytes});
}

/** Advancing a cursor keeps the digest it was created for; a cursor cannot be re-pointed at other bytes. */
export function advanceCursor(cursor, {completedBytes, completedItems = cursor.completedItems} = {}) {
  ok(isPlainObject(cursor), 'CURSOR_REQUIRED');
  ok(Number.isSafeInteger(completedBytes) && completedBytes >= cursor.completedBytes, 'CURSOR_CANNOT_GO_BACKWARD');
  // The partial-output fact describes the TRANSFER, not the cursor's position, so advancing carries it forward rather
  // than forcing every caller to restate it.
  return createResumeCursor({...cursor, completedBytes, completedItems, partialOutputVisible: cursor.partialOutputVisible === true});
}
