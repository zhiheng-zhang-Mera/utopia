// BA-004 conformance suite — assistant switching and explicit task handoff.
//
// Acceptance: switching the phone foreground A->B leaves A's unrelated background task running and owned
// by A while A stays online; no responsibility transfer happens without a machine-readable handoff; a
// true transfer produces a handoff package, recipient permission/capability re-evaluation, acknowledged
// takeover and exactly one authoritative new owner; a rejected or expired handoff leaves the old owner
// unchanged; and the executor is not restarted merely because the owner changed.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 ASSISTANT_HANDOFF_CONTRACT, AUTHORITY_FIELDS, HANDOFF_CODES, HANDOFF_KINDS, HANDOFF_STATES,
 HandoffError, TASK_STORE_PORT, assertHandoff, createHandoffCoordinator, createHandoffPackage,
 createTaskStoreDouble, findAuthorityFields, handoffDepthExceeded, isIsoInstant,
 recomputeRecipientAuthority, switchForegroundAssistant, validateHandoff
} from '../index.mjs';

const TS = '2026-09-30T12:00:00.000Z';
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

const tasks = () => [
  { task_ref: 'task-1', state: 'RUNNING', owner_ref: 'assistant-butler', executor_ref: 'device-desktop', checkpoint_ref: null },
  { task_ref: 'task-background', state: 'RUNNING', owner_ref: 'assistant-butler', executor_ref: 'device-desktop', checkpoint_ref: null },
];
const policy = { grantsByAssistant: { 'assistant-butler': ['FILESYSTEM', 'SHELL'], 'assistant-companion': ['FILESYSTEM'] } };
const coordinatorOn = (list = tasks()) => {
  const store = createTaskStoreDouble({ tasks: list });
  return { store, coordinator: createHandoffCoordinator({ taskStore: store, policy, clock: () => TS }) };
};

/* -------------------------------------------------- 1. switching is not handoff */

test('switching the foreground assistant touches no task', () => {
  const before = tasks();
  const switched = switchForegroundAssistant({
    deviceRef: 'device-phone',
    assistants: ['assistant-butler', 'assistant-companion'],
    from: 'assistant-butler',
    to: 'assistant-companion',
    onlineAssistants: ['assistant-butler', 'assistant-companion'],
  });
  assert.equal(switched.switched, true);
  assert.equal(switched.foreground_after, 'assistant-companion');
  assert.equal(switched.tasks_touched, 0);
  assert.equal(switched.task_ownership_changed, false);
  assert.equal(switched.is_a_handoff, false, 'a foreground switch is never a handoff');
  assert.equal(switched.outgoing_assistant_still_online, true, 'the outgoing assistant stays online elsewhere');
  assert.deepEqual(tasks(), before, 'the task list is untouched by a switch');
  // the unrelated background task is still owned and executed by the outgoing assistant
  const store = createTaskStoreDouble({ tasks: before });
  assert.equal(store.getTask('task-background').owner_ref, 'assistant-butler');
  assert.equal(store.getTask('task-background').executor_ref, 'device-desktop');
  assert.equal(store.__writes.length, 0, 'no task store write happens for a switch');
  assert.equal(ASSISTANT_HANDOFF_CONTRACT.switching_is_a_handoff, false);
  assert.equal(ASSISTANT_HANDOFF_CONTRACT.switching_changes_task_ownership, false);
  // an assistant that is not present on the device cannot become foreground there
  expectCode(() => switchForegroundAssistant({ deviceRef: 'device-phone', assistants: ['assistant-butler'], to: 'assistant-stranger' }), 'RECIPIENT_REQUIRED');
});

/* -------------------------------------------------- 2. authority never transfers */

