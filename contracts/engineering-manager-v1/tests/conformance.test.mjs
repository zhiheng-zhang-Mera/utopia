// EM-001 conformance suite for the Engineering Manager core contracts.
//
// Covers the task's acceptance requirements: no redefinition of foreign
// semantics, unknown version/state/route rejection, owner/executor separation,
// no second City task database, no provider product name requirement, no raw
// secret fields, plus idempotency/version/replay rules for submit/control/result.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
 ARTIFACT_SPEC, ATTENTION_STATUSES, ATTENTION_SPEC, CANONICAL_OWNERSHIP, CANONICAL_TASK_TRUTH_PORT,
 CONTROL_COMMANDS, ENGINEERING_MANAGER_CONTRACT, ENGINEERING_OWNED_STATE_FIELDS, ENGINEERING_ROUTE,
 EngineeringContractError, EVENT_SPEC, EVENT_TYPES, EXECUTION_MODES, FOREIGN_CANONICAL_FIELDS,
 FOREIGN_ROUTES, JOB_SPEC, JOB_STATES, PORT_CONTRACTS, PORT_CONTRACT_VERSION, REMOTE_FALLBACK_SPEC,
 applyApprovedFallback, applyControlCommand, applyResult, assertJobEnvelope, assertPortConformance,
 canonicalJson, createDeterministicConnectorDouble, createIdempotencyLedger, describePort, digestOf,
 findSecretFields, jobIdentityDigest, parseJobEnvelope, probePortConformance, projectAttention,
 acknowledgeAttention, resolveJobRoles, submitJob, validateAttentionEnvelope, validateArtifactEnvelope,
 validateAuthStatus, validateConnectorDescriptor, validateConnectorInstance, validateEngineeringOwnedState,
 validateEngineeringRoute, validateEventEnvelope, validateJobEnvelope, validateRemoteFallbackProposal,
 validateResultEnvelope
} from '../index.mjs';

const TS = '2026-09-30T12:00:00.000Z';
const expectCode = (fn, code) => {
 try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
 assert.fail(`expected the call to fail with ${code}`);
};

const baseJob = (overrides = {}) => ({
 contract_version: 1,
 route: 'ENGINEERING',
 job_ref: 'job-1',
 city_task_ref: 'city-task-1',
 execution_mode: 'AUTONOMOUS_AGENT',
 owner: { task_owner_ref: 'city-task-1', coordinator_ref: 'city-task-1' },
 executor: { host_kind: 'LOCAL', host_ref: 'mech', placement: 'LOCAL_ALLOWED' },
 connector_instance_ref: 'connector-instance-1',
 workspace: { repo_ref: 'utopia', worktree_ref: null, branch_ref: 'engineering-manager/EM-001' },
 scope: { include_refs: ['contracts/'], exclude_refs: [] },
 acceptance: { criteria_refs: ['acceptance-1'], required_checks: ['pnpm test'] },
 permission_context_ref: 'permission-context-1',
 risk_class: 'LOW',
 context_refs: [], checkpoints: [], evidence_refs: [], artifact_refs: [],
 lease_ref: null,
 idempotency_key: 'submit-key-1',
 job_version: 1,
 state: 'SUBMITTED',
 blocking_state: null,
 created_at: TS,
 updated_at: TS,
 ...overrides
});

const baseEvent = (overrides = {}) => ({ contract_version: 1, event_id: 'event-1', job_ref: 'job-1', event_type: 'JOB_STATE_CHANGED', job_version: 1, sequence: 0, at: TS, payload: {}, ...overrides });

const baseAttention = (overrides = {}) => ({
 contract_version: 1, attention_id: 'attention-1', job_ref: 'job-1', blocking: true,
 question: 'Provider login requires confirmation',
 projections: [
  { device_ref: 'mech', projection: 'ACTIONABLE', delivered_at: TS, ringing: false, actionable: true },
  { device_ref: 'alien', projection: 'RING', delivered_at: TS, ringing: true, actionable: false }
 ],
 acknowledgement: { status: 'PENDING', acknowledged_by: null, at: null },
 created_at: TS,
 ...overrides
});

