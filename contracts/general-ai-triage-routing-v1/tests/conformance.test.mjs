// Conformance tests for GAI-005 â€?deterministic + JEV triage routing.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS, DESTRUCTIVE_RISKS, EXECUTION_FIELDS, FALLBACK_REASONS, INTENTS, RISKS, TriageError,
  createTriageRouter, findExecutionFields, normalizeJevOutput,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';

const jevPort = output => {
  const calls = [];
  return {
    calls,
    port: {
      classify({ text }) {
        calls.push(text);
        if (output instanceof Error) throw output;
        return typeof output === 'function' ? output(text) : output;
      },
    },
  };
};

const engineeringPort = () => {
  const routed = [];
  return { routed, port: { route({ text }) { routed.push(text); return { routed: true, engineering_job_ref: 'job:em-1' }; } } };
};

const routerWith = (options = {}) => createTriageRouter({
  deterministicCommands: [
    { command_ref: '/help', handler_ref: 'handler:help', description: 'show help' },
    { command_ref: '/city open', handler_ref: 'handler:city-open' },
  ],
  clock: () => T0,
  ...options,
});

test('a known deterministic command consults no JEV and no provider', () => {
  const jev = jevPort({ intent: 'QUESTION', confidence: 1 });
  const router = routerWith({ jev: jev.port });
  const decision = router.route({ text: '/help me please' });
  assert.equal(decision.chosen.route, 'DETERMINISTIC');
  assert.equal(decision.chosen.handler_ref, 'handler:help');
  assert.equal(decision.chosen.reason, 'DETERMINISTIC_MATCH');
  assert.equal(decision.recommendation_source, 'DETERMINISTIC');
  assert.equal(decision.jev_attempted, false, 'a local command never depends on a model');
  assert.equal(decision.jev_used, false);
  assert.equal(decision.jev_fallback_reason, null);
  assert.equal(jev.calls.length, 0, 'the triage port was never called');
  assert.equal(decision.general_ai_invoked, false);
  assert.equal(decision.action_executed, false);
  assert.equal(router.deterministicMatch('/city open the map').handler_ref, 'handler:city-open');
  assert.equal(router.deterministicMatch('please open the city'), null, 'only a command prefix matches, not a mention');

  // Unknown text does consult JEV: the deterministic path is a fast path, not a wall.
  const ambiguous = router.route({ text: 'what should I do about the thing' });
  assert.equal(ambiguous.jev_attempted, true);
  assert.equal(jev.calls.length, 1);
  assert.deepEqual([...CHANNELS], ['DETERMINISTIC', 'GENERAL_AI', 'ENGINEERING', 'MANUAL_PICKER', 'CONFIRMATION_REQUIRED']);
});

