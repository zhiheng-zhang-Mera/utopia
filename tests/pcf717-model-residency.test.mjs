// PCF-717 acceptance: model residency and serving as a contract.
//
// No licensed model runtime exists on this project, so nothing here loads a model - that part is a typed NOT_RUN. What
// the workbook can be held to locally is everything a residency manager gets wrong: versioned compatibility, an
// authorisation for downloads and paid providers, requirement kept apart from observation, admission that counts what
// is already resident, a bounded warm pool that will not evict a model in use, OOM as an event rather than a silent
// retry, per-task KV isolation, and routing that never takes a cache hit across a privacy or cost gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeModelManifest, memoryRequirement, admitModelRequest, evictFor, handleOutOfMemory, releaseRequest, routeModelRequest,
  QUANTIZATIONS, ACCELERATOR_KINDS, OBSERVATION_SOURCES, RESIDENCY_REFUSALS, WARM_POOL_LIMITS} from '../services/personal-compute-fabric/model-residency.mjs';
import {createArtifactRef} from '../services/personal-compute-fabric/artifact-reference.mjs';

const artifact = () => createArtifactRef({opaqueId: 'weights-bundle-1', digest: 'a'.repeat(64), size: 1024, schema: 'gguf-v1', owner: 'owner:zhiheng',
  dataScope: 'PERSONAL', replicas: [{kind: 'LOCAL_CACHE', state: 'AVAILABLE', locationRef: 'cache:model-1'}], createdAt: 1000});
const manifest = (extra = {}) => ({version: 1, modelRef: 'qwen-local-7b', modelVersion: '2026-10', runtimeRef: 'llama-runtime', runtimeVersion: 3,
  quantization: 'GGUF_Q4', accelerator: {kind: 'CUDA', minimumDriver: '555.0'}, artifacts: [artifact()],
  memory: {weightsBytes: 4_000_000_000, workspaceBytes: 500_000_000, kvCacheBytesPerRequest: 200_000_000, coldStartBytes: 100_000_000},
  maxConcurrentRequests: 4, ...extra});

test('PCF717-01 the manifest is versioned and compatible, and nothing is used without authorisation', () => {
  const normalized = normalizeModelManifest(manifest());
  assert.equal(normalized.modelRef, 'qwen-local-7b');
  assert.equal(normalized.accelerator.kind, 'CUDA');
  assert.equal(normalized.downloadPerformed, false, 'this module never downloads anything');
  assert.equal(normalized.artifacts.length, 1);
  // Version and compatibility refusals.
  assert.throws(() => normalizeModelManifest(manifest({version: 2})), /MODEL_MANIFEST_VERSION/);
  assert.throws(() => normalizeModelManifest(manifest({quantization: 'MAGIC_Q2'})), /MODEL_QUANTIZATION_UNKNOWN/);
  assert.throws(() => normalizeModelManifest(manifest({accelerator: {kind: 'TPU'}})), /MODEL_ACCELERATOR_UNKNOWN/);
  assert.throws(() => normalizeModelManifest(manifest({runtimeVersion: 0})), /MODEL_MANIFEST_IDENTITY/);
  assert.throws(() => normalizeModelManifest(manifest({artifacts: []})), /MODEL_ARTIFACTS_REQUIRED/);
  // An artifact that is not a valid PCF-709 reference is refused here, not at load time.
  assert.throws(() => normalizeModelManifest(manifest({artifacts: [{opaqueId: 'C:/weights', digest: 'a'.repeat(64), size: 1, schema: 's', owner: 'o', dataScope: 'PERSONAL'}]})), /ARTIFACT_ID_MUST_BE_OPAQUE/);
  assert.throws(() => normalizeModelManifest(manifest({artifacts: [{...artifact(), digest: 'short'}]})), /ARTIFACT_DIGEST_REQUIRED/);
  // Downloading or adding a paid provider both need an explicit authorisation; the module will not reach for either.
  assert.throws(() => normalizeModelManifest(manifest({requiresDownload: true})), /MODEL_DOWNLOAD_NOT_AUTHORISED/);
  assert.equal(normalizeModelManifest(manifest({requiresDownload: true, authorizationRef: 'owner-approval:model-1'})).requiresDownload, true);
  assert.throws(() => normalizeModelManifest(manifest({paidProvider: true})), /MODEL_PROVIDER_NOT_AUTHORISED/);
  assert.throws(() => normalizeModelManifest(manifest({paidProvider: true, authorizationRef: 'owner-approval:model-1'})), /MODEL_PROVIDER_NOT_AUTHORISED/, 'cost authorisation is a separate fact');
  assert.equal(normalizeModelManifest(manifest({paidProvider: true, authorizationRef: 'owner-approval:model-1', costAuthorised: true})).costAuthorised, true);
  assert.deepEqual(QUANTIZATIONS.includes('GGUF_Q4'), true);
  assert.deepEqual(ACCELERATOR_KINDS.includes('NONE_CPU'), true);
});