test('a handoff carries responsibility and never authority', () => {
  const handoff = createHandoffPackage();
  assert.deepEqual(validateHandoff(handoff), { ok: true, errors: [] });
  const withGrant = { ...handoff, grants: ['SHELL'] };
  const verdict = validateHandoff(withGrant);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some(error => error.includes('authority transfer')), true);
  expectCode(() => assertHandoff(withGrant), 'HANDOFF_TRANSFERS_NO_AUTHORITY');
  expectCode(() => assertHandoff({ ...handoff, to: { ...handoff.to, capabilities: ['SHELL'] } }), 'HANDOFF_TRANSFERS_NO_AUTHORITY');
  expectCode(() => assertHandoff({ ...handoff, lease: { scope: 'exclusive' } }), 'HANDOFF_TRANSFERS_NO_AUTHORITY');
  assert.deepEqual(findAuthorityFields({ nested: { action_key: 'k' } }, ''), ['.nested.action_key']);
  assert.equal(AUTHORITY_FIELDS.includes('execution_lease'), true);
  const authority = recomputeRecipientAuthority({ policy, recipientRef: 'assistant-companion', requiredCapabilities: ['FILESYSTEM'] });
  assert.equal(authority.recomputed, true);
  assert.deepEqual([...authority.transferred_grants], [], 'nothing is transferred');
  assert.deepEqual([...authority.granted_capabilities], ['FILESYSTEM']);
  assert.equal(authority.can_take_over, true);
  // the recipient does not inherit the outgoing assistant's wider grants
  const wider = recomputeRecipientAuthority({ policy, recipientRef: 'assistant-companion', requiredCapabilities: ['SHELL'] });
  assert.deepEqual([...wider.missing_capabilities], ['SHELL']);
  assert.equal(wider.can_take_over, false);
  assert.equal(ASSISTANT_HANDOFF_CONTRACT.handoff_transfers_authority, false);
  assert.equal(ASSISTANT_HANDOFF_CONTRACT.recipient_recomputes_permission, true);
});

/* -------------------------------------------------- 3. acknowledged takeover */

test('a true transfer needs acceptance and leaves exactly one authoritative owner', () => {
  const { store, coordinator } = coordinatorOn();
  const proposed = coordinator.propose(createHandoffPackage());
  assert.equal(proposed.proposed, true);
  assert.equal(store.getTask('task-1').owner_ref, 'assistant-butler', 'proposing changes nothing');
  // nobody but the recipient may accept
  expectCode(() => coordinator.accept('handoff-1', { acceptedBy: 'assistant-butler' }), 'NOT_THE_RECIPIENT');
  // A recipient without the required capability is refused rather than silently downgraded. The
  // authority is recomputed at proposal time so the shortfall is visible, but the refusal happens at
  // acceptance: it is the recipient's own capability that cannot be exceeded, and the recipient is the
  // one who answers.
  const shortfall = coordinatorOn();
  const shortProposal = shortfall.coordinator.propose(createHandoffPackage({ handoff_id: 'h-short', required_capabilities: ['SHELL'] }));
  assert.equal(shortProposal.proposed, true);
  assert.equal(shortProposal.handoff.authority.can_take_over, false);
  assert.deepEqual([...shortProposal.handoff.authority.missing_capabilities], ['SHELL']);
  assert.equal(shortfall.store.getTask('task-1').owner_ref, 'assistant-butler');
  expectCode(() => shortfall.coordinator.accept('h-short', { acceptedBy: 'assistant-companion' }), 'SCOPE_WIDENING_FORBIDDEN');
  assert.equal(shortfall.store.getTask('task-1').owner_ref, 'assistant-butler', 'a refused takeover leaves the owner unchanged');
  const accepted = coordinator.accept('handoff-1', { acceptedBy: 'assistant-companion' });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.owner_ref, 'assistant-companion');
  assert.equal(accepted.previous_owner_ref, 'assistant-butler');
  assert.equal(accepted.checkpoint_ref, 'checkpoint-9');
  assert.deepEqual([...accepted.transferred_grants], []);
  const task = store.getTask('task-1');
  assert.equal(task.owner_ref, 'assistant-companion');
  assert.equal(task.checkpoint_ref, 'checkpoint-9');
  // the executor was not restarted: the handoff named the same executor
  assert.equal(accepted.executor_moved, false);
  assert.equal(task.executor_ref, 'device-desktop');
  assert.deepEqual(store.__writes.map(entry => entry.op), ['setOwner', 'recordCheckpoint']);
  assert.equal(ASSISTANT_HANDOFF_CONTRACT.recipient_acceptance_required, true);
  assert.equal(ASSISTANT_HANDOFF_CONTRACT.handoff_restarts_executor, false);
});

