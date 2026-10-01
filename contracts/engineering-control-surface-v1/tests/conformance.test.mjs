// Conformance tests for EM-013 — Shared Task Core + Utopia engineering control surface.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTENTION_STATES, ControlSurfaceError, ELIGIBILITY, JOB_STATES, PROVENANCE_FIELDS, SURFACE_VIEWS,
  TERMINAL_JOB_STATES, createEngineeringControlSurface, findSecretFields,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const OWNER = 'assistant:butler-a';
const CONNECTOR = 'connector:deepseek-harness';
const LAPTOP = 'device:laptop';
const DESKTOP = 'device:desktop';

function surfaceAt(policy = {}) {
  const state = { ms: 0 };
  const clock = () => new Date(Date.parse(T0) + state.ms).toISOString();
  clock.advance = ms => { state.ms += ms; return clock(); };
  return { surface: createEngineeringControlSurface({ clock, policy }), clock };
}

const submit = (surface, overrides = {}) => surface.submit({
  job_ref: 'job:1',
  canonical_task_ref: 'task:canonical-1',
  canonical_action_ref: 'action:1',
  logical_owner_ref: OWNER,
  executor_connector_ref: CONNECTOR,
  executor_device_ref: DESKTOP,
  interaction_device_ref: LAPTOP,
  ...overrides,
});

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof ControlSurfaceError, `expected a ControlSurfaceError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

test('one canonical job is observed by Web and Android without duplicate execution', () => {
  const { surface } = surfaceAt();
  assert.deepEqual([...SURFACE_VIEWS], ['SUBMIT', 'STATUS', 'PROGRESS', 'STAGE', 'ATTENTION', 'CONTROL', 'RESULT', 'ARTIFACT']);

  const submitted = submit(surface);
  assert.equal(submitted.canonical_task_ref, 'task:canonical-1');
  assert.equal(submitted.task_truth_source, 'SHARED_TASK_CORE');
  assert.equal(submitted.manager_creates_canonical_truth, false, 'the manager obtains responsibility, it does not invent truth');
  assert.equal(submitted.execution_responsibility, 'OBTAINED_FROM_SHARED_TASK_CORE');
  assert.equal(submitted.state, 'SUBMITTED');

  // Two surfaces (Web and Android) read the same canonical job.
  const web = surface.status({ job_ref: 'job:1' });
  const android = surface.status({ job_ref: 'job:1' });
  assert.equal(web.job_ref, android.job_ref);
  assert.equal(web.canonical_task_ref, android.canonical_task_ref);
  assert.equal(web.same_job_for_every_surface, true);
  assert.equal(web.duplicate_execution, false);
  assert.equal(web.per_device_job_copy, false);
  assert.equal(surface.jobs().length, 1, 'one job, not one per device');
  assert.equal(surface.surfaceContract().one_canonical_job_per_web_and_android, true);

  // A job without a canonical task is refused outright.
  const noTask = failure(() => submit(surface, { job_ref: 'job:2', canonical_task_ref: null }));
  assert.equal(noTask.code, 'CANONICAL_TASK_REQUIRED');
  assert.equal(noTask.manager_creates_canonical_truth, false);
  assert.equal(failure(() => submit(surface, { job_ref: 'job:1' })).code, 'DUPLICATE_JOB');
  assert.equal(failure(() => submit(surface, { job_ref: 'job:3', logical_owner_ref: null })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => submit(surface, { job_ref: 'job:4', eligibility: 'MAYBE' })).code, 'INVALID_REQUEST');
  assert.equal(surface.job('job:nope'), null, 'an unknown job is a typed absence');
});

test('the interaction device may differ from the execution device', () => {
  const { surface } = surfaceAt();
  const job = submit(surface);
  assert.equal(job.interaction_device_ref, LAPTOP);
  assert.equal(job.executor_device_ref, DESKTOP);
  assert.equal(job.interaction_device_is_execution_device, false);
  assert.equal(job.owner_and_executor_separated, true, 'logical owner and executor are separate fields');
  assert.equal(job.logical_owner_ref, OWNER);
  assert.equal(job.executor_connector_ref, CONNECTOR);

  const contract = surface.surfaceContract();
  assert.equal(contract.foreground_may_differ_from_execution, true);
  assert.equal(contract.control_stays_on_interaction_surface, true);
  assert.equal(contract.user_navigated_to_execution_host, false);
  assert.equal(PROVENANCE_FIELDS.includes('executor_connector_ref'), false);

  // Control works from the interaction surface and never sends the user to the host.
  const controlled = surface.control({ job_ref: 'job:1', operation: 'PAUSE', by_device_ref: LAPTOP });
  assert.equal(controlled.applied, true);
  assert.equal(controlled.interaction_device_ref, LAPTOP);
  assert.equal(controlled.execution_device_ref, DESKTOP);
  assert.equal(controlled.user_navigated_to_execution_host, false);
  assert.equal(controlled.control_on_shared_surface, true);
  assert.equal(surface.status({ job_ref: 'job:1' }).state, 'WAITING_CONFIRMATION');
  assert.equal(surface.control({ job_ref: 'job:1', operation: 'RESUME' }).state, 'RUNNING');
  assert.equal(failure(() => surface.control({ job_ref: 'job:1', operation: 'EXPLODE' })).code, 'INVALID_REQUEST');
});

test('remote fallback requires explicit approval and local allowed work stays local', () => {
  const { surface } = surfaceAt();
  submit(surface);
  assert.deepEqual([...ELIGIBILITY], ['LOCAL_ALLOWED', 'LOCAL_THROTTLED', 'LOCAL_BLOCKED', 'REMOTE_REQUIRED']);

  // A job that may run locally must not be moved to a faster machine.
  const refused = failure(() => surface.proposeRemoteFallback({ job_ref: 'job:1', remote_device_ref: 'device:fast-server' }));
  assert.equal(refused.code, 'LOCAL_WORK_MUST_STAY_LOCAL');
  assert.equal(refused.auto_selected_faster_machine, false);

  // A throttled job may be proposed, and the proposal is never applied automatically.
  submit(surface, { job_ref: 'job:2', eligibility: 'LOCAL_THROTTLED' });
  const proposal = surface.proposeRemoteFallback({ job_ref: 'job:2', remote_device_ref: 'device:fast-server', reason: 'LOCAL_THROTTLED' });
  assert.equal(proposal.requires_explicit_approval, true);
  assert.equal(proposal.approved, false, 'a proposal is not an approval');
  assert.equal(proposal.auto_selected, false);
  assert.equal(proposal.local_first_respected, true);
  assert.equal(proposal.user_navigated_to_execution_host, false);
  assert.equal(surface.job('job:2').executor_device_ref, DESKTOP, 'the executor is unchanged until approval');

  // Declining keeps the work local.
  const declined = surface.approveRemoteFallback({ job_ref: 'job:2', proposal_ref: proposal.proposal_ref, approved: false });
  assert.equal(declined.applied, false);
  assert.equal(declined.work_stays_local, true);
  assert.equal(surface.job('job:2').executor_device_ref, DESKTOP);

  // Approving moves the executor, and the interaction device still does not change.
  const approved = surface.approveRemoteFallback({ job_ref: 'job:2', proposal_ref: proposal.proposal_ref, approved: true });
  assert.equal(approved.applied, true);
  assert.equal(approved.executor_device_ref, 'device:fast-server');
  assert.equal(approved.interaction_device_ref, LAPTOP);
  assert.equal(approved.interaction_device_is_execution_device, false);
  assert.equal(approved.user_navigated_to_execution_host, false);
  assert.equal(surface.status({ job_ref: 'job:2' }).executor_device_ref, 'device:fast-server');
  assert.equal(failure(() => surface.approveRemoteFallback({ job_ref: 'job:2', proposal_ref: 'proposal:nope' })).code, 'INVALID_REQUEST');
});

test('attention comes from shared state and one acknowledgement reconciles every projection', () => {
  const { surface } = surfaceAt();
  submit(surface);
  assert.deepEqual([...ATTENTION_STATES], ['PENDING', 'ACKNOWLEDGED', 'EXPIRED', 'WITHDRAWN']);

  // A second Engineering-global attention store is refused.
  const secondStore = failure(() => surface.registerAttentionStore({ store_ref: 'engineering-attention-db' }));
  assert.equal(secondStore.code, 'SECOND_ATTENTION_STORE_REFUSED');
  assert.equal(secondStore.created, false);

  const projected = surface.projectAttention({ job_ref: 'job:1', attention_ref: 'attention:1', question: 'Which branch should I use?' });
  assert.equal(projected.state, 'PENDING');
  assert.equal(projected.source, 'SHARED_CORE_ATTENTION');
  assert.equal(projected.projection_of_shared_state, true);
  assert.equal(projected.engineering_global_store, false);
  assert.equal(projected.delivered_to_interaction_device, LAPTOP);
  assert.equal(surface.status({ job_ref: 'job:1' }).state, 'WAITING_CONFIRMATION');
  assert.equal(surface.status({ job_ref: 'job:1' }).attention_refs.includes('attention:1'), true);
  assert.equal(surface.attentionFor({ job_ref: 'job:1' }).pending_count, 1);
  assert.equal(failure(() => surface.projectAttention({ job_ref: 'job:1', attention_ref: 'a', question: 'q', source: 'ENGINEERING_LOCAL' })).code, 'SECOND_ATTENTION_STORE_REFUSED');

  // The first acknowledgement reconciles all device projections; a repeat is a duplicate, not a second act.
  const acknowledged = surface.acknowledgeAttention({ attention_ref: 'attention:1', device_ref: LAPTOP });
  assert.equal(acknowledged.state, 'ACKNOWLEDGED');
  assert.equal(acknowledged.reconciles_all_projections, true);
  assert.equal(acknowledged.other_devices_reconciled, true);
  assert.equal(acknowledged.second_acknowledgement_needed, false);
  const duplicate = surface.acknowledgeAttention({ attention_ref: 'attention:1', device_ref: DESKTOP });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.reconciles_all_projections, true);
  assert.equal(surface.attentionFor({ job_ref: 'job:1' }).pending_count, 0);
  assert.equal(surface.attentionEntries()[0].state, 'ACKNOWLEDGED');
  assert.equal(failure(() => surface.acknowledgeAttention({ attention_ref: 'attention:nope', device_ref: LAPTOP })).code, 'UNKNOWN_ATTENTION');
  assert.equal(failure(() => surface.projectAttention({ job_ref: 'job:nope', attention_ref: 'a', question: 'q' })).code, 'UNKNOWN_JOB');
});

test('user-visible success comes only from a terminal accepted result', () => {
  const { surface } = surfaceAt();
  submit(surface);
  assert.deepEqual([...JOB_STATES], ['SUBMITTED', 'QUEUED', 'RUNNING', 'WAITING_CONFIRMATION', 'SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED', 'UNKNOWN']);
  assert.deepEqual([...TERMINAL_JOB_STATES], ['SUCCEEDED', 'FAILED', 'REFUSED', 'CANCELLED']);

  // Progress is not success.
  const progress = surface.progress({ job_ref: 'job:1', kind: 'PROGRESS', stage: 'BUILDING', detail_ref: 'detail:1' });
  assert.equal(progress.progress_is_not_success, true);
  assert.equal(progress.terminal, false);
  assert.equal(surface.status({ job_ref: 'job:1' }).result, null, 'no result yet');
  assert.equal(surface.surfaceContract().progress_is_not_success, true);

  // A non-terminal state cannot be applied as a result.
  const premature = failure(() => surface.applyResult({ job_ref: 'job:1', state: 'RUNNING' }));
  assert.equal(premature.code, 'NOT_TERMINAL_ACCEPTED');
  assert.equal(premature.dispatch_is_not_success, true);
  assert.equal(surface.status({ job_ref: 'job:1' }).result, null);

  // A success needs an accepted result reference.
  assert.equal(failure(() => surface.applyResult({ job_ref: 'job:1', state: 'SUCCEEDED' })).code, 'NOT_TERMINAL_ACCEPTED');

  const result = surface.applyResult({ job_ref: 'job:1', state: 'SUCCEEDED', result_ref: 'result:accepted', artifacts: [{ artifact_ref: 'artifact:1', kind: 'DIFF' }] });
  assert.equal(result.user_visible_success, true);
  assert.equal(result.success_source, 'TERMINAL_ACCEPTED_ENGINEERING_RESULT');
  assert.equal(result.dispatch_is_not_success, true);
  assert.equal(result.terminal, true);
  assert.equal(result.result.accepted, true);
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.canonical_task_ref, 'task:canonical-1');

  // A terminal job refuses further progress.
  assert.equal(failure(() => surface.progress({ job_ref: 'job:1', kind: 'PROGRESS' })).code, 'FALSE_SUCCESS_REFUSED');
  const failed = submit(surface, { job_ref: 'job:9' });
  assert.equal(failed.state, 'SUBMITTED');
  const failureResult = surface.applyResult({ job_ref: 'job:9', state: 'FAILED' });
  assert.equal(failureResult.user_visible_success, false);
  assert.equal(failureResult.success_source, null, 'a failure is never labelled a success');
  assert.equal(failureResult.terminal, true);
});

test('advanced provenance exposes identifiers without leaking secrets, and the surface is strict', () => {
  const { surface } = surfaceAt();
  submit(surface);
  const provenance = surface.provenance({ job_ref: 'job:1', provenance: { connector_ref: CONNECTOR, backend_run_ref: 'backend:run:1', device_ref: DESKTOP, branch_ref: 'branch:x', commit_ref: 'commit:abc', test_ref: 'test:1', error_ref: null } });
  assert.equal(provenance.advanced_view, true);
  assert.equal(provenance.contains_secret_material, false);
  assert.equal(provenance.references_only, true);
  assert.equal(provenance.provenance.commit_ref, 'commit:abc');
  assert.deepEqual(findSecretFields(provenance.provenance), []);

  const secret = failure(() => surface.provenance({ job_ref: 'job:1', provenance: { connector_ref: CONNECTOR, access_token: 'sk-live-abcdefghijklmnop' } }));
  assert.equal(secret.code, 'SECRET_MATERIAL_REFUSED', 'a secret-shaped key is named as such, not merely rejected as unknown');
  assert.equal(secret.stored, false);
  const unknownField = failure(() => surface.provenance({ job_ref: 'job:1', provenance: { connector_ref: CONNECTOR, nickname: 'x' } }));
  assert.equal(unknownField.code, 'INVALID_REQUEST', 'a harmless unknown field is refused as non-canonical');
  assert.deepEqual(unknownField.allowed, [...PROVENANCE_FIELDS]);
  const secretField = failure(() => surface.provenance({ job_ref: 'job:1', provenance: { error_ref: 'x', credential_value: 'y' } }));
  assert.equal(secretField.code, 'SECRET_MATERIAL_REFUSED');
  assert.equal(secretField.stored, false);
  assert.deepEqual(findSecretFields({ a: { token: 'x' } }), ['record.a.token']);
  assert.deepEqual(findSecretFields({ connector_ref: 'connector:1' }), [], 'a reference is not a secret');
  assert.deepEqual(findSecretFields({ contains_secret_material: false }), [], 'a boolean assertion is not a secret');

  // Frozen projections and isolation between surfaces.
  const status = surface.status({ job_ref: 'job:1' });
  assert.throws(() => { status.state = 'SUCCEEDED'; }, TypeError, 'status projections are frozen');
  assert.throws(() => { surface.surfaceContract().dispatch_is_not_success = true; }, TypeError);
  assert.equal(failure(() => createEngineeringControlSurface({ clock: 'now' })).code, 'INVALID_CLOCK');
  const other = surfaceAt().surface;
  assert.equal(other.jobs().length, 0, 'surfaces share no state');
  assert.equal(surface.journal().some(entry => entry.event === 'JOB_SUBMITTED'), true);
  assert.equal(surface.surfaceContract().task_truth_source, 'SHARED_TASK_CORE');
  assert.equal(surface.surfaceContract().provenance_is_secret_free, true);
  assert.equal(surface.policy().policy_ref, 'policy:em-control-surface-default');
});
// EM-013-CORRECTION-REGRESSIONS - the corrected behaviours the Development head did not have.
import { isIsoInstant } from '../control-surface.mjs';

const cloneSubmit = (surface, overrides = {}) => submit(surface, overrides);

test('the surface policy cannot be used to switch the canonical binding or the attention source off', () => {
  assert.equal(failure(() => createEngineeringControlSurface({ policy: { require_canonical_task: false } })).code, 'CANONICAL_TASK_REQUIRED');
  assert.equal(failure(() => createEngineeringControlSurface({ policy: { unknown_key: 1 } })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => createEngineeringControlSurface({ policy: { local_first: 'yes' } })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => createEngineeringControlSurface({ policy: { attention_projection_sources: [] } })).code, 'SECOND_ATTENTION_STORE_REFUSED');
  assert.equal(failure(() => createEngineeringControlSurface({ policy: { attention_projection_sources: ['ENGINEERING_LOCAL'] } })).code, 'SECOND_ATTENTION_STORE_REFUSED');
  assert.equal(failure(() => createEngineeringControlSurface({ policy: 'default' })).code, 'INVALID_REQUEST');
  assert.equal(surfaceAt({ local_first: true }).surface.policy().policy_ref, 'policy:em-control-surface-default');
});

test('an impossible instant is refused everywhere it could become evidence', () => {
  assert.equal(isIsoInstant('2026-01-01T00:00:00.000Z'), true);
  assert.equal(isIsoInstant('2026-13-45T99:99:99Z'), false);
  assert.equal(isIsoInstant('2026-02-30T00:00:00Z'), false);
  const { surface } = surfaceAt();
  assert.equal(failure(() => cloneSubmit(surface, { at: '2026-02-30T00:00:00Z' })).code, 'INVALID_REQUEST');
  const badClock = createEngineeringControlSurface({ clock: () => '2026-13-45T99:99:99Z' });
  assert.equal(failure(() => submit(badClock)).code, 'INVALID_CLOCK');
  assert.equal(badClock.jobs().length, 0, 'a refused submit creates no job');
});

test('a hidden, symbol-keyed or header-shaped secret is still secret material', () => {
  const hidden = { connector_ref: CONNECTOR };
  Object.defineProperty(hidden, 'access_token', { value: 'sk-live-abcdef', enumerable: false });
  assert.deepEqual(findSecretFields(hidden), ['record.access_token']);
  const symbol = { connector_ref: CONNECTOR };
  symbol[Symbol('api_key')] = 'sk-live-abcdef';
  assert.deepEqual(findSecretFields(symbol), ['record.[api_key]']);
  assert.deepEqual(findSecretFields({ authorization: 'Bearer abc' }), ['record.authorization']);
  assert.deepEqual(findSecretFields({ cookie: 'session=1' }), ['record.cookie']);
  assert.deepEqual(findSecretFields({ 'x-api-key': 'k' }), ['record.x-api-key']);
  assert.deepEqual(findSecretFields({ connector_ref: 'connector:1' }), [], 'a reference is still not a secret');
  const cyclic = { connector_ref: CONNECTOR };
  cyclic.self = cyclic;
  assert.deepEqual(findSecretFields(cyclic), [], 'a cycle is walked once, not forever');
  const { surface } = surfaceAt();
  submit(surface);
  assert.equal(failure(() => surface.provenance({ job_ref: 'job:1', provenance: hidden })).code, 'SECRET_MATERIAL_REFUSED');
  assert.equal(failure(() => surface.provenance({ job_ref: 'job:1', provenance: symbol })).code, 'SECRET_MATERIAL_REFUSED');
  assert.equal(failure(() => surface.provenance({ job_ref: 'job:1', provenance: { connector_ref: CONNECTOR, cookie: 'session=1' } })).code, 'SECRET_MATERIAL_REFUSED');
  assert.equal(failure(() => surface.provenance({ job_ref: 'job:1', provenance: cyclic })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => surface.provenance({ job_ref: 'job:1', provenance: new Date() })).code, 'INVALID_REQUEST');
});

test('a cancelled job is finished even though it carries no result', () => {
  const { surface } = surfaceAt();
  submit(surface);
  assert.equal(surface.control({ job_ref: 'job:1', operation: 'CANCEL', by_device_ref: LAPTOP }).state, 'CANCELLED');
  assert.equal(surface.status({ job_ref: 'job:1' }).result, null);
  const refused = failure(() => surface.progress({ job_ref: 'job:1', kind: 'PROGRESS' }));
  assert.equal(refused.code, 'FALSE_SUCCESS_REFUSED');
  assert.equal(refused.progress_recorded, false);
});

test('control authority is bound to the job, not to whoever calls', () => {
  const { surface } = surfaceAt();
  submit(surface);
  const intruder = failure(() => surface.control({ job_ref: 'job:1', operation: 'CANCEL', by_device_ref: 'device:intruder' }));
  assert.equal(intruder.code, 'NOT_AUTHORIZED_TO_CONTROL');
  assert.equal(intruder.applied, false);
  assert.deepEqual([...intruder.authorized_devices], [LAPTOP]);
  assert.equal(surface.status({ job_ref: 'job:1' }).state, 'SUBMITTED', 'a refused control changes nothing');
  submit(surface, { job_ref: 'job:2', authorized_devices: ['device:tablet'] });
  assert.equal(surface.control({ job_ref: 'job:2', operation: 'PAUSE', by_device_ref: 'device:tablet' }).state, 'WAITING_CONFIRMATION');
  assert.equal(surface.control({ job_ref: 'job:2', operation: 'RESUME' }).state, 'RUNNING', 'the interaction device stays authorized');
  assert.equal(failure(() => surface.control({ job_ref: 'job:1', operation: 'PAUSE', by_device_ref: 7 })).code, 'NOT_AUTHORIZED_TO_CONTROL');
});

test('a retry re-queues failed work only and never revives or duplicates execution', () => {
  const { surface } = surfaceAt();
  submit(surface, { job_ref: 'job:failed' });
  surface.applyResult({ job_ref: 'job:failed', state: 'FAILED' });
  const retried = surface.control({ job_ref: 'job:failed', operation: 'RETRY', by_device_ref: LAPTOP });
  assert.equal(retried.state, 'QUEUED');
  assert.equal(retried.applied, true);
  submit(surface, { job_ref: 'job:done' });
  surface.applyResult({ job_ref: 'job:done', state: 'SUCCEEDED', result_ref: 'result:1' });
  const revived = failure(() => surface.control({ job_ref: 'job:done', operation: 'RETRY', by_device_ref: LAPTOP }));
  assert.equal(revived.code, 'FALSE_SUCCESS_REFUSED');
  assert.equal(revived.applied, false);
  assert.equal(surface.status({ job_ref: 'job:done' }).state, 'SUCCEEDED');
  submit(surface, { job_ref: 'job:live' });
  const duplicated = failure(() => surface.control({ job_ref: 'job:live', operation: 'RETRY', by_device_ref: LAPTOP }));
  assert.equal(duplicated.code, 'DUPLICATE_JOB');
  assert.equal(duplicated.duplicate_execution_prevented, true);
});

test('the first terminal result is the job truth and malformed artifacts are refused, not dropped', () => {
  const { surface } = surfaceAt();
  submit(surface);
  surface.applyResult({ job_ref: 'job:1', state: 'SUCCEEDED', result_ref: 'result:accepted' });
  const rewritten = failure(() => surface.applyResult({ job_ref: 'job:1', state: 'FAILED' }));
  assert.equal(rewritten.code, 'FALSE_SUCCESS_REFUSED');
  assert.equal(rewritten.rewritten, false);
  assert.equal(surface.status({ job_ref: 'job:1' }).state, 'SUCCEEDED');
  submit(surface, { job_ref: 'job:2' });
  assert.equal(failure(() => surface.applyResult({ job_ref: 'job:2', state: 'SUCCEEDED', result_ref: 'r', artifacts: 'artifact:1' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => surface.applyResult({ job_ref: 'job:2', state: 'SUCCEEDED', result_ref: 'r', artifacts: [{ kind: 'DIFF' }] })).code, 'INVALID_REQUEST');
  assert.equal(surface.status({ job_ref: 'job:2' }).result, null, 'a refused result leaves no partial state');
  assert.equal(surface.status({ job_ref: 'job:2' }).state, 'SUBMITTED');
  const accepted = surface.applyResult({ job_ref: 'job:2', state: 'SUCCEEDED', result_ref: 'r', artifacts: [{ artifact_ref: 'artifact:1' }] });
  assert.equal(accepted.result.artifacts.length, 1);
});

test('an attention-required backend is not rendered as success', () => {
  const { surface } = surfaceAt();
  submit(surface);
  surface.projectAttention({ job_ref: 'job:1', attention_ref: 'attention:1', question: 'Which branch?' });
  const refused = failure(() => surface.applyResult({ job_ref: 'job:1', state: 'SUCCEEDED', result_ref: 'result:early' }));
  assert.equal(refused.code, 'FALSE_SUCCESS_REFUSED');
  assert.equal(refused.backend_attention_required, true);
  assert.equal(surface.status({ job_ref: 'job:1' }).result, null);
  surface.acknowledgeAttention({ attention_ref: 'attention:1', device_ref: LAPTOP });
  const accepted = surface.applyResult({ job_ref: 'job:1', state: 'SUCCEEDED', result_ref: 'result:late' });
  assert.equal(accepted.user_visible_success, true);
});

test('the surface reports the execution device it was given and never invents one', () => {
  const { surface } = surfaceAt();
  const withoutDevice = submit(surface, { job_ref: 'job:nodevice', executor_device_ref: null });
  assert.equal(withoutDevice.executor_device_ref, null, 'a connector reference is not a device reference');
  assert.equal(withoutDevice.interaction_device_is_execution_device, false);
  const submitted = submit(surface, { job_ref: 'job:ok' });
  assert.equal(submitted.executor_device_ref, DESKTOP);
  assert.equal(submitted.execution_responsibility_source, 'CALLER_DECLARED_CANONICAL_TASK_BINDING');
  assert.equal(submitted.lease_verified_here, false, 'this surface holds no lease to verify');
});

test('owner and executor separation is about the owner and the executor connector', () => {
  const { surface } = surfaceAt();
  const same = submit(surface, { job_ref: 'job:self', logical_owner_ref: CONNECTOR });
  assert.equal(same.executor_connector_is_logical_owner, true);
  assert.equal(same.owner_and_executor_separated, false, 'one connector cannot be reported as separated from itself');
  const separated = submit(surface, { job_ref: 'job:separate' });
  assert.equal(separated.owner_and_executor_separated, true);
  assert.equal(separated.executor_connector_is_logical_owner, false);
});

test('canonical refs are unique across surfaces in one process', () => {
  const first = surfaceAt().surface;
  const second = surfaceAt().surface;
  submit(first);
  submit(second);
  const one = first.progress({ job_ref: 'job:1', kind: 'PROGRESS' }).event_ref;
  const two = second.progress({ job_ref: 'job:1', kind: 'PROGRESS' }).event_ref;
  assert.equal(one === two, false, 'two surfaces must not publish the same canonical event reference');
  submit(first, { job_ref: 'job:throttled', eligibility: 'LOCAL_THROTTLED' });
  const firstProposal = first.proposeRemoteFallback({ job_ref: 'job:throttled', remote_device_ref: 'device:fast-server' });
  submit(second, { job_ref: 'job:throttled', eligibility: 'LOCAL_THROTTLED' });
  const secondProposal = second.proposeRemoteFallback({ job_ref: 'job:throttled', remote_device_ref: 'device:fast-server' });
  assert.equal(firstProposal.proposal_ref === secondProposal.proposal_ref, false, 'two surfaces must not publish the same proposal reference');
});

test('an attention acknowledgement records the subject it answers and the read views are frozen', () => {
  const { surface } = surfaceAt();
  submit(surface);
  surface.projectAttention({ job_ref: 'job:1', attention_ref: 'attention:1', question: 'Which branch?' });
  surface.acknowledgeAttention({ attention_ref: 'attention:1', device_ref: LAPTOP });
  const record = surface.acknowledgements()[0];
  assert.equal(record.job_ref, 'job:1');
  assert.equal(record.subject_ref, 'job:1');
  assert.equal(record.device_ref, LAPTOP);
  assert.equal(failure(() => surface.acknowledgeAttention({ attention_ref: 'attention:2', device_ref: null })).code, 'UNKNOWN_ATTENTION');
  surface.projectAttention({ job_ref: 'job:1', attention_ref: 'attention:2', question: 'And now?' });
  assert.equal(failure(() => surface.acknowledgeAttention({ attention_ref: 'attention:2', device_ref: null })).code, 'INVALID_REQUEST');
  assert.throws(() => { surface.jobs().push({}); }, TypeError, 'the job list is a frozen projection');
  assert.throws(() => { surface.journal().push({}); }, TypeError, 'the journal is a frozen record');
  assert.throws(() => { surface.attentionEntries()[0].state = 'WITHDRAWN'; }, TypeError);
});