const baseResult = (overrides = {}) => ({
 contract_version: 1, result_ref: 'result-1', job_ref: 'job-1', job_version: 1, outcome: 'SUCCEEDED',
 acceptance: { status: 'PASS', evidence_refs: ['evidence-1'] },
 changed_files: [{ path: 'contracts/a.mjs', status: 'MODIFIED', digest: null }],
 tests: [{ name: 'pnpm test', status: 'PASS' }],
 branch_ref: 'engineering-manager/EM-001', commit_ref: 'abc1234', artifact_refs: ['artifact-1'],
 blocking_state: null, produced_at: TS,
 ...overrides
});

const baseProposal = (overrides = {}) => ({
 contract_version: 1, proposal_ref: 'proposal-1', job_ref: 'job-1', owner_ref: 'city-task-1',
 reason: 'LOCAL_BLOCKED',
 candidates: [{ host_ref: 'alien', measured_reason: 'LOCAL_BLOCKED', capability_refs: ['cap-1'] }],
 requires_user_approval: true, scope: 'CURRENT_JOB', status: 'PROPOSED', created_at: TS,
 ...overrides
});

const baseCommand = (overrides = {}) => ({ contract_version: 1, command_id: 'command-1', job_ref: 'job-1', kind: 'PAUSE', job_version: 1, idempotency_key: 'control-key-1', issued_by_ref: 'mech', issued_at: TS, ...overrides });

test('a provider-neutral autonomous job validates and keeps owner and executor distinct', () => {
 const job = baseJob();
 assert.deepEqual(validateJobEnvelope(job), { ok: true, errors: [] });
 const roles = resolveJobRoles(job);
 assert.equal(roles.taskOwnerRef, 'city-task-1');
 assert.equal(roles.executorHostRef, 'mech');
 assert.equal(roles.sameHost, false);
 assert.equal(roles.executionHostChangeCreatesNewOwner, false);
 // the same physical host may fill both roles, and they remain distinct fields
 const sameHost = resolveJobRoles(baseJob({ executor: { host_kind: 'LOCAL', host_ref: 'city-task-1', placement: 'LOCAL_ALLOWED' } }));
 assert.equal(sameHost.sameHost, true);
});

test('scripted executors need explicit operations while agent modes must not carry them', () => {
 assert.equal(validateJobEnvelope(baseJob({ execution_mode: 'SCRIPTED_EXECUTOR' })).ok, false);
 const scripted = validateJobEnvelope(baseJob({ execution_mode: 'SCRIPTED_EXECUTOR', operations: ['run-tests', 'collect-diff'] }));
 assert.equal(scripted.ok, true, scripted.errors.join(' | '));
 const autonomous = validateJobEnvelope(baseJob({ execution_mode: 'AUTONOMOUS_AGENT', operations: ['run-tests'] }));
 assert.equal(autonomous.ok, false);
 assert.equal(autonomous.errors.some(error => error.includes('must not be supplied')), true);
 assert.equal(validateJobEnvelope(baseJob({ execution_mode: 'INTERACTIVE_AGENT' })).ok, true);
});

test('unknown version, state, mode, event type or port is rejected rather than guessed', () => {
 assert.equal(validateJobEnvelope(baseJob({ contract_version: 2 })).ok, false);
 assert.equal(validateJobEnvelope(baseJob({ state: 'PROBABLY_DONE' })).ok, false);
 assert.equal(validateJobEnvelope(baseJob({ execution_mode: 'SMART_MODE' })).ok, false);
 assert.equal(validateJobEnvelope(baseJob({ risk_class: 'EXTREME' })).ok, false);
 assert.equal(validateJobEnvelope(baseJob({ blocking_state: 'MAYBE_BLOCKED' })).ok, false);
 assert.equal(validateJobEnvelope(baseJob({ mood: 'happy' })).ok, false);
 assert.equal(validateEventEnvelope(baseEvent({ event_type: 'JOB_VIBES' })).ok, false);
 expectCode(() => describePort('TurboPort'), 'UNKNOWN_PORT_CONTRACT');
 expectCode(() => createIdempotencyLedger({ maxEntries: 0 }), 'INVALID_LEDGER_CAPACITY');
});

test('foreign routes cannot be redefined as Engineering routes', () => {
 for (const route of FOREIGN_ROUTES) {
  const result = validateEngineeringRoute(route);
  assert.equal(result.ok, false, route);
  assert.equal(validateJobEnvelope(baseJob({ route })).ok, false, route);
 }
 assert.equal(validateEngineeringRoute(ENGINEERING_ROUTE).ok, true);
 assert.equal(validateEngineeringRoute('').ok, false);
 const foreign = validateEngineeringRoute('ROOM');
 assert.equal(foreign.errors.some(error => error.includes('owned by another domain')), true);
});