test('an explicit executor move is carried by the handoff and recorded separately', () => {
  const { store, coordinator } = coordinatorOn();
  coordinator.propose(createHandoffPackage({ executor_ref: 'device-laptop' }));
  const accepted = coordinator.accept('handoff-1', { acceptedBy: 'assistant-companion' });
  assert.equal(accepted.executor_moved, true);
  assert.equal(store.getTask('task-1').executor_ref, 'device-laptop');
  assert.deepEqual(store.__writes.map(entry => entry.op), ['setOwner', 'recordCheckpoint', 'setExecutor']);
});

/* -------------------------------------------------- 4. refusal and expiry */

test('a rejected or expired handoff leaves the authoritative owner unchanged', () => {
  const { store, coordinator } = coordinatorOn();
  coordinator.propose(createHandoffPackage());
  const rejected = coordinator.reject('handoff-1', { reason: 'the companion is busy' });
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.ownership_changed, false);
  assert.equal(rejected.owner_ref, 'assistant-butler');
  assert.equal(store.getTask('task-1').owner_ref, 'assistant-butler');
  assert.equal(store.__writes.length, 0);
  // an expired handoff is the same
  const second = coordinatorOn();
  second.coordinator.propose(createHandoffPackage({ handoff_id: 'handoff-2' }));
  const expired = second.coordinator.expire('handoff-2');
  assert.equal(expired.expired, true);
  assert.equal(expired.ownership_changed, false);
  assert.equal(second.store.getTask('task-1').owner_ref, 'assistant-butler');
  // accepting an answered handoff is a no-op, not a second transfer
  assert.deepEqual(coordinator.accept('handoff-1', { acceptedBy: 'assistant-companion' }), { accepted: false, state: 'REJECTED', reason: 'REJECTED' });
  assert.equal(coordinator.listOpen().length, 0);
  assert.equal(ASSISTANT_HANDOFF_CONTRACT.rejected_handoff_changes_ownership, false);
  assert.deepEqual([...HANDOFF_STATES], ['PROPOSED', 'ACCEPTED', 'REJECTED', 'EXPIRED']);
});

test('a consultation transfers nothing even when accepted', () => {
  const { store, coordinator } = coordinatorOn();
  coordinator.propose(createHandoffPackage({ kind: 'CONSULTATION' }));
  const accepted = coordinator.accept('handoff-1', { acceptedBy: 'assistant-companion' });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.ownership_changed, false);
  assert.equal(accepted.reason, 'CONSULTATION_TRANSFERS_NOTHING');
  assert.equal(store.getTask('task-1').owner_ref, 'assistant-butler');
  assert.equal(store.__writes.length, 0);
  assert.deepEqual([...HANDOFF_KINDS], ['RESPONSIBILITY_TRANSFER', 'CONSULTATION']);
  assert.equal(ASSISTANT_HANDOFF_CONTRACT.checkpoint_required_for_transfer, true);
});

/* -------------------------------------------------- 5. strictness and idempotency */

