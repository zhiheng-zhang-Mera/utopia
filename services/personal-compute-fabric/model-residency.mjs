// PCF-717: model residency and serving - the CONTRACT, not a runtime.
//
// This project has no licensed model runtime and no accelerator to serve from, so nothing here loads a model. What it
// does is make the decisions that a naive residency manager gets wrong, and it refuses the ones it cannot make:
//
//   * a model/runtime/quantization/accelerator set is versioned and compatibility-checked, and every artifact goes
//     through the PCF-709 reference contract before it is counted as available;
//   * downloading a model or adding a provider needs an AUTHORISATION reference. Without one the answer is a refusal -
//     this module never reaches for a paid or unlicensed provider on its own;
//   * REQUIREMENT AND OBSERVATION ARE KEPT APART. Weights, workspace and KV cache are declared needs; what the host
//     actually has is an observation with a source, and a missing observation is UNKNOWN - never 0, never sufficient;
//   * admission counts what is ALREADY RESIDENT and already reserved, not the number of accelerators, because two
//     devices with the same count hold different amounts of free memory;
//   * the warm pool is bounded, eviction refuses to take a model with active requests, and an OOM is reported as an
//     event with an attention state rather than absorbed by a silent retry;
//   * user context/KV is released with the request that owns it, and reusing it for another task is a violation;
//   * routing may prefer a warm replica, but a cache hit NEVER crosses a privacy or cost gate.
import {requireThat as ok, text, strings, finite, copy, freeze} from './validation.mjs';
import {validateArtifactRef} from './artifact-reference.mjs';

export const MODEL_RESIDENCY_VERSION = 1;
export const QUANTIZATIONS = Object.freeze(['NONE', 'FP16', 'BF16', 'INT8', 'INT4', 'GGUF_Q4', 'GGUF_Q5', 'GGUF_Q8']);
export const ACCELERATOR_KINDS = Object.freeze(['NONE_CPU', 'CUDA', 'ROCM', 'METAL', 'NPU', 'VULKAN']);
export const OBSERVATION_SOURCES = Object.freeze(['DRIVER_QUERY', 'NVML', 'HOST_AGENT', 'UNSUPPORTED', 'UNKNOWN']);
export const RESIDENCY_REFUSALS = Object.freeze({
  NOT_AUTHORISED: 'MODEL_NOT_AUTHORISED',
  DOWNLOAD_NOT_AUTHORISED: 'MODEL_DOWNLOAD_NOT_AUTHORISED',
  PROVIDER_NOT_AUTHORISED: 'MODEL_PROVIDER_NOT_AUTHORISED',
  ACCELERATOR_MISMATCH: 'ACCELERATOR_MISMATCH',
  VRAM_OBSERVATION_MISSING: 'VRAM_OBSERVATION_MISSING',
  VRAM_INSUFFICIENT: 'VRAM_INSUFFICIENT',
  CONCURRENCY_EXCEEDED: 'CONCURRENCY_EXCEEDED',
  KV_ISOLATION: 'KV_CONTEXT_ISOLATION_VIOLATION',
  EVICTION_ACTIVE: 'EVICTION_REFUSED_ACTIVE_REQUESTS',
  PRIVACY_GATE: 'PRIVACY_GATE_BLOCKS_CACHE_HIT',
  COST_GATE: 'COST_GATE_BLOCKS_CACHE_HIT',
});
export const WARM_POOL_LIMITS = Object.freeze({maxModels: 8, maxBytes: 64 * 1024 * 1024 * 1024, idleTimeoutMs: 900000});
const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Normalize a model manifest. Versioned, authorized, and with every artifact reference verified through PCF-709.
 *
 * A "digest matches" check is NOT an authorisation check, so the artifact reference is validated as a reference and the
 * authorisation is a separate, explicit reference. A manifest with no authorisation reference cannot be downloaded or
 * added as a provider, and says so.
 */