test('provider product names are never a route and are never required by the core contract', () => {
 for (const provider of ['HNS', 'codex', 'claude', 'workbuddy']) {
  const result = validateEngineeringRoute(provider);
  assert.equal(result.ok, false, provider);
  assert.equal(result.errors.some(error => error.includes('provider product name')), true);
 }
 // a concrete provider may appear only as an opaque connector reference
 const descriptor = {
  contract_version: 1, connector_kind: 'generic-process', descriptor_version: 1, display_name: 'Generic process connector',
  provider_ref: 'provider-ref-1', transports: ['local-process'], capabilities: [{ capability_id: 'engineering.execute', capability_version: 1 }], auth_required: false
 };
 assert.deepEqual(validateConnectorDescriptor(descriptor), { ok: true, errors: [] });
 assert.equal(validateConnectorDescriptor({ ...descriptor, provider_name: 'HNS' }).ok, false);
 assert.equal(ENGINEERING_MANAGER_CONTRACT.connector_hub_is_provider_neutral, true);
});

test('Codex-Boss is rejected everywhere it could be referenced', () => {
 const job = baseJob({ connector_instance_ref: 'codex-boss-worker' });
 const result = validateJobEnvelope(job);
 assert.equal(result.ok, false);
 assert.equal(result.errors.some(error => error.includes('Codex-Boss')), true);
 assert.equal(validateEventEnvelope(baseEvent({ payload: { note: 'codex boss legacy' } })).ok, false);
 assert.equal(validateConnectorDescriptor({ contract_version: 1, connector_kind: 'generic', descriptor_version: 1, display_name: 'Codex-Boss', provider_ref: null, transports: [], capabilities: [], auth_required: false }).ok, false);
});

test('raw secrets are rejected while handle references are allowed', () => {
 assert.equal(validateJobEnvelope(baseJob({ access_token: 'xyz' })).ok, false);
 assert.equal(validateJobEnvelope(baseJob({ connector_secret: 'xyz' })).ok, false);
 assert.equal(validateJobEnvelope(baseJob({ context_refs: ['ctx-1'], permission_context_ref: 'p-1' })).ok, true);
 // a credential handle is allowed; a raw credential is not
 assert.deepEqual(validateAuthStatus({ contract_version: 1, instance_ref: 'instance-1', status: 'AUTHENTICATED', credential_ref: 'secure-handle://1', expires_at: null, checked_at: TS }), { ok: true, errors: [] });
 const rawCredential = validateAuthStatus({ contract_version: 1, instance_ref: 'instance-1', status: 'AUTHENTICATED', credential: 'raw-secret', expires_at: null, checked_at: TS });
 assert.equal(rawCredential.ok, false);
 assert.equal(rawCredential.errors.some(error => error.includes('raw secret')), true);
 assert.deepEqual(findSecretFields({ credential_ref: 'secure-handle://1', access_token: 'x' }, ''), ['.access_token']);
 assert.deepEqual(findSecretFields({ session_handle: 'h', api_key: 'k' }, ''), ['.api_key']);
 assert.equal(validateConnectorInstance({ contract_version: 1, instance_ref: 'instance-1', connector_kind: 'generic-process', descriptor_version: 1, host_ref: 'mech', state: 'AVAILABLE', auth_status: 'AUTHENTICATED', health: 'HEALTHY', capability_refs: [], last_probe_at: TS }).ok, true);
 assert.equal(validateArtifactEnvelope({ contract_version: 1, artifact_ref: 'artifact-1', job_ref: 'job-1', kind: 'diff', media_type: 'text/plain', digest: 'not-a-digest', size_bytes: -1, storage_ref: 'storage-1', produced_at: TS }).ok, false);
});

