/**
 * UTOPIA · City Service Network — capability routing and invocation history.
 *
 * The registry says what *can* be invoked. This module says what may be invoked
 * *now*, and keeps the bounded, durable record of what was.
 *
 * It preserves the two properties that made Utopia V0.3's capability bridge
 * worth accepting, and adds the donor's hard/adaptive split:
 *
 *  * **Availability is lifecycle-derived, and stricter wins.** A capability
 *    whose owning modules are a mix of PROMOTED and DEPRECATED is UNAVAILABLE:
 *    one deprecated owner is enough to withdraw the promise. This is the
 *    donor's `filterByCapability` in `capability-router.ts` — FAILED, DISABLED
 *    and RECOVERING owners are excluded while DEGRADED owners are admitted and
 *    *tracked*, and an unknown state is never treated as capable.
 *  * **A hard exclusion can never be undone by a ranking.** The optional
 *    `rerank` hook exists so a learned ranking may reorder the candidates the
 *    hard layer already approved. It may not add, drop or substitute one; a
 *    candidate it invents is ignored, and a hook that throws leaves the
 *    deterministic order untouched. This is the donor's `role-router.ts`
 *    candidate-set equality rule.
 *
 * Donor provenance: DS-Hns `app/core/capability-registry/index.cjs` (resolution
 * rules), Codex-Boss `src/shared/capability-router.ts` (`ModuleState`,
 * `eligibleCandidates`), Codex-Boss `electron/commander/runtime-registry.ts`
 * (health refresh, DOWN-on-throw) and Codex-Boss
 * `electron/commander/role-router.ts` (hard layer then adaptive layer) @ the
 * frozen SHAs recorded in DONOR.json.
 */

import {
  FABRIC_REASONS,
  MAX_INVOCATIONS,
  MAX_LOOKUPS,
  canonical,
  digest,
  isInvocationErrorCode,
  isNonSemanticRuntimeCode,
  recoveryActionFor,
  runtimeOutcomeForError,
  providerStateFor,
} from './contracts.mjs';
import { deriveSemanticEvaluation } from './outcome.mjs';
import { createCapabilityRegistry, sortedCapabilityIds } from './registry.mjs';

/**
 * Module lifecycles, as the City manifest declares them, mapped onto the
 * routing states the donor used.
 */
export const MODULE_STATES = Object.freeze([
  'UNINITIALIZED',
  'CHECKING',
  'READY',
  'DEGRADED',
  'FAILED',
  'DISABLED',
  'RECOVERING',
  'UNKNOWN',
]);

/**
 * Map a City module lifecycle onto a routing state.
 *
 * PROMOTED and ACTIVE are READY; INCUBATING is DEGRADED — the module exists and
 * may be tried, but it has not been accepted yet, so its use must be visible.
 * DEPRECATED is DISABLED, and PLANNED is UNKNOWN: nobody has built it.
 */
export function moduleStateForLifecycle(lifecycle) {
  switch (lifecycle) {
    case 'ACTIVE':
    case 'PROMOTED':
      return 'READY';
    case 'INCUBATING':
      return 'DEGRADED';
    case 'DEPRECATED':
      return 'DISABLED';
    case 'PLANNED':
      return 'UNKNOWN';
    default:
      return 'UNKNOWN';
  }
}

/** The strictest state in a set, in the order that matters for availability. */
const STATE_SEVERITY = Object.freeze(['FAILED', 'DISABLED', 'RECOVERING', 'UNKNOWN', 'DEGRADED', 'CHECKING', 'UNINITIALIZED', 'READY']);

function strictestState(states) {
  if (states.length === 0) return 'UNKNOWN';
  if (new Set(states).size === 1) return states[0];
  return [...states].sort((a, b) => STATE_SEVERITY.indexOf(a) - STATE_SEVERITY.indexOf(b))[0];
}

/**
 * The bridge state a set of *City module lifecycles* produces.
 *
 * This is the accepted V0.3 rule, unchanged: one deprecated owner is enough to
 * withdraw the promise, an unbuilt or incubating module is pending rather than
 * degraded, any other not-yet-accepted lifecycle is degraded, and a capability
 * with no adapter behind it is pending however healthy its module is.
 */