export function normalizeModelManifest(input) {
  const m = copy(input);
  ok(isPlainObject(m), 'MODEL_MANIFEST_INVALID');
  ok(m.version === MODEL_RESIDENCY_VERSION, 'MODEL_MANIFEST_VERSION');
  ok(text(m.modelRef) && text(m.modelVersion) && text(m.runtimeRef) && Number.isSafeInteger(m.runtimeVersion) && m.runtimeVersion > 0, 'MODEL_MANIFEST_IDENTITY');
  ok(QUANTIZATIONS.includes(m.quantization), 'MODEL_QUANTIZATION_UNKNOWN');
  ok(isPlainObject(m.accelerator) && ACCELERATOR_KINDS.includes(m.accelerator.kind), 'MODEL_ACCELERATOR_UNKNOWN');
  ok(m.accelerator.minimumDriver === null || text(m.accelerator.minimumDriver), 'MODEL_ACCELERATOR_DRIVER');
  ok(Array.isArray(m.artifacts) && m.artifacts.length > 0 && m.artifacts.length <= 32, 'MODEL_ARTIFACTS_REQUIRED');
  const artifacts = m.artifacts.map(reference => validateArtifactRef(reference));
  // Declared needs. They are REQUIREMENTS; the observation below is kept separate on purpose.
  ok(isPlainObject(m.memory) && finite(m.memory.weightsBytes) && finite(m.memory.workspaceBytes) && finite(m.memory.kvCacheBytesPerRequest) && finite(m.memory.coldStartBytes), 'MODEL_MEMORY_REQUIRED');
  ok(m.authorizationRef === undefined || m.authorizationRef === null || text(m.authorizationRef), 'MODEL_AUTHORISATION_INVALID');
  if (m.requiresDownload === true) ok(text(m.authorizationRef), RESIDENCY_REFUSALS.DOWNLOAD_NOT_AUTHORISED);
  if (m.paidProvider === true) ok(text(m.authorizationRef) && m.costAuthorised === true, RESIDENCY_REFUSALS.PROVIDER_NOT_AUTHORISED);
  return freeze({...m, accelerator: freeze({...m.accelerator}), artifacts: freeze(artifacts), memory: freeze({...m.memory}),
    authorizationRef: m.authorizationRef ?? null, requiresDownload: m.requiresDownload === true, paidProvider: m.paidProvider === true,
    costAuthorised: m.costAuthorised === true, downloadPerformed: false,
    note: 'this module never downloads, installs or contacts a provider; it only decides whether a declared manifest may be used'});
}

/** The declared requirement, in its components, so "how much memory does this need" has a computable answer. */
export function memoryRequirement(manifest, {concurrentRequests = 1, resident = false} = {}) {
  const m = normalizeModelManifest(manifest);
  ok(Number.isSafeInteger(concurrentRequests) && concurrentRequests >= 1 && concurrentRequests <= 64, 'MODEL_CONCURRENCY_BOUND');
  const weights = resident ? 0 : m.memory.weightsBytes;
  const required = weights + m.memory.coldStartBytes + m.memory.workspaceBytes + m.memory.kvCacheBytesPerRequest * concurrentRequests;
  return freeze({kind: 'ModelMemoryRequirement', modelRef: m.modelRef, concurrentRequests, resident,
    components: freeze({weightsBytes: weights, coldStartBytes: m.memory.coldStartBytes, workspaceBytes: m.memory.workspaceBytes,
      kvCacheBytesPerRequest: m.memory.kvCacheBytesPerRequest, kvCacheBytes: m.memory.kvCacheBytesPerRequest * concurrentRequests}),
    requiredBytes: required, basis: 'DECLARED_REQUIREMENT_NOT_AN_OBSERVATION'});
}

/**
 * Admission for one request. The host observation is what the host actually reported; `resident` is what is already
 * loaded and `reserved` is what earlier admissions have already claimed. Counting only accelerators is the mistake this
 * function exists to prevent.
 */