test('the handoff package is strict, idempotent and refuses terminal or foreign tasks', () => {
  const base = createHandoffPackage();
  assert.equal(validateHandoff({ ...base, kind: 'TAKEOVER' }).ok, false);
  assert.equal(validateHandoff({ ...base, contract_version: 2 }).ok, false);
  assert.equal(validateHandoff({ ...base, to: { ...base.to, assistant_ref: base.from.assistant_ref } }).ok, false);
  assert.equal(validateHandoff({ ...base, created_at: 'yesterday' }).ok, false);
  assert.equal(validateHandoff({ ...base, evidence_refs: 'not-an-array' }).ok, false);
  assert.equal(validateHandoff({ ...base, extra: 1 }).ok, false);

  const { coordinator } = coordinatorOn();
  coordinator.propose(base);
  const duplicate = coordinator.propose(base);
  assert.equal(duplicate.proposed, false);
  assert.equal(duplicate.reason, 'DUPLICATE_HANDOFF');
  expectCode(() => coordinator.get('handoff-missing'), 'UNKNOWN_HANDOFF');
  expectCode(() => coordinator.reject('handoff-missing'), 'UNKNOWN_HANDOFF');

  // a task that does not exist, is terminal, or is owned by someone else cannot be handed off
  expectCode(() => coordinator.propose(createHandoffPackage({ handoff_id: 'h-missing', task_ref: 'task-missing' })), 'UNKNOWN_TASK');
  const terminal = coordinatorOn([{ task_ref: 'task-1', state: 'SUCCEEDED', owner_ref: 'assistant-butler', executor_ref: 'device-desktop' }]);
  expectCode(() => terminal.coordinator.propose(createHandoffPackage({ handoff_id: 'h-done' })), 'TASK_TERMINAL');
  const foreign = coordinatorOn([{ task_ref: 'task-1', state: 'RUNNING', owner_ref: 'assistant-secretary', executor_ref: 'device-desktop' }]);
  expectCode(() => foreign.coordinator.propose(createHandoffPackage({ handoff_id: 'h-foreign' })), 'INVALID_HANDOFF');
  // a responsibility transfer must carry a checkpoint
  expectCode(() => coordinatorOn().coordinator.propose(createHandoffPackage({ handoff_id: 'h-nocp', checkpoint_ref: null })), 'CHECKPOINT_REQUIRED');
  // the coordinator never writes task truth itself
  assert.equal(TASK_STORE_PORT.handoff_writes_task_truth_directly, false);
  expectCode(() => createHandoffCoordinator({ taskStore: {} }), 'INVALID_HANDOFF');
  assert.equal(new Set(HANDOFF_CODES).size, HANDOFF_CODES.length);
  assert.equal(new HandoffError('X', 'y').status, 409);
  assert.equal(ASSISTANT_HANDOFF_CONTRACT.multiple_online_assistants, true);
});

/* --------------------------------- 8. regressions (Correction, host Alien) */

// Every refusal is paired with the legitimate neighbour that must still pass, so no guard can be
// satisfied by refusing everything.

test('unknown fields are refused even when named after Object.prototype members', () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const handoff = Object.defineProperty({ ...createHandoffPackage() }, name, { value: 'SMUGGLED', enumerable: true, configurable: true, writable: true });
    const verdict = validateHandoff(handoff);
    assert.equal(verdict.ok, false, `handoff.${name} must not be part of the canonical contract`);
    assert.equal(verdict.errors.some(error => error.startsWith(`handoff.${name}`)), true);
  }
  const nested = Object.defineProperty({ ...createHandoffPackage() }, 'from', { value: { assistant_ref: 'assistant-butler', device_ref: 'device-phone' }, enumerable: true, configurable: true, writable: true });
  nested.from.constructor = 'x';
  assert.equal(validateHandoff(nested).ok, false);
  // neighbours: an ordinary unknown field is still refused, and a clean package is still admitted
  assert.equal(validateHandoff({ ...createHandoffPackage(), transport: 'RF' }).ok, false);
  assert.equal(validateHandoff(createHandoffPackage()).ok, true);
  assert.equal({}.SMUGGLED, undefined, 'no prototype pollution');
});

test('a non-enumerable own authority field cannot evade the authority scan', () => {
  assert.deepEqual([...findAuthorityFields(createHandoffPackage())], []);
  for (const field of AUTHORITY_FIELDS) {
    assert.equal(validateHandoff({ ...createHandoffPackage(), [field]: 'x' }).ok, false, `enumerable ${field} must be refused`);
    const sneaky = Object.defineProperty({ ...createHandoffPackage() }, field, { value: 'RAW', enumerable: false, configurable: true, writable: true });
    assert.equal(validateHandoff(sneaky).ok, false, `non-enumerable ${field} must be refused too`);
    expectCode(() => assertHandoff(sneaky), 'HANDOFF_TRANSFERS_NO_AUTHORITY');
  }
  // neighbour: the scan still reports nested authority fields, and a clean package is accepted
  const nested = { ...createHandoffPackage(), evidence_refs: ['e1'] };
  nested.from = { assistant_ref: 'assistant-butler', device_ref: 'device-phone', lease: 'L' };
  assert.deepEqual([...findAuthorityFields(nested)], ['handoff.from.lease']);
  assert.equal(assertHandoff(createHandoffPackage()).contract_version, 1);
});