test('JEV recommends, gateway policy decides, and both are independently auditable', () => {
  const jev = jevPort({ intent: 'QUESTION', complexity: 'SIMPLE', risk: 'LOW', confidence: 0.9, needs_general_ai: true, preferred_channel: 'GENERAL_AI' });
  const router = routerWith({ jev: jev.port });
  const decision = router.route({ text: 'explain how the pairing handshake works', request_ref: 'req:1' });
  assert.equal(decision.jev_used, true);
  assert.equal(decision.recommendation.source, 'JEV');
  assert.equal(decision.recommendation.intent, 'QUESTION');
  assert.equal(decision.recommendation.complexity, 'SIMPLE');
  assert.equal(decision.recommendation.risk, 'LOW');
  assert.equal(decision.recommendation.confidence, 0.9);
  assert.equal(decision.recommendation.needs_general_ai, true);
  assert.equal(decision.recommendation.preferred_channel, 'GENERAL_AI');
  assert.equal(decision.chosen.route, 'GENERAL_AI');
  assert.equal(decision.chosen.decided_by, 'GATEWAY_POLICY_DEFAULT');
  assert.equal(decision.chosen.policy_ref, 'policy:gai-triage-default');
  assert.equal(decision.general_ai_invoked, false, 'routing reports a channel; admission belongs to the channel');
  assert.equal(decision.permission_granted, false);
  assert.equal(decision.jev_is_canonical_truth, false);

  // A gateway policy may override the recommendation â€?and the recommendation is still recorded.
  const overridden = routerWith({
    jev: jevPort({ intent: 'COMMAND', confidence: 0.9, preferred_channel: 'GENERAL_AI' }).port,
    policy: { policy_ref: 'policy:manual-only', decide: () => ({ route: 'MANUAL_PICKER', reason: 'USER_PREFERS_MANUAL' }) },
  }).route({ text: 'do the thing' });
  assert.equal(overridden.recommendation.preferred_channel, 'GENERAL_AI', 'what JEV said is preserved');
  assert.equal(overridden.chosen.route, 'MANUAL_PICKER', 'what the gateway chose is separate');
  assert.equal(overridden.chosen.decided_by, 'GATEWAY_POLICY_CUSTOM');
  assert.equal(overridden.chosen.reason, 'USER_PREFERS_MANUAL');
  assert.equal(overridden.chosen.policy_ref, 'policy:manual-only');

  // The audit trail keeps both for every decision.
  const trail = router.auditTrail();
  assert.equal(trail.length, 1);
  assert.equal(trail[0].decision_id, 'triage:1');
  assert.equal(trail[0].recommendation.preferred_channel, 'GENERAL_AI');
  assert.equal(trail[0].chosen.route, 'GENERAL_AI');
  assert.equal(trail[0].request_ref, 'req:1');
  assert.equal(trail[0].at, T0);
  assert.deepEqual([...INTENTS], ['QUESTION', 'COMMAND', 'ACTION', 'ENGINEERING', 'AMBIGUOUS']);
  assert.deepEqual([...RISKS], ['NONE', 'LOW', 'MEDIUM', 'HIGH', 'DESTRUCTIVE']);
  assert.deepEqual([...DESTRUCTIVE_RISKS], ['HIGH', 'DESTRUCTIVE']);
});