export function admitModelRequest({manifest, host, resident = [], reservedBytes = 0, request} = {}) {
  const m = normalizeModelManifest(manifest);
  ok(isPlainObject(request) && text(request.requestId) && text(request.taskId) && Number.isSafeInteger(request.concurrentRequests ?? 1), 'MODEL_REQUEST_INVALID');
  const refuse = (reason, detail, extra = {}) => freeze({admitted: false, reason, detail, modelRef: m.modelRef, requestId: request.requestId, ...extra});
  if (!isPlainObject(host)) return refuse(RESIDENCY_REFUSALS.VRAM_OBSERVATION_MISSING, 'no host observation was supplied');
  if (!ACCELERATOR_KINDS.includes(m.accelerator.kind)) return refuse(RESIDENCY_REFUSALS.ACCELERATOR_MISMATCH, 'unknown accelerator');
  if (m.accelerator.kind !== 'NONE_CPU' && host.acceleratorKind !== m.accelerator.kind) return refuse(RESIDENCY_REFUSALS.ACCELERATOR_MISMATCH, 'the host has ' + host.acceleratorKind + ', the model needs ' + m.accelerator.kind);
  // An unsupported or failed observation is UNKNOWN: it is not "0 free" and it is certainly not "enough".
  if (!OBSERVATION_SOURCES.includes(host.observationSource) || host.observationSource === 'UNSUPPORTED' || host.observationSource === 'UNKNOWN' || !finite(host.freeBytes)) {
    return refuse(RESIDENCY_REFUSALS.VRAM_OBSERVATION_MISSING, 'the host did not report usable free memory', {observationSource: host.observationSource ?? null, treatedAs: 'UNKNOWN'});
  }
  const loaded = resident.filter(entry => entry.modelRef === m.modelRef);
  const alreadyResident = loaded.length > 0;
  const activeRequests = resident.reduce((sum, entry) => sum + (entry.activeRequests ?? 0), 0);
  if (activeRequests + 1 > (m.maxConcurrentRequests ?? 64)) return refuse(RESIDENCY_REFUSALS.CONCURRENCY_EXCEEDED, 'the manifest concurrency bound is reached', {activeRequests});
  const requirement = memoryRequirement(m, {concurrentRequests: request.concurrentRequests ?? 1, resident: alreadyResident});
  const available = host.freeBytes - reservedBytes;
  if (requirement.requiredBytes > available) {
    return refuse(RESIDENCY_REFUSALS.VRAM_INSUFFICIENT, 'the declared requirement exceeds free minus already-reserved memory',
      {requiredBytes: requirement.requiredBytes, availableBytes: available, reservedBytes, observationSource: host.observationSource});
  }
  return freeze({admitted: true, reason: null, modelRef: m.modelRef, requestId: request.requestId, taskId: request.taskId,
    cacheState: alreadyResident ? 'WARM' : 'COLD', requiredBytes: requirement.requiredBytes, availableBytes: available,
    reservedBytes, observationSource: host.observationSource, observationBasis: 'MEASURED_BY_HOST_AGENT',
    isolation: freeze({taskId: request.taskId, kvShared: false, releaseOn: 'REQUEST_COMPLETION'})});
}

/**
 * Evict from a bounded warm pool. The pool has hard limits, the eviction order is LRU by last use, and a model with
 * active requests is NEVER evicted - refusing is better than pulling the context out from under a running request.
 */
export function evictFor({pool, needBytes = 0, needSlot = false, now} = {}) {
  ok(Array.isArray(pool) && pool.length <= 64 && finite(needBytes) && finite(now), 'WARM_POOL_INPUT');
  const entries = pool.map(entry => ({...entry}));
  const evicted = [];
  const expired = entries.filter(entry => (entry.activeRequests ?? 0) === 0 && finite(entry.lastUsedAt) && now - entry.lastUsedAt > (entry.idleTimeoutMs ?? WARM_POOL_LIMITS.idleTimeoutMs));
  for (const entry of expired) { entry.evicted = true; evicted.push({modelRef: entry.modelRef, reason: 'IDLE_TIMEOUT', freedBytes: entry.residentBytes ?? 0}); }
  const survivors = entries.filter(entry => !entry.evicted).sort((left, right) => (left.lastUsedAt ?? 0) - (right.lastUsedAt ?? 0));
  let freed = evicted.reduce((sum, entry) => sum + entry.freedBytes, 0);
  let slots = 0;
  for (const entry of survivors) {
    if (freed >= needBytes && (!needSlot || slots >= 1)) break;
    if ((entry.activeRequests ?? 0) > 0) continue;
    entry.evicted = true;
    slots++;
    freed += entry.residentBytes ?? 0;
    evicted.push({modelRef: entry.modelRef, reason: 'LRU_PRESSURE', freedBytes: entry.residentBytes ?? 0});
  }
  const active = entries.filter(entry => (entry.activeRequests ?? 0) > 0);
  const satisfied = freed >= needBytes && (!needSlot || slots >= 1);
  return freeze({kind: 'WarmPoolEviction', evicted: freeze(evicted), freedBytes: freed, satisfied,
    // A need that could not be met is refused with the reason, never met by evicting a model that is in use.
    refused: satisfied ? null : {reason: RESIDENCY_REFUSALS.EVICTION_ACTIVE, detail: 'the remaining eviction candidates all have active requests',
      blockedBy: freeze(active.map(entry => entry.modelRef)), requiredBytes: needBytes},
    remaining: freeze(entries.filter(entry => !entry.evicted).map(entry => entry.modelRef))});
}

