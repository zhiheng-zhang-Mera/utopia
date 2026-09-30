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
 createTaskStoreDouble, findAuthorityFields, recomputeRecipientAuthority, switchForegroundAssistant,
 validateHandoff
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
