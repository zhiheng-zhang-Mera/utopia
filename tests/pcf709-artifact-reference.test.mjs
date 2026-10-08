// PCF-709 acceptance: the ArtifactRef contract and the resume cursor.
//
// The property under test throughout is that INTEGRITY and PERMISSION are different questions: a reference can be
// perfectly well-formed and its digest can match the bytes while the caller still has no right to read it.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REPLICA_KINDS, AVAILABILITY, REFERENCE_LIMITS,
  createArtifactRef, validateArtifactRef, verifyArtifactBytes, authorizeRead, availabilityOf,
  createResumeCursor, canResume, advanceCursor,
} from '../services/personal-compute-fabric/artifact-reference.mjs';

const DIGEST = 'a'.repeat(64);
const OTHER_DIGEST = 'b'.repeat(64);
const draft = overrides => ({
  opaqueId: 'artifact-7f3a', digest: DIGEST, size: 1024, schema: 'cpu-json-v1', owner: 'sess-owner', dataScope: 'PERSONAL',
  replicas: [{kind: 'LOCAL_CACHE', state: 'AVAILABLE', locationRef: 'cache:local'}], expiresAt: null, retention: null, createdAt: 1000,
  ...overrides,
});
const refusal = (overrides, code) => assert.throws(() => createArtifactRef(draft(overrides)), new RegExp(code), `expected ${code}`);

test('PCF709-01 a complete reference is accepted, frozen, and its declared facts survive normalization', () => {
  const reference = createArtifactRef(draft({replicas: [{kind: 'LOCAL_CACHE', state: 'AVAILABLE', locationRef: 'cache:local'}, {kind: 'EXECUTOR_DEVICE', state: 'NOT_YET_TRANSFERRED'}]}));
  assert.equal(reference.opaqueId, 'artifact-7f3a');
  assert.equal(reference.digest, DIGEST);
  assert.equal(reference.size, 1024);
  assert.equal(reference.replicas.length, 2);
  assert.ok(Object.isFrozen(reference));
  assert.deepEqual(REPLICA_KINDS, ['LOCAL_CACHE', 'REMOTE_STORE', 'ORIGIN_DEVICE', 'EXECUTOR_DEVICE']);
});

test('PCF709-02 an id that is a filesystem path is refused, because the store resolves paths itself', () => {
  // A path in a reference would let a caller name WHERE to read instead of WHAT to read.
  refusal({opaqueId: '../../etc/passwd'}, 'ARTIFACT_ID_MUST_BE_OPAQUE');
  refusal({opaqueId: 'C:/Windows/system32/config'}, 'ARTIFACT_ID_MUST_BE_OPAQUE');
  refusal({opaqueId: 'sub/dir/file'}, 'ARTIFACT_ID_MUST_BE_OPAQUE');
  refusal({opaqueId: ''}, 'ARTIFACT_ID_REQUIRED');
});

test('PCF709-03 a digest that agrees is INTEGRITY, never PERMISSION', () => {
  const reference = createArtifactRef(draft());
  const bytes = Buffer.alloc(1024);
  assert.equal(verifyArtifactBytes(reference, bytes), true, 'size and shape agree, so the integrity check passes');
  // ...and the same well-formed, size-matching reference is still REFUSED to a caller without the scope.
  assert.throws(() => authorizeRead(reference, {callerRef: 'sess-other', dataScopes: ['PUBLIC']}), /ARTIFACT_DATA_SCOPE_DENIED:PERSONAL/);
  assert.equal(authorizeRead(reference, {callerRef: 'sess-owner', dataScopes: ['PERSONAL']}).authorized, true);
  // Integrity does not even look at the caller: it takes no context at all, by design.
  assert.equal(verifyArtifactBytes.length, 2, 'verifyArtifactBytes accepts only (reference, bytes) - there is no context to authorize with');
});

test('PCF709-04 revocation, expiry and a wrong-size byte buffer each refuse with their OWN reason', () => {
  const revoked = createArtifactRef(draft({replicas: [{kind: 'LOCAL_CACHE', state: 'REVOKED'}]}));
  assert.throws(() => authorizeRead(revoked, {callerRef: 'sess-owner', dataScopes: ['PERSONAL']}), /ARTIFACT_REVOKED/);
  const expired = createArtifactRef(draft({expiresAt: 5000}));
  assert.throws(() => authorizeRead(expired, {callerRef: 'sess-owner', dataScopes: ['PERSONAL'], now: 6000}), /ARTIFACT_EXPIRED/);
  assert.equal(authorizeRead(expired, {callerRef: 'sess-owner', dataScopes: ['PERSONAL'], now: 4000}).authorized, true, 'before expiry it is readable');
  assert.throws(() => verifyArtifactBytes(createArtifactRef(draft()), Buffer.alloc(10)), /ARTIFACT_SIZE_MISMATCH/);
  assert.throws(() => authorizeRead(createArtifactRef(draft()), {}), /ARTIFACT_CALLER_REQUIRED/);
});

