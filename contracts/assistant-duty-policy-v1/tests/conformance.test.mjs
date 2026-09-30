// Conformance tests for BA-009 鈥?duties, permission + proactivity policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANGE_TRIGGERS, DECISIONS, DutyPolicyError, POLICY_AXES, PROACTIVITY_LEVELS, createDutyPolicyRegistry,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const BUTLER = 'assistant:butler-a';
const SPECIALIST = 'assistant:specialist-b';

function registryAt(policy = {}) {
  const state = { ms: 0 };
  const clock = () => new Date(Date.parse(T0) + state.ms).toISOString();
  clock.advance = ms => { state.ms += ms; return clock(); };
  const registry = createDutyPolicyRegistry({ clock, policy });
  registry.setDutyPolicy({ assistant_ref: BUTLER, duties: ['camera.capture', 'calendar.read'], proactivity: 'ACT_WITH_CONFIRMATION' });
  registry.setDutyPolicy({ assistant_ref: SPECIALIST, duties: ['calendar.read'], proactivity: 'NOTIFY' });
  return { registry, clock };
}

const axesFor = overrides => ({ user_owner_policy: true, assistant_policy: true, device_capability: true, task_action_grant: true, ...overrides });

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof DutyPolicyError, `expected a DutyPolicyError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

test('two assistants hold different duties and proactivity over one authorized user context', () => {
  const { registry } = registryAt();
  assert.deepEqual([...POLICY_AXES], ['USER_OWNER_POLICY', 'ASSISTANT_POLICY', 'DEVICE_CAPABILITY', 'TASK_ACTION_GRANT']);
  assert.deepEqual([...PROACTIVITY_LEVELS], ['SILENT', 'NOTIFY', 'SUGGEST', 'ACT_WITH_CONFIRMATION', 'ACT_AUTONOMOUSLY']);
  assert.deepEqual([...DECISIONS], ['ALLOWED', 'DENIED', 'CONFIRMATION_REQUIRED', 'PROACTIVE_NOTIFICATION', 'DELEGATED', 'REFUSED']);

  const butler = registry.dutyPolicy(BUTLER);
  const specialist = registry.dutyPolicy(SPECIALIST);
  assert.deepEqual(butler.duties, ['camera.capture', 'calendar.read']);
  assert.deepEqual(specialist.duties, ['calendar.read']);
  assert.equal(butler.proactivity, 'ACT_WITH_CONFIRMATION');
  assert.equal(specialist.proactivity, 'NOTIFY');
  assert.equal(butler.source, 'ASSISTANT_OWNED_POLICY');
  assert.equal(butler.writes_digital_me, false, 'duty policy never writes canonical user data');
  assert.equal(registry.assistants().length, 2);

  // Both act on the same shared context, with different outcomes for the same action.
  const butlerCamera = registry.decide({ assistant_ref: BUTLER, action_ref: 'camera.capture', axes: axesFor() });
  const specialistCamera = registry.decide({ assistant_ref: SPECIALIST, action_ref: 'camera.capture', axes: axesFor() });
  assert.equal(butlerCamera.decision, 'CONFIRMATION_REQUIRED', 'the butler is in duty but its proactivity needs confirmation');
  assert.equal(specialistCamera.decision, 'REFUSED');
  assert.equal(specialistCamera.reason, 'OUT_OF_DUTY');
  const specialistCalendar = registry.decide({ assistant_ref: SPECIALIST, action_ref: 'calendar.read', axes: axesFor() });
  assert.equal(specialistCalendar.decision, 'ALLOWED', 'the specialist is allowed on its own duty');
  assert.equal(registry.sharedCoreContribution().is_second_global_policy_engine, false);
  assert.equal(registry.sharedCoreContribution().contributes_to, 'SHARED_CORE_POLICY_CONTRACT');
});

test('out-of-duty requests are refused or delegated without changing permissions', () => {
  const { registry } = registryAt();
  const check = registry.checkDuty({ assistant_ref: SPECIALIST, action_ref: 'camera.capture' });
  assert.equal(check.duty_kind, 'OUT_OF_DUTY');
  assert.equal(check.in_duty, false);
  assert.equal(check.underlying_permissions_changed, false, 'a duty check never edits permissions');
  assert.equal(check.delegated_to, 'SHARED_CORE_DUTY_MATCHER');
  assert.equal(registry.checkDuty({ assistant_ref: SPECIALIST, action_ref: 'calendar.read' }).in_duty, true);

  const refused = registry.decide({ assistant_ref: SPECIALIST, action_ref: 'camera.capture', axes: axesFor() });
  assert.equal(refused.decision, 'REFUSED');
  assert.equal(refused.reason, 'OUT_OF_DUTY');
  assert.equal(refused.underlying_permissions_changed, false);
  assert.equal(refused.executed, false);

  // An explicit duty reference is honoured, and a wildcard duty covers everything.
  assert.equal(registry.checkDuty({ assistant_ref: BUTLER, action_ref: 'anything', duty_ref: 'calendar.read' }).in_duty, true);
  registry.setDutyPolicy({ assistant_ref: 'assistant:general', duties: ['*'], proactivity: 'NOTIFY' });
  assert.equal(registry.decide({ assistant_ref: 'assistant:general', action_ref: 'anything.at.all', axes: axesFor() }).decision, 'ALLOWED');

  assert.equal(failure(() => registry.checkDuty({ assistant_ref: 'assistant:nope', action_ref: 'x' })).code, 'UNKNOWN_ASSISTANT');
  assert.equal(failure(() => registry.checkDuty({ assistant_ref: BUTLER })).code, 'INVALID_REQUEST');
  assert.equal(registry.dutyPolicy('assistant:nope'), null, 'an unknown assistant is a typed absence');
});

test('effective permission is the four-axis intersection and a lease never substitutes for it', () => {
  const { registry } = registryAt();
  for (const axis of ['user_owner_policy', 'assistant_policy', 'device_capability', 'task_action_grant']) {
    const denied = registry.decide({ assistant_ref: BUTLER, action_ref: 'calendar.read', axes: axesFor({ [axis]: false }) });
    assert.equal(denied.decision, 'DENIED', `${axis} must be required`);
    assert.equal(denied.denied_axes.length, 1);
    assert.equal(denied.executed, false);
  }
  assert.equal(registry.decide({ assistant_ref: BUTLER, action_ref: 'calendar.read', axes: axesFor() }).decision, 'CONFIRMATION_REQUIRED', 'the butler may act on its own duty, but its proactivity level requires confirmation');
  assert.equal(registry.decide({ assistant_ref: SPECIALIST, action_ref: 'calendar.read', axes: axesFor() }).decision, 'ALLOWED');

  // A perfectly valid lease cannot rescue a policy denial or a missing capability.
  const lease = { lease_ref: 'lease:1', lease_valid: true, holder_ref: BUTLER };
  const policyDenied = registry.decide({ assistant_ref: BUTLER, action_ref: 'calendar.read', axes: axesFor({ user_owner_policy: false }), lease });
  assert.equal(policyDenied.decision, 'DENIED');
  assert.equal(policyDenied.lease_usable, true);
  assert.equal(policyDenied.lease_would_not_help, true, 'a lease is execution safety, not permission');
  assert.equal(policyDenied.effective_permission.lease_does_not_grant_forbidden_capability, true);
  const capabilityDenied = registry.decide({ assistant_ref: BUTLER, action_ref: 'calendar.read', axes: axesFor(), capability_available: false, lease });
  assert.equal(capabilityDenied.decision, 'DENIED');
  assert.equal(capabilityDenied.reason, 'CAPABILITY_MISSING');
  assert.equal(capabilityDenied.task_owner_authorized, true);

  assert.equal(registry.assertLeaseIsNotPermission({ assistant_ref: BUTLER, lease_ref: 'lease:1', action_ref: 'calendar.read', axes: axesFor({ assistant_policy: false }) }).lease_is_permission, false);
  assert.equal(registry.assertLeaseIsNotPermission({ assistant_ref: BUTLER, lease_ref: 'lease:1', action_ref: 'calendar.read', axes: axesFor() }).lease_supplied_capability, false);
  assert.equal(failure(() => registry.assertLeaseIsNotPermission({ assistant_ref: BUTLER, action_ref: 'x' })).code, 'INVALID_REQUEST');
});

test('a handoff to a less-privileged assistant stays less privileged', () => {
  const { registry } = registryAt();
  const handoff = registry.evaluateHandoff({ from_assistant_ref: BUTLER, to_assistant_ref: SPECIALIST, action_ref: 'camera.capture', axes: axesFor() });
  assert.equal(handoff.from_decision, 'CONFIRMATION_REQUIRED');
  assert.equal(handoff.to_decision, 'REFUSED', 'the recipient recomputes from its own duty policy');
  assert.equal(handoff.recipient_recomputed_permission, true);
  assert.equal(handoff.recipient_inherits_grants, false);
  assert.equal(handoff.authority_transferred, false);
  assert.equal(handoff.recipient_more_privileged_than_before, false);

  // A handoff payload cannot elevate the recipient.
  const elevation = failure(() => registry.evaluateHandoff({
    from_assistant_ref: BUTLER, to_assistant_ref: SPECIALIST, action_ref: 'camera.capture', axes: axesFor(),
    handoff: { grants: ['camera.capture'], checkpoint_ref: 'checkpoint:1' },
  }));
  assert.equal(elevation.code, 'HANDOFF_CANNOT_ELEVATE');
  assert.equal(elevation.recipient_elevated, false);
  const decideElevation = failure(() => registry.decide({ assistant_ref: SPECIALIST, action_ref: 'camera.capture', axes: axesFor(), handoff: { grants: ['camera.capture'] } }));
  assert.equal(decideElevation.code, 'HANDOFF_CANNOT_ELEVATE');
  assert.equal(decideElevation.elevation_applied, false);

  // A handoff with no grants is fine and still transfers no authority.
  const clean = registry.evaluateHandoff({ from_assistant_ref: BUTLER, to_assistant_ref: SPECIALIST, action_ref: 'calendar.read', axes: axesFor(), handoff: { checkpoint_ref: 'checkpoint:1' } });
  assert.equal(clean.to_decision, 'ALLOWED');
  assert.equal(clean.authority_transferred, false);
  assert.equal(failure(() => registry.evaluateHandoff({ from_assistant_ref: BUTLER, to_assistant_ref: 'assistant:nope', action_ref: 'x', axes: axesFor() })).code, 'UNKNOWN_ASSISTANT');
});

test('permission is recomputed after handoff, device change, reconnect and capability change', () => {
  const { registry } = registryAt();
  assert.deepEqual([...CHANGE_TRIGGERS], ['HANDOFF', 'EXECUTOR_CHANGE', 'DEVICE_CHANGE', 'RECONNECT', 'CAPABILITY_CHANGE', 'DUTY_CHANGE']);
  for (const trigger of CHANGE_TRIGGERS) {
    const decision = registry.recomputeForChange({ assistant_ref: SPECIALIST, action_ref: 'calendar.read', trigger, axes: axesFor() });
    assert.equal(decision.trigger, trigger);
    assert.equal(decision.recomputed_after_change, true);
    assert.equal(decision.cached_decision_reused, false, `${trigger} must not reuse a cached decision`);
    assert.equal(decision.inherited_permission, false);
    assert.equal(decision.decision, 'ALLOWED');
  }
  // A capability loss during a device change blocks the action.
  const lost = registry.recomputeForChange({ assistant_ref: BUTLER, action_ref: 'camera.capture', trigger: 'CAPABILITY_CHANGE', axes: axesFor(), capability_available: false });
  assert.equal(lost.decision, 'DENIED');
  assert.equal(lost.reason, 'CAPABILITY_MISSING');
  assert.equal(registry.recomputeForChange({ assistant_ref: BUTLER, action_ref: 'calendar.read', trigger: 'HANDOFF', axes: axesFor({ task_action_grant: false }) }).decision, 'DENIED');
  assert.equal(failure(() => registry.recomputeForChange({ assistant_ref: BUTLER, action_ref: 'x', trigger: 'SOMETHING', axes: axesFor() })).code, 'INVALID_REQUEST');
});

test('proactivity levels bound initiative and notification audiences', () => {
  const { registry } = registryAt();
  const silent = registry.setDutyPolicy({ assistant_ref: 'assistant:quiet', duties: ['*'], proactivity: 'SILENT' });
  assert.equal(silent.proactivity, 'SILENT');
  assert.equal(silent.confirmation_required, false);

  const notify = registry.proactiveNotice({ assistant_ref: SPECIALIST, topic_ref: 'calendar.reminder' });
  assert.equal(notify.decision, 'PROACTIVE_NOTIFICATION');
  assert.equal(notify.initiative_executed, false, 'a notification is not an action');
  assert.equal(notify.user_permission_unchanged, true);

  const quiet = registry.proactiveNotice({ assistant_ref: 'assistant:quiet', topic_ref: 'anything' });
  assert.equal(quiet.decision, 'REFUSED');
  assert.equal(quiet.reason, 'SILENT_ASSISTANT');

  const proactive = registry.setDutyPolicy({ assistant_ref: 'assistant:keen', duties: ['*'], proactivity: 'ACT_WITH_CONFIRMATION' });
  assert.equal(proactive.confirmation_required, true);
  const keen = registry.proactiveNotice({ assistant_ref: 'assistant:keen', topic_ref: 'anything' });
  assert.equal(keen.decision, 'CONFIRMATION_REQUIRED');
  assert.equal(keen.reason, 'INITIATIVE_REQUIRES_CONFIRMATION');
  assert.equal(keen.initiative_executed, false);

  // An audience outside the assistant's notification scope is refused, not silently widened.
  const scoped = registry.setDutyPolicy({ assistant_ref: 'assistant:scoped', duties: ['*'], proactivity: 'NOTIFY', notification_audiences: ['USER'] });
  assert.deepEqual(scoped.notification_audiences, ['USER']);
  const outOfScope = registry.proactiveNotice({ assistant_ref: 'assistant:scoped', topic_ref: 'x', audience: 'PUBLIC' });
  assert.equal(outOfScope.decision, 'REFUSED');
  assert.equal(outOfScope.reason, 'PROACTIVITY_LIMIT');
  assert.equal(outOfScope.user_permission_unchanged, true);

  // The deployment ceiling cannot be exceeded, and duties are independent of Digital-Me.
  assert.equal(failure(() => registry.setDutyPolicy({ assistant_ref: 'assistant:keen', duties: ['*'], proactivity: 'ACT_AUTONOMOUSLY' })).code, 'PROACTIVITY_LIMIT');
  assert.equal(failure(() => registry.setDutyPolicy({ assistant_ref: 'assistant:keen', duties: ['*'], proactivity: 'ALWAYS' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => registry.setDutyPolicy({ assistant_ref: '', duties: [] })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => registry.setDutyPolicy({ assistant_ref: 'a', duties: [1] })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => registry.writeDigitalMe()).code, 'DIGITAL_ME_IS_READ_ONLY');
  assert.equal(failure(() => registry.writeDigitalMe()).canonical_source, 'DIGITAL_ME_CANONICAL');
  assert.equal(failure(() => registry.proactiveNotice({ assistant_ref: SPECIALIST })).code, 'INVALID_REQUEST');
});

test('the policy engine is strict, frozen, observable and independent', () => {
  const { registry } = registryAt();
  const duty = registry.dutyPolicy(BUTLER);
  assert.throws(() => { duty.duties.push('shell.execute'); }, TypeError, 'duty policies are frozen');
  assert.throws(() => { duty.proactivity = 'ACT_AUTONOMOUSLY'; }, TypeError);
  const decision = registry.decide({ assistant_ref: BUTLER, action_ref: 'calendar.read', axes: axesFor() });
  assert.throws(() => { decision.decision = 'DENIED'; }, TypeError);
  assert.equal(decision.effective_permission.permission_is_intersectional, true);
  assert.equal(decision.effective_permission.persona_is_not_permission, true);
  assert.equal(decision.effective_permission.profile_is_not_permission, true);
  assert.equal(decision.effective_permission.relationship_state_is_not_permission, true);
  assert.equal(decision.effective_permission.foreground_is_not_permission, true);

  // Decisions are recorded and retrievable, revisions advance, and the journal is inspectable.
  assert.equal(registry.decisions().length > 0, true);
  assert.equal(registry.decision(decision.decision_id).assistant_ref, BUTLER);
  assert.equal(registry.decision('decision:nope'), null);
  const first = registry.setDutyPolicy({ assistant_ref: BUTLER, duties: ['calendar.read'], proactivity: 'NOTIFY' });
  const second = registry.setDutyPolicy({ assistant_ref: BUTLER, duties: ['calendar.read'], proactivity: 'NOTIFY' });
  assert.equal(second.revision, first.revision + 1, 'duty changes are versioned');
  assert.equal(registry.dutyPolicy(BUTLER).duties.includes('camera.capture'), false, 'the latest policy replaced the duties');
  assert.equal(registry.journal().some(entry => entry.event === 'DUTY_POLICY_SET'), true);

  // Two registries share nothing, and shared-core contribution is explicit.
  const other = registryAt().registry;
  assert.equal(other.assistants().length, 2);
  assert.equal(other.decisions().length, 0);
  assert.equal(registry.sharedCoreContribution().root_core_authority_moved, false);
  assert.equal(registry.sharedCoreContribution().fabric_revalidates_effective_decision, true);
  assert.equal(failure(() => createDutyPolicyRegistry({ clock: 'now' })).code, 'INVALID_CLOCK');
  assert.equal(registry.policy().policy_ref, 'policy:ba-duty-default');
});