test('a stale concurrent handoff cannot take ownership from a new owner', () => {
  // both recipients must be capable, so the refusal below is about staleness and nothing else
  const bothCapable = { grantsByAssistant: { 'assistant-butler': ['FILESYSTEM'], 'assistant-companion': ['FILESYSTEM'], 'assistant-secretary': ['FILESYSTEM'] } };
  const store = createTaskStoreDouble({ tasks: tasks() });
  const coordinator = createHandoffCoordinator({ taskStore: store, policy: bothCapable, clock: () => TS });
  coordinator.propose(createHandoffPackage({ handoff_id: 'h1', to: { assistant_ref: 'assistant-companion', device_ref: 'device-tablet' } }));
  coordinator.propose(createHandoffPackage({ handoff_id: 'h2', to: { assistant_ref: 'assistant-secretary', device_ref: 'device-tablet' } }));
  const first = coordinator.accept('h1', { acceptedBy: 'assistant-companion' });
  assert.equal(first.owner_ref, 'assistant-companion');
  assert.equal(first.previous_owner_ref, 'assistant-butler');
  assert.equal(store.getTask('task-1').owner_ref, 'assistant-companion');
  // the second proposal was made by an assistant that no longer owns the task
  const error = expectCode(() => coordinator.accept('h2', { acceptedBy: 'assistant-secretary' }), 'INVALID_HANDOFF');
  assert.equal(error.message.includes('stale'), true);
  assert.equal(store.getTask('task-1').owner_ref, 'assistant-companion', 'the new owner is unchanged');
  // neighbours: exactly one owner, the stale handoff is still open for an explicit reject, and a
  // legitimate transfer from the *current* owner still works
  assert.deepEqual(coordinator.listOpen().map(entry => entry.handoff_id), ['h2']);
  assert.equal(coordinator.reject('h2', { reason: 'superseded' }).ownership_changed, false);
  coordinator.propose(createHandoffPackage({ handoff_id: 'h3', from: { assistant_ref: 'assistant-companion', device_ref: 'device-tablet' }, to: { assistant_ref: 'assistant-secretary', device_ref: 'device-tablet' } }));
  const second = coordinator.accept('h3', { acceptedBy: 'assistant-secretary' });
  assert.equal(second.previous_owner_ref, 'assistant-companion');
  assert.equal(store.getTask('task-1').owner_ref, 'assistant-secretary');
});

test('recipient authority is recomputed at takeover, not reused from proposal time', () => {
  const mutablePolicy = { grantsByAssistant: { 'assistant-companion': ['FILESYSTEM'] } };
  const store = createTaskStoreDouble({ tasks: tasks() });
  const coordinator = createHandoffCoordinator({ taskStore: store, policy: mutablePolicy, clock: () => TS });
  coordinator.propose(createHandoffPackage({ handoff_id: 'h-revoked' }));
  // the capability is revoked while the handoff is open
  mutablePolicy.grantsByAssistant['assistant-companion'] = [];
  expectCode(() => coordinator.accept('h-revoked', { acceptedBy: 'assistant-companion' }), 'SCOPE_WIDENING_FORBIDDEN');
  assert.equal(store.getTask('task-1').owner_ref, 'assistant-butler', 'a refused takeover leaves the owner unchanged');
  // neighbours: re-granting lets the same open handoff proceed, and it reports the recomputed authority
  mutablePolicy.grantsByAssistant['assistant-companion'] = ['FILESYSTEM'];
  const accepted = coordinator.accept('h-revoked', { acceptedBy: 'assistant-companion' });
  assert.equal(accepted.accepted, true);
  assert.deepEqual([...accepted.authority.granted_capabilities], ['FILESYSTEM']);
  assert.deepEqual([...accepted.transferred_grants], []);
});