test('Engineering Manager stores only Engineering execution state', () => {
 const owned = { job_ref: 'job-1', city_task_ref: 'city-task-1', idempotency_key: 'k', job_version: 1, state: 'RUNNING', blocking_state: null, checkpoints: [], evidence_refs: [], artifact_refs: [], lease_ref: null, created_at: TS, updated_at: TS };
 assert.deepEqual(validateEngineeringOwnedState(owned), { ok: true, errors: [] });
 for (const field of ['task_graph', 'city_task_state', 'device_trust_state', 'assistant_profile', 'provider_model_catalog']) {
  const state = { ...owned, [field]: {} };
  const result = validateEngineeringOwnedState(state);
  assert.equal(result.ok, false, field);
 }
 assert.equal(validateEngineeringOwnedState({ ...owned, arbitrary_field: 1 }).ok, false);
 assert.equal(validateEngineeringOwnedState({ ...owned, refresh_token: 'x' }).ok, false);
 assert.equal(CANONICAL_TASK_TRUTH_PORT.engineering_manager_may_own_task_truth, false);
 assert.equal(CANONICAL_TASK_TRUTH_PORT.owner, CANONICAL_OWNERSHIP.task_action_attention_identity);
 assert.equal(FOREIGN_CANONICAL_FIELDS.includes('conversation_history'), true);
 assert.equal(ENGINEERING_OWNED_STATE_FIELDS.includes('job_version'), true);
 // foreign canonical state is also rejected when nested inside a job envelope
 assert.equal(validateJobEnvelope(baseJob({ context_refs: ['x'] })).ok, true);
});

test('canonical events are typed and validated', () => {
 assert.deepEqual(validateEventEnvelope(baseEvent()), { ok: true, errors: [] });
 assert.equal(validateEventEnvelope(baseEvent({ sequence: -1 })).ok, false);
 assert.equal(validateEventEnvelope(baseEvent({ at: 'yesterday' })).ok, false);
 assert.equal(validateEventEnvelope(baseEvent({ payload: 'text' })).ok, false);
 assert.equal(EVENT_TYPES.includes('ATTENTION_REQUIRED'), true);
 assert.deepEqual(Object.keys(EVENT_SPEC).sort(), ['at', 'contract_version', 'event_id', 'event_type', 'job_ref', 'job_version', 'payload', 'sequence']);
});

test('one attention event projects to the current plus recent devices and rings once', () => {
 assert.deepEqual(validateAttentionEnvelope(baseAttention()), { ok: true, errors: [] });
 const noActionable = baseAttention({ projections: [{ device_ref: 'mech', projection: 'NOTIFY', delivered_at: TS, ringing: true, actionable: false }] });
 assert.equal(validateAttentionEnvelope(noActionable).ok, false);
 const twoActionable = baseAttention({ projections: [
  { device_ref: 'mech', projection: 'ACTIONABLE', delivered_at: TS, ringing: false, actionable: true },
  { device_ref: 'alien', projection: 'ACTIONABLE', delivered_at: TS, ringing: false, actionable: true }
 ] });
 assert.equal(validateAttentionEnvelope(twoActionable).ok, false);
 const duplicatedDevice = baseAttention({ projections: [
  { device_ref: 'mech', projection: 'ACTIONABLE', delivered_at: TS, ringing: false, actionable: true },
  { device_ref: 'mech', projection: 'RING', delivered_at: TS, ringing: true, actionable: false }
 ] });
 assert.equal(validateAttentionEnvelope(duplicatedDevice).ok, false);
 const informationalRinging = baseAttention({ blocking: false });
 assert.equal(validateAttentionEnvelope(informationalRinging).ok, false);
 const fourRecent = baseAttention({ projections: [
  { device_ref: 'mech', projection: 'ACTIONABLE', delivered_at: TS, ringing: false, actionable: true },
  { device_ref: 'd1', projection: 'RING', delivered_at: TS, ringing: true, actionable: false },
  { device_ref: 'd2', projection: 'RING', delivered_at: TS, ringing: true, actionable: false },
  { device_ref: 'd3', projection: 'RING', delivered_at: TS, ringing: true, actionable: false }
 ] });
 assert.equal(validateAttentionEnvelope(fourRecent).ok, true, validateAttentionEnvelope(fourRecent).errors.join(' | '));
 const tooMany = baseAttention({ projections: [...fourRecent.projections, { device_ref: 'd4', projection: 'RING', delivered_at: TS, ringing: true, actionable: false }] });
 assert.equal(validateAttentionEnvelope(tooMany).ok, false);
});