/** OOM is an event with an attention state, not something a silent retry may absorb. */
export function handleOutOfMemory({pool, modelRef, now} = {}) {
  ok(Array.isArray(pool) && text(modelRef) && finite(now), 'OOM_INPUT');
  const affected = pool.filter(entry => entry.modelRef === modelRef);
  return freeze({kind: 'OutOfMemoryEvent', modelRef, at: now, droppedRequests: affected.reduce((sum, entry) => sum + (entry.activeRequests ?? 0), 0),
    poolState: 'DEGRADED', attention: 'MODEL_RESIDENCY_OOM_REQUIRES_OWNER_ATTENTION', automaticRetry: false,
    detail: 'in-flight requests were dropped and are NOT silently replayed; side effects are unknown to this module'});
}

/** Release the KV/context of a finished request. Another task may not inherit it. */
export function releaseRequest({pool, modelRef, taskId} = {}) {
  ok(Array.isArray(pool) && text(modelRef) && text(taskId), 'RELEASE_INPUT');
  const entry = pool.find(candidate => candidate.modelRef === modelRef);
  if (!entry) return freeze({released: false, reason: 'MODEL_NOT_RESIDENT', modelRef, taskId});
  const owners = entry.kvOwners ?? [];
  if (owners.length > 0 && !owners.includes(taskId)) {
    return freeze({released: false, reason: RESIDENCY_REFUSALS.KV_ISOLATION, modelRef, taskId, owners: freeze([...owners]),
      detail: 'this context belongs to another task and is never reused across tasks'});
  }
  return freeze({released: true, reason: null, modelRef, taskId, kvReusedAcrossTasks: false});
}

/** Routing may prefer warm, but a cache hit never crosses a privacy or a cost gate. */
export function routeModelRequest({request, hosts = []} = {}) {
  ok(isPlainObject(request) && text(request.taskId) && text(request.modelRef) && text(request.dataScope), 'ROUTE_INPUT');
  ok(Array.isArray(hosts) && hosts.length <= 32, 'ROUTE_INPUT');
  const warm = hosts.filter(host => (host.residentModels ?? []).includes(request.modelRef));
  const allowed = warm.filter(host => (host.allowedDataScopes ?? []).includes(request.dataScope));
  if (warm.length > 0 && allowed.length === 0) {
    return freeze({decision: 'REFUSED', reason: RESIDENCY_REFUSALS.PRIVACY_GATE, warmHosts: freeze(warm.map(host => host.hostId)),
      detail: 'a warm replica exists but it is not authorised for this data scope; the cache hit is not taken'});
  }
  if (allowed.length > 0) {
    const free = allowed.filter(host => host.transferCostMinor === 0);
    if (free.length === 0) return freeze({decision: 'REFUSED', reason: RESIDENCY_REFUSALS.COST_GATE, warmHosts: freeze(allowed.map(host => host.hostId)),
      detail: 'reaching the warm replica would incur a cost this project has not authorised'});
    return freeze({decision: 'WARM', reason: null, hostId: free[0].hostId, cacheHit: true, costMinor: 0,
      detail: 'warm, in-scope and free to reach; the choice is the cache, not a new deployment'});
  }
  if (request.coldStartAllowed !== true) return freeze({decision: 'REFUSED', reason: 'COLD_START_NOT_AUTHORISED', detail: 'no warm authorised replica exists and a cold start was not authorised for this request'});
  return freeze({decision: 'COLD_START', reason: null, cacheHit: false, coldStartBytes: request.coldStartBytes ?? null,
    detail: 'a cold start is the only remaining option and it was explicitly authorised'});
}
