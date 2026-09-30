// BA-003 conformance suite — device embodiment + foreground binding.
//
// Covers the workbook's acceptance lines: one assistant on PC and Android at once; a device
// refuses a second simultaneous foreground assistant; foreground A→B while an unrelated A-owned
// background task stays A-owned and continues; switching never creates a handoff, cancels work or
// replaces an executor; device-local state is released and rebound cleanly; and binding
// reconstructs after restart from authoritative state, never from stale local assumptions.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 ACTION_KINDS, ASSISTANT_EMBODIMENT_CONTRACT, BINDING_SOURCES, CAPABILITY_KINDS,
 DEVICE_IDENTITY_AUTHORITY, EMBODIMENT_CONTRACT_VERSION, EmbodimentError, LOCAL_STATE_KINDS,
 TASK_OBSERVATION_PORT, UI_SURFACES, assertEmbodimentDescriptor, createDeterministicTaskObservationDouble,
 createEmbodimentRegistry, descriptorFor, deviceIdentityReference, findCompetingIdentityFields,
 restoreEmbodimentRegistry, validateEmbodimentDescriptor
} from '../index.mjs';

const TS = '2026-09-30T12:00:00.000Z';
const EARLIER = '2026-09-30T11:00:00.000Z';
const PC_DEVICE = 'dev-11111111111111111111111111111111';
const PHONE_DEVICE = 'dev-22222222222222222222222222222222';

const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

const pcDescriptor = (overrides = {}) => descriptorFor({
  embodimentRef: 'embodiment-mech-pc',
  kind: 'DESKTOP',
  displayName: 'Mech workstation',
  capabilities: ['DISPLAY', 'SPEAKER', 'KEYBOARD'],
  sensors: [],
  uiSurfaces: ['CHAT'],
  actions: ['DISPLAY', 'SPEAK'],
  deviceIdentityRef: deviceIdentityReference({ device_id: PC_DEVICE, installation_ref: 'ins-1' }),
  registeredAt: EARLIER,
  ...overrides,
});

const phoneDescriptor = (overrides = {}) => descriptorFor({
  embodimentRef: 'embodiment-mech-phone',
  kind: 'MOBILE',
  displayName: 'Mech phone',
  capabilities: ['MICROPHONE', 'CAMERA', 'DISPLAY', 'NOTIFICATION'],
  sensors: ['PRESENCE'],
  uiSurfaces: ['CHAT', 'VOICE', 'NOTIFICATION'],
  actions: ['SPEAK', 'NOTIFY', 'CAPTURE'],
  deviceIdentityRef: deviceIdentityReference({ device_id: PHONE_DEVICE, installation_ref: 'ins-2' }),
  registeredAt: EARLIER,
  ...overrides,
});

const zoneOf = (tasks = []) => {
  const observation = createDeterministicTaskObservationDouble({ tasks });
  return { observation, registry: createEmbodimentRegistry({ clock: () => TS, taskObservation: observation }) };
};

/* ------------------------------------------------ 1. descriptors */

test('an embodiment descriptor references Remote Fabric identity and never mints its own', () => {
  assert.deepEqual(validateEmbodimentDescriptor(pcDescriptor()), { ok: true, errors: [] });
  assert.equal(pcDescriptor().device_identity_ref.authority, DEVICE_IDENTITY_AUTHORITY);
  const competing = { ...pcDescriptor(), butler_device_id: PC_DEVICE };
  const verdict = validateEmbodimentDescriptor(competing);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some(error => error.includes('competing physical-device identity')), true);
  assert.deepEqual(findCompetingIdentityFields({ device_trust_state: 'TRUSTED' }, ''), ['.device_trust_state']);
  // an unknown identity authority or a foreign reference shape is refused
  assert.equal(validateEmbodimentDescriptor({ ...pcDescriptor(), device_identity_ref: { ...pcDescriptor().device_identity_ref, authority: 'BUTLER' } }).ok, false);
  assert.equal(validateEmbodimentDescriptor({ ...pcDescriptor(), device_identity_ref: { ...pcDescriptor().device_identity_ref, butler_id: 'x' } }).ok, false);
  expectCode(() => deviceIdentityReference({ device_id: 'not-a-device-id' }), 'INVALID_DEVICE_IDENTITY');
});