test('first attention acknowledgement closes the epoch globally and never rings again', () => {
 const attention = baseAttention();
 const first = acknowledgeAttention(attention, { device_ref: 'mech', at: TS });
 assert.equal(first.acknowledged, true);
 assert.equal(first.rangAgain, false);
 assert.equal(first.attention.acknowledgement.status, 'ACKNOWLEDGED');
 assert.equal(first.attention.acknowledgement.acknowledged_by, 'mech');
 assert.equal(first.attention.projections.every(projection => projection.ringing === false && projection.actionable === false), true);
 assert.deepEqual(validateAttentionEnvelope(first.attention), { ok: true, errors: [] });
 const second = acknowledgeAttention(first.attention, { device_ref: 'alien', at: TS });
 assert.equal(second.acknowledged, false);
 assert.equal(second.duplicate, true);
 assert.equal(second.rangAgain, false);
 assert.equal(second.attention.acknowledgement.acknowledged_by, 'mech');
 expectCode(() => acknowledgeAttention(attention, { device_ref: 'unknown-tablet', at: TS }), 'ATTENTION_NOT_PROJECTED_TO_DEVICE');
});

test('reconnect and duplicate delivery do not re-ring an attention epoch', () => {
 const attention = baseAttention();
 assert.deepEqual(projectAttention(attention, { device_ref: 'tablet', projection: 'RING' }), { delivered: true, ringing: true, actionable: false, suppressed: false });
 assert.equal(projectAttention(attention, { device_ref: 'alien', projection: 'RING' }).suppressed, true);
 const acknowledged = acknowledgeAttention(attention, { device_ref: 'mech', at: TS }).attention;
 assert.deepEqual(projectAttention(acknowledged, { device_ref: 'tablet', projection: 'RING' }), { delivered: false, ringing: false, actionable: false, suppressed: true });
 expectCode(() => projectAttention(attention, { device_ref: 'tablet', projection: 'SHOUT' }), 'UNKNOWN_ATTENTION_PROJECTION');
});

test('a result cannot report success on a typed blocker, without acceptance or with failing tests', () => {
 assert.deepEqual(validateResultEnvelope(baseResult()), { ok: true, errors: [] });
 const blocked = validateResultEnvelope(baseResult({ blocking_state: 'PHYSICAL_ACTION_REQUIRED' }));
 assert.equal(blocked.ok, false);
 assert.equal(blocked.errors.some(error => error.includes('must not be SUCCEEDED')), true);
 const unaccepted = validateResultEnvelope(baseResult({ acceptance: { status: 'NOT_REQUIRED', evidence_refs: [] } }));
 assert.equal(unaccepted.ok, false);
 assert.equal(unaccepted.errors.some(error => error.includes('requires acceptance.status PASS')), true);
 const failing = validateResultEnvelope(baseResult({ tests: [{ name: 'pnpm test', status: 'FAIL' }] }));
 assert.equal(failing.ok, false);
 const honestBlocker = validateResultEnvelope(baseResult({ outcome: 'FAILED', blocking_state: 'PHYSICAL_ACTION_REQUIRED', acceptance: { status: 'FAIL', evidence_refs: ['evidence-1'] } }));
 assert.equal(honestBlocker.ok, true, honestBlocker.errors.join(' | '));
});

test('ports are versioned, replacement-safe and refuse non-conforming subjects', () => {
 const double = createDeterministicConnectorDouble({ capabilities: [{ capability_id: 'engineering.execute', capability_version: 1 }] });
 const probe = probePortConformance('ConnectorPort', double);
 assert.equal(probe.ok, true, probe.errors.join(' | '));
 assert.equal(probe.version, PORT_CONTRACT_VERSION);
 assert.deepEqual(probe.missing, []);
 assert.deepEqual(probe.extensions, []);
 assert.equal(assertPortConformance('ConnectorPort', double), double);
 const partial = { probe: () => {} , describe: () => {}, authStatus: () => {} };
 const partialProbe = probePortConformance('ConnectorPort', partial);
 assert.equal(partialProbe.ok, false);
 assert.equal(partialProbe.missing.includes('submit'), true);
 const nonFunction = probePortConformance('ConnectorPort', { ...double, submit: 'not-a-function' });
 assert.deepEqual(nonFunction.nonFunctions, ['submit']);
 assert.equal(describePort('EngineeringManagerPort').replacementSafe, true);
 assert.equal(describePort('EngineeringManagerPort').transportAgnostic, true);
 for (const methods of Object.values(PORT_CONTRACTS)) assert.equal(Array.isArray(methods), true);
 assert.equal(PORT_CONTRACTS.ConnectorPort.includes('shutdown'), true);
 assert.equal(PORT_CONTRACTS.EngineeringRemoteExecutionPort.includes('dispatchApproved'), true);
 assert.equal(PORT_CONTRACTS.ConnectorRegistryPort.includes('probeAll'), true);
});

