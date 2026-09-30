/**
 * UTOPIA - City Service Network - capability fabric parity tests.
 *
 * Every test below names the donor behaviour it holds, so a Verification Host
 * can check the migration against the donor without reading this author's prose.
 * The donor SHAs are in `DONOR.json`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_PRIORITY,
  FABRIC_REASONS,
  FABRIC_API_VERSION,
  NON_SEMANTIC_RUNTIME_CODES,
  RUNTIME_OUTCOMES,
  canonical,
  capabilityDescriptor,
  capabilityRequirement,
  digest,
  isNonSemanticRuntimeCode,
  providerStateFor,
  recoveryActionFor,
  runtimeOutcomeForError,
} from '../contracts.mjs';
import { compareProviders, createCapabilityRegistry, sortedCapabilityIds } from '../registry.mjs';
import {
  aggregateHealth,
  createProviderLedger,
  deriveProviderState,
  normalizeHealth,
  reactionFor,
} from '../providers.mjs';
import {
  OUTCOME_AXES,
  OUTCOME_EVALUATOR_VERSION,
  SEMANTIC_OUTCOMES,
  createEvaluationRevision,
  deriveSemanticEvaluation,
  detectGoalDrift,
} from '../outcome.mjs';
import {
  bridgeStateForLifecycles,
  createFabric,
  describeOwnership,
  eligibleCandidates,
  moduleStateForLifecycle,
  providerUpdateFor,
} from '../routing.mjs';
import { LOCK_REASONS, compareLock, parseLock, renderLock, verifyLock, writeLock } from '../lock.mjs';

const provider = (overrides = {}) => ({
  capabilityId: 'planning.knowledge.query',
  name: 'Knowledge Query',
  describes: 'Answer a query from the knowledge core.',
  owner: 'provider.test',
  operations: ['query'],
  inputKind: 'knowledge',
  ...overrides,
});

// ---------------------------------------------------------------------------
// Registry - DS-Hns app/core/capability-registry/index.cjs
// ---------------------------------------------------------------------------

test('a capability resolves by name, never by provider identity', () => {
  const registry = createCapabilityRegistry();
  assert.equal(registry.register(provider({ capabilityId: 'work', owner: 'provider.a' })).ok, true);
  const resolved = registry.resolve({ capabilityId: 'work' });
  assert.equal(resolved.owner, 'provider.a');
  assert.equal(registry.has('provider.a'), false, 'the registry is not addressable by owner');
});

test('a missing required capability is recorded as a miss and emits, an optional one only records', () => {
  const registry = createCapabilityRegistry();
  const events = [];
  const resolving = createCapabilityRegistry({ events: { emit: (type, detail) => events.push({ type, detail }) } });
  assert.equal(registry.resolve('nothing-provides-this'), null);
  assert.equal(registry.misses().length, 1);
  assert.equal(registry.misses()[0].reason, FABRIC_REASONS.MISSING);
  assert.equal(resolving.resolve({ capabilityId: 'absent', optional: true, by: 'consumer.x' }), null);
  assert.equal(resolving.misses().length, 1, 'an optional miss is still on the record');
  assert.deepEqual(events, [], 'an optional miss is a normal composition');
  resolving.resolve({ capabilityId: 'absent', by: 'consumer.x' });
  assert.deepEqual(events.map((entry) => entry.type), ['capability.missing']);
});

test('a required-capability gate names every capability nothing provides', () => {
  const registry = createCapabilityRegistry();
  registry.register(provider({ capabilityId: 'work', owner: 'provider.a' }));
  assert.deepEqual(registry.missingRequired(['work', 'rest']), ['rest']);
  assert.deepEqual(registry.missingRequired([]), []);
  registry.recordMiss('rest', 'consumer.one');
  assert.equal(registry.misses().at(-1).source, 'requirement');
});

test('one capability has exactly one owner, and a second owner is refused at registration', () => {
  const registry = createCapabilityRegistry();
  assert.equal(registry.register(provider({ capabilityId: 'work', owner: 'provider.a' })).ok, true);
  const clash = registry.register(provider({ capabilityId: 'work', owner: 'provider.b', priority: 50 }));
  assert.equal(clash.ok, false);
  assert.equal(clash.conflict.owners[0], 'provider.a');
  assert.match(clash.reason, /already owned by provider\.a/);
  assert.equal(registry.get('work').owner, 'provider.a', 'the refusal left the winner in place');
});

test('the same owner re-registering its own capability is an update, not a conflict', () => {
  const registry = createCapabilityRegistry();
  registry.register(provider({ capabilityId: 'work', owner: 'provider.a', priority: 10 }));
  const updated = registry.register(provider({ capabilityId: 'work', owner: 'provider.a', priority: 90 }));
  assert.equal(updated.ok, true);
  assert.equal(updated.provider.priority, 90);
  assert.equal(updated.provider.replaced, true);
  assert.equal(registry.size, 1);
});

test('priority orders providers and the order is total, not insertion order', () => {
  assert.ok(compareProviders({ priority: 80, owner: 'a' }, { priority: 10, owner: 'b' }) < 0);
  assert.ok(compareProviders({ priority: 50, owner: 'a' }, { priority: 50, owner: 'b' }) < 0);
  assert.deepEqual(sortedCapabilityIds(new Map([['b', 1], ['a', 2]])), ['a', 'b']);
  const registry = createCapabilityRegistry();
  registry.register(provider({ capabilityId: 'work', owner: 'provider.low', priority: 10 }));
  assert.equal(registry.resolve('work').priority, 10);
});

test('a provider that does not say what it can do is refused', () => {
  const registry = createCapabilityRegistry();
  const refused = registry.register(provider({ describes: '   ' }));
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /describes/);
  assert.throws(() => capabilityDescriptor(provider({ describes: '' })), { code: 'INVALID_INPUT' });
});

test('unloading an owner revokes everything it provided, and the miss says why', () => {
  const registry = createCapabilityRegistry();
  registry.register(provider({ capabilityId: 'watch', owner: 'provider.a' }));
  registry.register(provider({ capabilityId: 'work', owner: 'provider.a' }));
  registry.register(provider({ capabilityId: 'other', owner: 'provider.b' }));
  assert.deepEqual(registry.revokeOwner('provider.a'), ['watch', 'work']);
  assert.deepEqual(registry.capabilities(), ['other']);
  assert.equal(registry.resolve('watch'), null);
  assert.equal(registry.misses().at(-1).reason, FABRIC_REASONS.REVOKED, 'a revoked capability is not merely missing');
});

test('revoking one capability is owner-checked', () => {
  const registry = createCapabilityRegistry();
  registry.register(provider({ capabilityId: 'work', owner: 'provider.a' }));
  assert.equal(registry.revoke('work', 'provider.b').ok, false);
  const revoked = registry.revoke('work', 'provider.a');
  assert.equal(revoked.ok, true);
  assert.equal(revoked.provider.capabilityId, 'work');
  assert.equal(registry.size, 0);
});

test('the lookup log is bounded and returned as copies', () => {
  const registry = createCapabilityRegistry({ maxLookups: 3 });
  for (let index = 0; index < 6; index += 1) registry.resolve(`c${index}`);
  assert.equal(registry.lookups().length, 3);
  const read = registry.lookups();
  read.push('mutated');
  assert.equal(registry.lookups().length, 3, 'a read cannot mutate the registry');
});

// ---------------------------------------------------------------------------
// Provider lifecycle - DS-Hns app/core/plugin-manager/index.cjs
// ---------------------------------------------------------------------------

test('the four lifecycle questions stay separate and the derived state has a fixed order', () => {
  const ledger = createProviderLedger();
  ledger.register({ owner: 'provider.a', enabled: false, faultLevel: 'degraded' });
  assert.equal(ledger.status('provider.a').state, 'disabled');
  ledger.setEnabled('provider.a', true);
  assert.equal(ledger.status('provider.a').state, 'enabled');
  ledger.load('provider.a');
  assert.equal(ledger.status('provider.a').state, 'loaded');
  ledger.checkHealth('provider.a', () => ({ status: 'HEALTHY' }));
  assert.equal(ledger.status('provider.a').state, 'healthy');
  ledger.checkHealth('provider.a', () => ({ status: 'UNHEALTHY', reason: 'probe says no' }));
  assert.equal(ledger.status('provider.a').state, 'unhealthy');
});

test('a disabled provider is refused a load unless forced, and a second load is a no-op', () => {
  const ledger = createProviderLedger();
  ledger.register({ owner: 'provider.a', enabled: false });
  const refused = ledger.load('provider.a');
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'PLUGIN_DISABLED');
  assert.equal(ledger.load('provider.a', { force: true }).ok, true);
  const again = ledger.load('provider.a');
  assert.equal(again.ok, true);
  assert.equal(again.already, true);
});

test('a duplicate owner is refused and an unknown owner is a coded refusal, never a throw', () => {
  const ledger = createProviderLedger();
  assert.equal(ledger.register({ owner: 'provider.a' }).ok, true);
  assert.equal(ledger.register({ owner: 'provider.a' }).code, 'PLUGIN_DUPLICATE_ID');
  assert.equal(ledger.load('provider.ghost').code, 'PLUGIN_NOT_FOUND');
  assert.equal(ledger.status('provider.ghost').ok, false);
});

test('a throwing health probe is contained and never escapes', () => {
  const ledger = createProviderLedger();
  ledger.register({ owner: 'provider.a' });
  ledger.load('provider.a');
  const result = ledger.checkHealth('provider.a', () => {
    throw new Error('the probe exploded');
  });
  assert.equal(result.ok, true);
  assert.equal(result.health.status, 'UNHEALTHY');
  assert.match(result.health.reason, /probe exploded/);
  assert.equal(result.record.healthy, false);
});

test('an unasked or unparseable health answer stays UNKNOWN, never HEALTHY', () => {
  assert.equal(normalizeHealth(undefined).status, 'UNKNOWN');
  assert.equal(normalizeHealth({ status: 'PROBABLY_FINE' }).status, 'UNKNOWN');
  assert.equal(normalizeHealth({ status: 'HEALTHY' }).status, 'HEALTHY');
  const ledger = createProviderLedger();
  ledger.register({ owner: 'provider.a' });
  ledger.load('provider.a');
  assert.equal(ledger.checkHealth('provider.a').health.status, 'UNKNOWN');
  assert.equal(ledger.status('provider.a').healthy, null, 'unknown is not healthy and not unhealthy');
});

test('unloading releases the capability and resets the restart budget', () => {
  const released = [];
  const ledger = createProviderLedger({ onRelease: (owner) => released.push(owner) });
  ledger.register({ owner: 'provider.a' });
  ledger.load('provider.a');
  ledger.recordRestart('provider.a');
  assert.equal(ledger.restartCount('provider.a'), 1);
  ledger.unload('provider.a');
  assert.deepEqual(released, ['provider.a']);
  assert.equal(ledger.status('provider.a').loaded, false);
  assert.equal(ledger.restartCount('provider.a'), 0);
});

test('a provider fault is recorded at its declared level and contains the provider', () => {
  const ledger = createProviderLedger();
  ledger.register({ owner: 'provider.soft', faultLevel: 'soft' });
  ledger.register({ owner: 'provider.fatal', faultLevel: 'fatal' });
  ledger.loadAll(['provider.soft', 'provider.fatal']);
  ledger.fault('provider.soft', { code: 'PLUGIN_LOAD_FAILED', reason: 'it threw' });
  const status = ledger.status('provider.soft');
  assert.equal(status.state, 'enabled', 'the failed load left it enabled, not loaded');
  assert.equal(status.fault.level, 'soft');
  assert.equal(status.faults.length, 1);
});

test('the health reaction ladder is the donor order: fatal stops, soft ignores, then budget', () => {
  assert.deepEqual(
    reactionFor({ healthy: true, healthReason: null, faultLevel: 'fatal', attempts: 9, maxRestarts: 2 }).action,
    'none',
    'a healthy fatal provider is not stopped',
  );
  assert.deepEqual(
    reactionFor({ healthy: null, healthReason: null, faultLevel: 'fatal', attempts: 9, maxRestarts: 2 }).action,
    'none',
    'unknown is not evidence of a fault',
  );
  assert.equal(reactionFor({ healthy: false, healthReason: 'x', faultLevel: 'fatal', attempts: 0, maxRestarts: 2 }).action, 'stop');
  assert.equal(reactionFor({ healthy: false, healthReason: 'x', faultLevel: 'soft', attempts: 0, maxRestarts: 2 }).action, 'ignore');
  assert.equal(reactionFor({ healthy: false, healthReason: 'x', faultLevel: 'degraded', attempts: 0, maxRestarts: 2 }).action, 'restart');
  assert.equal(reactionFor({ healthy: false, healthReason: 'x', faultLevel: 'degraded', attempts: 2, maxRestarts: 2 }).action, 'degrade');
});

test('the aggregate verdict is blocked, degraded or healthy and names the providers', () => {
  const ledger = createProviderLedger();
  ledger.register({ owner: 'provider.a' });
  ledger.register({ owner: 'provider.b', faultLevel: 'fatal' });
  ledger.loadAll(['provider.a', 'provider.b']);
  ledger.checkHealth('provider.a', () => ({ status: 'HEALTHY' }));
  ledger.checkHealth('provider.b', () => ({ status: 'UNHEALTHY', reason: 'gone' }));
  const aggregate = ledger.aggregate();
  assert.equal(aggregate.status, 'blocked');
  assert.deepEqual(aggregate.fatal, ['provider.b']);
  assert.equal(aggregate.unknown.length, 0);
  assert.equal(aggregateHealth([]).status, 'healthy', 'nothing registered is not degraded');
  assert.equal(deriveProviderState(null), 'not-registered');
});

// ---------------------------------------------------------------------------
// Outcome - Codex-Boss src/shared/provider-outcome.ts
// ---------------------------------------------------------------------------

test('a runtime-layer fault is never evidence about the provider', () => {
  for (const code of NON_SEMANTIC_RUNTIME_CODES) {
    const evaluation = deriveSemanticEvaluation({ runtimeOutcome: 'SUCCESS', runtimeFailureCode: code, content: 'anything' });
    assert.equal(evaluation.outcome, 'UNCLASSIFIED', code);
    assert.equal(evaluation.confidence, 0, code);
    assert.equal(evaluation.runtimeAttributable, true, code);
    assert.equal(evaluation.penalizesSemanticProfile, false, code);
    assert.deepEqual(evaluation.axes, OUTCOME_AXES.UNCLASSIFIED, code);
  }
  const notSuccessful = deriveSemanticEvaluation({ runtimeOutcome: 'TIMEOUT', content: 'x' });
  assert.equal(notSuccessful.penalizesSemanticProfile, false);
});

test('an explicit refusal inside a successful call is semantic, not a runtime failure', () => {
  const evaluation = deriveSemanticEvaluation({ runtimeOutcome: 'SUCCESS', content: 'I cannot help with that.', signals: { refusal: true } });
  assert.equal(evaluation.outcome, 'HARD_REFUSAL');
  assert.equal(evaluation.runtimeAttributable, false);
  assert.equal(evaluation.penalizesSemanticProfile, true);
  assert.equal(evaluation.axes.restrictionImpact, 1);
});

test('a deterministic verification or format failure outranks provider behaviour', () => {
  assert.equal(
    deriveSemanticEvaluation({ runtimeOutcome: 'SUCCESS', content: 'x', signals: { refusal: true, verificationPassed: false } }).outcome,
    'VERIFICATION_FAILURE',
  );
  assert.equal(
    deriveSemanticEvaluation({ runtimeOutcome: 'SUCCESS', content: 'x', signals: { refusal: true, formatOk: false } }).outcome,
    'FORMAT_FAILURE',
  );
});

test('an unobservable success is UNCLASSIFIED rather than a fabricated completion', () => {
  const evaluation = deriveSemanticEvaluation({ runtimeOutcome: 'SUCCESS', content: '   ' });
  assert.equal(evaluation.outcome, 'UNCLASSIFIED');
  assert.equal(evaluation.penalizesSemanticProfile, false);
});

test('the classifier walks completion coverage, drift and quality in the donor order', () => {
  assert.equal(deriveSemanticEvaluation({ runtimeOutcome: 'SUCCESS', content: 'ok', signals: { driftEvidence: ['scope-change marker: x'] } }).outcome, 'GOAL_DRIFT');
  assert.equal(deriveSemanticEvaluation({ runtimeOutcome: 'SUCCESS', content: 'ok', signals: { deliverablesCovered: 0.5 } }).outcome, 'PARTIAL_COMPLETION');
  assert.equal(deriveSemanticEvaluation({ runtimeOutcome: 'SUCCESS', content: 'ok', signals: { deliverablesCovered: 0.5, badQuality: true } }).outcome, 'BAD_QUALITY');
  assert.equal(deriveSemanticEvaluation({ runtimeOutcome: 'SUCCESS', content: 'ok', signals: { quality: 0.1 } }).outcome, 'BAD_QUALITY');
  const full = deriveSemanticEvaluation({ runtimeOutcome: 'SUCCESS', content: 'the answer' });
  assert.equal(full.outcome, 'FULL_COMPLETION');
  assert.equal(full.confidence, 0.7);
  assert.equal(full.evaluatorVersion, OUTCOME_EVALUATOR_VERSION);
  assert.equal(SEMANTIC_OUTCOMES.length, 11);
});

test('goal drift is reported, never rewritten', () => {
  const drift = detectGoalDrift({ deliverables: ['the quarterly report', 'a risk table'] }, 'instead of the requested report, here is a poem');
  assert.equal(drift.drifted, true);
  assert.ok(drift.evidence.some((line) => line.startsWith('scope-change marker:')));
  assert.ok(drift.evidence.some((line) => line.includes('risk table')));
  assert.equal(detectGoalDrift({ deliverables: [] }, 'anything').drifted, false);
  const addressed = detectGoalDrift({ deliverables: ['quarterly report'] }, 'here is the quarterly report');
  assert.equal(addressed.drifted, false);
});

test('an evaluator revision is appended and never overwrites the original', () => {
  const original = deriveSemanticEvaluation({ runtimeOutcome: 'TIMEOUT' });
  const revised = deriveSemanticEvaluation({ runtimeOutcome: 'SUCCESS', content: 'ok' });
  const revision = createEvaluationRevision({ episodeId: 'E-1', original, revised, reason: 're-judged after a fix', revisedAt: '2026-01-01T00:00:00.000Z' });
  assert.equal(revision.originalOutcome, 'UNCLASSIFIED');
  assert.equal(revision.revised.outcome, 'FULL_COMPLETION');
  assert.equal(revision.originalEvaluatorVersion, original.evaluatorVersion);
});

// ---------------------------------------------------------------------------
// Provider state - Codex-Boss src/shared/provider-state.ts
// ---------------------------------------------------------------------------

test('the provider lifecycle is two named states with an explicit autoResume flag', () => {
  const waiting = providerStateFor('RETRY', 'rate limited', 1000, 0);
  assert.equal(waiting.state, 'WAITING_PROVIDER');
  assert.equal(waiting.autoResume, true);
  assert.equal(waiting.retryAt, 1000);
  const paused = providerStateFor('VERIFY_SIDE_EFFECT', 'check the side effect', undefined, 0);
  assert.equal(paused.state, 'PAUSED_PROVIDER');
  assert.equal(paused.autoResume, false);
  assert.equal(Object.hasOwn(paused, 'retryAt'), false, 'an undefined deadline is absent, not zero');
  const active = providerStateFor('NONE', 'running', undefined, 0);
  assert.equal(active.state, 'ACTIVE');
  assert.equal(active.autoResume, true);
  const unknown = providerStateFor('SOMETHING_ELSE', '', undefined, 0);
  assert.equal(unknown.state, 'ACTIVE', 'an unknown action is ACTIVE, not a throw and not PAUSED');
});

test('the runtime outcome maps to a recovery action and a provider update', () => {
  assert.equal(recoveryActionFor('TIMEOUT'), 'RETRY');
  assert.equal(recoveryActionFor('AUTH_REQUIRED'), 'HUMAN_REQUIRED');
  assert.equal(recoveryActionFor('INVALID_INPUT'), 'NONE');
  assert.equal(recoveryActionFor('SUCCESS'), 'NONE');
  assert.equal(runtimeOutcomeForError('EXECUTION_TIMEOUT'), 'TIMEOUT');
  assert.equal(runtimeOutcomeForError('GATEWAY_RESTARTED'), 'UNAVAILABLE');
  const update = providerUpdateFor({ runtimeOutcome: 'TIMEOUT', reason: 'slow', now: 0 });
  assert.equal(update.providerState.state, 'WAITING_PROVIDER');
  assert.equal(update.countsAgainstProvider, false, 'a timeout says nothing about the provider');
  assert.equal(providerUpdateFor({ runtimeOutcome: 'UNSUPPORTED', now: 0 }).countsAgainstProvider, false);
  assert.equal(providerUpdateFor({ runtimeOutcome: 'SUCCESS', now: 0 }).countsAgainstProvider, true);
});

// ---------------------------------------------------------------------------
// Routing and invocation - Codex-Boss capability-router / role-router,
// Utopia V0.3 capability-bridge behaviour
// ---------------------------------------------------------------------------

const moduleRef = (id) => ({ districtId: '09-planning-knowledge', buildingId: '01-knowledge-service', moduleId: id });

test('the City lifecycle maps onto a routing state and availability is lifecycle-derived', () => {
  assert.equal(moduleStateForLifecycle('ACTIVE'), 'READY');
  assert.equal(moduleStateForLifecycle('PROMOTED'), 'READY');
  assert.equal(moduleStateForLifecycle('INCUBATING'), 'DEGRADED');
  assert.equal(moduleStateForLifecycle('DEPRECATED'), 'DISABLED');
  assert.equal(moduleStateForLifecycle('PLANNED'), 'UNKNOWN');
  const lifecycles = { a: 'ACTIVE', b: 'PROMOTED', c: 'INCUBATING', d: 'PLANNED', e: 'DEPRECATED' };
  const ownership = (id) => describeOwnership({ moduleRefs: [moduleRef(id)], lifecycleFor: (ref) => lifecycles[ref.moduleId], hasAdapter: true });
  assert.equal(ownership('a').bridgeState, 'AVAILABLE');
  assert.equal(ownership('c').bridgeState, 'BRIDGE_PENDING');
  assert.equal(ownership('d').bridgeState, 'BRIDGE_PENDING');
  assert.equal(ownership('e').bridgeState, 'UNAVAILABLE');
  assert.equal(describeOwnership({ moduleRefs: [moduleRef('a'), moduleRef('c')], lifecycleFor: (ref) => lifecycles[ref.moduleId], hasAdapter: true }).bridgeState, 'BRIDGE_PENDING');
  assert.equal(describeOwnership({ moduleRefs: [moduleRef('a'), moduleRef('e')], lifecycleFor: (ref) => lifecycles[ref.moduleId], hasAdapter: true }).bridgeState, 'UNAVAILABLE');
  assert.equal(describeOwnership({ moduleRefs: [moduleRef('a')], lifecycleFor: () => undefined, hasAdapter: true }).bridgeState, 'BRIDGE_PENDING');
  assert.equal(describeOwnership({ moduleRefs: [moduleRef('a')], lifecycleFor: () => undefined, hasAdapter: true }).cityLifecycle, 'NOT_IN_MANIFEST', 'an unlisted module is reported as absent, not as an accepted lifecycle');
  assert.equal(describeOwnership({ moduleRefs: [moduleRef('a')], lifecycleFor: (ref) => lifecycles[ref.moduleId], hasAdapter: false }).bridgeState, 'BRIDGE_PENDING');
  assert.equal(bridgeStateForLifecycles(['ACTIVE', 'PROMOTED'], true), 'AVAILABLE');
  assert.equal(bridgeStateForLifecycles(['ACTIVE'], false), 'BRIDGE_PENDING');
});

test('hard eligibility excludes failed, disabled, recovering and unknown candidates and tracks degraded ones', () => {
  const candidates = ['ready', 'degraded', 'unknown', 'failed', 'disabled', 'recovering', 'incapable'].map((id) => ({ id, capabilities: id === 'incapable' ? [] : ['work'] }));
  const states = { ready: 'READY', degraded: 'DEGRADED', unknown: 'UNKNOWN', failed: 'FAILED', disabled: 'DISABLED', recovering: 'RECOVERING' };
  const result = eligibleCandidates(candidates, states, ['work']);
  assert.deepEqual(result.selected, ['ready', 'degraded']);
  assert.deepEqual(result.degraded, ['degraded'], 'degraded is admitted AND tracked');
  assert.deepEqual(result.blocked, ['failed']);
  const reasons = Object.fromEntries(result.excluded.map((entry) => [entry.id, entry.reason]));
  assert.match(reasons.unknown, /not evidence that the candidate can accept work/);
  assert.match(reasons.incapable, /missing capability: work/);
});

function fabricWithProviders({ lifecycleFor = () => 'ACTIVE', providers } = {}) {
  const events = [];
  const fabric = createFabric({ lifecycleFor, emit: (type, detail) => events.push({ type, detail }) });
  for (const declaration of providers) {
    const result = fabric.registerProvider(declaration);
    assert.equal(result.ok, true, result.reason);
  }
  return { fabric, events };
}

test('an invocation validates the operation against the provider allowlist before any work runs', async () => {
  const { fabric } = fabricWithProviders({
    providers: [provider({ capabilityId: 'work', owner: 'provider.a', operations: ['read'], moduleRefs: [moduleRef('a')] })],
  });
  let ran = 0;
  const blocked = await fabric.invoke('work', { operationId: 'write' }, { execute: () => { ran += 1; return { result: 1 }; } });
  assert.equal(blocked.status, 'FAILED');
  assert.equal(blocked.errorCode, 'OPERATION_BLOCKED');
  assert.equal(ran, 0, 'no work runs for a blocked operation');
  const missing = await fabric.invoke('nope', { operationId: 'read' }, { execute: () => ({ result: 1 }) });
  assert.equal(missing.errorCode, 'CAPABILITY_NOT_FOUND');
});

test('a capability whose owner is not accepted answers BRIDGE_PENDING and runs nothing', async () => {
  const { fabric } = fabricWithProviders({
    lifecycleFor: () => 'INCUBATING',
    providers: [provider({ capabilityId: 'work', owner: 'provider.a', operations: ['read'], moduleRefs: [moduleRef('a')] })],
  });
  let ran = 0;
  const pending = await fabric.invoke('work', { operationId: 'read' }, { execute: () => { ran += 1; return { result: 1 }; } });
  assert.equal(pending.errorCode, 'BRIDGE_PENDING');
  assert.equal(pending.httpStatus, 409);
  assert.equal(ran, 0);
});

test('a completed invocation carries a stable digest of its canonical result', async () => {
  const fabric = createFabric({ lifecycleFor: () => 'ACTIVE' });
  fabric.registerProvider(provider({ capabilityId: 'work', owner: 'provider.a', operations: ['read'], moduleRefs: [moduleRef('a')] }));
  const row = await fabric.invoke('work', { operationId: 'read', input: { b: 1, a: 2 } }, { execute: () => ({ result: { z: 1, y: [2, 1] } }) });
  assert.equal(row.status, 'COMPLETED');
  assert.equal(row.resultDigest, digest({ z: 1, y: [2, 1] }));
  assert.equal(digest({ a: 2, b: 1 }), digest({ b: 1, a: 2 }), 'canonical order is not insertion order');
  assert.equal(canonical({ b: 1, a: 2 }).a, 2);
  assert.throws(() => canonical({ n: Number.NaN }), { code: 'INVALID_INPUT' });
});

test('a typed error survives, an unknown throw becomes ADAPTER_UNAVAILABLE, and an oversized result is refused', async () => {
  const fabric = createFabric({ lifecycleFor: () => 'ACTIVE' });
  fabric.registerProvider(provider({ capabilityId: 'work', owner: 'provider.a', operations: ['read'], moduleRefs: [moduleRef('a')] }));
  const typed = await fabric.invoke('work', { operationId: 'read' }, { execute: () => { throw Object.assign(new Error('boom'), { code: 'EXECUTION_TIMEOUT' }); } });
  assert.equal(typed.errorCode, 'EXECUTION_TIMEOUT');
  assert.equal(typed.runtimeOutcome, 'TIMEOUT');
  const unknown = await fabric.invoke('work', { operationId: 'read' }, { execute: () => { throw new Error('no code'); } });
  assert.equal(unknown.errorCode, 'ADAPTER_UNAVAILABLE');
  const huge = await fabric.invoke('work', { operationId: 'read' }, { execute: () => ({ result: { blob: 'x'.repeat(3 * 1024 * 1024 + 16) } }) });
  assert.equal(huge.errorCode, 'RESULT_TOO_LARGE');
  assert.equal(huge.resultDigest, null);
});

test('concurrency is bounded so one caller cannot exhaust the process', async () => {
  const fabric = createFabric({ lifecycleFor: () => 'ACTIVE', maxInvocations: 50 });
  fabric.registerProvider(provider({ capabilityId: 'work', owner: 'provider.a', operations: ['read'], moduleRefs: [moduleRef('a')] }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = fabric.invoke('work', { operationId: 'read' }, { execute: async () => { await gate; return { result: 1 }; } });
  const second = fabric.invoke('work', { operationId: 'read' }, { execute: async () => { await gate; return { result: 2 }; } });
  const third = await fabric.invoke('work', { operationId: 'read' }, { execute: () => ({ result: 3 }) });
  assert.equal(third.errorCode, 'BUSY');
  release();
  await Promise.all([first, second]);
});

test('a restart marks in-flight invocations INTERRUPTED rather than leaving them running', async () => {
  const fabric = createFabric({ lifecycleFor: () => 'ACTIVE', maxInvocations: 10 });
  fabric.registerProvider(provider({ capabilityId: 'work', owner: 'provider.a', operations: ['read'], moduleRefs: [moduleRef('a')] }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const inFlight = fabric.invoke('work', { operationId: 'read' }, { execute: async () => { await gate; return { result: 1 }; } });
  const affected = fabric.interrupt();
  assert.equal(affected.length, 1);
  const row = fabric.get(affected[0]);
  assert.equal(row.status, 'INTERRUPTED');
  assert.equal(row.errorCode, 'GATEWAY_RESTARTED');
  assert.equal(fabric.list().find((entry) => entry.invocationId === affected[0]).resultAvailable, false);
  assert.equal(fabric.interrupt().length, 0, 'interrupting twice reports nothing the second time');
  release();
  await inFlight;
});

test('a learned ranking may reorder the approved candidates and nothing else', async () => {
  const declarations = [provider({ capabilityId: 'work', owner: 'provider.a', operations: ['read'], moduleRefs: [moduleRef('a')] })];
  const applied = createFabric({ lifecycleFor: () => 'ACTIVE', routing: { rerank: (request) => request.candidates.map((candidate) => candidate.id) } });
  applied.registerProvider(declarations[0]);
  assert.equal(applied.descriptorFor('work').bridgeState, 'AVAILABLE');

  const inventing = createFabric({ lifecycleFor: () => 'ACTIVE', routing: { rerank: () => [{ id: 'work' }, { id: 'not-approved' }] } });
  inventing.registerProvider(declarations[0]);
  const row = await inventing.invoke('work', { operationId: 'read' }, { execute: () => ({ result: 1 }) });
  assert.equal(row.status, 'COMPLETED');
  assert.deepEqual(row.adaptation.ignored, ['not-approved']);
  assert.equal(row.adaptation.applied, false);

  const throwing = createFabric({ lifecycleFor: () => 'ACTIVE', routing: { rerank: () => { throw new Error('scorer broke'); } } });
  throwing.registerProvider(declarations[0]);
  const survived = await throwing.invoke('work', { operationId: 'read' }, { execute: () => ({ result: 1 }) });
  assert.equal(survived.status, 'COMPLETED', 'a throwing ranking leaves the deterministic order untouched');
});

test('the fabric reports only the capabilities that exist and revokes with their owner', () => {
  const { fabric, events } = fabricWithProviders({
    lifecycleFor: (ref) => (ref.moduleId === 'b' ? 'INCUBATING' : 'ACTIVE'),
    providers: [
      provider({ capabilityId: 'work', owner: 'provider.a', operations: ['read'], moduleRefs: [moduleRef('a')] }),
      provider({ capabilityId: 'helper', owner: 'provider.a', operations: ['read'], moduleRefs: [moduleRef('b')] }),
    ],
  });
  const described = fabric.descriptors();
  assert.deepEqual(described.map((entry) => entry.capabilityId), ['helper', 'work']);
  assert.equal(described.find((entry) => entry.capabilityId === 'work').bridgeState, 'AVAILABLE');
  assert.equal(described.find((entry) => entry.capabilityId === 'helper').bridgeState, 'BRIDGE_PENDING');
  assert.deepEqual(fabric.revokeOwner('provider.a'), ['helper', 'work']);
  assert.equal(fabric.descriptors().length, 0);
  assert.ok(events.some((entry) => entry.type === 'capability.revoked'));
  assert.equal(fabric.resolve('work'), null);
});

test('the invocation list is bounded and a summary never leaks the stored result', async () => {
  const fabric = createFabric({ lifecycleFor: () => 'ACTIVE', maxInvocations: 3 });
  fabric.registerProvider(provider({ capabilityId: 'work', owner: 'provider.a', operations: ['read'], moduleRefs: [moduleRef('a')] }));
  for (let index = 0; index < 5; index += 1) {
    await fabric.invoke('work', { operationId: 'read' }, { execute: () => ({ result: { index } }) });
  }
  const listed = fabric.list();
  assert.equal(listed.length, 3);
  assert.equal(Object.hasOwn(listed[0], 'result'), false);
  assert.equal(listed[0].resultAvailable, true);
  assert.throws(() => fabric.list(0), { code: 'INVALID_LIMIT' });
});

// ---------------------------------------------------------------------------
// Lock - DS-Hns app/core/lockfile/index.cjs
// ---------------------------------------------------------------------------

test('rendering a lock sorts ids so an unchanged composition keeps the same bytes', () => {
  const a = renderLock({ b: { owner: 'p.b', version: '2.0.0' }, a: { owner: 'p.a', version: null } });
  const b = renderLock({ a: { owner: 'p.a', version: '0.0.0' }, b: { owner: 'p.b', version: '2.0.0' } });
  assert.equal(a, b);
  assert.ok(a.indexOf('"a"') < a.indexOf('"b"'));
});

test('the parser refuses what it does not understand instead of guessing', () => {
  assert.equal(parseLock('').ok, false);
  assert.equal(parseLock('not json').ok, false);
  assert.equal(parseLock('[]').ok, false);
  assert.equal(parseLock(JSON.stringify({ lockVersion: 99, capabilities: {} })).ok, false);
  assert.equal(parseLock(JSON.stringify({ lockVersion: 1, capabilities: { 'Not An Id': { owner: 'p' } } })).ok, false);
  assert.equal(parseLock(JSON.stringify({ lockVersion: 1, capabilities: { a: { owner: '' } } })).ok, false);
  const ok = parseLock(renderLock({ a: { owner: 'p.a', version: '1.0.0' } }));
  assert.equal(ok.ok, true);
  assert.equal(ok.capabilities.a.owner, 'p.a');
});

test('drift is an exact owner/version set diff with a reason naming every class', () => {
  const comparison = compareLock({ a: { owner: 'p.a', version: '1.0.0' }, gone: { owner: 'p.g', version: '1.0.0' } }, [
    { capabilityId: 'a', owner: 'p.a', version: '2.0.0' },
    { capabilityId: 'added', owner: 'p.n', version: '1.0.0' },
  ]);
  assert.equal(comparison.ok, false);
  assert.equal(comparison.drift, 3);
  assert.deepEqual(comparison.changed.map((entry) => entry.capabilityId), ['a']);
  assert.deepEqual(comparison.added.map((entry) => entry.capabilityId), ['added']);
  assert.deepEqual(comparison.removed.map((entry) => entry.capabilityId), ['gone']);
  assert.match(comparison.reason, /a 1\.0\.0 -> 2\.0\.0/);
  assert.match(comparison.reason, /gone/);
  assert.equal(compareLock({ a: { owner: 'p.a', version: '1.0.0' } }, [{ capabilityId: 'a', owner: 'p.a', version: '1.0.0' }]).ok, true);
});

test('an absent lock is not drift, an empty write is refused, and enforcement is opt-in', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'fabric-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const providers = [{ capabilityId: 'work', owner: 'p.a', version: '1.0.0' }];

  const absent = await verifyLock({ root, providers });
  assert.equal(absent.ok, true);
  assert.equal(absent.locked, false);

  assert.equal((await writeLock({ root, providers: [] })).ok, false);
  await writeLock({ root, providers });

  const clean = await verifyLock({ root, providers });
  assert.equal(clean.ok, true);
  assert.equal(clean.locked, true);
  assert.equal(clean.capabilities, 1);

  const drifted = await verifyLock({ root, providers: [{ capabilityId: 'work', owner: 'p.a', version: '9.9.9' }] });
  assert.equal(drifted.ok, true, 'drift is recorded, not fatal, unless it is enforced');
  assert.equal(drifted.drifted, true);
  assert.equal(drifted.code, LOCK_REASONS.DRIFT);

  const enforced = await verifyLock({ root, providers: [{ capabilityId: 'work', owner: 'p.a', version: '9.9.9' }], enforce: true });
  assert.equal(enforced.ok, false);
  assert.equal(enforced.code, LOCK_REASONS.DRIFT);

  await writeFile(join(root, 'capability-fabric-lock.json'), '{ broken', 'utf8');
  const invalid = await verifyLock({ root, providers });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.code, LOCK_REASONS.INVALID);
});

test('the fabric contract exposes the donors\' vocabulary without inventing new terms', () => {
  assert.equal(FABRIC_API_VERSION, 'utopia.capability-fabric/v1');
  assert.equal(DEFAULT_PRIORITY, 50);
  assert.ok(RUNTIME_OUTCOMES.includes('SUCCESS'));
  assert.equal(isNonSemanticRuntimeCode('TIMEOUT'), true);
  assert.equal(isNonSemanticRuntimeCode('SUCCESS'), false);
  assert.equal(isNonSemanticRuntimeCode(undefined), false);
  assert.throws(() => capabilityRequirement({ capabilityId: 'x', optional: 'yes' }), { code: 'INVALID_INPUT' });
  assert.equal(capabilityRequirement({ capabilityId: 'x' }).optional, false);
  assert.equal(FABRIC_REASONS.CONFLICT, 'two providers offer the same capability at the same priority');
});