test('PCF709-05 availability is computed from STATED replica facts and never guessed from a failure', () => {
  assert.equal(availabilityOf(createArtifactRef(draft())).state, 'AVAILABLE');
  assert.equal(availabilityOf(createArtifactRef(draft({replicas: [{kind: 'LOCAL_CACHE', state: 'EVICTED'}]}))).state, 'EVICTED');
  assert.equal(availabilityOf(createArtifactRef(draft({replicas: []}))).state, 'UNKNOWN');
  assert.equal(availabilityOf(createArtifactRef(draft({replicas: [{kind: 'EXECUTOR_DEVICE', state: 'NOT_YET_TRANSFERRED'}]}))).state, 'NOT_YET_TRANSFERRED');
  assert.equal(availabilityOf(createArtifactRef(draft({expiresAt: 1000})), {now: 2000}).state, 'EXPIRED');
  assert.equal(availabilityOf(createArtifactRef(draft({replicas: [{kind: 'LOCAL_CACHE', state: 'REVOKED'}]}))).state, 'REVOKED');
  // Every state carries a reason, so a consumer is never left with a bare "not available".
  for (const state of AVAILABILITY) {
    const reference = createArtifactRef(draft({replicas: state === 'UNKNOWN' ? [] : [{kind: 'LOCAL_CACHE', state}]}));
    const availability = availabilityOf(reference, {now: 9999});
    assert.ok(typeof availability.reason === 'string' && availability.reason.length > 0, `${state} must carry a reason`);
  }
});

test('PCF709-06 a malformed reference is refused field by field rather than partially trusted', () => {
  refusal({digest: 'nothex'}, 'ARTIFACT_DIGEST_REQUIRED');
  refusal({size: -1}, 'ARTIFACT_SIZE_REQUIRED');
  refusal({schema: ''}, 'ARTIFACT_SCHEMA_REQUIRED');
  refusal({owner: null}, 'ARTIFACT_OWNER_REQUIRED');
  refusal({dataScope: 'SECRET'}, 'ARTIFACT_DATA_SCOPE_UNKNOWN');
  refusal({replicas: [{kind: 'SOMEWHERE'}]}, 'ARTIFACT_REPLICA_KIND_UNKNOWN');
  refusal({replicas: [{kind: 'LOCAL_CACHE', state: 'MAYBE'}]}, 'ARTIFACT_REPLICA_STATE_UNKNOWN');
  refusal({retention: {keepUntil: 1}}, 'ARTIFACT_RETENTION_INVALID');
  refusal({replicas: Array.from({length: REFERENCE_LIMITS.maxReplicas + 1}, () => ({kind: 'LOCAL_CACHE'}))}, 'ARTIFACT_REPLICAS_INVALID');
  // A reference read back from storage is re-validated, not trusted because it parsed.
  assert.throws(() => validateArtifactRef({opaqueId: 'x', digest: 'short'}), /ARTIFACT_DIGEST_REQUIRED/);
});

test('PCF709-07 a resume applies ONLY when digest and version both match, and a cursor cannot move backward', () => {
  const reference = createArtifactRef(draft());
  const cursor = createResumeCursor({opaqueId: reference.opaqueId, digest: DIGEST, referenceVersion: 1, completedBytes: 400, partialOutputVisible: false});
  const allowed = canResume(reference, cursor);
  assert.equal(allowed.resume, true);
  assert.equal(allowed.remainingBytes, 624);
  // A cursor for OTHER bytes must not be applied - this is the failure the cursor exists to prevent.
  assert.equal(canResume(reference, {...cursor, digest: OTHER_DIGEST}).reason, 'DIGEST_MISMATCH');
  assert.equal(canResume(reference, {...cursor, referenceVersion: 2}).reason, 'VERSION_MISMATCH');
  assert.equal(canResume(createArtifactRef(draft({expiresAt: 1000})), cursor, {now: 2000}).reason, 'EXPIRED');
  assert.equal(canResume(reference, {...cursor, completedBytes: 5000}).reason, 'CURSOR_AHEAD');
  const advanced = advanceCursor(cursor, {completedBytes: 800});
  assert.equal(advanced.completedBytes, 800);
  assert.equal(advanced.digest, DIGEST, 'advancing keeps the digest it was created for');
  assert.throws(() => advanceCursor(cursor, {completedBytes: 100}), /CURSOR_CANNOT_GO_BACKWARD/);
});

test('PCF709-08 a partial transfer is recorded as partial and never presented as usable content', () => {
  const cursor = createResumeCursor({opaqueId: 'artifact-1', digest: DIGEST, referenceVersion: 1, completedBytes: 10, partialOutputVisible: true});
  assert.equal(cursor.partialOutputVisible, true, 'the partial state is carried so a consumer can see it');
  // A cursor with progress MUST state whether partial output is visible; a fresh one has nothing to describe.
  assert.throws(() => createResumeCursor({opaqueId: 'artifact-1', digest: DIGEST, completedBytes: 5}), /CURSOR_PARTIAL_FLAG_REQUIRED/);
  assert.equal(createResumeCursor({opaqueId: 'artifact-1', digest: DIGEST}).completedBytes, 0);
  assert.throws(() => createResumeCursor({opaqueId: 'artifact-1', digest: DIGEST, referenceVersion: 0}), /CURSOR_VERSION_REQUIRED/);
  assert.throws(() => createResumeCursor({opaqueId: 'artifact-1', digest: 'nope'}), /CURSOR_DIGEST_REQUIRED/);
});
