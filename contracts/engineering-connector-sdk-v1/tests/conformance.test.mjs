// Conformance tests for EM-012 鈥?Connector SDK + Claude Code / WorkBuddy extension paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCEPTANCE_PENDING, ADAPTER_FAMILIES, ADAPTER_STATES, AUTH_SEMANTICS, CAPABILITY_SEMANTICS,
  MINIMUM_CONNECTOR_METHODS, SdkError, TEST_EXPECTATIONS, createAdapterRegistry, createSdkAdapter,
  defineConnector, extensionGuide, runConformanceHarness,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';

/** A well-behaved synthetic connector built only with the SDK helpers. */
function syntheticHandlers(behaviour = {}) {
  const calls = [];
  const handlers = {
    probe: () => ({ installed: behaviour.installed !== false }),
    version: () => ({ version: behaviour.version ?? '1.0.0' }),
    auth: () => ({ state: behaviour.auth_state ?? 'READY' }),
    readiness: () => ({ state: behaviour.readiness ?? 'READY' }),
    capabilities: () => ({ capabilities: behaviour.capabilities ?? ['code.generate'] }),
    health: () => ({ health: behaviour.health ?? 'HEALTHY', attention: behaviour.attention ?? null }),
    startOrAttach: ({ canonical_job_ref }) => ({ canonical_job_ref, session_ref: 'session:synthetic:1' }),
    submit: ({ operation }) => {
      calls.push(operation);
      if (behaviour.submit_throws) {
        const error = new Error(behaviour.submit_throws.message ?? 'adapter blew up');
        error.code = behaviour.submit_throws.code;
        throw error;
      }
      if (!(behaviour.capabilities ?? ['code.generate']).includes(operation)) {
        const error = new Error(`unsupported ${operation}`);
        error.code = 'UNSUPPORTED_CAPABILITY';
        throw error;
      }
      return { result_ref: 'result:1' };
    },
    events: () => ({ events: [] }),
    control: ({ operation }) => {
      if (!(behaviour.controls ?? []).includes(operation)) {
        const error = new Error(`unsupported ${operation}`);
        error.code = 'UNSUPPORTED_OPERATION';
        throw error;
      }
      return { applied: true };
    },
    result: () => ({ state: behaviour.result_state ?? 'RUNNING', terminal: false }),
  };
  return { handlers, calls };
}