test('unavailable, timed-out, malformed and low-confidence JEV is non-blocking', () => {
  // No port at all.
  const noJev = routerWith().route({ text: 'something ambiguous' });
  assert.equal(noJev.jev_attempted, false);
  assert.equal(noJev.jev_fallback_reason, 'JEV_UNAVAILABLE');
  assert.equal(noJev.chosen.route, 'MANUAL_PICKER', 'the manual picker is the honest fallback');
  assert.equal(noJev.recommendation.source, 'NONE');

  // Timeout and unavailability arrive as typed outcomes from the port adapter.
  const timeout = new Error('triage deadline exceeded');
  timeout.code = 'TIMEOUT';
  const timedOut = routerWith({ jev: jevPort(timeout).port }).route({ text: 'ambiguous text' });
  assert.equal(timedOut.jev_fallback_reason, 'JEV_TIMEOUT');
  assert.equal(timedOut.chosen.route, 'MANUAL_PICKER');
  assert.equal(timedOut.jev_note.includes('deadline'), true);
  const unavailable = new Error('connection refused');
  const downResult = routerWith({ jev: jevPort(unavailable).port }).route({ text: 'ambiguous text' });
  assert.equal(downResult.jev_fallback_reason, 'JEV_UNAVAILABLE');

  // Malformed output: nothing recognisable, or not an object at all.
  const malformed = routerWith({ jev: jevPort({ temperature: 3, notes: [] }).port }).route({ text: 'ambiguous text' });
  assert.equal(malformed.jev_fallback_reason, 'JEV_MALFORMED');
  assert.equal(malformed.chosen.route, 'MANUAL_PICKER');
  assert.equal(routerWith({ jev: jevPort('not an object').port }).route({ text: 'x' }).jev_fallback_reason, 'JEV_MALFORMED');
  assert.equal(routerWith({ jev: jevPort(() => undefined).port }).route({ text: 'x' }).jev_fallback_reason, 'JEV_UNAVAILABLE');

  // Low confidence is treated as no signal rather than a weak signal.
  const shy = routerWith({ jev: jevPort({ intent: 'ENGINEERING', confidence: 0.2 }).port }).route({ text: 'maybe refactor everything' });
  assert.equal(shy.jev_fallback_reason, 'JEV_LOW_CONFIDENCE');
  assert.equal(shy.jev_used, false);
  assert.equal(shy.chosen.route, 'MANUAL_PICKER', 'a low-confidence engineering guess does not silently become an engineering job');
  assert.equal(routerWith({ jev: jevPort({ intent: 'QUESTION', confidence: 1 }).port }).route({ text: 'x' }).chosen.route, 'MANUAL_PICKER', 'an intent with no channel and no needs_general_ai still falls back honestly');

  // Every failure path still returns a usable decision, and never claims an execution.
  for (const reason of ['JEV_UNAVAILABLE', 'JEV_TIMEOUT', 'JEV_MALFORMED', 'JEV_LOW_CONFIDENCE']) {
    assert.equal(FALLBACK_REASONS.includes(reason), true);
  }
  assert.equal(noJev.action_executed, false);
  assert.equal(noJev.permission_granted, false);
  // Normalization never invents values it did not recognize.
  const partial = normalizeJevOutput({ intent: 'CHITCHAT', confidence: '0.8' });
  assert.equal(partial.ok, false, 'an unrecognized intent with nothing else is not a recommendation');
  const mixed = normalizeJevOutput({ intent: 'CHITCHAT', risk: 'low', confidence: 0.8 });
  assert.equal(mixed.ok, true);
  assert.equal(mixed.recommendation.intent, null, 'an unknown intent is null, not coerced');
  assert.equal(mixed.recommendation.risk, 'LOW');
  assert.equal(mixed.recommendation.confidence, 0.8);
  assert.equal(normalizeJevOutput(null).ok, false);
});

test('JEV cannot execute an Action or grant permission', () => {
  const jev = jevPort({ intent: 'ACTION', confidence: 0.95, preferred_channel: 'GENERAL_AI' });
  const router = routerWith({ jev: jev.port });
  const decision = router.route({ text: 'delete the old artifacts' });
  assert.equal(decision.chosen.route, 'CONFIRMATION_REQUIRED', 'a side-effecting intent stays behind the boundary');
  assert.equal(decision.chosen.requires_confirmation, true);
  assert.equal(decision.permission_granted, false);
  assert.equal(decision.action_executed, false);

  // An output that tries to carry an execution, an authority transfer or a credential is refused outright.
  for (const hostile of [
    { intent: 'ACTION', confidence: 0.99, action_ref: 'action:delete-everything' },
    { intent: 'COMMAND', confidence: 0.99, grants: { shell: true } },
    { intent: 'COMMAND', confidence: 0.99, nested: { lease: 'lease:1' } },
    { intent: 'COMMAND', confidence: 0.99, capabilities: ['screen.stream@1'] },
    { intent: 'COMMAND', confidence: 0.99, execute: 'rm -rf /' },
    { intent: 'COMMAND', confidence: 0.99, credential_ref: 'handle:CREDENTIAL:1' },
  ]) {
    const refused = routerWith({ jev: jevPort(hostile).port }).route({ text: 'ambiguous request' });
    assert.equal(refused.jev_used, false, `${JSON.stringify(hostile)} must not be used as a recommendation`);
    assert.equal(refused.jev_fallback_reason, 'JEV_MAY_NOT_EXECUTE');
    assert.equal(refused.recommendation.source, 'NONE');
    assert.equal(refused.action_executed, false);
    assert.equal(refused.permission_granted, false);
    assert.equal(refused.chosen.requires_confirmation, false, 'the hostile recommendation changed no decision');
    assert.equal(refused.chosen.route, 'MANUAL_PICKER');
  }
  assert.equal(findExecutionFields({ a: { action_ref: 'x' } }).length, 1);
  assert.equal(EXECUTION_FIELDS.includes('lease'), true);

  // The router itself exposes no execution surface.
  for (const forbidden of ['execute', 'invoke', 'run', 'apply', 'dispatch', 'grant']) {
    assert.equal(router[forbidden], undefined, `the router must not expose ${forbidden}`);
  }
  // And an ACTION-classified request can never reach the engineering or general-AI channel by accident.
  const risky = routerWith({ jev: jevPort({ intent: 'QUESTION', risk: 'DESTRUCTIVE', confidence: 0.9, preferred_channel: 'GENERAL_AI' }).port }).route({ text: 'wipe the workspace' });
  assert.equal(risky.chosen.route, 'CONFIRMATION_REQUIRED');
  assert.equal(risky.recommendation.preferred_channel, 'GENERAL_AI', 'the recommendation is recorded but not followed');
});

