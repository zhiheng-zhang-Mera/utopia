// Conformance tests for GAI-008 — health + resilience + honest degradation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUTH_STATES, BUDGET_STATES, CIRCUIT_STATES, FAULT_CLASSES, HEALTH_STATES, LOCAL_SURFACES, READINESS,
  ResilienceError, SCOPE_KINDS, classifyFailure, createResilienceGovernor,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const AT = ms => new Date(Date.parse(T0) + ms).toISOString();

function governorAt(policy = {}) {
  const state = { ms: 0 };
  const clock = () => AT(state.ms);
  clock.advance = ms => { state.ms += ms; return clock(); };
  return { governor: createResilienceGovernor({ clock, policy }), clock };
}

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof ResilienceError, `expected a ResilienceError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

test('availability, health, auth, rate limit and budget stay separate signals', () => {
  const { governor } = governorAt();
  assert.deepEqual([...HEALTH_STATES], ['HEALTHY', 'DEGRADED', 'UNHEALTHY', 'UNKNOWN']);
  assert.deepEqual([...READINESS], ['READY', 'NOT_READY', 'UNKNOWN']);
  assert.deepEqual([...AUTH_STATES], ['READY', 'MISSING', 'EXPIRED', 'NEEDS_USER', 'UNAVAILABLE', 'UNKNOWN']);
  assert.deepEqual([...BUDGET_STATES], ['WITHIN_BUDGET', 'EXHAUSTED', 'UNKNOWN']);
  assert.deepEqual([...SCOPE_KINDS], ['PROVIDER', 'ACCOUNT', 'MODEL', 'WEB_CHANNEL', 'API_CHANNEL']);
  assert.deepEqual([...FAULT_CLASSES], ['TRANSIENT_TECHNICAL', 'HUMAN_BLOCKED', 'PERMANENT', 'AMBIGUOUS']);

  const healthy = governor.observeHealth({ scope_kind: 'PROVIDER', scope_ref: 'provider:deepseek', observed_at: T0 });
  assert.equal(healthy.availability, 'AVAILABLE');
  assert.equal(healthy.health, 'HEALTHY');
  assert.equal(healthy.auth_state, 'READY');
  assert.equal(healthy.rate_limit_state, 'WITHIN_LIMIT');
  assert.equal(healthy.budget_state, 'WITHIN_BUDGET');
  assert.equal(healthy.readiness, 'READY');
  assert.equal(healthy.signals_are_separate, true);
  assert.equal(healthy.auth_is_not_health, true);
  assert.equal(healthy.budget_is_not_availability, true);

  // A technically healthy provider whose account needs a sign-in is NOT ready.
  const needsUser = governor.observeHealth({ scope_kind: 'ACCOUNT', scope_ref: 'account:1', health: 'HEALTHY', auth_state: 'NEEDS_USER', observed_at: T0 });
  assert.equal(needsUser.health, 'HEALTHY');
  assert.equal(needsUser.auth_state, 'NEEDS_USER');
  assert.equal(needsUser.readiness, 'NOT_READY');
  assert.equal(needsUser.reason, 'AUTH_NEEDS_USER');

  // Rate limited and out of budget are distinct refusals of readiness.
  assert.equal(governor.observeHealth({ scope_kind: 'MODEL', scope_ref: 'model:1', rate_limit_state: 'LIMITED', observed_at: T0 }).reason, 'RATE_LIMITED');
  assert.equal(governor.observeHealth({ scope_kind: 'MODEL', scope_ref: 'model:2', budget_state: 'EXHAUSTED', observed_at: T0 }).reason, 'BUDGET_EXHAUSTED');
  assert.equal(governor.observeHealth({ scope_kind: 'API_CHANNEL', scope_ref: 'api:1', availability: 'UNAVAILABLE', observed_at: T0 }).readiness, 'NOT_READY');

  assert.equal(failure(() => governor.observeHealth({ scope_kind: 'SOMETHING', scope_ref: 'x' })).code, 'INVALID_SCOPE');
  assert.equal(failure(() => governor.observeHealth({ scope_kind: 'PROVIDER', scope_ref: '' })).code, 'INVALID_SCOPE');
  assert.equal(failure(() => governor.observeHealth({ scope_kind: 'PROVIDER', scope_ref: 'p', health: 'FINE' })).code, 'INVALID_SIGNAL');
  assert.equal(failure(() => governor.observeHealth({ scope_kind: 'PROVIDER', scope_ref: 'p', auth_state: 'OK' })).code, 'INVALID_SIGNAL');
  assert.equal(failure(() => governor.observeHealth({ scope_kind: 'PROVIDER', scope_ref: 'p', ttl_ms: 99999999 })).code, 'INVALID_REQUEST');
});

test('stale health is distinguishable from healthy and never reported as healthy', () => {
  const { governor, clock } = governorAt();
  governor.observeHealth({ scope_kind: 'PROVIDER', scope_ref: 'provider:deepseek', observed_at: T0, ttl_ms: 1000 });
  assert.equal(governor.healthAt({ scope_kind: 'PROVIDER', scope_ref: 'provider:deepseek' }).health, 'HEALTHY');
  assert.equal(governor.healthAt({ scope_kind: 'PROVIDER', scope_ref: 'provider:deepseek' }).stale, false);

  clock.advance(2000);
  const stale = governor.healthAt({ scope_kind: 'PROVIDER', scope_ref: 'provider:deepseek' });
  assert.equal(stale.stale, true);
  assert.equal(stale.health, 'UNKNOWN', 'a stale observation is not a healthy provider');
  assert.equal(stale.auth_state, 'UNKNOWN');
  assert.equal(stale.readiness, 'UNKNOWN');
  assert.equal(stale.reason, 'STALE_OBSERVATION');
  assert.equal(stale.stale_health_is_not_healthy, true);
  assert.equal(stale.freshness.age_ms, 2000);
  assert.equal(stale.freshness.stale_after_ms, 1000);

  // A scope never observed is UNKNOWN rather than assumed healthy.
  const unseen = governor.healthAt({ scope_kind: 'ACCOUNT', scope_ref: 'account:never' });
  assert.equal(unseen.health, 'UNKNOWN');
  assert.equal(unseen.reason, 'NO_OBSERVATION');
  assert.equal(unseen.stale, true);

  const report = governor.resilienceReport();
  assert.deepEqual(report.healthy_scopes, [], 'no scope may be reported healthy while stale');
  assert.deepEqual(report.stale_scopes, ['PROVIDER:provider:deepseek']);
  assert.equal(report.api_escalation_automatically_triggered, false);
  assert.deepEqual(report.local_surfaces_available, [...LOCAL_SURFACES]);
});

test('a transient technical failure follows a bounded retry and backoff policy', () => {
  const { governor } = governorAt({ max_attempts: 3, backoff_base_ms: 100, backoff_factor: 2, backoff_cap_ms: 250 });
  const first = governor.retryDecision({ action_ref: 'action:1', attempt: 1, code: 'TIMEOUT' });
  assert.equal(first.fault_class, 'TRANSIENT_TECHNICAL');
  assert.equal(first.retry, true);
  assert.equal(first.backoff_ms, 100);
  assert.equal(first.attempts_remaining, 2);

  const second = governor.retryDecision({ action_ref: 'action:1', attempt: 2, code: 'ECONNRESET' });
  assert.equal(second.backoff_ms, 200);
  assert.equal(second.attempts_remaining, 1);

  // Backoff is capped, and a provider retry-after is honoured above the computed backoff.
  const honoured = governor.retryDecision({ action_ref: 'action:1', attempt: 2, code: 'RATE_LIMITED', retry_after_ms: 5000 });
  assert.equal(honoured.backoff_ms, 5000, 'a provider retry-after is honoured above the computed backoff');
  assert.equal(honoured.attempts_remaining, 1);

  // The budget is a hard bound: the last permitted attempt is never retried again.
  const exhausted = governor.retryDecision({ action_ref: 'action:1', attempt: 3, code: 'TIMEOUT' });
  assert.equal(exhausted.retry, false);
  assert.equal(exhausted.reason, 'ATTEMPTS_EXHAUSTED');
  assert.equal(exhausted.attempts_remaining, 0);
  assert.equal(exhausted.auto_resume, false);

  const capped = governor.retryDecision({ action_ref: 'action:2', attempt: 2, code: 'TIMEOUT' });
  assert.equal(capped.backoff_ms, 200);
  assert.equal(capped.capped_by_ms, 250);
  assert.equal(governor.retryDecision({ action_ref: 'action:2', attempt: 1, code: 'INVALID_REQUEST' }).retry, false, 'a permanent failure is not retried');
  assert.equal(governor.retryDecision({ action_ref: 'action:2', attempt: 1, code: 'INVALID_REQUEST' }).reason, 'PERMANENT_FAILURE');
  assert.equal(failure(() => governor.retryDecision({ action_ref: '', attempt: 1, code: 'TIMEOUT' })).code, 'INVALID_REQUEST');
  assert.equal(classifyFailure({ code: 'RATE_LIMITED', retry_after_ms: 900 }).retry_after_ms, 900);
  assert.equal(classifyFailure({ code: 'SOMETHING_ODD' }).fault_class, 'AMBIGUOUS', 'an unrecognized fault is never silently retryable');
});

test('human-blocked and ambiguous failures never auto-resume as a technical retry', () => {
  const { governor } = governorAt();
  for (const code of ['AUTH_REQUIRED', 'NEEDS_USER', 'PERMISSION_DENIED', 'CONSENT_REQUIRED']) {
    const decision = governor.retryDecision({ action_ref: `action:${code}`, attempt: 1, code });
    assert.equal(decision.retry, false, `${code} must not be retried`);
    assert.equal(decision.fault_class, 'HUMAN_BLOCKED');
    assert.equal(decision.human_action_required, true);
    assert.equal(decision.auto_resume, false);
    assert.equal(decision.one_shot_retry_is_not_resume, true);
    assert.equal(decision.reason, 'HUMAN_ACTION_REQUIRED');
  }
  assert.equal(governor.humanBlockedAction('action:NEEDS_USER').resolved, false);
  assert.equal(governor.resilienceReport().human_blocked_actions.includes('action:NEEDS_USER'), true);

  // Only an explicit acknowledgement clears it, and it is idempotent.
  const acknowledged = governor.acknowledgeHumanAction({ action_ref: 'action:NEEDS_USER', by_ref: 'user:owner' });
  assert.equal(acknowledged.acknowledged, true);
  assert.equal(acknowledged.duplicate, false);
  assert.equal(acknowledged.auto_resume_still_required, true, 'acknowledging a sign-in does not by itself resume work');
  assert.equal(governor.acknowledgeHumanAction({ action_ref: 'action:NEEDS_USER' }).duplicate, true);
  assert.equal(governor.humanBlockedAction('action:NEEDS_USER').resolved, true);
  assert.equal(governor.acknowledgeHumanAction({ action_ref: 'action:unknown' }).reason, 'NOT_BLOCKED');
  assert.equal(governor.resilienceReport().human_blocked_actions.length, 3, 'the other blocked actions remain pending');

  // A later healthy observation does not silently resolve a pending human action.
  governor.observeHealth({ scope_kind: 'ACCOUNT', scope_ref: 'account:1', auth_state: 'READY', observed_at: T0 });
  assert.equal(governor.humanBlockedAction('action:AUTH_REQUIRED').resolved, false, 'a health update is not a human action');

  // An ambiguous/destructive fault is not retried without an idempotency key.
  const ambiguous = governor.retryDecision({ action_ref: 'action:wipe', attempt: 1, code: 'DESTRUCTIVE_OUTCOME_UNKNOWN', side_effecting: true });
  assert.equal(ambiguous.fault_class, 'AMBIGUOUS');
  assert.equal(ambiguous.retry, false);
  assert.equal(ambiguous.reason, 'IDEMPOTENCY_REQUIRED');
  assert.equal(ambiguous.requires_reconciliation, true);
  const withKey = governor.retryDecision({ action_ref: 'action:wipe', attempt: 1, code: 'DESTRUCTIVE_OUTCOME_UNKNOWN', side_effecting: true, idempotency_key: 'idem:1' });
  assert.equal(withKey.retry, true);
  assert.equal(withKey.reason, 'AMBIGUOUS_WITH_IDEMPOTENCY');
  assert.equal(withKey.requires_reconciliation, true, 'an ambiguous retry is still reconciled');
  assert.equal(withKey.auto_resume, false);
});

test('circuits are scoped so one failure cannot trip all AI or the local surfaces', () => {
  const { governor, clock } = governorAt({ failure_threshold: 3, circuit_cooldown_ms: 1000 });
  assert.deepEqual([...CIRCUIT_STATES], ['CLOSED', 'OPEN', 'HALF_OPEN']);
  const providerA = { scope_kind: 'PROVIDER', scope_ref: 'provider:a' };
  const providerB = { scope_kind: 'PROVIDER', scope_ref: 'provider:b' };

  for (let index = 0; index < 2; index += 1) {
    const outcome = governor.recordOutcome({ ...providerA, outcome: 'FAILURE' });
    assert.equal(outcome.state, 'CLOSED', 'the threshold is not reached yet');
  }
  const tripped = governor.recordOutcome({ ...providerA, outcome: 'FAILURE' });
  assert.equal(tripped.state, 'OPEN');
  assert.equal(tripped.circuit_is_global, false);
  assert.deepEqual(tripped.other_scopes_affected, []);

  // Another provider, the account and the local surfaces are unaffected.
  assert.equal(governor.circuitState(providerB).state, 'CLOSED');
  assert.equal(governor.circuitState({ scope_kind: 'ACCOUNT', scope_ref: 'account:1' }).state, 'CLOSED');
  assert.equal(governor.circuitState({ scope_kind: 'WEB_CHANNEL', scope_ref: 'web:1' }).state, 'CLOSED');
  assert.equal(governor.retryDecision({ action_ref: 'action:on-b', attempt: 1, code: 'TIMEOUT', ...providerB }).retry, true, 'the healthy provider still retries');
  const blocked = governor.retryDecision({ action_ref: 'action:on-a', attempt: 1, code: 'TIMEOUT', ...providerA });
  assert.equal(blocked.retry, false);
  assert.equal(blocked.reason, 'CIRCUIT_OPEN');
  assert.equal(blocked.retry_after_ms, 1000);

  const isolation = governor.faultIsolation({ failing_scope_kind: 'PROVIDER', failing_scope_ref: 'provider:a' });
  assert.deepEqual(isolation.isolated_scopes, [{ scope_kind: 'PROVIDER', scope_ref: 'provider:a', state: 'OPEN' }]);
  assert.deepEqual(isolation.unrelated_scopes_affected, []);
  assert.equal(isolation.local_surfaces_use_general_ai, false);
  assert.equal(isolation.global_outage, false);
  assert.equal(isolation.poisons_all_ai, false);
  assert.deepEqual(isolation.local_surfaces, [...LOCAL_SURFACES]);
  assert.equal(governor.resilienceReport().open_circuits.includes('PROVIDER:provider:a'), true);
  assert.equal(governor.resilienceReport().local_surfaces_available.includes('ROOMS'), true);

  // After the cooldown a half-open probe is allowed, and success closes the circuit.
  clock.advance(1500);
  assert.equal(governor.circuitState(providerA).state, 'HALF_OPEN');
  assert.equal(governor.retryDecision({ action_ref: 'action:probe', attempt: 1, code: 'TIMEOUT', ...providerA }).retry, true, 'a half-open circuit allows one probe');
  assert.equal(governor.recordOutcome({ ...providerA, outcome: 'SUCCESS' }).state, 'CLOSED');
  assert.equal(governor.circuitState(providerA).consecutive_failures, 0);
  assert.equal(failure(() => governor.recordOutcome({ scope_kind: 'PROVIDER', scope_ref: 'p', outcome: 'MAYBE' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => governor.circuitState({ scope_kind: 'NOPE', scope_ref: 'x' })).code, 'INVALID_SCOPE');
});

test('a Web failure degrades honestly and never silently escalates to the API', () => {
  const { governor } = governorAt();
  const degraded = governor.degradeChannel({ channel: 'WEB_CHANNEL', reason: 'WEB_UNAVAILABLE', other_device_available: true });
  assert.equal(degraded.state, 'UNAVAILABLE');
  assert.equal(degraded.honest_degradation, true);
  assert.equal(degraded.api_escalation, null);
  assert.equal(degraded.api_escalation_automatically_triggered, false, 'no automatic API escalation exists');
  assert.equal(degraded.api_channel_requires_explicit_consent, true);
  assert.equal(degraded.false_success, false);
  assert.equal(degraded.proposal.kind, 'DEVICE_SWITCH_PROPOSAL');
  assert.equal(degraded.proposal.requires_user_confirmation, true, 'moving device is a proposal, not an automatic action');
  assert.equal(degraded.proposal.grants_execution_authority, false);
  assert.deepEqual(degraded.local_surfaces_available, [...LOCAL_SURFACES]);

  // With no other device the channel simply stays unavailable — it does not fall through to the API.
  const alone = governor.degradeChannel({ channel: 'WEB_CHANNEL', reason: 'WEB_UNAVAILABLE', other_device_available: false });
  assert.equal(alone.proposal, null);
  assert.equal(alone.api_escalation_automatically_triggered, false);

  // Any attempt to make resilience code escalate is refused.
  const escalation = failure(() => governor.escalateToApi());
  assert.equal(escalation.code, 'API_ESCALATION_IS_NOT_AUTOMATIC');
  assert.equal(escalation.api_escalation_automatically_triggered, false);
  assert.equal(escalation.requires_explicit_consent, true);
  assert.equal(governor.admissionsRecorded(), 0, 'resilience code admitted nothing to the API');
  assert.equal(governor.journal().some(entry => entry.event === 'CHANNEL_DEGRADED'), true);
});

test('the governor is strict, frozen, and free of ambient state', () => {
  const { governor } = governorAt();
  const observed = governor.observeHealth({ scope_kind: 'PROVIDER', scope_ref: 'provider:a', observed_at: T0 });
  assert.throws(() => { observed.health = 'UNHEALTHY'; }, TypeError, 'observations are frozen');
  assert.throws(() => { observed.freshness.stale = true; }, TypeError);
  assert.equal(failure(() => createResilienceGovernor({ clock: 'now' })).code, 'INVALID_CLOCK');
  assert.equal(governor.healthAt({ scope_kind: 'PROVIDER', scope_ref: 'provider:never' }).reason, 'NO_OBSERVATION');

  const other = governorAt().governor;
  assert.equal(other.resilienceReport().scopes.length, 0, 'governors share no state');
  assert.equal(governor.resilienceReport().scopes.length, 1);
  assert.equal(governor.policy().policy_ref, 'policy:gai-resilience-default');
  assert.equal(governor.classifyFailure({ code: 'TIMEOUT' }).retryable, true);
  assert.equal(governor.journal().length > 0, true);
  assert.equal(typeof createResilienceGovernor, 'function');
});

// ---------------------------------------------------------------- Alien Correction regressions
// Every test below fails against the Development head and passes against the corrected head.

test('the resilience policy bounds are real bounds', () => {
  for (const policy of [
    { max_attempts: Infinity }, { max_attempts: NaN }, { circuit_cooldown_ms: NaN },
    { health_ttl_ms: NaN }, { backoff_cap_ms: 0 }, { backoff_factor: 0.5 }, { health_ttl_ms: 1200000 }, 'nonsense',
  ]) {
    assert.equal(failure(() => governorAt(policy).governor).code, 'INVALID_REQUEST', `policy ${JSON.stringify(policy)}`);
  }
  const { governor } = governorAt({ max_attempts: 2, circuit_cooldown_ms: 1000, health_ttl_ms: 1000 });
  assert.equal(governor.retryDecision({ action_ref: 'action:x', attempt: 2, code: 'TIMEOUT' }).reason, 'ATTEMPTS_EXHAUSTED', 'the bound still bites');
  governor.recordOutcome({ scope_kind: 'PROVIDER', scope_ref: 'provider:a', outcome: 'FAILURE' });
  governor.recordOutcome({ scope_kind: 'PROVIDER', scope_ref: 'provider:a', outcome: 'FAILURE' });
  governor.recordOutcome({ scope_kind: 'PROVIDER', scope_ref: 'provider:a', outcome: 'FAILURE' });
  assert.equal(typeof governor.circuitState({ scope_kind: 'PROVIDER', scope_ref: 'provider:a' }).open_until, 'string', 'a finite cooldown still opens and dates the circuit');
});

test('a malformed caller instant is refused as a typed error', () => {
  const { governor } = governorAt();
  governor.observeHealth({ scope_kind: 'PROVIDER', scope_ref: 'p:1', observed_at: T0 });
  for (const at of ['garbage', '2026-13-45T99:99:99Z', '2026-02-30T00:00:00Z', 123]) {
    assert.equal(failure(() => governor.observeHealth({ scope_kind: 'PROVIDER', scope_ref: 'p:1', observed_at: at })).code, 'INVALID_REQUEST', `observed_at=${String(at)}`);
    assert.equal(failure(() => governor.healthAt({ scope_kind: 'PROVIDER', scope_ref: 'p:1', at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => governor.retryDecision({ action_ref: 'a', attempt: 1, code: 'TIMEOUT', at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => governor.recordOutcome({ scope_kind: 'PROVIDER', scope_ref: 'p:1', outcome: 'FAILURE', at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => governor.circuitState({ scope_kind: 'PROVIDER', scope_ref: 'p:1', at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => governor.degradeChannel({ at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => governor.faultIsolation({ at })).code, 'INVALID_REQUEST');
    assert.equal(failure(() => governor.resilienceReport({ at })).code, 'INVALID_REQUEST');
  }
  assert.equal(governor.healthAt({ scope_kind: 'PROVIDER', scope_ref: 'p:1', at: T0 }).health, 'HEALTHY', 'a real instant still works');
  const badClock = createResilienceGovernor({ clock: () => '2026-13-45T99:99:99Z' });
  assert.equal(failure(() => badClock.resilienceReport()).code, 'INVALID_CLOCK');
});

test('a side-effecting failure is not retried without an idempotency key', () => {
  const { governor } = governorAt();
  const withheld = governor.retryDecision({ action_ref: 'action:pay', attempt: 1, code: 'TIMEOUT', side_effecting: true });
  assert.equal(withheld.retry, false, 'a destructive retry could apply the effect twice');
  assert.equal(withheld.reason, 'IDEMPOTENCY_REQUIRED');
  assert.equal(withheld.idempotency_required, true);
  assert.equal(withheld.requires_reconciliation, true);
  const permitted = governor.retryDecision({ action_ref: 'action:pay', attempt: 1, code: 'TIMEOUT', side_effecting: true, idempotency_key: 'idem:1' });
  assert.equal(permitted.retry, true);
  assert.equal(permitted.idempotency_key_present, true);
  assert.equal(governor.retryDecision({ action_ref: 'action:read', attempt: 1, code: 'TIMEOUT' }).retry, true, 'a read-only retry is unaffected');
});

test('a cyclic value cannot crash the freezer, and a degraded availability is named', () => {
  const { governor } = governorAt();
  const cycle = {};
  cycle.self = cycle;
  assert.equal(failure(() => governor.degradeChannel({ reason: cycle })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => governor.degradeChannel({ channel: cycle })).code, 'INVALID_REQUEST');
  assert.equal(governor.degradeChannel({ reason: 'WEB_UNAVAILABLE' }).state, 'UNAVAILABLE');
  const degraded = governor.observeHealth({ scope_kind: 'PROVIDER', scope_ref: 'provider:a', availability: 'DEGRADED', observed_at: T0 });
  assert.equal(degraded.reason, 'AVAILABILITY_DEGRADED', 'a degraded availability is not reported as healthy');
  assert.equal(degraded.stale, false);
});

test('the governor policy is a plain record', () => {
  class Policy {}
  const instance = Object.assign(new Policy(), { max_attempts: 99 });
  assert.equal(failure(() => createResilienceGovernor({ clock: () => T0, policy: instance })).code, 'INVALID_REQUEST');
});