test('a policy lookup is own-key only, never through the prototype chain', () => {
  for (const ref of ['toString', 'valueOf', 'constructor', '__proto__', 'hasOwnProperty']) {
    const verdict = recomputeRecipientAuthority({ policy: { grantsByAssistant: {} }, recipientRef: ref, requiredCapabilities: [] });
    assert.deepEqual([...verdict.effective_grants], [], `${ref} must not inherit a grant`);
    assert.equal(verdict.can_take_over, true);
    assert.equal(verdict.recomputed, true);
  }
  // a non-array grant table entry is a typed refusal, not an untyped TypeError
  expectCode(() => recomputeRecipientAuthority({ policy: { grantsByAssistant: { 'assistant-x': 'FILESYSTEM' } }, recipientRef: 'assistant-x' }), 'INVALID_HANDOFF');
  // neighbours: a real grant still works and a missing recipient still gets nothing
  assert.deepEqual([...recomputeRecipientAuthority({ policy, recipientRef: 'assistant-companion', requiredCapabilities: ['FILESYSTEM'] }).granted_capabilities], ['FILESYSTEM']);
  assert.equal(recomputeRecipientAuthority({ policy, recipientRef: 'assistant-stranger', requiredCapabilities: ['FILESYSTEM'] }).can_take_over, false);
});

test('a re-proposal under a live id is only a duplicate when it says the same thing', () => {
  const { coordinator } = coordinatorOn();
  const base = createHandoffPackage({ handoff_id: 'h-dup' });
  assert.equal(coordinator.propose(base).proposed, true);
  const same = coordinator.propose(createHandoffPackage({ handoff_id: 'h-dup' }));
  assert.equal(same.proposed, false);
  assert.equal(same.reason, 'DUPLICATE_HANDOFF');
  const error = expectCode(() => coordinator.propose(createHandoffPackage({ handoff_id: 'h-dup', to: { assistant_ref: 'assistant-secretary', device_ref: 'device-tablet' }, reason: 'a completely different handoff' })), 'INVALID_HANDOFF');
  assert.equal(error.message.includes('different content'), true);
  assert.equal(coordinator.get('h-dup').handoff.to.assistant_ref, 'assistant-companion', 'the original proposal is untouched');
});

test('transition timestamps must be real instants at or after the proposal', () => {
  const { coordinator } = coordinatorOn();
  coordinator.propose(createHandoffPackage({ handoff_id: 'h-time', created_at: TS }));
  expectCode(() => coordinator.accept('h-time', { acceptedBy: 'assistant-companion', at: 'nonsense' }), 'INVALID_HANDOFF');
  expectCode(() => coordinator.accept('h-time', { acceptedBy: 'assistant-companion', at: '1999-01-01T00:00:00.000Z' }), 'INVALID_HANDOFF');
  // neighbours: a real instant works, no clock is still allowed, and the record keeps what was given
  const accepted = coordinator.accept('h-time', { acceptedBy: 'assistant-companion', at: '2026-09-30T12:05:00.000Z' });
  assert.equal(accepted.accepted, true);
  assert.equal(coordinator.get('h-time').accepted_at, '2026-09-30T12:05:00.000Z');
  const other = coordinatorOn();
  other.coordinator.propose(createHandoffPackage({ handoff_id: 'h-notime' }));
  assert.equal(other.coordinator.accept('h-notime', { acceptedBy: 'assistant-companion' }).accepted, true);
});

