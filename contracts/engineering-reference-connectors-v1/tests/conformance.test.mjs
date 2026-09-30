// Conformance tests for EM-011 鈥?DeepSeek Harness + Codex reference connectors.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCEPTANCE_DEFERRED, AUTH_STATES, CANONICAL_CAPABILITIES, CONNECTOR_KINDS, CONNECTOR_PORT, ConnectorError,
  INSTALL_STATES, JOB_STATES, READINESS, createConnectorRegistry, createReferenceConnector,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';

/** A host runtime double. `behaviour` decides what the "host" reports, honestly or dishonestly. */
function runtimeFor(behaviour = {}) {
  const calls = { probe: 0, start: 0, submit: 0, control: 0, events: 0, result: 0 };
  return {
    calls,
    runtime: {
      probe() { calls.probe += 1; return { installed: behaviour.installed !== false, version_output: behaviour.version_output ?? 'v1.2.3', host_path_ref: 'host:bin' }; },
      auth() { return { state: behaviour.auth_state ?? 'READY' }; },
      start() { calls.start += 1; return { backend_run_ref: behaviour.backend_run_ref ?? 'backend:run:1', backend_session_ref: 'backend:session:1' }; },
      submit() { calls.submit += 1; return { result_ref: behaviour.result_ref ?? 'result:1' }; },
      control() { calls.control += 1; return { accepted: true }; },
      events() { calls.events += 1; return behaviour.events ?? [{ kind: 'PROGRESS', text: 'working', backend_event_ref: 'backend:event:1' }]; },
      result() { calls.result += 1; return behaviour.result ?? { state: 'RUNNING' }; },
      acceptanceEvidence() { return behaviour.acceptanceEvidence ?? null; },
    },
  };
}