test('engineering intent routes to the Engineering programme, never to General AI', () => {
  const engineering = engineeringPort();
  const router = routerWith({ jev: jevPort({ intent: 'ENGINEERING', complexity: 'COMPLEX', confidence: 0.95 }).port, engineeringRoute: engineering.port });
  const decision = router.route({ text: 'refactor the connector runtime and add integration tests', request_ref: 'req:em' });
  assert.equal(decision.chosen.route, 'ENGINEERING');
  assert.equal(decision.chosen.reason, 'ENGINEERING_INTENT');
  assert.equal(decision.general_ai_invoked, false, 'HARD intent must not be executed by General AI as a coding worker');
  assert.equal(decision.engineering_deferred, false);
  assert.equal(decision.engineering.routed, true);
  assert.equal(decision.engineering.engineering_job_ref, 'job:em-1');
  assert.equal(engineering.routed.length, 1);
  assert.equal(decision.action_executed, false);

  // Without the Engineering port the same intent is a typed, deferred seam â€?not a silent General AI run.
  const deferred = routerWith({ jev: jevPort({ intent: 'ENGINEERING', confidence: 0.95 }).port }).route({ text: 'refactor the runtime' });
  assert.equal(deferred.chosen.route, 'ENGINEERING');
  assert.equal(deferred.engineering_deferred, true);
  assert.equal(deferred.engineering.code, 'ENGINEERING_ROUTE_DEFERRED');
  assert.equal(deferred.engineering.deferred, true);
  assert.equal(deferred.engineering.succeeded, false, 'a deferral is never reported as success');
  assert.equal(deferred.engineering.seam, 'ENGINEERING_ROUTE_PORT');
  assert.equal(deferred.general_ai_invoked, false);

  // Complexity alone can identify engineering work even when the intent looks conversational.
  const byComplexity = routerWith({ jev: jevPort({ intent: 'COMMAND', complexity: 'COMPLEX', confidence: 0.9 }).port, engineeringRoute: engineering.port });
  assert.equal(byComplexity.route({ text: 'do the big thing' }).chosen.route, 'ENGINEERING');
  // ...but a low-confidence complexity claim does not.
  assert.equal(routerWith({ jev: jevPort({ intent: 'COMMAND', complexity: 'COMPLEX', confidence: 0.1 }).port }).route({ text: 'do the big thing' }).chosen.route, 'MANUAL_PICKER');
  // A policy can route engineering work differently, and the decision says who decided.
  const policyRouted = routerWith({
    jev: jevPort({ intent: 'ENGINEERING', confidence: 0.9 }).port,
    policy: { policy_ref: 'policy:em-disabled', decide: () => ({ route: 'MANUAL_PICKER', reason: 'ENGINEERING_ROUTE_DISABLED' }) },
  }).route({ text: 'refactor everything' });
  assert.equal(policyRouted.chosen.route, 'MANUAL_PICKER');
  assert.equal(policyRouted.chosen.decided_by, 'GATEWAY_POLICY_CUSTOM');
  assert.equal(policyRouted.engineering, null);
});