test('a cyclic or over-deep handoff is refused, never a stack overflow', () => {
  const loop = [];
  loop.push(loop);
  assert.equal(validateHandoff({ ...createHandoffPackage(), evidence_refs: loop }).ok, false);
  const selfRef = { assistant_ref: 'assistant-x', device_ref: 'device-y' };
  selfRef.self = selfRef;
  assert.equal(validateHandoff({ ...createHandoffPackage(), to: selfRef }).ok, false);
  let deep = 'leaf';
  for (let index = 0; index < 200; index += 1) deep = { next: deep };
  assert.equal(validateHandoff({ ...createHandoffPackage(), evidence_refs: [deep] }).ok, false);
  assert.equal(handoffDepthExceeded(deep), true);
  // neighbours: a shallow sign-off is still valid, and no authority field is reported for a clean one
  assert.equal(handoffDepthExceeded(createHandoffPackage()), false);
  assert.equal(validateHandoff(createHandoffPackage()).ok, true);
  assert.deepEqual([...findAuthorityFields(createHandoffPackage())], []);
});

test('a calendar-impossible instant is refused, not merely shape-checked', () => {
  assert.equal(isIsoInstant('2026-13-45T99:99:99Z'), false);
  assert.equal(isIsoInstant('2026-02-30T00:00:00.000Z'), false);
  assert.equal(validateHandoff({ ...createHandoffPackage(), created_at: '2026-13-45T99:99:99Z' }).ok, false);
  // neighbours: both accepted spellings of a real instant still pass
  assert.equal(isIsoInstant('2026-09-30T12:00:00Z'), true);
  assert.equal(isIsoInstant('2026-09-30T12:00:00.000Z'), true);
  assert.equal(validateHandoff({ ...createHandoffPackage(), created_at: '2026-09-30T12:00:00Z' }).ok, true);
  assert.equal(isIsoInstant('nonsense'), false);
});

test('the switch report does not invent the outgoing assistant\'s presence', () => {
  const base = { deviceRef: 'device-phone', assistants: ['assistant-butler', 'assistant-companion'], from: 'assistant-butler', to: 'assistant-companion' };
  const unknown = switchForegroundAssistant(base);
  assert.equal(unknown.outgoing_assistant_still_online, null, 'presence was never supplied, so it is unknown');
  assert.equal(unknown.outgoing_online_verified, false);
  assert.equal(unknown.switched, true);
  assert.equal(unknown.tasks_touched, 0);
  assert.equal(unknown.task_ownership_changed, false);
  // neighbours: with evidence the flag is reported honestly, including the offline case
  const online = switchForegroundAssistant({ ...base, onlineAssistants: ['assistant-butler', 'assistant-companion'] });
  assert.equal(online.outgoing_assistant_still_online, true);
  assert.equal(online.outgoing_online_verified, true);
  const offline = switchForegroundAssistant({ ...base, onlineAssistants: ['assistant-companion'] });
  assert.equal(offline.outgoing_assistant_still_online, false);
});

test('a refusal that cannot be explained is not half-applied', () => {
  const { store, coordinator } = coordinatorOn();
  coordinator.propose(createHandoffPackage({ handoff_id: 'h-gone' }));
  store.__table.delete('task-1');
  // the old code stamped the refusal and then read the task inside the return expression
  expectCode(() => coordinator.reject('h-gone', { at: TS }), 'UNKNOWN_TASK');
  assert.equal(coordinator.get('h-gone').state, 'PROPOSED', 'the refusal must not have been applied');
  assert.equal(coordinator.get('h-gone').rejected_at, undefined);
  expectCode(() => coordinator.expire('h-gone', { at: TS }), 'UNKNOWN_TASK');
  assert.equal(coordinator.get('h-gone').state, 'PROPOSED');
  assert.equal(coordinator.get('h-gone').expired_at, undefined);
  // neighbours: with the task present the refusal is applied and reports the untouched owner
  const live = coordinatorOn();
  live.coordinator.propose(createHandoffPackage({ handoff_id: 'h-live' }));
  const rejected = live.coordinator.reject('h-live', { at: TS });
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.owner_ref, 'assistant-butler');
  assert.equal(rejected.ownership_changed, false);
  assert.equal(live.coordinator.get('h-live').rejected_at, TS);
});