test('a device without cross-device identity is representable, and says so', () => {
  const local = pcDescriptor({ deviceIdentityRef: null });
  assert.equal(local.identity_source, 'UNAVAILABLE');
  assert.equal(local.device_identity_ref, null);
  assert.equal(validateEmbodimentDescriptor(local).ok, true);
  // the two identity sources cannot disagree with the reference
  assert.equal(validateEmbodimentDescriptor({ ...local, device_identity_ref: deviceIdentityReference({ device_id: PC_DEVICE }) }).ok, false);
  assert.equal(validateEmbodimentDescriptor({ ...pcDescriptor(), identity_source: 'UNAVAILABLE' }).ok, false);
});

test('descriptor vocabularies are closed and unknown values are refused', () => {
  const base = pcDescriptor();
  const withField = overrides => ({ ...base, ...overrides });
  assert.equal(validateEmbodimentDescriptor(withField({ capabilities: ['TELEPORT'] })).ok, false);
  assert.equal(validateEmbodimentDescriptor(withField({ sensors: ['MIND_READING'] })).ok, false);
  assert.equal(validateEmbodimentDescriptor(withField({ ui_surfaces: ['HOLOGRAM'] })).ok, false);
  assert.equal(validateEmbodimentDescriptor(withField({ actions: ['EXPLODE'] })).ok, false);
  assert.equal(validateEmbodimentDescriptor(withField({ kind: 'TOASTER' })).ok, false);
  assert.equal(validateEmbodimentDescriptor(withField({ locality: 'SOMEWHERE' })).ok, false);
  assert.equal(validateEmbodimentDescriptor(withField({ mood: 'happy' })).ok, false);
  assert.equal(validateEmbodimentDescriptor(withField({ ui_surfaces: ['NONE', 'CHAT'] })).ok, false);
  assert.equal(validateEmbodimentDescriptor(withField({ ui_surfaces: ['NONE'] })).ok, true);
  assert.equal(validateEmbodimentDescriptor(withField({ registered_at: 'yesterday' })).ok, false);
  assert.equal(validateEmbodimentDescriptor(withField({ embodiment_ref: 'PC 1' })).ok, false);
  assert.equal(validateEmbodimentDescriptor(withField({ embodiment_version: 2 })).ok, false);
  assert.equal(validateEmbodimentDescriptor(null).ok, false);
  // the constructor itself refuses, so an invalid descriptor cannot even be built
  assert.throws(() => pcDescriptor({ capabilities: ['TELEPORT'] }), error => error.code === 'INVALID_EMBODIMENT_DESCRIPTOR');
  assert.deepEqual(Object.keys(ASSISTANT_EMBODIMENT_CONTRACT).includes('foreground_assistants_per_device'), true);
  assert.equal(UI_SURFACES.includes('CHAT'), true);
  assert.equal(CAPABILITY_KINDS.includes('CAMERA'), true);
  assert.equal(ACTION_KINDS.includes('NOTIFY'), true);
});

/* ------------------------------------------------ 2. attachment */

test('one logical assistant inhabits PC and Android at the same time', () => {
  const { registry } = zoneOf();
  registry.registerEmbodiment(pcDescriptor());
  registry.registerEmbodiment(phoneDescriptor());
  registry.attachAssistant('assistant-butler', 'embodiment-mech-pc');
  registry.attachAssistant('assistant-butler', 'embodiment-mech-phone');
  assert.deepEqual(registry.listDevicesForAssistant('assistant-butler'), ['embodiment-mech-pc', 'embodiment-mech-phone']);
  // attachment is presence, not authority: no foreground binding was created
  assert.equal(registry.getForeground('embodiment-mech-pc'), null);
  assert.equal(registry.getForeground('embodiment-mech-phone'), null);
  // several assistants may be present on one device
  registry.attachAssistant('assistant-companion', 'embodiment-mech-phone');
  assert.deepEqual(registry.listAssistantsForDevice('embodiment-mech-phone'), ['assistant-butler', 'assistant-companion']);
  assert.equal(registry.attachAssistant('assistant-butler', 'embodiment-mech-pc').idempotent, true);
});