test('the router is strict, frozen and free of ambient state', () => {
  const router = routerWith({ jev: jevPort({ intent: 'QUESTION', confidence: 0.9, preferred_channel: 'GENERAL_AI' }).port });
  const decision = router.route({ text: 'a question' });
  assert.throws(() => { decision.chosen.route = 'DETERMINISTIC'; }, TypeError, 'decisions are frozen');
  assert.throws(() => { decision.recommendation.intent = 'ENGINEERING'; }, TypeError);
  assert.throws(() => router.route({}), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => router.route({ text: 'x', extra: true, at: 'yesterday' }), error => error.code === 'INVALID_REQUEST');
  assert.throws(() => createTriageRouter({ clock: 'now' }), error => error.code === 'INVALID_CLOCK');
  assert.throws(() => createTriageRouter({ deterministicCommands: [{ command_ref: '/x' }] }), error => error.code === 'DETERMINISTIC_HANDLER_REQUIRED');
  assert.throws(() => createTriageRouter({ deterministicCommands: [{ command_ref: '/x', handler_ref: 'h', nickname: 'n' }] }), error => error.code === 'INVALID_POLICY');
  assert.throws(() => createTriageRouter({ deterministicCommands: 'nope' }), error => error.code === 'INVALID_POLICY');
  assert.throws(() => routerWith({ policy: { decide: () => ({ route: 'TELEPATHY' }) } }).route({ text: 'x' }), error => error.code === 'UNKNOWN_CHANNEL');
  assert.throws(() => routerWith({ policy: { decide: () => null } }).route({ text: 'x' }), error => error.code === 'UNKNOWN_CHANNEL');

  assert.equal(router.hasJev(), true);
  assert.equal(router.hasEngineeringRoute(), false);
  assert.equal(router.deterministicCommands().length, 2);
  assert.equal(router.policy().policy_ref, 'policy:gai-triage-default');
  assert.equal(router.policy().decide, undefined, 'the policy projection never leaks a function');

  const second = routerWith();
  assert.equal(second.auditTrail().length, 0, 'routers share no state');
  assert.equal(router.auditTrail().length, 1);
  const third = routerWith({ policy: { jev_enabled: false }, jev: jevPort({ intent: 'QUESTION', confidence: 1 }).port });
  const disabled = third.route({ text: 'a question' });
  assert.equal(disabled.jev_attempted, false, 'policy can disable triage entirely');
  assert.equal(disabled.jev_fallback_reason, 'JEV_UNAVAILABLE');
  assert.equal(third.hasJev(), true, 'the port is configured but not consulted');
});

/* --------------------------------- 7. regressions (Correction, host Alien) */

import { createTriageRouter as makeRouter } from '../index.mjs';
const expectCodeR = (fn, code) => { try { fn(); } catch (error) { assert.equal(error.code, code, 'expected ' + code + ', got ' + error.code); return error; } assert.fail('expected the call to fail with ' + code); };

const T0R = '2026-09-30T12:00:00.000Z';
const jevR = output => ({ classify: () => output });
const routerR = (over = {}) => makeRouter({ clock: () => T0R, ...over });