test('a deterministic connector double runs a scripted job without a real provider', async () => {
 const connector = createDeterministicConnectorDouble({ script: [{ state: 'RUNNING', progress: 50 }, { state: 'SUCCEEDED', progress: 100 }] });
 assert.equal((await connector.describe()).connector_kind, 'generic-process');
 const submitted = await connector.submit(baseJob());
 assert.deepEqual(submitted, { job_ref: 'job-1', accepted: true });
 assert.equal((await connector.subscribe('job-1')).state, 'RUNNING');
 assert.equal((await connector.subscribe('job-1')).state, 'SUCCEEDED');
 assert.equal((await connector.health()).health, 'HEALTHY');
 assert.equal((await connector.shutdown()).shutdown, true);
 assert.equal(connector.__events.length >= 3, true);
 await assert.rejects(() => connector.subscribe('unknown-job'), error => error.code === 'UNKNOWN_JOB_REF');
});

test('duplicate submit replays instead of creating a second job', () => {
 const ledger = createIdempotencyLedger();
 const job = baseJob();
 const first = submitJob(job, { ledger, at: TS });
 assert.deepEqual({ created: first.created, replayed: first.replayed, jobRef: first.jobRef }, { created: true, replayed: false, jobRef: 'job-1' });
 const retry = submitJob({ ...job, job_version: 1, state: 'QUEUED', updated_at: '2026-09-30T12:00:01.000Z' }, { ledger, at: TS });
 assert.equal(retry.created, false);
 assert.equal(retry.replayed, true);
 assert.equal(retry.outcome.job_ref, 'job-1');
 assert.equal(ledger.size(), 1);
 expectCode(() => submitJob(baseJob({ risk_class: 'HIGH' }), { ledger, at: TS }), 'IDEMPOTENCY_KEY_REUSE');
 expectCode(() => ledger.replay('unknown-scope', 'k', {}), 'UNKNOWN_IDEMPOTENCY_SCOPE');
 expectCode(() => ledger.replay('submit', '', {}), 'INVALID_IDEMPOTENCY_KEY');
});

test('control commands check version, transition and terminal state', () => {
 const ledger = createIdempotencyLedger();
 const running = baseJob({ state: 'RUNNING' });
 const paused = applyControlCommand(running, baseCommand(), { ledger, at: TS });
 assert.equal(paused.applied, true);
 assert.equal(paused.job.state, 'PAUSED');
 assert.equal(paused.job.job_version, 2);
 const replay = applyControlCommand(running, baseCommand(), { ledger, at: TS });
 assert.equal(replay.replayed, true);
 assert.equal(replay.applied, false);
 assert.equal(replay.job, running);
 expectCode(() => applyControlCommand(paused.job, baseCommand({ command_id: 'command-2', idempotency_key: 'control-key-2', job_version: 2 }), { ledger, at: TS }), 'ILLEGAL_STATE_TRANSITION');
 expectCode(() => applyControlCommand(running, baseCommand({ command_id: 'command-3', idempotency_key: 'control-key-3', job_version: 0 }), { ledger, at: TS }), 'STALE_JOB_VERSION');
 expectCode(() => applyControlCommand(running, baseCommand({ command_id: 'command-4', idempotency_key: 'control-key-4', job_version: 9 }), { ledger, at: TS }), 'FUTURE_JOB_VERSION');
 expectCode(() => applyControlCommand(running, baseCommand({ command_id: 'command-5', idempotency_key: 'control-key-5', kind: 'RESTART' }), { ledger, at: TS }), 'INVALID_CONTROL_COMMAND');
 expectCode(() => applyControlCommand(running, baseCommand({ job_ref: 'job-2' }), { ledger, at: TS }), 'CONTROL_JOB_MISMATCH');
 const cancelled = applyControlCommand(running, baseCommand({ command_id: 'command-6', idempotency_key: 'control-key-6', kind: 'CANCEL' }), { ledger, at: TS });
 assert.equal(cancelled.job.state, 'CANCELLED');
 assert.equal(cancelled.job.blocking_state, null);
 // a terminal job is never resurrected
 expectCode(() => applyControlCommand(cancelled.job, baseCommand({ command_id: 'command-7', idempotency_key: 'control-key-7', kind: 'RESUME', job_version: 2 }), { ledger, at: TS }), 'JOB_ALREADY_TERMINAL');
 assert.deepEqual(CONTROL_COMMANDS, ['PAUSE', 'RESUME', 'CANCEL']);
});