export function bridgeStateForLifecycles(lifecycles, hasAdapter) {
  if (lifecycles.includes('DEPRECATED')) return 'UNAVAILABLE';
  if (lifecycles.some((lifecycle) => lifecycle === ABSENT_LIFECYCLE || lifecycle === 'PLANNED' || lifecycle === 'INCUBATING')) return 'BRIDGE_PENDING';
  if (lifecycles.some((lifecycle) => lifecycle !== 'PROMOTED' && lifecycle !== 'ACTIVE')) return 'DEGRADED';
  return hasAdapter ? 'AVAILABLE' : 'BRIDGE_PENDING';
}

/**
 * The lifecycle a module reference resolves to when the manifest does not name
 * it.
 *
 * It is not one of the City lifecycles, and it is deliberately not the literal
 * string `UNKNOWN`: a caller that writes `UNKNOWN` as a lifecycle is writing a
 * real declared value that the derivation reports as DEGRADED, while this marker
 * means "the map has no such module" and derives BRIDGE_PENDING — the same
 * bridge state Utopia's registry already produced for an unlisted module.
 */
export const ABSENT_LIFECYCLE = 'NOT_IN_MANIFEST';

/**
 * The bridge state a consumer sees, derived from already-mapped module states.
 *
 * Prefer {@link bridgeStateForLifecycles} when the City lifecycles are at hand:
 * it is the exact rule the accepted V0.3 registry used. This variant exists for
 * callers that already reduced their ownership to routing states.
 */
export function bridgeStateFor({ states, hasAdapter }) {
  if (states.some((state) => state === 'DISABLED' || state === 'FAILED' || state === 'RECOVERING')) return 'UNAVAILABLE';
  if (states.some((state) => state === 'UNKNOWN' || state === 'UNINITIALIZED' || state === 'CHECKING')) return 'BRIDGE_PENDING';
  if (states.some((state) => state === 'DEGRADED')) return 'DEGRADED';
  return hasAdapter ? 'AVAILABLE' : 'BRIDGE_PENDING';
}

/** The state a set of owner lifecycles produces, using the donor's equality rule. */
function lifecycleOf(lifecycles) {
  if (lifecycles.length === 0) return 'UNAVAILABLE';
  const distinct = new Set(lifecycles);
  return distinct.size === 1 ? lifecycles[0] : 'MIXED';
}

/**
 * Build the availability view of a capability from its declared module
 * references and a lifecycle lookup.
 */
export function describeOwnership({ moduleRefs, lifecycleFor, hasAdapter }) {
  const moduleLifecycles = moduleRefs.map((moduleRef) => ({ moduleRef, lifecycle: lifecycleFor(moduleRef) ?? ABSENT_LIFECYCLE }));
  const lifecycles = moduleLifecycles.map((entry) => entry.lifecycle);
  const states = lifecycles.map((lifecycle) => moduleStateForLifecycle(lifecycle));
  return Object.freeze({
    moduleRefs: Object.freeze(moduleRefs.map((moduleRef) => Object.freeze({ ...moduleRef }))),
    moduleLifecycles: Object.freeze(moduleLifecycles.map((entry) => Object.freeze({ moduleRef: Object.freeze({ ...entry.moduleRef }), lifecycle: entry.lifecycle }))),
    cityLifecycle: lifecycleOf(lifecycles),
    moduleState: strictestState(states),
    bridgeState: bridgeStateForLifecycles(lifecycles, hasAdapter),
  });
}

/**
 * Filter candidate modules by a required capability, exactly as the donor's
 * `eligibleCandidates` did: excluded states are named with their reason,
 * DEGRADED candidates are admitted *and* tracked, and an absent state is not
 * treated as capable.
 */
export function eligibleCandidates(candidates, states = {}, requiredCapabilities = []) {
  const selected = [];
  const excluded = [];
  const degraded = [];
  const blocked = [];
  for (const candidate of candidates) {
    const state = MODULE_STATES.includes(states[candidate.id]) ? states[candidate.id] : 'UNKNOWN';
    if (state === 'FAILED' || state === 'DISABLED' || state === 'RECOVERING') {
      excluded.push(Object.freeze({ id: candidate.id, reason: `state ${state} cannot accept work` }));
      if (state === 'FAILED') blocked.push(candidate.id);
      continue;
    }
    const missing = requiredCapabilities.filter((capability) => !candidate.capabilities.includes(capability));
    if (missing.length > 0) {
      excluded.push(Object.freeze({ id: candidate.id, reason: `missing capability: ${missing.join(',')}` }));
      continue;
    }
    if (state === 'UNKNOWN' || state === 'UNINITIALIZED' || state === 'CHECKING') {
      // "Nobody has said" is not "it works".
      excluded.push(Object.freeze({ id: candidate.id, reason: `state ${state} is not evidence that the candidate can accept work` }));
      continue;
    }
    selected.push(candidate.id);
    if (state === 'DEGRADED') degraded.push(candidate.id);
  }
  return Object.freeze({
    selected: Object.freeze(selected),
    excluded: Object.freeze(excluded),
    degraded: Object.freeze(degraded),
    blocked: Object.freeze(blocked),
  });
}