test('a device refuses a second simultaneous foreground assistant', () => {
  const { registry } = zoneOf();
  registry.registerEmbodiment(phoneDescriptor());
  registry.attachAssistant('assistant-butler', 'embodiment-mech-phone');
  registry.attachAssistant('assistant-companion', 'embodiment-mech-phone');
  registry.bindForeground('embodiment-mech-phone', { assistantRef: 'assistant-butler' });
  assert.equal(registry.getForeground('embodiment-mech-phone').assistant_ref, 'assistant-butler');
  expectCode(() => registry.bindForeground('embodiment-mech-phone', { assistantRef: 'assistant-companion' }), 'FOREGROUND_ALREADY_BOUND');
  assert.equal(registry.getForeground('embodiment-mech-phone').assistant_ref, 'assistant-butler');
  // an unattached assistant can never take the foreground
  expectCode(() => registry.bindForeground('embodiment-mech-phone', { assistantRef: 'assistant-stranger' }), 'ASSISTANT_NOT_ATTACHED');
  assert.deepEqual(registry.assertSingleForegroundPerDevice(), { devices: 1, ok: true });
});

test('detaching the foreground assistant releases the binding', () => {
  const { registry } = zoneOf();
  registry.registerEmbodiment(pcDescriptor());
  registry.attachAssistant('assistant-butler', 'embodiment-mech-pc');
  registry.bindForeground('embodiment-mech-pc', { assistantRef: 'assistant-butler' });
  const result = registry.detachAssistant('assistant-butler', 'embodiment-mech-pc');
  assert.equal(result.detached, true);
  assert.equal(registry.getForeground('embodiment-mech-pc'), null);
  assert.equal(registry.listAssistantsForDevice('embodiment-mech-pc').length, 0);
  assert.equal(registry.detachAssistant('assistant-butler', 'embodiment-mech-pc').detached, false);
  expectCode(() => registry.getForeground('embodiment-unknown'), 'UNKNOWN_EMBODIMENT');
});

/* ------------------------------------------------ 3. foreground switch */

test('foreground A->B switches cleanly and releases the outgoing local context', () => {
  const { registry } = zoneOf();
  registry.registerEmbodiment(phoneDescriptor());
  registry.attachAssistant('assistant-butler', 'embodiment-mech-phone');
  registry.attachAssistant('assistant-companion', 'embodiment-mech-phone');
  registry.bindForeground('embodiment-mech-phone', { assistantRef: 'assistant-butler' });
  registry.setLocalState('embodiment-mech-phone', { kind: 'UI_TRANSIENT', value: { screen: 'butler-home' } });
  registry.setLocalState('embodiment-mech-phone', { kind: 'SENSORY_CONTEXT', value: { ambient: 'quiet' } });
  assert.deepEqual(Object.keys(registry.getLocalState('embodiment-mech-phone')).sort(), ['SENSORY_CONTEXT', 'UI_TRANSIENT']);
  const switched = registry.switchForeground('embodiment-mech-phone', { assistantRef: 'assistant-companion', expectedForegroundRef: 'assistant-butler' });
  assert.equal(switched.switched, true);
  assert.equal(switched.released_local_state_for, 'assistant-butler');
  assert.equal(switched.is_task_ownership, false);
  assert.equal(switched.is_execution_lease, false);
  assert.equal(registry.getForeground('embodiment-mech-phone').assistant_ref, 'assistant-companion');
  // the outgoing session's device-local context is gone, not inherited
  assert.deepEqual(registry.getLocalState('embodiment-mech-phone'), {});
  assert.deepEqual(registry.assertSingleForegroundPerDevice(), { devices: 1, ok: true });
});

test('a stale foreground view cannot take the device over', () => {
  const { registry } = zoneOf();
  registry.registerEmbodiment(phoneDescriptor());
  for (const assistant of ['assistant-butler', 'assistant-companion', 'assistant-secretary']) registry.attachAssistant(assistant, 'embodiment-mech-phone');
  registry.bindForeground('embodiment-mech-phone', { assistantRef: 'assistant-butler' });
  registry.switchForeground('embodiment-mech-phone', { assistantRef: 'assistant-companion', expectedForegroundRef: 'assistant-butler' });
  // a caller that still believes butler holds the device must not silently win
  expectCode(() => registry.switchForeground('embodiment-mech-phone', { assistantRef: 'assistant-secretary', expectedForegroundRef: 'assistant-butler' }), 'FOREGROUND_MISMATCH');
  assert.equal(registry.getForeground('embodiment-mech-phone').assistant_ref, 'assistant-companion');
  // switching to the assistant that already holds it is a no-op, not a new epoch
  const idempotent = registry.switchForeground('embodiment-mech-phone', { assistantRef: 'assistant-companion' });
  assert.equal(idempotent.idempotent, true);
  assert.equal(idempotent.switched, false);
  expectCode(() => registry.releaseForeground('embodiment-mech-phone', { assistantRef: 'assistant-butler' }), 'FOREGROUND_MISMATCH');
  assert.equal(registry.releaseForeground('embodiment-mech-phone', { assistantRef: 'assistant-companion' }).released, true);
  assert.equal(registry.getForeground('embodiment-mech-phone'), null);
});