test('a classification that carries an execution is refused however it is hidden', () => {
  // a non-enumerable own execution field used to pass the scan
  const hidden = { intent: 'QUESTION', confidence: 0.9 };
  Object.defineProperty(hidden, 'execute', { value: 'rm -rf /', enumerable: false, configurable: true, writable: true });
  assert.deepEqual([...findExecutionFields(hidden)], ['jev.execute']);
  assert.equal(normalizeJevOutput(hidden).execution_fields.includes('jev.execute'), true);
  const decision = routerR({ jev: jevR(hidden) }).route({ text: 'do something ambiguous' });
  assert.equal(decision.jev_used, false);
  assert.equal(decision.jev_fallback_reason, 'JEV_MAY_NOT_EXECUTE');
  assert.equal(decision.action_executed, false);
  assert.equal(decision.permission_granted, false);
  // neighbours: an honest classification is still used, and an enumerable execution is still refused
  assert.equal(routerR({ jev: jevR({ intent: 'QUESTION', confidence: 0.9 }) }).route({ text: 'ambiguous' }).jev_used, true);
  assert.equal(routerR({ jev: jevR({ intent: 'QUESTION', confidence: 0.9, execute: 'rm' }) }).route({ text: 'ambiguous' }).jev_fallback_reason, 'JEV_MAY_NOT_EXECUTE');
  // a cyclic classification is a fallback, not a crash
  const loop = [];
  loop.push(loop);
  assert.equal(routerR({ jev: jevR({ intent: 'QUESTION', confidence: 0.9, extra: loop }) }).route({ text: 'ambiguous' }).jev_used, true);
});

test('policy values are validated, so a route cannot be invented or a gate removed', () => {
  // an unvalidated ambiguous channel used to become the chosen route, including a privileged one
  expectCodeR(() => makeRouter({ clock: () => T0R, policy: { ambiguous_channel: 'TELEPATHY' } }), 'UNKNOWN_CHANNEL');
  // a *canonical* channel is policy's prerogative: the module validates the value, not the choice
  assert.equal(routerR({ policy: { ambiguous_channel: 'GENERAL_AI' } }).route({ text: 'nothing matches this' }).chosen.route, 'GENERAL_AI');
  // a non-numeric min_confidence used to make the confidence gate disappear
  for (const bad of [null, -1, 2, 'high']) {
    expectCodeR(() => makeRouter({ clock: () => T0R, policy: { min_confidence: bad } }), 'INVALID_POLICY');
  }
  expectCodeR(() => makeRouter({ clock: () => T0R, policy: { confirmation_risks: 'DESTRUCTIVE' } }), 'INVALID_POLICY');
  expectCodeR(() => makeRouter({ clock: () => T0R, policy: { jev_enabled: 'yes' } }), 'INVALID_POLICY');
  // neighbours: the default policy still works, and an honest custom policy still applies
  assert.equal(routerR().route({ text: 'nothing matches this' }).chosen.route, 'MANUAL_PICKER');
  assert.equal(routerR({ policy: { min_confidence: 0.9 } }).route({ text: 'x' }).chosen.route, 'MANUAL_PICKER');
  assert.equal(routerR({ policy: { ambiguous_channel: 'CONFIRMATION_REQUIRED' } }).route({ text: 'nothing matches' }).chosen.route, 'CONFIRMATION_REQUIRED');
});

test('command records are strict and instants are real', () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const cmd = Object.defineProperty({ command_ref: 'status', handler_ref: 'h-1' }, name, { value: 'X', enumerable: true, configurable: true, writable: true });
    expectCodeR(() => makeRouter({ clock: () => T0R, deterministicCommands: [cmd] }), 'INVALID_POLICY');
  }
  expectCodeR(() => makeRouter({ clock: () => T0R, deterministicCommands: [{ command_ref: 's', handler_ref: 'h', transport: 'RF' }] }), 'INVALID_POLICY');
  expectCodeR(() => routerR().route({ text: 'x', at: '2026-13-45T99:99:99Z' }), 'INVALID_REQUEST');
  // neighbours: a clean command is still deterministic-first and a real instant is still accepted
  const det = routerR({ deterministicCommands: [{ command_ref: 'status', handler_ref: 'h-1' }], jev: jevR({ intent: 'ENGINEERING', complexity: 'COMPLEX', confidence: 0.99 }) });
  const routed = det.route({ text: 'status now', at: T0R });
  assert.equal(routed.chosen.route, 'DETERMINISTIC');
  assert.equal(routed.jev_attempted, false);
  assert.equal(routerR().route({ text: 'x', at: T0R }).at, T0R);
});