test('a transfer must declare the capabilities the recipient is judged against', () => {
  const { store, coordinator } = coordinatorOn();
  // declaring nothing made the re-evaluation vacuous, so a capability-less recipient could take over
  expectCode(() => coordinator.propose(createHandoffPackage({ handoff_id: 'h-nocap', required_capabilities: [] })), 'INVALID_HANDOFF');
  assert.equal(store.__writes.length, 0);
  // neighbours: a declared requirement still gates, a capable recipient still proceeds, and a
  // consultation may require nothing because it transfers nothing
  assert.equal(coordinator.propose(createHandoffPackage({ handoff_id: 'h-cap' })).proposed, true);
  assert.equal(coordinator.accept('h-cap', { acceptedBy: 'assistant-companion' }).accepted, true);
  assert.equal(store.getTask('task-1').owner_ref, 'assistant-companion');
  const consult = coordinatorOn();
  assert.equal(consult.coordinator.propose(createHandoffPackage({ handoff_id: 'h-c', kind: 'CONSULTATION', required_capabilities: [] })).proposed, true);
});

test('the task store double does not leak or alias canonical state', () => {
  const nested = [{ ...tasks()[0], checkpoint: { label: 'original' } }];
  const store = createTaskStoreDouble({ tasks: nested });
  const view = store.getTask('task-1');
  view.checkpoint.label = 'MUTATED';
  view.owner_ref = 'assistant-attacker';
  assert.equal(store.getTask('task-1').checkpoint.label, 'original', 'a returned view must not be canonical state');
  assert.equal(store.getTask('task-1').owner_ref, 'assistant-butler');
  nested[0].checkpoint.label = 'MUTATED-AT-SOURCE';
  assert.equal(store.getTask('task-1').checkpoint.label, 'original', 'the store must not alias the caller input');
  assert.equal(store.__writes.length, 0);
  // neighbours: a real write is recorded, visible and immutable
  const written = store.setOwner('task-1', 'assistant-companion');
  assert.equal(written.owner_ref, 'assistant-companion');
  assert.equal(store.getTask('task-1').owner_ref, 'assistant-companion');
  assert.deepEqual(store.__writes.map(entry => entry.op), ['setOwner']);
  assert.equal(Object.isFrozen(store.__writes[0]), true);
});

test('a versioned task refuses a handoff built against another version', () => {
  const versioned = () => [{ ...tasks()[0], task_version: 4 }];
  const store = createTaskStoreDouble({ tasks: versioned() });
  const coordinator = createHandoffCoordinator({ taskStore: store, policy, clock: () => TS });
  expectCode(() => coordinator.propose(createHandoffPackage({ handoff_id: 'h-v9', task_version: 9 })), 'INVALID_HANDOFF');
  assert.equal(coordinator.propose(createHandoffPackage({ handoff_id: 'h-v4' })).proposed, true);
  // the version is re-checked at takeover too
  const moved = createTaskStoreDouble({ tasks: versioned() });
  const c2 = createHandoffCoordinator({ taskStore: moved, policy, clock: () => TS });
  c2.propose(createHandoffPackage({ handoff_id: 'h-moved' }));
  moved.__table.get('task-1').task_version = 5;
  expectCode(() => c2.accept('h-moved', { acceptedBy: 'assistant-companion' }), 'INVALID_HANDOFF');
  assert.equal(moved.getTask('task-1').owner_ref, 'assistant-butler');
  // neighbours: a store that exposes no version still works, and a matching version still transfers
  const plain = coordinatorOn();
  assert.equal(plain.coordinator.propose(createHandoffPackage({ handoff_id: 'h-plain' })).proposed, true);
  const matched = createTaskStoreDouble({ tasks: versioned() });
  const c3 = createHandoffCoordinator({ taskStore: matched, policy, clock: () => TS });
  c3.propose(createHandoffPackage({ handoff_id: 'h-ok' }));
  assert.equal(c3.accept('h-ok', { acceptedBy: 'assistant-companion' }).accepted, true);
  assert.equal(matched.getTask('task-1').owner_ref, 'assistant-companion');
  assert.equal(TASK_STORE_PORT.version_revalidation_required, true);
});