/* ------------------------------------------------ 4. background continuity */

test('a foreground switch leaves an unrelated background task owned, executing and uncancelled', () => {
  const tasks = [
    { task_ref: 'task-a', owner_ref: 'assistant-butler', executor_ref: 'embodiment-mech-pc', lease_ref: 'lease-1', lease_valid: true, capability_available: true, capability_ref: 'cap-1' },
    { task_ref: 'task-b', owner_ref: 'assistant-butler', executor_ref: 'embodiment-mech-pc', lease_ref: null, lease_valid: false, capability_available: true, capability_ref: 'cap-2' },
  ];
  const { registry, observation } = zoneOf(tasks);
  registry.registerEmbodiment(pcDescriptor());
  registry.registerEmbodiment(phoneDescriptor());
  registry.attachAssistant('assistant-butler', 'embodiment-mech-pc');
  registry.attachAssistant('assistant-butler', 'embodiment-mech-phone');
  registry.attachAssistant('assistant-companion', 'embodiment-mech-pc');
  registry.bindForeground('embodiment-mech-pc', { assistantRef: 'assistant-butler' });

  const before = registry.backgroundContinuity('assistant-butler');
  const callsBefore = observation.__calls.length;
  registry.switchForeground('embodiment-mech-pc', { assistantRef: 'assistant-companion' });
  const after = registry.backgroundContinuity('assistant-butler');

  // the task is still owned by butler, still on the same executor, and continues
  assert.deepEqual(after, before);
  assert.equal(after.find(task => task.task_ref === 'task-a').continues, true);
  assert.equal(after.find(task => task.task_ref === 'task-a').owner_ref, 'assistant-butler');
  assert.equal(after.find(task => task.task_ref === 'task-a').executor_ref, 'embodiment-mech-pc');
  assert.equal(after.every(task => task.cancelled_by_foreground_switch === false && task.ownership_changed_by_foreground_switch === false), true);
  // a task whose lease is not valid stops for its own reason, not because of the switch
  assert.equal(after.find(task => task.task_ref === 'task-b').continues, false);
  assert.equal(after.find(task => task.task_ref === 'task-b').reason, 'CONTINUITY_PRECONDITION_FAILED');
  // only observation happened: the registry cannot mutate ownership, cancel or reassign
  const methods = new Set(observation.__calls.slice(callsBefore).map(call => call.method));
  assert.equal([...methods].every(method => TASK_OBSERVATION_PORT.methods.includes(method)), true);
  assert.equal(TASK_OBSERVATION_PORT.may_mutate_ownership, false);
  assert.equal(TASK_OBSERVATION_PORT.may_cancel, false);
  assert.equal(TASK_OBSERVATION_PORT.may_reassign_executor, false);
  assert.equal(ASSISTANT_EMBODIMENT_CONTRACT.foreground_switch_moves_tasks, false);
});

/* ------------------------------------------------ 5. device-local state */