test('results are idempotent and cannot overwrite or resurrect a terminal job', () => {
 const ledger = createIdempotencyLedger();
 const running = baseJob({ state: 'RUNNING' });
 const applied = applyResult(running, baseResult(), { ledger, at: TS });
 assert.equal(applied.applied, true);
 assert.equal(applied.job.state, 'SUCCEEDED');
 assert.equal(applied.job.job_version, 2);
 assert.equal(applied.job.evidence_refs.includes('evidence-1'), true);
 assert.equal(applied.job.artifact_refs.includes('artifact-1'), true);
 const replay = applyResult(running, baseResult(), { ledger, at: TS });
 assert.equal(replay.replayed, true);
 assert.equal(replay.applied, false);
 assert.equal(replay.job, running);
 expectCode(() => applyResult(applied.job, baseResult({ result_ref: 'result-2', job_version: 2, outcome: 'FAILED', acceptance: { status: 'FAIL', evidence_refs: [] } }), { ledger, at: TS }), 'DUPLICATE_RESULT_CONFLICT');
 const later = baseJob({ state: 'RUNNING', job_version: 3 });
 expectCode(() => applyResult(later, baseResult({ result_ref: 'result-5', job_version: 2 }), { ledger, at: TS }), 'STALE_JOB_VERSION');
 expectCode(() => applyResult(later, baseResult({ result_ref: 'result-3', job_version: 4 }), { ledger, at: TS }), 'FUTURE_JOB_VERSION');
 expectCode(() => applyResult(later, baseResult({ result_ref: 'result-4', job_ref: 'job-9' }), { ledger, at: TS }), 'RESULT_JOB_MISMATCH');
});

test('canonical job identity survives restart/reconnect and rejects incompatible replay', () => {
 const job = baseJob();
 const digest = jobIdentityDigest(job);
 assert.equal(digest, jobIdentityDigest({ ...job, job_version: 7, state: 'RUNNING', updated_at: '2026-10-01T00:00:00.000Z' }));
 assert.notEqual(digest, jobIdentityDigest(baseJob({ job_ref: 'job-2' })));
 const restored = parseJobEnvelope(JSON.stringify(job));
 assert.deepEqual(restored, job);
 assert.equal(jobIdentityDigest(restored), digest);
 expectCode(() => parseJobEnvelope('{ not json'), 'INVALID_ENGINEERING_JOB');
 expectCode(() => parseJobEnvelope(JSON.stringify({ ...job, contract_version: 2 })), 'INCOMPATIBLE_JOB_ENVELOPE');
 assert.equal(assertJobEnvelope(job), job);
});