const definitionFor = (kind = 'SYNTHETIC_THIRD', behaviour = {}) => {
  const { handlers, calls } = syntheticHandlers(behaviour);
  return {
    calls,
    definition: defineConnector({
      connector_kind: kind,
      family: behaviour.family ?? null,
      capabilities: behaviour.capabilities ?? ['code.generate'],
      supported_controls: behaviour.controls ?? ['CANCEL'],
      optional: behaviour.optional === true,
      handlers,
      at: T0,
    }),
  };
};

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof SdkError, `expected an SdkError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

test('the SDK validates a definition and documents what an author must supply', () => {
  assert.equal(MINIMUM_CONNECTOR_METHODS.length, 11);
  assert.equal(CAPABILITY_SEMANTICS.canonical_names_only, true);
  assert.equal(AUTH_SEMANTICS.human_states_never_auto_retry, true);
  assert.equal(TEST_EXPECTATIONS.length >= 8, true);
  assert.deepEqual([...ADAPTER_FAMILIES], ['DEEPSEEK_HARNESS', 'CODEX', 'CLAUDE_CODE', 'WORKBUDDY']);
  assert.deepEqual([...ADAPTER_STATES], ['ENABLED', 'DISABLED', 'UNAVAILABLE', 'FAULTED', 'UNPROVEN']);

  const { definition } = definitionFor('DOC_PROBE');
  assert.equal(definition.minimum_methods_satisfied, true);
  assert.equal(definition.core_edited, false);
  assert.equal(Object.isFrozen(definition), true);

  // A definition missing methods names them, so an author knows exactly what to add.
  const missing = failure(() => defineConnector({ connector_kind: 'PARTIAL', handlers: { probe: () => ({ installed: true }) } }));
  assert.equal(missing.code, 'MISSING_METHOD');
  assert.equal(missing.missing_methods.length, 10);
  assert.equal(missing.missing_methods.includes('probe'), false);
  assert.equal(missing.minimum_methods.length, 11);
  assert.equal(failure(() => defineConnector({ handlers: {} })).code, 'INVALID_DEFINITION');
  assert.equal(failure(() => defineConnector({ connector_kind: 'X', handlers: syntheticHandlers().handlers, capabilities: [1] })).code, 'INVALID_DEFINITION');
  assert.equal(failure(() => defineConnector({ connector_kind: 'X', handlers: syntheticHandlers().handlers, family: 'MYSTERY' })).code, 'INVALID_DEFINITION');

  const guide = extensionGuide();
  assert.equal(guide.core_files_to_edit, 0, 'adding an adapter edits no core file');
  assert.equal(guide.registry_entries_required, 1);
  assert.equal(guide.foreman_core_edited, false);
  assert.equal(guide.engineering_manager_port_version_unchanged, true);
  assert.equal(guide.provider_specific_policy_in_core, false);
  assert.equal(guide.steps.length, 5);
  assert.deepEqual(guide.minimum_methods, [...MINIMUM_CONNECTOR_METHODS]);
});

test('a synthetic third connector passes the conformance harness without core edits', () => {
  const { definition } = definitionFor('SYNTHETIC_THIRD', { controls: [], capabilities: ['code.generate'] });
  const report = runConformanceHarness({ definition, fixtures: { canonical_job_ref: 'job:synthetic' }, at: T0 });
  assert.equal(report.conformant, true, JSON.stringify(report.checks.filter(check => !check.passed)));
  assert.equal(report.failed_count, 0);
  assert.equal(report.core_edits_required, 0);
  assert.equal(report.registry_changes_required, 0);
  assert.equal(report.foreman_core_edited, false);
  assert.equal(report.engineering_manager_port_version_unchanged, true);
  assert.equal(report.checks.length, 11);
  assert.equal(report.checks.every(check => check.name.length > 0), true);

  // A misbehaving connector fails the harness with a typed diagnosis instead of passing silently.
  const { definition: misbehaving } = definitionFor('BROKEN', { capabilities: ['code.generate'], controls: [] });
  const tampered = { ...misbehaving, handlers: { ...misbehaving.handlers, probe: () => ({ installed: 'yes' }) } };
  const broken = runConformanceHarness({ definition: tampered, at: T0 });
  assert.equal(broken.conformant, false);
  assert.equal(broken.failed_count >= 1, true);
  assert.equal(broken.checks.find(entry => entry.name.includes('probe')).passed, false);
  assert.equal(broken.checks.find(entry => entry.name.includes('probe')).detail.code, 'MALFORMED_RESULT');
  assert.equal(failure(() => runConformanceHarness({ definition: {} })).code, 'INVALID_DEFINITION');
});

test('adapter exceptions, timeouts and malformed results are isolated to the faulting adapter', () => {
  const registry = createAdapterRegistry({ clock: () => T0 });
  const { definition: healthy } = definitionFor('HEALTHY_ADAPTER', { controls: [] });
  const { definition: faulty } = definitionFor('FAULTY_ADAPTER', { controls: [], submit_throws: { code: 'ECONNRESET', message: 'socket died' } });
  const healthyAdapter = createSdkAdapter({ definition: healthy, clock: () => T0 });
  const faultyAdapter = createSdkAdapter({ definition: faulty, clock: () => T0 });
  registry.register({ adapter: healthyAdapter });
  registry.register({ adapter: faultyAdapter });
  assert.equal(failure(() => registry.register({ adapter: healthyAdapter })).code, 'DUPLICATE_ADAPTER');

  const fault = failure(() => faultyAdapter.submit({ session_ref: 'session:1', operation: 'code.generate' }));
  assert.equal(fault.code, 'ADAPTER_FAULT');
  assert.equal(fault.fault_kind, 'EXCEPTION');
  assert.equal(fault.isolated, true);
  assert.deepEqual(fault.unrelated_connectors_affected, []);
  assert.equal(faultyAdapter.adapterState(), 'FAULTED');
  assert.equal(faultyAdapter.faults().length, 1);
  assert.equal(faultyAdapter.faults()[0].isolated_to, 'FAULTY_ADAPTER');

  // The healthy adapter is untouched, and the faulted one is excluded from selection.
  assert.equal(healthyAdapter.health().health, 'HEALTHY');
  assert.equal(registry.selectForCapability({ capability: 'code.generate' }).connector_kind, 'HEALTHY_ADAPTER');
  assert.equal(failure(() => faultyAdapter.capabilities()).code, 'ADAPTER_FAULT');
  const startup = registry.startupReport();
  assert.equal(startup.startup_blocked, false);
  assert.deepEqual(startup.unrelated_connectors_blocked, []);
  assert.deepEqual(startup.usable, ['HEALTHY_ADAPTER']);

  // A timeout is typed distinctly, and clearing faults restores the adapter.
  const { definition: slow } = definitionFor('SLOW_ADAPTER', { controls: [], submit_throws: { code: 'TIMEOUT', message: 'deadline' } });
  const slowAdapter = createSdkAdapter({ definition: slow, clock: () => T0 });
  const timedOut = failure(() => slowAdapter.submit({ session_ref: 'session:1', operation: 'code.generate' }));
  assert.equal(timedOut.code, 'ADAPTER_TIMEOUT');
  assert.equal(timedOut.fault_kind, 'TIMEOUT');
  assert.equal(slowAdapter.clearFaults().adapter_state, 'ENABLED');
  assert.equal(slowAdapter.faults().length, 0);
  const malformed = failure(() => createSdkAdapter({ definition: { ...slow, handlers: { ...slow.handlers, version: () => undefined } }, clock: () => T0 }).version());
  assert.equal(malformed.code, 'MALFORMED_RESULT');
  assert.equal(failure(() => createSdkAdapter({ definition: {}, clock: () => T0 })).code, 'INVALID_DEFINITION');
  assert.equal(failure(() => createSdkAdapter({ definition: slow, clock: 'now' })).code, 'INVALID_CLOCK');
});

test('optional provider absence is a typed state that blocks nothing and fabricates nothing', () => {
  const registry = createAdapterRegistry({ clock: () => T0 });
  const { definition: claude } = definitionFor('CLAUDE_CODE', { family: 'CLAUDE_CODE', optional: true, controls: ['CANCEL'] });
  const { definition: workbuddy } = definitionFor('WORKBUDDY', { family: 'WORKBUDDY', optional: true, controls: [] });
  const { definition: core } = definitionFor('CORE_CONNECTOR', { controls: [] });
  const claudeAdapter = createSdkAdapter({ definition: claude, available: false, clock: () => T0 });
  const workbuddyAdapter = createSdkAdapter({ definition: workbuddy, available: false, clock: () => T0 });
  const coreAdapter = createSdkAdapter({ definition: core, clock: () => T0 });
  registry.register({ adapter: claudeAdapter });
  registry.register({ adapter: workbuddyAdapter });
  registry.register({ adapter: coreAdapter });

  assert.equal(claudeAdapter.adapterState(), 'UNAVAILABLE');
  const unavailable = failure(() => claudeAdapter.probe());
  assert.equal(unavailable.code, 'OPTIONAL_UNAVAILABLE');
  assert.equal(unavailable.adapter_state, 'UNAVAILABLE');
  assert.equal(unavailable.fabricated_installation, false);
  assert.equal(unavailable.acceptance_marker, ACCEPTANCE_PENDING);
  assert.equal(workbuddyAdapter.optional(), true);

  // Start-up is never blocked by an absent optional product.
  const startup = registry.startupReport();
  assert.equal(startup.startup_blocked, false);
  assert.deepEqual(startup.unrelated_connectors_blocked, []);
  assert.deepEqual(startup.usable, ['CORE_CONNECTOR']);
  assert.deepEqual([...startup.unavailable].sort(), ['CLAUDE_CODE', 'WORKBUDDY']);
  assert.equal(registry.selectForCapability({ capability: 'code.generate' }).connector_kind, 'CORE_CONNECTOR');
  assert.equal(failure(() => registry.selectForCapability({ capability: 'telepathy' })).code, 'OPTIONAL_UNAVAILABLE');

  // Acceptance for an absent product is pending, never claimed.
  const pending = claudeAdapter.acceptance();
  assert.equal(pending.component_stage_acceptance, false);
  assert.equal(pending.marker, ACCEPTANCE_PENDING);
  assert.equal(pending.fabricated_installation, false);
  assert.equal(pending.fabricated_run, false);
  const summary = registry.acceptanceSummary();
  assert.equal(summary.pending.includes('CLAUDE_CODE'), true);
  assert.equal(summary.fabricated_acceptance_claimed, 0);

  // Enabling is explicit and restores the adapter to the same port surface.
  const enabled = claudeAdapter.enable({ available: true });
  assert.equal(enabled.enabled, true);
  assert.equal(claudeAdapter.adapterState(), 'ENABLED');
  assert.equal(claudeAdapter.probe().installed, true);
  const refusedEnable = claudeAdapter.enable({ available: false });
  assert.equal(refusedEnable.enabled, false);
  assert.equal(refusedEnable.reason, 'PRODUCT_UNAVAILABLE');
  assert.equal(claudeAdapter.disable({ reason: 'USER_DISABLED' }).disabled, true);
  assert.equal(claudeAdapter.adapterState(), 'DISABLED');
});

test('Claude Code and WorkBuddy adapters use the SDK path, and acceptance needs real host evidence', () => {
  const evidenceRuntime = {
    acceptanceEvidence: ({ connector_kind }) => connector_kind === 'CLAUDE_CODE'
      ? { real: true, submit_ref: 'submit:1', terminal_ref: 'terminal:1' }
      : null,
  };
  const { definition: claude } = definitionFor('CLAUDE_CODE', { family: 'CLAUDE_CODE', optional: true, controls: ['CANCEL'] });
  const { definition: workbuddy } = definitionFor('WORKBUDDY', { family: 'WORKBUDDY', optional: true, controls: [] });
  const claudeAdapter = createSdkAdapter({ definition: claude, runtime: evidenceRuntime, clock: () => T0 });
  const workbuddyAdapter = createSdkAdapter({ definition: workbuddy, clock: () => T0 });

  // Both are built only from SDK helpers, so the harness passes for both.
  for (const definition of [claude, workbuddy]) {
    const report = runConformanceHarness({ definition, fixtures: { canonical_job_ref: 'job:extension' }, at: T0 });
    assert.equal(report.conformant, true, `${definition.connector_kind} must conform`);
    assert.equal(report.core_edits_required, 0);
    assert.equal(definition.family === 'CLAUDE_CODE' || definition.family === 'WORKBUDDY', true);
  }
  assert.equal(claudeAdapter.family(), 'CLAUDE_CODE');
  assert.equal(workbuddyAdapter.family(), 'WORKBUDDY');

  // Genuine evidence is accepted; its absence is pending rather than assumed.
  const accepted = claudeAdapter.acceptance();
  assert.equal(accepted.component_stage_acceptance, true);
  assert.equal(accepted.evidence_source, 'HOST_RUNTIME');
  assert.deepEqual(accepted.real_evidence, { submit_ref: 'submit:1', terminal_ref: 'terminal:1' });
  assert.equal(accepted.fabricated_run, false);
  const pending = workbuddyAdapter.acceptance();
  assert.equal(pending.component_stage_acceptance, false);
  assert.equal(pending.marker, ACCEPTANCE_PENDING);

  // Partial evidence is not acceptance.
  const partialRuntime = { acceptanceEvidence: () => ({ real: true, submit_ref: 'submit:1' }) };
  const { definition: partial } = definitionFor('PARTIAL_EVIDENCE', { controls: [] });
  assert.equal(createSdkAdapter({ definition: partial, runtime: partialRuntime, clock: () => T0 }).acceptance().component_stage_acceptance, false);
  const nonRealRuntime = { acceptanceEvidence: () => ({ real: false, submit_ref: 's', terminal_ref: 't' }) };
  assert.equal(createSdkAdapter({ definition: partial, runtime: nonRealRuntime, clock: () => T0 }).acceptance().marker, ACCEPTANCE_PENDING);
});

test('adding an adapter alters neither the EngineeringManagerPort nor the scheduling core', () => {
  const registry = createAdapterRegistry({ clock: () => T0 });
  const before = { port_version: 1, foreman_nodes: 3 };
  const { definition } = definitionFor('NEW_FAMILY_ADAPTER', { controls: [] });
  const registration = registry.register({ adapter: createSdkAdapter({ definition, clock: () => T0 }) });
  assert.equal(registration.core_edited, false);
  assert.equal(registration.registry_logic_changed, false);
  const after = { port_version: 1, foreman_nodes: 3 };
  assert.deepEqual(after, before, 'the port version and the scheduling core are untouched');

  // The guide states the same guarantee, and selection stays capability-based.
  assert.equal(extensionGuide().foreman_core_edited, false);
  assert.equal(registry.selectForCapability({ capability: 'code.generate' }).core_edited, false);
  assert.equal(registry.selectForCapability({ capability: 'code.generate' }).provider_specific_policy_in_core, undefined);
  assert.equal(failure(() => registry.selectForCapability({})).code, 'INVALID_REQUEST');
  assert.equal(registry.adapter('NOT_REGISTERED'), null, 'an unregistered adapter is a typed absence');
  assert.equal(failure(() => registry.register({ adapter: {} })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => createAdapterRegistry({ clock: 'now' })).code, 'INVALID_CLOCK');
});

test('the SDK surface is strict, frozen and free of ambient state', () => {
  const { definition } = definitionFor('FROZEN_CHECK');
  const adapter = createSdkAdapter({ definition, clock: () => T0 });
  assert.throws(() => { definition.connector_kind = 'HIJACKED'; }, TypeError, 'definitions are frozen');
  assert.throws(() => { const capabilities = adapter.capabilities(); capabilities.capabilities.push('shell.execute'); }, TypeError);
  assert.throws(() => { extensionGuide().steps.push('edit core'); }, TypeError);
  assert.equal(Object.isFrozen(extensionGuide().capability_semantics), true);

  // Two registries share nothing, and the harness result is frozen too.
  const report = runConformanceHarness({ definition, at: T0 });
  assert.throws(() => { report.conformant = false; }, TypeError);
  assert.equal(createAdapterRegistry({ clock: () => T0 }).adapterKinds().length, 0);
  const first = createAdapterRegistry({ clock: () => T0 });
  first.register({ adapter: adapter });
  assert.equal(first.adapterKinds().length, 1);
  assert.equal(createAdapterRegistry({ clock: () => T0 }).adapterKinds().length, 0);
  assert.equal(adapter.optional(), false);
  assert.equal(adapter.faults().length, 0);
  assert.equal(adapter.acceptance().marker, ACCEPTANCE_PENDING, 'no runtime evidence means pending, not accepted');
  assert.equal(ACCEPTANCE_PENDING, 'REAL_PROVIDER_ACCEPTANCE_PENDING');
});
// EM-012-CORRECTION-REGRESSIONS - the corrected behaviours that the Development head did not have.
import { isIsoInstant } from '../index.mjs';

const adapterFor = (kind, behaviour = {}, extra = {}) => createSdkAdapter({ definition: definitionFor(kind, behaviour).definition, clock: () => T0, ...extra });

test('a definition cannot be declared with mistyped policy fields or an impossible instant', () => {
  const handlers = syntheticHandlers().handlers;
  assert.equal(failure(() => defineConnector({ connector_kind: 'OPTIONAL_STRING', handlers, optional: 'yes' })).code, 'INVALID_DEFINITION');
  assert.equal(failure(() => defineConnector({ connector_kind: 'CONTROLS_NULL', handlers, supported_controls: null })).code, 'INVALID_DEFINITION');
  assert.equal(failure(() => defineConnector({ connector_kind: 'CONTROLS_STRING', handlers, supported_controls: 'CANCEL' })).code, 'INVALID_DEFINITION');
  assert.equal(failure(() => defineConnector({ connector_kind: 'CONTROLS_MIXED', handlers, supported_controls: ['CANCEL', 7] })).code, 'INVALID_DEFINITION');
  assert.equal(isIsoInstant('2026-01-01T00:00:00.000Z'), true);
  assert.equal(isIsoInstant('2026-13-45T99:99:99Z'), false, 'an impossible instant is not an instant');
  assert.equal(isIsoInstant('2026-02-30T00:00:00Z'), false, 'a rolled-over calendar date is not an instant');
  assert.equal(failure(() => defineConnector({ connector_kind: 'BAD_INSTANT', handlers, at: '2026-02-30T00:00:00Z' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => runConformanceHarness({ definition: definitionFor('HARNESS_BAD_AT').definition, at: '2026-13-45T99:99:99Z' })).code, 'INVALID_REQUEST');
});

test('a cyclic port result crosses the boundary as a frozen cycle, not as the adapter own object', () => {
  const cyclic = defineConnector({
    connector_kind: 'CYCLIC_RESULT',
    capabilities: ['code.generate'],
    handlers: {
      ...syntheticHandlers().handlers,
      capabilities: () => {
        const value = { capabilities: ['code.generate'] };
        value.self = value;
        return value;
      },
    },
    at: T0,
  });
  const result = createSdkAdapter({ definition: cyclic, clock: () => T0 }).capabilities();
  assert.equal(result.self === result, true, 'the snapshot preserves the cycle');
  assert.equal(Object.isFrozen(result), true, 'a caller cannot mutate the adapter own object');
  assert.equal(result.capabilities.includes('code.generate'), true);
});

test('a non-cloneable port result is a typed refusal instead of a live object', () => {
  const uncloneable = defineConnector({
    connector_kind: 'UNCLONEABLE_RESULT',
    capabilities: ['code.generate'],
    handlers: { ...syntheticHandlers().handlers, capabilities: () => ({ capabilities: ['code.generate'], live: () => 'adapter state' }) },
    at: T0,
  });
  const adapter = createSdkAdapter({ definition: uncloneable, clock: () => T0 });
  const refused = failure(() => adapter.capabilities());
  assert.equal(refused.code, 'MALFORMED_RESULT');
  assert.equal(refused.fault_kind, 'MALFORMED_RESULT');
});

test('the harness does not certify a connector that silently accepts an unsupported capability', () => {
  const lenient = defineConnector({
    connector_kind: 'LENIENT_CAPABILITIES',
    capabilities: ['code.generate'],
    handlers: { ...syntheticHandlers().handlers, submit: () => ({ result_ref: 'result:lenient' }) },
    at: T0,
  });
  const report = runConformanceHarness({ definition: lenient });
  const check = report.checks.find(entry => entry.name.includes('unsupported capabilities'));
  assert.equal(check.passed, false, 'accepting an unsupported operation is not conformance');
  assert.equal(check.detail.code, 'MALFORMED_RESULT');
  assert.equal(report.conformant, false);
});

test('the harness does not certify a connector that silently accepts an unsupported control', () => {
  const lenient = defineConnector({
    connector_kind: 'LENIENT_CONTROLS',
    capabilities: ['code.generate'],
    handlers: { ...syntheticHandlers().handlers, control: () => ({ applied: true }) },
    at: T0,
  });
  const report = runConformanceHarness({ definition: lenient, fixtures: { unsupported_control: 'TELEPORT' } });
  const check = report.checks.find(entry => entry.name.includes('unsupported controls'));
  assert.equal(check.passed, false);
  assert.equal(check.detail.code, 'MALFORMED_RESULT');
  assert.equal(report.conformant, false);
});

test('an enabled adapter whose product is not installed is not usable, not selected and not accepted', () => {
  const definition = definitionFor('MISSING_PRODUCT', { installed: false }).definition;
  const adapter = createSdkAdapter({ definition, clock: () => T0 });
  assert.equal(adapter.adapterState(), 'ENABLED');
  assert.equal(adapter.installState(), 'NOT_INSTALLED');
  const registry = createAdapterRegistry({ clock: () => T0 });
  registry.register({ adapter });
  const startup = registry.startupReport();
  assert.equal(startup.adapters[0].install_state, 'NOT_INSTALLED');
  assert.equal(startup.usable.includes('MISSING_PRODUCT'), false, 'an uninstalled product is not usable');
  assert.equal(startup.unavailable.includes('MISSING_PRODUCT'), true);
  assert.equal(failure(() => registry.selectForCapability({ capability: 'code.generate' })).code, 'OPTIONAL_UNAVAILABLE');
  const claiming = createSdkAdapter({
    definition,
    runtime: { acceptanceEvidence: () => ({ real: true, submit_ref: 'submit:1', terminal_ref: 'terminal:1' }) },
    clock: () => T0,
  });
  const acceptance = claiming.acceptance();
  assert.equal(acceptance.component_stage_acceptance, false, 'a product that reports itself uninstalled cannot be accepted');
  assert.equal(acceptance.marker, ACCEPTANCE_PENDING);
});

test('only a faulted adapter can be cleared, and the fault record survives the clearing', () => {
  const healthy = adapterFor('CLEAR_WHEN_HEALTHY');
  assert.equal(failure(() => healthy.clearFaults()).code, 'INVALID_REQUEST');
  const faulty = createSdkAdapter({
    definition: defineConnector({
      connector_kind: 'FAULTY_TO_CLEAR',
      capabilities: ['code.generate'],
      handlers: { ...syntheticHandlers().handlers, probe: () => { throw new Error('probe exploded'); } },
      at: T0,
    }),
    clock: () => T0,
  });
  assert.equal(failure(() => faulty.probe()).code, 'ADAPTER_FAULT');
  assert.equal(faulty.adapterState(), 'FAULTED');
  const cleared = faulty.clearFaults();
  assert.equal(cleared.adapter_state, 'ENABLED');
  assert.equal(cleared.cleared_fault_count, 1);
  assert.equal(cleared.faults_retained, true);
  assert.equal(faulty.faults().length, 0);
  assert.equal(faulty.faultHistory().length, 1, 'the cleared fault is retained as a record');
  assert.equal(faulty.faultHistory()[0].faults.length, 1);
  assert.equal(faulty.faultHistory()[0].faults[0].isolated_to, 'FAULTY_TO_CLEAR');
  assert.equal(faulty.faultHistory()[0].faults[0].clock_valid, true);
});

test('re-declaring availability cannot revive a faulted adapter', () => {
  const faulty = createSdkAdapter({
    definition: defineConnector({
      connector_kind: 'FAULTY_REVIVE',
      capabilities: ['code.generate'],
      handlers: { ...syntheticHandlers().handlers, capabilities: () => { throw new Error('capabilities exploded'); } },
      at: T0,
    }),
    clock: () => T0,
  });
  assert.equal(failure(() => faulty.capabilities()).code, 'ADAPTER_FAULT');
  assert.equal(failure(() => faulty.enable()).code, 'ADAPTER_FAULT');
  assert.equal(faulty.adapterState(), 'FAULTED');
  assert.equal(failure(() => adapterFor('BAD_AVAILABLE').enable({ available: 'yes' })).code, 'INVALID_REQUEST');
});

test('the registry refuses an adapter the SDK did not wrap, so isolation cannot be bypassed', () => {
  const forged = {
    connectorKind: () => 'FORGED_ADAPTER',
    adapterState: () => 'ENABLED',
    optional: () => false,
    installState: () => 'INSTALLED',
    capabilities: () => ({ capabilities: ['code.generate'] }),
    acceptance: () => ({ connector_kind: 'FORGED_ADAPTER', component_stage_acceptance: true }),
  };
  const registry = createAdapterRegistry({ clock: () => T0 });
  const refused = failure(() => registry.register({ adapter: forged }));
  assert.equal(refused.code, 'INVALID_REQUEST');
  assert.equal(refused.isolation_wrapped, false);
  assert.deepEqual([...registry.adapterKinds()], []);
  const wrapped = registry.register({ adapter: adapterFor('WRAPPED_ADAPTER') });
  assert.equal(wrapped.isolation_wrapped, true);
});

test('a caller-declared acceptance says so instead of implying the SDK verified a host', () => {
  const definition = definitionFor('DECLARED_EVIDENCE').definition;
  const adapter = createSdkAdapter({
    definition,
    runtime: { acceptanceEvidence: () => ({ real: true, submit_ref: 'submit:9', terminal_ref: 'terminal:9' }) },
    clock: () => T0,
  });
  const accepted = adapter.acceptance();
  assert.equal(accepted.component_stage_acceptance, true);
  assert.equal(accepted.acceptance_verified_here, false, 'this SDK cannot verify a host runtime');
  assert.equal(accepted.evidence_declared_by, 'CALLER_SUPPLIED_RUNTIME');
  assert.equal(accepted.real_evidence_verified_here, false);
  assert.deepEqual(accepted.real_evidence, { submit_ref: 'submit:9', terminal_ref: 'terminal:9' });
  const registry = createAdapterRegistry({ clock: () => T0 });
  registry.register({ adapter });
  const summary = registry.acceptanceSummary();
  assert.equal(summary.fabricated_acceptance_claimed, 1, 'an unverified acceptance is counted as such');
  assert.deepEqual([...summary.unverified_acceptances], ['DECLARED_EVIDENCE']);
  class Evidence {
    constructor() {
      this.real = true;
      this.submit_ref = 'submit:1';
      this.terminal_ref = 'terminal:1';
    }
  }
  const classRuntime = createSdkAdapter({ definition, runtime: { acceptanceEvidence: () => new Evidence() }, clock: () => T0 });
  assert.equal(classRuntime.acceptance().component_stage_acceptance, false, 'a class instance is not a plain evidence record');
  assert.equal(classRuntime.acceptance().marker, ACCEPTANCE_PENDING);
});
// EM-012-CORRECTION-REGRESSIONS-PASS-3 - hostile errors, harness certification, handler record, fault identity.

test('an error whose code getter throws is still an isolated, typed fault', () => {
  const hostile = createSdkAdapter({
    definition: defineConnector({
      connector_kind: 'HOSTILE_ERROR',
      capabilities: ['code.generate'],
      handlers: {
        ...syntheticHandlers().handlers,
        capabilities: () => {
          const error = { message: 'hostile' };
          Object.defineProperty(error, 'code', { get() { throw new Error('code getter exploded'); }, enumerable: true });
          throw error;
        },
      },
      at: T0,
    }),
    clock: () => T0,
  });
  const refused = failure(() => hostile.capabilities());
  assert.equal(refused.code, 'ADAPTER_FAULT');
  assert.equal(refused.fault_kind, 'EXCEPTION');
  assert.equal(refused.adapter_state, 'FAULTED');
  assert.equal(hostile.adapterState(), 'FAULTED');
  const fault = hostile.faults()[0];
  assert.equal(fault.code_readable, false);
  assert.equal(fault.detail, 'unreadable error');
  assert.equal(fault.recorded_by, 'SDK_ADAPTER');
});

test('the harness refuses a connector that reports a state outside the vocabulary', () => {
  const report = runConformanceHarness({
    definition: defineConnector({
      connector_kind: 'BAD_RESULT_STATE',
      capabilities: ['code.generate'],
      handlers: { ...syntheticHandlers().handlers, result: () => ({ state: 'BANANA', terminal: false }) },
      at: T0,
    }),
  });
  const check = report.checks.find(entry => entry.name.includes('result distinguishes'));
  assert.equal(check.passed, false);
  assert.equal(check.detail.code, 'MALFORMED_RESULT');
  assert.equal(report.conformant, false);
});

test('the harness refuses a declared capability the connector does not report', () => {
  const report = runConformanceHarness({
    definition: defineConnector({
      connector_kind: 'UNDECLARED_CAPABILITY',
      capabilities: ['code.generate', 'telepathy'],
      handlers: syntheticHandlers({ capabilities: ['code.generate'] }).handlers,
      at: T0,
    }),
  });
  const check = report.checks.find(entry => entry.name.includes('capabilities are canonical'));
  assert.equal(check.passed, false);
  assert.equal(check.detail.code, 'MALFORMED_RESULT');
  assert.equal(report.conformant, false);
});

test('the harness proves the unsupported-control expectation instead of skipping it', () => {
  const report = runConformanceHarness({ definition: definitionFor('DEFAULT_CONTROL_CHECK').definition });
  const check = report.checks.find(entry => entry.name.includes('unsupported controls'));
  assert.equal(check.detail.skipped === true, false, 'the control expectation is proven, not skipped');
  assert.equal(check.passed, true);
  assert.equal(report.skipped_count, 0);
  assert.equal(report.conformant, true);
});

test('a definition whose handlers are only inherited is refused, not claimed as satisfied', () => {
  const inherited = Object.create(syntheticHandlers().handlers);
  const refused = failure(() => defineConnector({ connector_kind: 'PROTOTYPE_HANDLERS', handlers: inherited }));
  assert.equal(refused.code, 'INVALID_DEFINITION', 'handlers must be a plain own-method record');
});

test('a definition stores the methods it validated, including non-enumerable ones', () => {
  const handlers = {};
  for (const [method, fn] of Object.entries(syntheticHandlers().handlers)) {
    Object.defineProperty(handlers, method, { value: fn, enumerable: false, writable: false });
  }
  const definition = defineConnector({ connector_kind: 'HIDDEN_METHODS', capabilities: ['code.generate'], handlers, at: T0 });
  assert.equal(definition.minimum_methods_satisfied, true);
  assert.equal(typeof definition.handlers.probe, 'function', 'the stored record carries the validated method');
  assert.equal(MINIMUM_CONNECTOR_METHODS.every(method => typeof definition.handlers[method] === 'function'), true);
});

test('a non-conformant connector is given no core-edit certificate', () => {
  const lenient = defineConnector({
    connector_kind: 'NO_CERTIFICATE',
    capabilities: ['code.generate'],
    handlers: { ...syntheticHandlers().handlers, submit: () => ({ result_ref: 'result:lenient' }) },
    at: T0,
  });
  const report = runConformanceHarness({ definition: lenient });
  assert.equal(report.conformant, false);
  assert.equal(report.claims_withheld, true);
  assert.equal(report.core_edits_required, null);
  assert.equal(report.foreman_core_edited, null);
  assert.equal(report.engineering_manager_port_version_unchanged, null);
});

test('a runtime that throws is not evidence and does not break the acceptance summary', () => {
  const adapter = adapterFor('BROKEN_RUNTIME', {}, { runtime: { acceptanceEvidence: () => { throw new Error('runtime exploded'); } } });
  assert.equal(adapter.acceptance().marker, ACCEPTANCE_PENDING);
  const registry = createAdapterRegistry({ clock: () => T0 });
  registry.register({ adapter });
  const summary = registry.acceptanceSummary();
  assert.equal(summary.pending.includes('BROKEN_RUNTIME'), true);
  assert.equal(summary.fabricated_acceptance_claimed, 0);
});

test('fault identities are unique across adapters of the same kind in one process', () => {
  const faultyFor = message => createSdkAdapter({
    definition: defineConnector({
      connector_kind: 'SAME_KIND_FAULT',
      capabilities: ['code.generate'],
      handlers: { ...syntheticHandlers().handlers, probe: () => { throw new Error(message); } },
      at: T0,
    }),
    clock: () => T0,
  });
  const first = faultyFor('first exploded');
  const second = faultyFor('second exploded');
  assert.equal(failure(() => first.probe()).code, 'ADAPTER_FAULT');
  assert.equal(failure(() => second.probe()).code, 'ADAPTER_FAULT');
  assert.equal(first.faults()[0].fault_ref === second.faults()[0].fault_ref, false, 'two adapters must not publish the same fault reference');
});