test('device-local context stays per-device and never becomes authoritative', () => {
  const { registry } = zoneOf();
  registry.registerEmbodiment(pcDescriptor());
  registry.registerEmbodiment(phoneDescriptor());
  registry.setLocalState('embodiment-mech-pc', { kind: 'LOCAL_SCRATCH', value: { draft: 'unfinished' } });
  registry.setLocalState('embodiment-mech-phone', { kind: 'UI_TRANSIENT', value: { screen: 'chat' } });
  assert.deepEqual(Object.keys(registry.getLocalState('embodiment-mech-pc')), ['LOCAL_SCRATCH']);
  assert.deepEqual(Object.keys(registry.getLocalState('embodiment-mech-phone')), ['UI_TRANSIENT']);
  const snapshot = registry.snapshot();
  assert.equal(JSON.stringify(snapshot).includes('unfinished'), false);
  assert.equal(JSON.stringify(snapshot).includes('LOCAL_SCRATCH'), false);
  assert.equal(ASSISTANT_EMBODIMENT_CONTRACT.device_local_state_is_authoritative, false);
  expectCode(() => registry.setLocalState('embodiment-mech-pc', { kind: 'TOKEN_CONTEXT', value: {} }), 'UNKNOWN_LOCAL_STATE_KIND');
  assert.deepEqual([...LOCAL_STATE_KINDS], ['SENSORY_CONTEXT', 'UI_TRANSIENT', 'LOCAL_SCRATCH']);
  assert.equal(registry.clearLocalState('embodiment-mech-pc').cleared, true);
  assert.deepEqual(registry.getLocalState('embodiment-mech-pc'), {});
});

/* ------------------------------------------------ 6. restart / recovery */

test('binding reconstructs from authoritative state after a restart', () => {
  const { registry } = zoneOf();
  registry.registerEmbodiment(pcDescriptor());
  registry.registerEmbodiment(phoneDescriptor());
  registry.attachAssistant('assistant-butler', 'embodiment-mech-pc');
  registry.attachAssistant('assistant-butler', 'embodiment-mech-phone');
  registry.attachAssistant('assistant-companion', 'embodiment-mech-phone');
  registry.bindForeground('embodiment-mech-pc', { assistantRef: 'assistant-butler' });
  registry.bindForeground('embodiment-mech-phone', { assistantRef: 'assistant-companion' });
  registry.setLocalState('embodiment-mech-pc', { kind: 'LOCAL_SCRATCH', value: { draft: 'lost on restart' } });

  const restored = restoreEmbodimentRegistry(registry.snapshot(), { clock: () => TS });
  assert.deepEqual(restored.revalidation_required_for, ['embodiment-mech-pc', 'embodiment-mech-phone']);
  assert.deepEqual(restored.restored_foreground.map(entry => entry.source), ['RESTORED_FROM_AUTHORITY', 'RESTORED_FROM_AUTHORITY']);
  assert.deepEqual(BINDING_SOURCES, ['LIVE_SESSION', 'RESTORED_FROM_AUTHORITY']);
  assert.equal(restored.registry.getForeground('embodiment-mech-pc').assistant_ref, 'assistant-butler');
  assert.equal(restored.registry.getForeground('embodiment-mech-phone').assistant_ref, 'assistant-companion');
  assert.deepEqual(restored.registry.listDevicesForAssistant('assistant-butler'), ['embodiment-mech-pc', 'embodiment-mech-phone']);
  // device-local context did not survive, because it is not authoritative
  assert.deepEqual(restored.registry.getLocalState('embodiment-mech-pc'), {});
  assert.deepEqual(restored.registry.assertSingleForegroundPerDevice(), { devices: 2, ok: true });
  expectCode(() => restoreEmbodimentRegistry({ embodiment_contract_version: 99 }, {}), 'INCOMPATIBLE_EMBODIMENT_SNAPSHOT');
  expectCode(() => restoreEmbodimentRegistry({ embodiment_contract_version: EMBODIMENT_CONTRACT_VERSION, embodiments: [{}], attachments: [], foreground: [] }), 'INCOMPATIBLE_EMBODIMENT_SNAPSHOT');
});