test('PCF717-02 the declared requirement is kept apart from the observation', () => {
  const cold = memoryRequirement(manifest(), {concurrentRequests: 2});
  assert.equal(cold.requiredBytes, 4_000_000_000 + 100_000_000 + 500_000_000 + 2 * 200_000_000);
  assert.deepEqual(cold.components.kvCacheBytes, 400_000_000);
  assert.equal(cold.basis, 'DECLARED_REQUIREMENT_NOT_AN_OBSERVATION');
  // An already resident model does not pay for its weights again - it pays for workspace and KV only.
  const warm = memoryRequirement(manifest(), {concurrentRequests: 2, resident: true});
  assert.equal(warm.components.weightsBytes, 0);
  assert.equal(warm.requiredBytes, cold.requiredBytes - 4_000_000_000);
  assert.throws(() => memoryRequirement(manifest(), {concurrentRequests: 0}), /MODEL_CONCURRENCY_BOUND/);
  // The observation is a separate input, and its source is recorded rather than assumed.
  const host = {hostId: 'alien', acceleratorKind: 'CUDA', freeBytes: 10_000_000_000, observationSource: 'NVML'};
  const admitted = admitModelRequest({manifest: manifest(), host, request: {requestId: 'R1', taskId: 'T1', concurrentRequests: 1}});
  assert.equal(admitted.admitted, true);
  assert.equal(admitted.cacheState, 'COLD');
  assert.equal(admitted.observationSource, 'NVML');
  assert.equal(admitted.observationBasis, 'MEASURED_BY_HOST_AGENT');
  assert.deepEqual(OBSERVATION_SOURCES.includes('UNSUPPORTED'), true);
});

test('PCF717-03 admission counts what is resident and reserved, not how many accelerators exist', () => {
  const host = {hostId: 'alien', acceleratorKind: 'CUDA', freeBytes: 5_000_000_000, observationSource: 'NVML'};
  const request = {requestId: 'R1', taskId: 'T1', concurrentRequests: 1};
  // Baseline: it fits.
  assert.equal(admitModelRequest({manifest: manifest(), host, request}).admitted, true);
  // The same free memory is not enough once earlier admissions have reserved it.
  const reserved = 4_000_000_000;
  const refused = admitModelRequest({manifest: manifest(), host, reservedBytes: reserved, request});
  assert.equal(refused.admitted, false);
  assert.equal(refused.reason, RESIDENCY_REFUSALS.VRAM_INSUFFICIENT);
  assert.equal(refused.reservedBytes, reserved);
  // A WRONG accelerator kind is a mismatch, not a slow path.
  assert.equal(admitModelRequest({manifest: manifest(), host: {...host, acceleratorKind: 'ROCM'}, request}).reason, RESIDENCY_REFUSALS.ACCELERATOR_MISMATCH);
  // An unsupported or failed observation is UNKNOWN - never 0 free and never "enough".
  for (const hostOverride of [{observationSource: 'UNSUPPORTED'}, {observationSource: 'UNKNOWN'}, {observationSource: 'GUESS'}, {freeBytes: undefined}, {freeBytes: null}]) {
    const outcome = admitModelRequest({manifest: manifest(), host: {...host, ...hostOverride}, request});
    assert.equal(outcome.admitted, false, JSON.stringify(hostOverride));
    assert.equal(outcome.reason, RESIDENCY_REFUSALS.VRAM_OBSERVATION_MISSING);
    assert.equal(outcome.treatedAs, 'UNKNOWN');
  }
  assert.equal(admitModelRequest({manifest: manifest(), request}).reason, RESIDENCY_REFUSALS.VRAM_OBSERVATION_MISSING, 'no observation at all is not an admission');
  // A CPU-only model needs no accelerator match.
  const cpu = admitModelRequest({manifest: manifest({accelerator: {kind: 'NONE_CPU', minimumDriver: null}}), host: {hostId: 'alien', acceleratorKind: 'NONE', freeBytes: 8_000_000_000, observationSource: 'HOST_AGENT'}, request});
  assert.equal(cpu.admitted, true);
  // The manifest concurrency bound refuses rather than queueing forever.
  const busy = admitModelRequest({manifest: manifest({maxConcurrentRequests: 1}), host, resident: [{modelRef: 'qwen-local-7b', activeRequests: 1, residentBytes: 4_000_000_000}], request});
  assert.equal(busy.reason, RESIDENCY_REFUSALS.CONCURRENCY_EXCEEDED);
  // A resident model is reported WARM and does not re-pay for weights.
  const warm = admitModelRequest({manifest: manifest({maxConcurrentRequests: 8}), host, resident: [{modelRef: 'qwen-local-7b', activeRequests: 1, residentBytes: 4_000_000_000}], request});
  assert.equal(warm.admitted, true);
  assert.equal(warm.cacheState, 'WARM');
  assert.equal(warm.requiredBytes, 100_000_000 + 500_000_000 + 200_000_000);
});