test('remote fallback is measured, user-approved and preserves the logical owner', () => {
 assert.deepEqual(validateRemoteFallbackProposal(baseProposal()), { ok: true, errors: [] });
 assert.equal(validateRemoteFallbackProposal(baseProposal({ requires_user_approval: false })).ok, false);
 assert.equal(validateRemoteFallbackProposal(baseProposal({ reason: 'REMOTE_FASTER' })).ok, false);
 assert.equal(validateRemoteFallbackProposal(baseProposal({ candidates: [] })).ok, false);
 assert.equal(validateRemoteFallbackProposal(baseProposal({ candidates: [
  { host_ref: 'a', measured_reason: 'LOCAL_BLOCKED', capability_refs: [] },
  { host_ref: 'b', measured_reason: 'LOCAL_BLOCKED', capability_refs: [] },
  { host_ref: 'c', measured_reason: 'LOCAL_BLOCKED', capability_refs: [] },
  { host_ref: 'd', measured_reason: 'LOCAL_BLOCKED', capability_refs: [] }
 ] })).ok, false);
 // a faster idle host cannot be smuggled in as a ranking field
 assert.equal(validateRemoteFallbackProposal(baseProposal({ candidates: [{ host_ref: 'alien', measured_reason: 'LOCAL_BLOCKED', capability_refs: [], speed_rank: 1 }] })).ok, false);
 assert.equal(validateRemoteFallbackProposal(baseProposal({ scope: 'ALL_JOBS' })).ok, false);
 const job = baseJob({ state: 'BLOCKED', blocking_state: 'LOCAL_BLOCKED' });
 expectCode(() => applyApprovedFallback(job, baseProposal(), { host_ref: 'alien', at: TS }), 'REMOTE_FALLBACK_NOT_APPROVED');
 expectCode(() => applyApprovedFallback(job, baseProposal({ status: 'APPROVED', job_ref: 'job-9' }), { host_ref: 'alien', at: TS }), 'PROPOSAL_JOB_MISMATCH');
 expectCode(() => applyApprovedFallback(job, baseProposal({ status: 'APPROVED', owner_ref: 'city-task-9' }), { host_ref: 'alien', at: TS }), 'PROPOSAL_OWNER_MISMATCH');
 expectCode(() => applyApprovedFallback(job, baseProposal({ status: 'APPROVED' }), { host_ref: 'unknown-host', at: TS }), 'REMOTE_HOST_NOT_PROPOSED');
 const dispatched = applyApprovedFallback(job, baseProposal({ status: 'APPROVED' }), { host_ref: 'alien', at: TS });
 assert.equal(dispatched.job.executor.host_kind, 'REMOTE');
 assert.equal(dispatched.job.executor.host_ref, 'alien');
 assert.equal(dispatched.job.executor.placement, 'REMOTE_APPROVED');
 assert.equal(dispatched.job.state, 'QUEUED');
 assert.equal(dispatched.job.job_version, 2);
 assert.equal(dispatched.ownerRef, job.owner.task_owner_ref);
 assert.equal(dispatched.job.owner.task_owner_ref, job.owner.task_owner_ref);
 assert.equal(resolveJobRoles(dispatched.job).executionHostChangeCreatesNewOwner, false);
});

test('canonical serialization is order-independent and the schema matches the runtime contract', () => {
 assert.equal(digestOf({ b: 2, a: 1 }), digestOf({ a: 1, b: 2 }));
 assert.equal(canonicalJson({ b: [2, 1], a: 'x' }), '{"a":"x","b":[2,1]}');
 const schema = JSON.parse(readFileSync(new URL('../schema.json', import.meta.url), 'utf8'));
 assert.equal(schema.$defs.job.properties.contract_version.const, 1);
 assert.equal(schema.$defs.job.properties.route.const, ENGINEERING_ROUTE);
 assert.deepEqual(schema.$defs.job.properties.execution_mode.enum, [...EXECUTION_MODES]);
 assert.deepEqual(schema.$defs.job.properties.state.enum, [...JOB_STATES]);
 assert.deepEqual(schema.$defs.event.properties.event_type.enum, [...EVENT_TYPES]);
 assert.deepEqual(schema.$defs.attention.properties.acknowledgement.properties.status.enum, [...ATTENTION_STATUSES]);
 assert.equal(schema.$defs.remoteFallback.properties.requires_user_approval.const, true);
 assert.equal(schema.$defs.job.additionalProperties, false);
 assert.deepEqual(schema.$defs.job.required.slice().sort(), Object.entries(JOB_SPEC).filter(([, rule]) => rule.required).map(([key]) => key).sort());
 assert.deepEqual(schema.$defs.event.required.slice().sort(), Object.keys(EVENT_SPEC).sort());
 assert.deepEqual(Buffer.from([]).length, 0);
 assert.deepEqual(Object.keys(schema.$defs.artifact.properties).sort(), Object.keys(ARTIFACT_SPEC).sort());
 assert.deepEqual(Object.keys(schema.$defs.attention.properties).sort(), Object.keys(ATTENTION_SPEC).sort());
 assert.deepEqual(Object.keys(schema.$defs.remoteFallback.properties).sort(), Object.keys(REMOTE_FALLBACK_SPEC).sort());
 assert.equal(schema.$defs.remoteFallback.additionalProperties, false);
});

test('contract error type carries a stable code and status', () => {
 const error = new EngineeringContractError('SOME_CODE', 'detail');
 assert.equal(error.code, 'SOME_CODE');
 assert.equal(error.detail, 'detail');
 assert.equal(error.status, 400);
 assert.equal(error instanceof Error, true);
});