test('a reconnecting device is refused when its local belief disagrees with authority', () => {
  const { registry } = zoneOf();
  registry.registerEmbodiment(phoneDescriptor());
  registry.attachAssistant('assistant-butler', 'embodiment-mech-phone');
  registry.attachAssistant('assistant-companion', 'embodiment-mech-phone');
  registry.bindForeground('embodiment-mech-phone', { assistantRef: 'assistant-butler' });
  const binding = registry.getForeground('embodiment-mech-phone');
  const restored = restoreEmbodimentRegistry(registry.snapshot(), { clock: () => TS });

  // the device reconnects believing it still holds butler: authority agrees
  const agreed = restored.registry.revalidateEmbodiment('embodiment-mech-phone', { assistantRef: 'assistant-butler', localBindingRef: binding.binding_ref });
  assert.equal(agreed.ok, true);
  assert.equal(agreed.reason, 'AUTHORITATIVE_AGREEMENT');

  // the user switched on another surface: the local belief is stale and is refused
  restored.registry.switchForeground('embodiment-mech-phone', { assistantRef: 'assistant-companion' });
  restored.registry.setLocalState('embodiment-mech-phone', { kind: 'LOCAL_SCRATCH', value: { draft: 'stale' } });
  const stale = restored.registry.revalidateEmbodiment('embodiment-mech-phone', { assistantRef: 'assistant-butler', localBindingRef: binding.binding_ref });
  assert.equal(stale.ok, false);
  assert.equal(stale.reason, 'STALE_LOCAL_BINDING');
  assert.equal(stale.authoritative_binding.assistant_ref, 'assistant-companion');
  assert.deepEqual(restored.registry.getLocalState('embodiment-mech-phone'), {});
  // no foreground at all, and a session with no foreground, are distinct honest answers
  restored.registry.releaseForeground('embodiment-mech-phone');
  assert.equal(restored.registry.revalidateEmbodiment('embodiment-mech-phone', { assistantRef: 'assistant-butler' }).reason, 'AUTHORITATIVE_NO_FOREGROUND');
  restored.registry.bindForeground('embodiment-mech-phone', { assistantRef: 'assistant-companion' });
  assert.equal(restored.registry.revalidateEmbodiment('embodiment-mech-phone', { assistantRef: null }).reason, 'LOCAL_SESSION_HAS_NO_FOREGROUND');
});

test('one assistant on many devices keeps each device independent', () => {
  const { registry } = zoneOf();
  registry.registerEmbodiment(pcDescriptor());
  registry.registerEmbodiment(phoneDescriptor());
  registry.attachAssistant('assistant-butler', 'embodiment-mech-pc');
  registry.attachAssistant('assistant-butler', 'embodiment-mech-phone');
  registry.attachAssistant('assistant-companion', 'embodiment-mech-phone');
  registry.bindForeground('embodiment-mech-pc', { assistantRef: 'assistant-butler' });
  registry.bindForeground('embodiment-mech-phone', { assistantRef: 'assistant-butler' });
  // butler is foreground on both devices at once
  assert.deepEqual(['embodiment-mech-pc', 'embodiment-mech-phone'].map(ref => registry.getForeground(ref).assistant_ref), ['assistant-butler', 'assistant-butler']);
  // switching one device does not touch the other
  registry.switchForeground('embodiment-mech-phone', { assistantRef: 'assistant-companion' });
  assert.equal(registry.getForeground('embodiment-mech-pc').assistant_ref, 'assistant-butler');
  assert.equal(registry.getForeground('embodiment-mech-phone').assistant_ref, 'assistant-companion');
  assert.deepEqual(registry.assertSingleForegroundPerDevice(), { devices: 2, ok: true });
  assert.equal(ASSISTANT_EMBODIMENT_CONTRACT.one_logical_assistant_many_devices, true);
  assert.equal(ASSISTANT_EMBODIMENT_CONTRACT.foreground_assistants_per_device, 1);
});

test('duplicate device identity and unknown embodiments are refused', () => {
  const { registry } = zoneOf();
  registry.registerEmbodiment(pcDescriptor());
  expectCode(() => registry.registerEmbodiment(pcDescriptor({ embodimentRef: 'embodiment-mech-pc-2' })), 'DUPLICATE_DEVICE_IDENTITY');
  // a device that refreshes its own descriptor is idempotent, not a conflict
  assert.deepEqual(registry.registerEmbodiment(pcDescriptor()), { embodiment_ref: 'embodiment-mech-pc', registered: true, refreshed: true });
  expectCode(() => registry.registerEmbodiment(pcDescriptor({ embodimentRef: 'embodiment-other', deviceIdentityRef: deviceIdentityReference({ device_id: 'dev-33333333333333333333333333333333' }) }).embodiment_ref && registry.attachAssistant('a', 'embodiment-missing')), 'UNKNOWN_EMBODIMENT');
  const error = expectCode(() => zoneOf().registry.registerEmbodiment(pcDescriptor({ capabilities: ['TELEPORT'] })), 'INVALID_EMBODIMENT_DESCRIPTOR');
  assert.equal(new EmbodimentError('X', 'y').status, 409);
  assert.equal(error.detail.includes('capabilities'), true);
  assert.equal(EMBODIMENT_CONTRACT_VERSION, 1);
});