test('PCF717-04 the warm pool is bounded, evicts idle first, and refuses to evict a model in use', () => {
  assert.deepEqual(WARM_POOL_LIMITS.maxModels, 8);
  const pool = [
    {modelRef: 'idle-old', residentBytes: 1_000_000_000, lastUsedAt: 0, idleTimeoutMs: 1000, activeRequests: 0},
    {modelRef: 'lru', residentBytes: 1_000_000_000, lastUsedAt: 5_000, activeRequests: 0},
    {modelRef: 'busy', residentBytes: 1_000_000_000, lastUsedAt: 1, activeRequests: 2},
  ];
  const evicted = evictFor({pool, needBytes: 1_000_000_000, now: 5000});
  assert.equal(evicted.satisfied, true);
  assert.deepEqual(evicted.evicted.map(entry => entry.reason), ['IDLE_TIMEOUT']);
  assert.deepEqual(evicted.remaining.includes('busy'), true, 'a model with active requests survives');
  // Pressure that can only be met by evicting the busy model is REFUSED, and the reason names what blocked it.
  const blocked = evictFor({pool: [{modelRef: 'busy', residentBytes: 1_000_000_000, lastUsedAt: 1, activeRequests: 1}], needBytes: 1_000_000_000, now: 5000});
  assert.equal(blocked.satisfied, false);
  assert.equal(blocked.refused.reason, RESIDENCY_REFUSALS.EVICTION_ACTIVE);
  assert.deepEqual(blocked.refused.blockedBy, ['busy']);
  assert.deepEqual(blocked.evicted, []);
  // A slot requirement forces at least one eviction even when bytes are plentiful.
  const slot = evictFor({pool, needBytes: 0, needSlot: true, now: 5000});
  assert.equal(slot.satisfied, true);
  assert.equal(slot.remaining.includes('busy'), true);
});

test('PCF717-05 OOM is an event with attention, per-task KV is isolated, and a cache hit never crosses a gate', () => {
  const oom = handleOutOfMemory({pool: [{modelRef: 'm', activeRequests: 2}], modelRef: 'm', now: 1000});
  assert.equal(oom.automaticRetry, false, 'a silent retry would replay work whose side effects are unknown');
  assert.equal(oom.poolState, 'DEGRADED');
  assert.match(oom.attention, /OWNER_ATTENTION/);
  assert.equal(oom.droppedRequests, 2);
  // KV belongs to the task that owns it.
  const pool = [{modelRef: 'm', kvOwners: ['T1']}];
  assert.equal(releaseRequest({pool, modelRef: 'm', taskId: 'T1'}).released, true);
  const violation = releaseRequest({pool, modelRef: 'm', taskId: 'T2'});
  assert.equal(violation.released, false);
  assert.equal(violation.reason, RESIDENCY_REFUSALS.KV_ISOLATION);
  assert.equal(violation.kvReusedAcrossTasks, undefined);
  assert.equal(releaseRequest({pool, modelRef: 'ghost', taskId: 'T1'}).reason, 'MODEL_NOT_RESIDENT');
  // Routing prefers warm, but not across a privacy gate...
  const hosts = [{hostId: 'other', residentModels: ['qwen-local-7b'], allowedDataScopes: ['PUBLIC'], transferCostMinor: 0},
    {hostId: 'mine', residentModels: [], allowedDataScopes: ['PERSONAL'], transferCostMinor: 0}];
  const privacy = routeModelRequest({request: {taskId: 'T1', modelRef: 'qwen-local-7b', dataScope: 'PERSONAL'}, hosts});
  assert.equal(privacy.decision, 'REFUSED');
  assert.equal(privacy.reason, RESIDENCY_REFUSALS.PRIVACY_GATE);
  assert.deepEqual(privacy.warmHosts, ['other']);
  // ...nor across a cost gate...
  const costly = routeModelRequest({request: {taskId: 'T1', modelRef: 'qwen-local-7b', dataScope: 'PUBLIC'},
    hosts: [{hostId: 'paid', residentModels: ['qwen-local-7b'], allowedDataScopes: ['PUBLIC'], transferCostMinor: 5}]});
  assert.equal(costly.reason, RESIDENCY_REFUSALS.COST_GATE);
  // ...and a cold start is only taken when it was explicitly authorised.
  assert.equal(routeModelRequest({request: {taskId: 'T1', modelRef: 'qwen-local-7b', dataScope: 'PUBLIC'}, hosts: []}).reason, 'COLD_START_NOT_AUTHORISED');
  const cold = routeModelRequest({request: {taskId: 'T1', modelRef: 'qwen-local-7b', dataScope: 'PUBLIC', coldStartAllowed: true}, hosts: []});
  assert.equal(cold.decision, 'COLD_START');
  assert.equal(cold.cacheHit, false);
  // The in-scope, free warm replica is chosen when one exists.
  const warm = routeModelRequest({request: {taskId: 'T1', modelRef: 'qwen-local-7b', dataScope: 'PUBLIC'}, hosts});
  assert.equal(warm.decision, 'WARM');
  assert.equal(warm.hostId, 'other');
  assert.equal(warm.costMinor, 0);
});