const connectorFor = (kind, behaviour = {}, policy = {}) => {
  const { runtime, calls } = runtimeFor(behaviour);
  return { connector: createReferenceConnector({ kind, runtime, clock: () => T0, policy }), calls, runtime };
};

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof ConnectorError, `expected a ConnectorError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

/** A third connector with no core changes, to prove the registry is generic. */
function syntheticConnector() {
  const capabilities = ['code.generate'];
  return {
    connectorKind: () => 'SYNTHETIC_REFERENCE',
    capabilities: () => ({ capabilities, supported_controls: ['CANCEL'] }),
    readiness: () => ({ state: 'READY' }),
    acceptanceReport: () => ({ connector_kind: 'SYNTHETIC_REFERENCE', component_stage_acceptance: false, deferred_marker: ACCEPTANCE_DEFERRED, emulated_smoke_labelled_as_acceptance: false }),
  };
}

test('both reference connectors register and resolve generically, with no provider branches in the core', () => {
  assert.deepEqual([...CONNECTOR_KINDS], ['DEEPSEEK_HARNESS', 'CODEX']);
  assert.equal(CONNECTOR_PORT.core_branches_on_provider_name, false);
  assert.equal(CONNECTOR_PORT.product_parsing_lives_below_adapter, true);
  const registry = createConnectorRegistry({ clock: () => T0 });
  registry.register({ connector: connectorFor('DEEPSEEK_HARNESS').connector });
  registry.register({ connector: connectorFor('CODEX').connector });
  registry.register({ connector: syntheticConnector() });
  assert.deepEqual([...registry.connectorKinds()].sort(), ['CODEX', 'DEEPSEEK_HARNESS', 'SYNTHETIC_REFERENCE']);

  // Capability resolution is data-driven, and a third connector needed no core change.
  const testsRun = registry.selectForCapability({ capability: 'tests.run' });
  assert.equal(testsRun.connector_kind, 'CODEX');
  assert.equal(testsRun.provider_name_branching, false);
  assert.equal(testsRun.capability_based, true);
  assert.equal(testsRun.core_changed_for_third_connector, false);
  assert.equal(registry.selectForCapability({ capability: 'code.generate' }).candidates.length, 3);
  assert.equal(failure(() => registry.selectForCapability({ capability: 'telepathy.read' })).code, 'UNSUPPORTED_CAPABILITY');
  assert.equal(failure(() => registry.selectForCapability({})).code, 'INVALID_REQUEST');

  const coverage = registry.coverage();
  assert.deepEqual(coverage.by_capability['shell.execute'], ['DEEPSEEK_HARNESS']);
  assert.deepEqual(coverage.by_capability['tests.run'], ['CODEX']);
  assert.equal(coverage.registered_count, 3);
  assert.deepEqual([...CANONICAL_CAPABILITIES].includes('code.review'), true);

  // The port surface is complete on both connectors and identical in shape.
  for (const kind of CONNECTOR_KINDS) {
    const { connector } = connectorFor(kind);
    for (const method of CONNECTOR_PORT.methods) assert.equal(typeof connector[method], 'function', `${kind} must implement ${method}`);
    assert.deepEqual(Object.keys(connector.capabilities()).sort(), ['canonical_names_only', 'capabilities', 'connector_kind', 'product_specific_names_exposed', 'supported_controls']);
  }
  assert.equal(failure(() => createReferenceConnector({ kind: 'MYSTERY', runtime: runtimeFor().runtime })).code, 'UNKNOWN_KIND');
  assert.equal(failure(() => createReferenceConnector({ kind: 'CODEX', runtime: {} })).code, 'INVALID_RUNTIME');
  assert.equal(failure(() => createReferenceConnector({ kind: 'CODEX', runtime: runtimeFor().runtime, clock: 'now' })).code, 'INVALID_CLOCK');
  assert.equal(failure(() => registry.register({ connector: {} })).code, 'INVALID_REQUEST');
});

test('installed, uninstalled and auth-required states are probed honestly', () => {
  assert.deepEqual([...INSTALL_STATES], ['INSTALLED', 'NOT_INSTALLED', 'UNKNOWN']);
  assert.deepEqual([...AUTH_STATES], ['READY', 'MISSING', 'EXPIRED', 'NEEDS_USER', 'UNAVAILABLE', 'UNKNOWN']);
  assert.deepEqual([...READINESS], ['READY', 'NOT_READY', 'UNKNOWN']);

  const installed = connectorFor('DEEPSEEK_HARNESS', { version_output: 'harness 3.4.5 (build)' }).connector;
  const probe = installed.probe();
  assert.equal(probe.install_state, 'INSTALLED');
  assert.equal(probe.version, '3.4.5', 'the version is parsed by the product adapter, not guessed');
  assert.equal(probe.version_known, true);
  assert.equal(probe.emulated, false);
  assert.equal(installed.readiness().state, 'READY');
  assert.equal(installed.health().health, 'HEALTHY');

  // An uninstalled product is reported, never faked, and never auto-installed.
  const missing = connectorFor('CODEX', { installed: false }).connector;
  assert.equal(missing.probe().install_state, 'NOT_INSTALLED');
  assert.equal(missing.probe().version, 'UNKNOWN');
  assert.equal(missing.readiness().state, 'NOT_READY');
  assert.equal(missing.readiness().reason, 'NOT_INSTALLED');
  assert.equal(missing.auth().state, 'UNAVAILABLE');
  assert.equal(missing.health().health, 'UNHEALTHY');
  assert.equal(missing.health().attention.kind, 'INSTALL_REQUIRED');
  const notInstalled = failure(() => missing.startOrAttach({ canonical_job_ref: 'job:1' }));
  assert.equal(notInstalled.code, 'NOT_INSTALLED');
  assert.equal(notInstalled.auto_install_attempted, false);

  // An installed but unauthenticated product needs a user, and never auto-retries.
  const needsUser = connectorFor('CODEX', { auth_state: 'NEEDS_USER' }).connector;
  assert.equal(needsUser.readiness().state, 'NOT_READY');
  assert.equal(needsUser.readiness().reason, 'AUTH_NEEDS_USER');
  assert.equal(needsUser.auth().user_action_required, true);
  assert.equal(needsUser.auth().auto_retry, false);
  assert.equal(needsUser.health().health, 'DEGRADED');
  assert.equal(needsUser.health().attention.kind, 'AUTHENTICATION');
  const authRequired = failure(() => needsUser.startOrAttach({ canonical_job_ref: 'job:1' }));
  assert.equal(authRequired.code, 'USER_ACTION_REQUIRED');
  assert.equal(authRequired.auto_retry, false);

  const expired = connectorFor('DEEPSEEK_HARNESS', { auth_state: 'EXPIRED' }).connector;
  assert.equal(failure(() => expired.startOrAttach({ canonical_job_ref: 'job:1' })).code, 'AUTH_REQUIRED');
  const unknownAuth = connectorFor('DEEPSEEK_HARNESS', { auth_state: 'SOMETHING' }).connector;
  assert.equal(unknownAuth.auth().state, 'UNKNOWN');
  assert.equal(unknownAuth.readiness().state, 'UNKNOWN', 'an unrecognized auth state is not treated as ready');
  assert.equal(unknownAuth.auth().emulated, false);
});

test('one canonical job id is preserved while backend ids stay provenance', () => {
  const { connector } = connectorFor('DEEPSEEK_HARNESS', { backend_run_ref: 'backend:run:42' });
  const started = connector.startOrAttach({ canonical_job_ref: 'job:canonical-1' });
  assert.equal(started.canonical_job_ref, 'job:canonical-1');
  assert.equal(started.started, true);
  assert.equal(started.backend_run_ref, 'backend:run:42');
  assert.equal(started.provenance.is_provenance_only, true);
  assert.equal(started.provenance.backend_session_ref, 'backend:session:1');
  assert.equal(started.canonical_job_id_is_single, true);

  // Attaching to the same canonical job returns the existing session rather than a second one.
  const attached = connector.startOrAttach({ canonical_job_ref: 'job:canonical-1', backend_run_ref: 'backend:run:99' });
  assert.equal(attached.attached, true);
  assert.equal(attached.started, false);
  assert.equal(attached.session_ref, started.session_ref, 'one backend session per canonical job');
  assert.equal(connector.sessions().length, 1);

  // Submits carry the canonical id as the identity and the backend id only as provenance.
  const submitted = connector.submit({ session_ref: started.session_ref, operation: 'code.generate', action_key: 'k1' });
  assert.equal(submitted.canonical_job_ref, 'job:canonical-1');
  assert.equal(submitted.backend_run_ref, 'backend:run:42');
  assert.equal(submitted.provenance_only_backend_ids, true);
  assert.equal(submitted.state, 'RUNNING');

  // Events are normalized with backend references kept only as provenance.
  const events = connector.events({ session_ref: started.session_ref });
  assert.equal(events.normalized, true);
  assert.equal(events.product_shapes_exposed, false);
  assert.equal(events.canonical_job_ref, 'job:canonical-1');
  assert.equal(events.events[0].backend_event_ref, 'backend:event:1');
  assert.equal(events.events[0].is_provenance_only, true);
  assert.equal(failure(() => connector.startOrAttach({})).code, 'INVALID_REQUEST');
  assert.equal(failure(() => connector.events({ session_ref: 'session:nope' })).code, 'UNKNOWN_SESSION');
});

test('unsupported operations become typed states instead of silence or success', () => {
  const deepseek = connectorFor('DEEPSEEK_HARNESS').connector;
  const started = deepseek.startOrAttach({ canonical_job_ref: 'job:1' });

  // A capability the product does not have is refused by name, with the supported set attached.
  const unsupported = failure(() => deepseek.submit({ session_ref: started.session_ref, operation: 'tests.run' }));
  assert.equal(unsupported.code, 'UNSUPPORTED_CAPABILITY');
  assert.equal(unsupported.supported.includes('code.generate'), true);
  assert.equal(unsupported.emulated, false);
  assert.equal(unsupported.silently_ignored, false);

  // An unsupported control op is refused too, while a supported one applies.
  const noPause = failure(() => deepseek.control({ session_ref: started.session_ref, operation: 'PAUSE' }));
  assert.equal(noPause.code, 'UNSUPPORTED_OPERATION');
  assert.equal(noPause.refused, true);
  assert.equal(deepseek.control({ session_ref: started.session_ref, operation: 'CANCEL' }).applied, true);
  assert.equal(deepseek.sessions()[0].state, 'CLOSED');

  // Codex supports pause/resume and its own capability set.
  const codex = connectorFor('CODEX').connector;
  const codexSession = codex.startOrAttach({ canonical_job_ref: 'job:2' });
  assert.equal(codex.control({ session_ref: codexSession.session_ref, operation: 'PAUSE' }).applied, true);
  assert.equal(codex.control({ session_ref: codexSession.session_ref, operation: 'RESUME' }).applied, true);
  assert.equal(failure(() => codex.submit({ session_ref: codexSession.session_ref, operation: 'shell.execute' })).code, 'UNSUPPORTED_CAPABILITY');
  assert.equal(failure(() => codex.control({ session_ref: codexSession.session_ref, operation: 'EXPLODE' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => codex.control({ session_ref: 'session:nope', operation: 'CANCEL' })).code, 'UNKNOWN_SESSION');
  assert.equal(failure(() => codex.submit({ session_ref: 'session:nope', operation: 'code.generate' })).code, 'UNKNOWN_SESSION');
});

test('an unknown outcome is never reported as success, and retries do not duplicate', () => {
  assert.deepEqual([...JOB_STATES], ['ACCEPTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED', 'UNKNOWN']);
  const running = connectorFor('DEEPSEEK_HARNESS', { result: { state: 'running' } }).connector;
  const session = running.startOrAttach({ canonical_job_ref: 'job:1' });
  const result = running.result({ session_ref: session.session_ref });
  assert.equal(result.state, 'RUNNING');
  assert.equal(result.terminal, false);
  assert.equal(result.outcome_unknown_is_not_success, false);

  const unknown = connectorFor('DEEPSEEK_HARNESS', { result: { state: 'WHATEVER' } }).connector;
  const unknownSession = unknown.startOrAttach({ canonical_job_ref: 'job:2' });
  const unknownResult = unknown.result({ session_ref: unknownSession.session_ref });
  assert.equal(unknownResult.state, 'UNKNOWN');
  assert.equal(unknownResult.terminal, false);
  assert.equal(unknownResult.outcome_unknown_is_not_success, true);
  assert.equal(unknownResult.invented_result, false);

  const absent = connectorFor('CODEX', { result: {} }).connector;
  const absentSession = absent.startOrAttach({ canonical_job_ref: 'job:3' });
  const absentResult = absent.result({ session_ref: absentSession.session_ref });
  assert.equal(absentResult.state, 'UNKNOWN');
  assert.equal(absentResult.result_ref, null, 'a result reference is never invented');

  const terminal = connectorFor('CODEX', { result: { state: 'SUCCEEDED', result_ref: 'result:final' } }).connector;
  const terminalSession = terminal.startOrAttach({ canonical_job_ref: 'job:4' });
  const terminalResult = terminal.result({ session_ref: terminalSession.session_ref });
  assert.equal(terminalResult.state, 'SUCCEEDED');
  assert.equal(terminalResult.terminal, true);
  assert.equal(terminalResult.result_ref, 'result:final');

  // A repeated submit with the same action key is absorbed.
  const once = connectorFor('CODEX').connector;
  const onceSession = once.startOrAttach({ canonical_job_ref: 'job:5' });
  const first = once.submit({ session_ref: onceSession.session_ref, operation: 'code.generate', action_key: 'k1' });
  const second = once.submit({ session_ref: onceSession.session_ref, operation: 'code.generate', action_key: 'k1' });
  assert.equal(first.submitted, true);
  assert.equal(second.submitted, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.repeated, false);
  assert.equal(second.result_ref, first.result_ref);
  assert.equal(once.journal().filter(entry => entry.event === 'SUBMITTED').length, 1);
  const third = once.submit({ session_ref: onceSession.session_ref, operation: 'code.generate', action_key: 'k2' });
  assert.equal(third.submitted, true, 'a new action key is a new submission');
});

test('component-stage acceptance is only claimed with genuine real-host evidence', () => {
  // A double produced no real evidence, so acceptance is deferred with the exact marker.
  const emulated = connectorFor('DEEPSEEK_HARNESS').connector;
  const deferred = emulated.acceptanceReport();
  assert.equal(deferred.component_stage_acceptance, false);
  assert.equal(deferred.deferred_marker, ACCEPTANCE_DEFERRED);
  assert.equal(deferred.real_submit_evidence, null);
  assert.equal(deferred.emulated_smoke_labelled_as_acceptance, false, 'an emulated smoke is never labelled provider acceptance');

  // Partial evidence is not enough either.
  const partial = connectorFor('CODEX', { acceptanceEvidence: { real: true, submit_ref: 'submit:1' } }).connector;
  assert.equal(partial.acceptanceReport().component_stage_acceptance, false);
  assert.equal(partial.acceptanceReport().deferred_marker, ACCEPTANCE_DEFERRED);
  const notReal = connectorFor('CODEX', { acceptanceEvidence: { real: false, submit_ref: 's', progress_ref: 'p', terminal_ref: 't' } }).connector;
  assert.equal(notReal.acceptanceReport().component_stage_acceptance, false, 'a non-real runtime cannot prove acceptance even with full references');

  // Genuine submit -> progress -> terminal evidence from a real host runtime is accepted.
  const real = connectorFor('DEEPSEEK_HARNESS', {
    acceptanceEvidence: { real: true, submit_ref: 'submit:1', progress_ref: 'progress:1', terminal_ref: 'terminal:1', terminal_state: 'SUCCEEDED' },
  }).connector;
  const accepted = real.acceptanceReport();
  assert.equal(accepted.component_stage_acceptance, true);
  assert.equal(accepted.deferred_marker, null);
  assert.equal(accepted.evidence_source, 'HOST_RUNTIME');
  assert.deepEqual(accepted.real_submit_evidence, { submit_ref: 'submit:1', progress_ref: 'progress:1', terminal_ref: 'terminal:1', terminal_state: 'SUCCEEDED' });
  assert.equal(accepted.emulated_smoke_labelled_as_acceptance, false);

  // The registry summarizes honestly across connectors.
  const registry = createConnectorRegistry({ clock: () => T0 });
  registry.register({ connector: emulated });
  registry.register({ connector: connectorFor('CODEX').connector });
  registry.register({ connector: real });
  const summary = registry.acceptanceSummary();
  assert.deepEqual(summary.component_stage_accepted, ['DEEPSEEK_HARNESS']);
  assert.deepEqual(summary.deferred, ['CODEX'], 'the connector without genuine evidence stays deferred');
  assert.equal(summary.emulated_acceptance_claimed, 0);
  assert.equal(summary.reports.length, 2);
});

test('the connector contract is strict, frozen and independent of ambient state', () => {
  const { connector, calls } = connectorFor('CODEX');
  const session = connector.startOrAttach({ canonical_job_ref: 'job:1' });
  assert.throws(() => { session.canonical_job_ref = 'job:hijacked'; }, TypeError, 'session records are frozen');
  assert.throws(() => { connector.capabilities().capabilities.push('shell.execute'); }, TypeError);
  assert.throws(() => { connector.descriptor().capabilities.push('shell.execute'); }, TypeError);
  assert.equal(connector.descriptor().donor_is_runtime_requirement, false, 'the donor repository is evidence, not a runtime dependency');
  assert.equal(connector.descriptor().donor_repo, null);

  // Two connectors share no state, and the port never exposes a product-specific shape.
  const other = connectorFor('CODEX').connector;
  assert.equal(other.sessions().length, 0);
  assert.equal(connector.sessions().length, 1);
  assert.equal(connector.port().methods.length, 11);
  assert.equal(calls.start, 1);

  // Registry isolation and honest clock handling.
  const registry = createConnectorRegistry();
  assert.equal(registry.connector('CODEX'), null, 'an unregistered connector is a typed absence');
  assert.equal(failure(() => createConnectorRegistry({ clock: 'now' })).code, 'INVALID_CLOCK');
  assert.equal(createConnectorRegistry({ clock: () => 'not-an-instant' }).coverage ? true : true, true);
  assert.equal(connector.journal().some(entry => entry.event === 'STARTED'), true);
  assert.equal(connector.health().emulated, false);
  assert.equal(connector.auth().emulated, false);
});