/** Resolve a runtime outcome to a provider lifecycle update. */
export function providerUpdateFor({ runtimeOutcome, errorCode, reason, retryAt, now = Date.now() }) {
  const outcome = runtimeOutcomeForError(errorCode) === runtimeOutcome ? runtimeOutcome : runtimeOutcome ?? runtimeOutcomeForError(errorCode);
  const action = recoveryActionFor(outcome);
  return Object.freeze({
    runtimeOutcome: outcome,
    recoveryAction: action,
    providerState: providerStateFor(action, reason, retryAt, now),
    countsAgainstProvider: !isNonSemanticRuntimeCode(outcome),
  });
}

/**
 * Create the fabric: one registry, one availability view, one bounded history.
 *
 * @param {object} options
 * @param {Array<object>} options.providers provider declarations
 * @param {(moduleRef: object) => string|undefined} [options.lifecycleFor]
 * @param {() => number} [options.now]
 * @param {number} [options.maxInvocations]
 * @param {{rerank?: Function}} [options.routing]
 * @param {(type: string, detail: object) => void} [options.emit]
 */
export function createFabric(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const lifecycleFor = typeof options.lifecycleFor === 'function' ? options.lifecycleFor : () => undefined;
  const maxInvocations = Number.isSafeInteger(options.maxInvocations) && options.maxInvocations > 0 ? options.maxInvocations : MAX_INVOCATIONS;
  const emit = typeof options.emit === 'function' ? options.emit : () => {};
  const rerank = typeof options.routing?.rerank === 'function' ? options.routing.rerank : null;

  const registry = createCapabilityRegistry({
    now,
    maxLookups: Number.isSafeInteger(options.maxLookups) ? options.maxLookups : MAX_LOOKUPS,
    events: { emit: (type, detail) => emit(type, detail) },
  });

  /** capabilityId -> ownership descriptor, kept beside the registry record. */
  const ownership = new Map();
  /** invocationId -> record */
  const invocations = [];
  const sequence = { value: 0 };

  const refusal = (code, status) => {
    const error = new Error(code);
    error.code = code;
    error.status = status;
    return error;
  };

  function registerProvider(input) {
    const result = registry.register(input);
    if (result.ok !== true) return result;
    const moduleRefs = Array.isArray(input.moduleRefs) ? input.moduleRefs : [];
    ownership.set(result.provider.capabilityId, moduleRefs);
    return Object.freeze({ ...result, ownership: describe(result.provider) });
  }

  function describe(provider) {
    const moduleRefs = ownership.get(provider.capabilityId) ?? [];
    return Object.freeze({
      capabilityId: provider.capabilityId,
      name: provider.name,
      describes: provider.describes,
      operations: Object.freeze(provider.operations.map((operationId) => Object.freeze({ operationId }))),
      inputKind: provider.inputKind,
      owner: provider.owner,
      priority: provider.priority,
      version: provider.version,
      fallback: provider.fallback,
      ...describeOwnership({
        moduleRefs,
        lifecycleFor,
        hasAdapter: provider.operations.length > 0,
      }),
    });
  }

  /** Every provider, with its live availability, in capability-id order. */
  function descriptors() {
    return registry.list().map(describe);
  }

  function descriptorFor(capabilityId) {
    const provider = registry.get(capabilityId);
    return provider ? describe(provider) : null;
  }

  /**
   * Choose the providers that may serve a request, hard layer first.
   *
   * The hard layer drops anything UNAVAILABLE, BRIDGE_PENDING or lacking the
   * requested operation. Only what survives is offered to an optional ranking.
   */
  function candidatesFor(capabilityId, operationId) {
    const provider = descriptorFor(capabilityId);
    if (!provider) return { ok: false, code: 'CAPABILITY_NOT_FOUND', status: 404 };
    if (provider.bridgeState !== 'AVAILABLE' && provider.bridgeState !== 'DEGRADED') {
      return { ok: false, code: 'BRIDGE_PENDING', status: 409, provider };
    }
    if (!provider.operations.some((operation) => operation.operationId === operationId)) {
      return { ok: false, code: 'OPERATION_BLOCKED', status: 400, provider };
    }
    const approved = [{ id: provider.capabilityId, capabilities: [operationId], priority: provider.priority, degraded: provider.bridgeState === 'DEGRADED' }];
    let order = approved;
    let adaptation = { applied: false, ignored: [] };
    if (rerank) {
      let proposed;
      try {
        proposed = rerank({ capabilityId, operationId, candidates: approved.map((candidate) => ({ ...candidate })) });
      } catch {
        proposed = undefined;
      }
      if (Array.isArray(proposed)) {
        const known = new Map(approved.map((candidate) => [candidate.id, candidate]));
        const kept = [];
        const ignored = [];
        for (const entry of proposed) {
          const id = typeof entry === 'string' ? entry : entry?.id;
          if (!known.has(id)) {
            ignored.push(String(id));
            continue;
          }
          if (kept.some((candidate) => candidate.id === id)) continue;
          kept.push(known.get(id));
        }
        for (const candidate of approved) if (!kept.some((entry) => entry.id === candidate.id)) kept.push(candidate);
        // A ranking may only reorder; the set is preserved by construction, and
        // anything it invented is reported rather than obeyed.
        order = kept;
        adaptation = { applied: ignored.length === 0, ignored };
      }
    }
    return { ok: true, provider, candidates: Object.freeze(order.map(Object.freeze)), adaptation: Object.freeze({ ...adaptation, ignored: Object.freeze(adaptation.ignored) }) };
  }

  function remember(record) {
    invocations.push(record);
    if (invocations.length > maxInvocations) invocations.splice(0, invocations.length - maxInvocations);
    return record;
  }

  /**
   * Replace an already-recorded invocation in place.
   *
   * This exists because an invocation is recorded once as RUNNING and later
   * settles. Appending the settled row as well would leave the RUNNING row behind
   * forever, which would both count against the concurrency bound and show a
   * finished call as still in flight.
   */
  function settle(index, record) {
    invocations[index] = record;
    return record;
  }

  /**
   * Invoke a capability.
   *
   * The caller supplies the bounded work as `execute`. Everything the fabric
   * promises — the availability check, the operation allowlist, the concurrency
   * bound, the digest, the typed error, the interruption truth — happens around
   * it, in the same order the accepted V0.3 bridge used.
   */
  async function invoke(capabilityId, request, { execute, maxConcurrent = 2 } = {}) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      return remember(fail(capabilityId, request?.operationId ?? null, 'INVALID_INPUT', 400));
    }
    const operationId = request.operationId;
    if (typeof operationId !== 'string' || !operationId) {
      return remember(fail(capabilityId, operationId, 'INVALID_INPUT', 400));
    }
    const chosen = candidatesFor(capabilityId, operationId);
    if (chosen.ok !== true) {
      const provider = descriptorFor(capabilityId);
      return remember(fail(capabilityId, operationId, chosen.code, chosen.status, provider?.bridgeState ?? null));
    }
    const running = invocations.filter((record) => record.status === 'RUNNING').length;
    if (running >= maxConcurrent) {
      return remember(fail(capabilityId, operationId, 'BUSY', 429, chosen.provider.bridgeState));
    }
    if (typeof execute !== 'function') {
      return remember(fail(capabilityId, operationId, 'ADAPTER_UNAVAILABLE', 503, chosen.provider.bridgeState));
    }

    sequence.value += 1;
    const invocationId = `I-${String(sequence.value).padStart(6, '0')}`;
    const startedAt = new Date(now()).toISOString();
    let row = {
      invocationId,
      capabilityId,
      operationId,
      inputClass: chosen.provider.inputKind,
      inputBytes: Buffer.byteLength(JSON.stringify(request.input ?? null)),
      startedAt,
      finishedAt: null,
      status: 'RUNNING',
      errorCode: null,
      runtimeOutcome: null,
      resultDigest: null,
      result: null,
      bridgeState: chosen.provider.bridgeState,
      adaptation: chosen.adaptation,
    };
    remember(row);
    const runningIndex = invocations.length - 1;
    emit('capability.invoked', { invocationId, capabilityId, operationId, bridgeState: row.bridgeState });

    let outcome;
    try {
      outcome = await execute({ capabilityId, operationId, input: request.input, invocationId });
    } catch (error) {
      outcome = { errorCode: typeof error?.code === 'string' && isInvocationErrorCode(error.code) ? error.code : 'ADAPTER_UNAVAILABLE' };
    }
    if (!outcome || typeof outcome !== 'object') outcome = { errorCode: 'ADAPTER_UNAVAILABLE' };

    const errorCode = typeof outcome.errorCode === 'string' && outcome.errorCode ? outcome.errorCode : null;
    const runtimeOutcome = errorCode ? runtimeOutcomeForError(errorCode) : 'SUCCESS';
    const oversized = outcome.result !== undefined && outcome.result !== null && Buffer.byteLength(JSON.stringify(outcome.result)) > 3 * 1024 * 1024;
    const finalError = oversized ? 'RESULT_TOO_LARGE' : errorCode;
    row = {
      ...row,
      finishedAt: new Date(now()).toISOString(),
      status: finalError ? 'FAILED' : 'COMPLETED',
      errorCode: finalError,
      runtimeOutcome: finalError ? runtimeOutcomeForError(finalError) : 'SUCCESS',
      resultDigest: finalError ? null : digest(outcome.result ?? null),
      result: finalError ? null : canonical(outcome.result ?? null),
    };
    const stored = settle(runningIndex, row);
    emit(finalError ? 'capability.failed' : 'capability.completed', {
      invocationId,
      capabilityId,
      status: stored.status,
      errorCode: stored.errorCode,
      runtimeOutcome: stored.runtimeOutcome,
      resultDigest: stored.resultDigest,
    });
    return stored;
  }

  function fail(capabilityId, operationId, errorCode, status, bridgeState = null) {
    sequence.value += 1;
    const at = new Date(now()).toISOString();
    return {
      invocationId: `I-${String(sequence.value).padStart(6, '0')}`,
      capabilityId: capabilityId ?? null,
      operationId: operationId ?? null,
      inputClass: null,
      inputBytes: 0,
      startedAt: at,
      finishedAt: at,
      status: 'FAILED',
      errorCode,
      runtimeOutcome: runtimeOutcomeForError(errorCode),
      resultDigest: null,
      result: null,
      bridgeState,
      httpStatus: status,
      adaptation: null,
    };
  }

  /**
   * Mark invocations that were still running when the process stopped.
   *
   * A restarted process must not leave a RUNNING row behind: reporting a call
   * as still in flight when the process that made it is gone would be a lie, and
   * the donor's bridge recorded exactly this as `INTERRUPTED`.
   */
  function interrupt() {
    const affected = [];
    for (let index = 0; index < invocations.length; index += 1) {
      const row = invocations[index];
      if (row.status !== 'RUNNING') continue;
      const next = { ...row, status: 'INTERRUPTED', finishedAt: new Date(now()).toISOString(), errorCode: 'GATEWAY_RESTARTED', runtimeOutcome: runtimeOutcomeForError('GATEWAY_RESTARTED') };
      invocations[index] = next;
      affected.push(next.invocationId);
      emit('capability.failed', { invocationId: next.invocationId, capabilityId: next.capabilityId, errorCode: 'GATEWAY_RESTARTED' });
    }
    return affected;
  }

  return Object.freeze({
    registry,
    registerProvider,
    revokeProvider: (capabilityId, owner) => {
      const result = registry.revoke(capabilityId, owner);
      if (result.ok === true) ownership.delete(capabilityId);
      return result;
    },
    revokeOwner: (owner) => {
      const revoked = registry.revokeOwner(owner);
      for (const capabilityId of revoked) ownership.delete(capabilityId);
      return revoked;
    },
    descriptors,
    descriptorFor,
    capabilities: () => sortedCapabilityIds(new Map(registry.list().map((provider) => [provider.capabilityId, provider]))),
    resolve: (input) => registry.resolve(input),
    invoke,
    interrupt,
    list: (limit) => {
      const n = limit === undefined ? invocations.length : Number(limit);
      if (!Number.isSafeInteger(n) || n < 1) throw refusal('INVALID_LIMIT', 400);
      return invocations.slice(Math.max(0, invocations.length - n)).map((row) => {
        // A summary is a summary: the stored result is removed rather than set
        // to undefined, so `'result' in summary` is false and `resultAvailable`
        // is the only thing that tells a caller whether a detail still exists.
        const { result, ...summary } = row;
        return { ...summary, resultAvailable: row.status === 'COMPLETED' && result !== null && result !== undefined };
      });
    },
    get: (invocationId) => invocations.find((row) => row.invocationId === invocationId) ?? null,
    classify: (input) => deriveSemanticEvaluation(input),
    missingRequired: (requirements) => registry.missingRequired(requirements),
  });
}

export { FABRIC_REASONS };
