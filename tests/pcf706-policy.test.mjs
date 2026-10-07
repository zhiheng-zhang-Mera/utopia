// PCF-706 acceptance: policy, consent and data boundaries.
//
// Workbook: dc/mission-book/mission-group/personal-compute-fabric/PCF-706-policy-consent-and-data-boundaries.md
// (English mirror under en/). Each test names the workbook line it covers; typed refusals are asserted by code, and
// the workbook's "must NOT be claimed" sentences (no domain inference, no metadata-forged privilege, zero budget is
// not spend, no consent control published before the 715 UI wiring) are asserted as the honest value, not as prose.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../services/dev-gateway/store.mjs';
import {createFabricService} from '../services/personal-compute-fabric/service.mjs';
import {resolveEffectivePolicy, assertPolicy} from '../services/personal-compute-fabric/policy.mjs';
import {feasibility} from '../services/personal-compute-fabric/placement.mjs';
import {normalizeWorkload} from '../services/personal-compute-fabric/workload.mjs';
import {compileExecutionCapsule, validateResultEnvelope} from '../services/personal-compute-fabric/execution-capsule.mjs';
import {chooseTransport} from '../services/personal-compute-fabric/bounded-stream.mjs';
import {toResearchEvent} from '../services/personal-compute-fabric/research-adapter.mjs';
import {buildFabricProjection} from '../services/personal-compute-fabric/presentation.mjs';
import {assertNoProtectedFieldChange, advancePolicyStage, rollbackPolicy, evaluateHeldOut, assertScorerHealthy, MAX_COST_MINOR} from '../services/personal-compute-fabric/shadow-placement.mjs';

const NOW = 1000;
const authority = (extra = {}) => ({version: 3, authorized: true, expiresAt: 5000, originDeviceId: 'alien', allowedDevices: ['alien', 'mech'], dataScopes: ['PUBLIC', 'PERSONAL'], sharingConsent: true, cloudConsent: false, budget: 0, ...extra});
const policy = (request = {}, facts = authority()) => resolveEffectivePolicy(request, facts, NOW);
const refusal = run => { try { run(); } catch (error) { return error; } throw new Error('expected a typed refusal, but the call succeeded'); };
const workload = {version: 1, taskId: 'T1', actionId: 'A1', originDeviceId: 'alien', parentSessionId: 'S1', appId: 'app', kind: 'CPU_JSON', capabilities: ['cpu.json'], resources: {cpu: 1, memory: 1024}, dataScope: 'PUBLIC', qos: 'BATCH', retryClass: 'PURE', inputRefs: [], writeScope: [], outputSchema: 'json', deadlineAt: 4000};
const candidate = (deviceId, extra = {}) => ({deviceId, bootId: 'boot-' + deviceId, trusted: true, authorized: true, executorReady: true, sharing: true, platform: 'win32',
  provider: {id: 'cpu', ready: true, capabilities: ['cpu.json'], workloadKinds: ['CPU_JSON'], isolation: 'COOPERATIVE'}, observationVersion: 1, observedAt: 900, validUntil: 3000,
  free: {cpu: 2, memory: 4096}, queueMs: 10, cost: {inputMs: [1, 2], coldStartMs: [0, 1], executeMs: [10, 20], returnMs: [1, 2]}, ...extra});

// Workbook sub-task 1: "数据域明确ORIGIN_DEVICE_ONLY / TRUSTED_PERSONAL_FABRIC / APPROVED_CLOUD" and the acceptance
// clause "ORIGIN_DEVICE_ONLY不能发给另一私人PC".
test('PCF706-01 the three data domains are distinct and the default grant stays origin-device-only', () => {
  const originOnly = policy();
  assert.equal(originOnly.mode, 'ORIGIN_DEVICE_ONLY');
  assert.deepEqual(originOnly.allowedDevices, ['alien'], 'local-first: the default grant names only the origin device');
  assertPolicy(originOnly, {deviceId: 'alien', dataScope: 'PUBLIC', fee: 0}, NOW);
  // Another private PC is NOT covered by an origin-only grant, even one the authority lists as a known device.
  assert.throws(() => assertPolicy(originOnly, {deviceId: 'mech', dataScope: 'PUBLIC', fee: 0}, NOW), {code: 'DEVICE_NOT_APPROVED'});
  // The same origin-only grant cannot be widened by asking for it.
  assert.deepEqual(policy({allowedDevices: ['alien', 'mech']}).allowedDevices, ['alien']);
  // Cross-device work in the fabric domain needs the explicit sharing confirmation.
  const shared = policy({mode: 'TRUSTED_PERSONAL_FABRIC'});
  assert.equal(shared.mode, 'TRUSTED_PERSONAL_FABRIC');
  assertPolicy(shared, {deviceId: 'mech', dataScope: 'PUBLIC', fee: 0}, NOW);
  assert.throws(() => assertPolicy(policy({mode: 'TRUSTED_PERSONAL_FABRIC'}, authority({sharingConsent: false})), {deviceId: 'mech', dataScope: 'PUBLIC', fee: 0}, NOW), {code: 'SHARING_NOT_APPROVED'});
  // The cloud domain is its own mode and needs its own consent and a positive budget.
  const cloud = policy({mode: 'APPROVED_CLOUD'}, authority({cloudConsent: true, budget: 10}));
  assert.equal(cloud.mode, 'APPROVED_CLOUD');
  assert.equal(cloud.cloudConsent, true);
  assertPolicy(cloud, {deviceId: 'mech', dataScope: 'PUBLIC', fee: 1, cloud: true}, NOW);
  assert.equal(refusal(() => policy({mode: 'APPROVED_CLOUD'}, authority({cloudConsent: true, budget: 0}))).code, 'CLOUD_NOT_APPROVED');
  // The domain set is closed: a fourth name is refused rather than treated as "some remote domain".
  assert.equal(refusal(() => policy({mode: 'ANY_DEVICE'})).code, 'INVALID_MODE');
});

// Workbook acceptance: "过期/撤销/别的task的consent无效".
test('PCF706-02 expired, revoked and other-task consent are all refused', () => {
  const grant = policy();
  assertPolicy(grant, {deviceId: 'alien', dataScope: 'PUBLIC', fee: 0}, 4999);
  // Expiry is exclusive: at the expiry instant the grant is already void.
  assert.throws(() => assertPolicy(grant, {deviceId: 'alien', dataScope: 'PUBLIC', fee: 0}, 5000), {code: 'AUTHORITY_EXPIRED_OR_REVOKED'});
  // Revocation is read from the authority, not from the grant the caller is holding.
  const revoked = policy({}, authority({authorized: false}));
  assert.equal(revoked.authorized, false);
  assert.throws(() => assertPolicy(revoked, {deviceId: 'alien', dataScope: 'PUBLIC', fee: 0}, NOW), {code: 'AUTHORITY_EXPIRED_OR_REVOKED'});
  // A consent record is bound to ONE task's capsule: another task's receipt cannot ride on it.
  const active = policy({mode: 'TRUSTED_PERSONAL_FABRIC'});
  const capsule = compileExecutionCapsule(normalizeWorkload(workload), {attemptId: 'X1', epoch: 1, executorDeviceId: 'mech', bootId: 'boot', providerId: 'cpu', inputDigest: 'a'.repeat(64), policy: active}, NOW);
  const receipt = {version: 1, taskId: 'T1', actionId: 'A1', parentSessionId: 'S1', attemptId: 'X1', epoch: 1, executorDeviceId: 'mech', bootId: 'boot', providerId: 'cpu', inputDigest: 'a'.repeat(64), outputDigest: 'b'.repeat(64), policyVersion: 3, outcome: 'SUCCEEDED', exitCode: 0};
  assert.equal(validateResultEnvelope(capsule, receipt, {policy: active, now: NOW}).outcome, 'SUCCEEDED');
  assert.throws(() => validateResultEnvelope(capsule, {...receipt, taskId: 'T2'}, {policy: active, now: NOW}), {code: 'RECEIPT_BINDING_taskId'});
  assert.throws(() => validateResultEnvelope(capsule, {...receipt, parentSessionId: 'S2'}, {policy: active, now: NOW}), {code: 'RECEIPT_BINDING_parentSessionId'});
  assert.throws(() => validateResultEnvelope(capsule, {...receipt, attemptId: 'X2'}, {policy: active, now: NOW}), {code: 'RECEIPT_BINDING_attemptId'});
  // Publication revalidates the policy itself: a newer version or a revocation invalidates the result.
  assert.throws(() => validateResultEnvelope(capsule, receipt, {policy: policy({}, authority({version: 4})), now: NOW}), {code: 'POLICY_CHANGED'});
  assert.throws(() => validateResultEnvelope(capsule, receipt, {policy: policy({}, authority({authorized: false})), now: NOW}), {code: 'AUTHORITY_EXPIRED_OR_REVOKED'});
  assert.throws(() => validateResultEnvelope(capsule, receipt, {policy: active, now: 5000}), {code: 'AUTHORITY_EXPIRED_OR_REVOKED'});
});

// Workbook acceptance: "网内设备不自动受信任；许可元数据不能伪造授权" and sub-task 2's "更快的节点不能绕过授权" /
// sub-task 4's "不得以高级设置覆盖身份/权限硬门".
test('PCF706-03 LAN membership is not trust, and declared metadata cannot forge authorisation', () => {
  const grant = policy({mode: 'TRUSTED_PERSONAL_FABRIC'});
  // A device that declares itself nearby, on the same LAN and trusted is still refused when the authority never
  // listed it: proximity is not a permission.
  const neighbour = candidate('stranger', {local: true, sameLan: true, nearby: true, trusted: true, authorized: true, sharing: true});
  assert.equal(feasibility(workload, neighbour, grant, NOW), 'DEVICE_NOT_APPROVED');
  // The same metadata cannot buy a cloud path either, on a grant that carries no cloud consent or budget: the
  // candidate's own fee/budget/cloudConsent claims are not authority.
  const paid = candidate('alien', {cloud: true, fee: 5, cloudConsent: true, budget: 1000});
  assert.equal(feasibility(workload, paid, grant, NOW), 'BUDGET_NOT_APPROVED');
  const cloudClaim = candidate('alien', {cloud: true, fee: 0, cloudConsent: true, budget: 1000});
  assert.equal(feasibility(workload, cloudClaim, grant, NOW), 'CLOUD_NOT_APPROVED');
  // A request cannot confer authority on itself: only the authority facts decide.
  const injected = policy({authorized: true, budget: 0, allowedDevices: ['alien']}, authority({authorized: false}));
  assert.equal(injected.authorized, false);
  assert.equal(injected.budget, 0);
  assert.deepEqual(injected.allowedDevices, ['alien']);
  assert.deepEqual(injected.dataScopes, ['PUBLIC', 'PERSONAL']);
  // Broadening the device set, the scope or the budget is refused by name rather than clipped to fit.
  assert.throws(() => policy({mode: 'TRUSTED_PERSONAL_FABRIC', allowedDevices: ['stranger']}), {code: 'DEVICE_NOT_APPROVED'});
  assert.throws(() => policy({dataScopes: ['CONFIDENTIAL']}), {code: 'SCOPE_NOT_APPROVED'});
  assert.throws(() => policy({budget: 99}), {code: 'BUDGET_NOT_APPROVED'});
  // An advanced/learned setting touching a permission field is refused by name, present value or not.
  for (const field of ['consent', 'trusted', 'budget', 'strictTarget', 'feeMinor']) {
    assert.match(refusal(() => assertNoProtectedFieldChange({[field]: true})).code, /^SHIELD_PROTECTED_FIELD/);
  }
  assert.equal(assertNoProtectedFieldChange({deviceId: 'mech'}), true, 'non-protected metadata stays writable');
});

// Workbook sub-task 2: "可保存Owner明确的有界预授权，不能把一次同意扩大到任意设备/未来所有任务".
test('PCF706-04 a request cannot broaden, extend or outlive the granted preauthorisation', () => {
  const facts = authority();
  const bounded = policy({mode: 'TRUSTED_PERSONAL_FABRIC', expiresAt: 99999, allowedDevices: ['alien', 'mech'], dataScopes: ['PUBLIC'], budget: 0}, facts);
  assert.equal(bounded.expiresAt, 5000, 'the request cannot extend the authority expiry');
  assert.equal(bounded.version, 3, 'the effective policy is stamped with the authority version it was resolved from');
  assert.ok(Object.isFrozen(bounded));
  // The grant is a snapshot: later mutation of the authority record cannot widen a policy already issued.
  const mutable = authority();
  const issued = resolveEffectivePolicy({}, mutable, NOW);
  mutable.allowedDevices.push('stranger');
  mutable.dataScopes.push('CONFIDENTIAL');
  mutable.authorized = false;
  assert.deepEqual(issued.allowedDevices, ['alien']);
  assert.deepEqual(issued.dataScopes, ['PUBLIC', 'PERSONAL']);
  assert.equal(issued.authorized, true);
  // Each resolution is a fresh read of the authority, so a stale grant cannot be re-presented as current.
  assert.equal(resolveEffectivePolicy({}, authority({version: 4}), NOW).version, 4);
  assert.notEqual(resolveEffectivePolicy({}, authority({version: 4}), NOW).version, issued.version);
  // A wider device set than the authority holds is refused rather than intersected silently.
  assert.throws(() => policy({mode: 'TRUSTED_PERSONAL_FABRIC', allowedDevices: ['alien', 'ghost']}), {code: 'DEVICE_NOT_APPROVED'});
  assert.throws(() => policy({mode: 'TRUSTED_PERSONAL_FABRIC', dataScopes: ['PUBLIC', 'SECRET']}), {code: 'SCOPE_NOT_APPROVED'});
});

// Workbook sub-task 3: "策略未配置或不一致时保守fail-closed，legacy默认不改变".
test('PCF706-05 a missing or inconsistent policy fails closed and the legacy default is unchanged', () => {
  // Nothing configured at all: no version, no expiry, no devices, no scopes -> refusals, never a permissive default.
  assert.equal(refusal(() => policy({}, {})).code, 'AUTHORITY_VERSION');
  for (const version of [undefined, null, '3', 3.5, -1]) assert.equal(refusal(() => policy({}, authority({version}))).code, 'AUTHORITY_VERSION');
  for (const change of [{expiresAt: undefined}, {allowedDevices: undefined}, {dataScopes: undefined}, {allowedDevices: ['ok', '']}]) {
    assert.equal(refusal(() => policy({}, authority(change))).code, 'INVALID_AUTHORITY');
  }
  for (const clock of [undefined, NaN, -1]) assert.equal(refusal(() => resolveEffectivePolicy({}, authority(), clock)).code, 'INVALID_CLOCK');
  // An inconsistent combination is refused under its own name rather than resolved to something "close enough".
  assert.equal(refusal(() => policy({mode: 'APPROVED_CLOUD'}, authority({cloudConsent: false}))).code, 'CLOUD_NOT_APPROVED');
  assert.equal(refusal(() => policy({mode: 'APPROVED_CLOUD'}, authority({cloudConsent: true, budget: undefined}))).code, 'CLOUD_NOT_APPROVED');
  // A legacy caller that passes no mode keeps the original origin-only behaviour.
  const legacy = policy({}, authority({sharingConsent: false}));
  assert.equal(legacy.mode, 'ORIGIN_DEVICE_ONLY');
  assertPolicy(legacy, {deviceId: 'alien', dataScope: 'PUBLIC', fee: 0}, NOW);
  assert.throws(() => assertPolicy(legacy, {deviceId: 'mech', dataScope: 'PUBLIC', fee: 0}, NOW), {code: 'DEVICE_NOT_APPROVED'});
});

// Workbook acceptance: "零/未知预算不触发付费" and sub-task 4's "费用上限的单位、币种/计量和剩余额度不可混淆".
test('PCF706-06 a zero or unknown budget cannot trigger paid execution', () => {
  const free = policy({mode: 'TRUSTED_PERSONAL_FABRIC'});
  assert.equal(free.budget, 0);
  assertPolicy(free, {deviceId: 'alien', dataScope: 'PUBLIC', fee: 0}, NOW);
  // Any charge at all - including a malformed one - is refused when the allowance is zero.
  for (const fee of [0.01, 1, NaN, -1, '0', null]) {
    assert.equal(refusal(() => assertPolicy(free, {deviceId: 'alien', dataScope: 'PUBLIC', fee}, NOW)).code, 'BUDGET_NOT_APPROVED');
  }
  // Declaring the call remote/cloud does not create an allowance.
  assert.equal(refusal(() => assertPolicy(free, {deviceId: 'alien', dataScope: 'PUBLIC', fee: 0, cloud: true}, NOW)).code, 'CLOUD_NOT_APPROVED');
  // An unknown allowance is not "unlimited": the same rule applies.
  const unknown = policy({mode: 'TRUSTED_PERSONAL_FABRIC'}, authority({budget: undefined}));
  assert.equal(unknown.budget, 0);
  assert.equal(refusal(() => assertPolicy(unknown, {deviceId: 'alien', dataScope: 'PUBLIC', fee: 1}, NOW)).code, 'BUDGET_NOT_APPROVED');
  // With a real allowance the ceiling is exact and per call.
  const funded = policy({mode: 'APPROVED_CLOUD'}, authority({cloudConsent: true, budget: 5}));
  assert.equal(funded.budget, 5);
  assertPolicy(funded, {deviceId: 'alien', dataScope: 'PUBLIC', fee: 5}, NOW);
  assert.equal(refusal(() => assertPolicy(funded, {deviceId: 'alien', dataScope: 'PUBLIC', fee: 5.0001}, NOW)).code, 'BUDGET_NOT_APPROVED');
  // The offload decision refuses any transport cost at all: this project authorises no spend.
  assert.equal(chooseTransport({authorised: true, linkStable: true, transportCostMinor: 1, localAvailable: true}).reason, 'TRANSFER_COST');
  assert.equal(chooseTransport({authorised: true, linkStable: true, transportCostMinor: 0, transferBytes: 1024}).choice, 'OFFLOAD');
  assert.equal(MAX_COST_MINOR, 0);
  assert.match(refusal(() => assertScorerHealthy({confidence: 0.9, costMinor: 1})).code, /^SHIELD_COST_EXCEEDED/);
});

// Workbook spec rev 2: "共享许可、一次任务卸载许可、凭据使用、跨设备文件域及provider费用是不同的门；...不得相互推导授权".
test('PCF706-07 sharing, offload, data scope and provider spend are separate gates that cannot be inferred', () => {
  // Sharing granted, but the workload's data scope was never granted: still refused.
  const sharingOnly = policy({mode: 'TRUSTED_PERSONAL_FABRIC'}, authority({dataScopes: []}));
  assert.equal(sharingOnly.sharingConsent, true);
  assert.equal(refusal(() => assertPolicy(sharingOnly, {deviceId: 'mech', dataScope: 'PUBLIC', fee: 0}, NOW)).code, 'SCOPE_NOT_APPROVED');
  const narrowScope = policy({mode: 'TRUSTED_PERSONAL_FABRIC'}, authority({dataScopes: ['PUBLIC']}));
  assert.equal(refusal(() => assertPolicy(narrowScope, {deviceId: 'mech', dataScope: 'PERSONAL', fee: 0}, NOW)).code, 'SCOPE_NOT_APPROVED');
  // Cloud spend granted does NOT grant cross-device sharing ...
  const spendOnly = policy({mode: 'APPROVED_CLOUD'}, authority({sharingConsent: false, cloudConsent: true, budget: 10}));
  assert.equal(spendOnly.cloudConsent, true);
  assert.equal(spendOnly.sharingConsent, false);
  assert.equal(refusal(() => assertPolicy(spendOnly, {deviceId: 'mech', dataScope: 'PUBLIC', fee: 1}, NOW)).code, 'SHARING_NOT_APPROVED');
  assertPolicy(spendOnly, {deviceId: 'alien', dataScope: 'PUBLIC', fee: 1}, NOW);
  // ... and sharing granted does NOT grant spend: the allowance can be present while the cloud gate stays shut.
  const shareOnly = policy({mode: 'TRUSTED_PERSONAL_FABRIC'}, authority({budget: 10}));
  assert.equal(shareOnly.sharingConsent, true);
  assert.equal(shareOnly.budget, 10);
  assert.equal(refusal(() => assertPolicy(shareOnly, {deviceId: 'mech', dataScope: 'PUBLIC', fee: 1}, NOW)).code, 'CLOUD_NOT_APPROVED');
  // The offload decision keeps its own gate, and its local fallback must be DECLARED, never assumed.
  assert.equal(chooseTransport({authorised: false, localAvailable: true}).choice, 'LOCAL');
  assert.equal(chooseTransport({authorised: false, localAvailable: true}).reason, 'NOT_AUTHORISED');
  assert.equal(chooseTransport({authorised: false}).choice, 'REFUSED');
  assert.equal(chooseTransport({authorised: false}).localDeclared, false);
});

// Workbook acceptance: "日志无secret" plus sub-task 3's "拒绝cause可追溯，敏感值脱敏" and the closing sentence
// "直接控制的同意/拒绝/撤销和sharing策略必须经715真实UI接线后才作为用户能力发布".
test('PCF706-08 a refusal is traceable by code, secrets are redacted, and no consent control is published as live', () => {
  const denial = refusal(() => resolveEffectivePolicy({}, {}, NOW));
  assert.equal(denial.code, 'AUTHORITY_VERSION');
  assert.equal(denial.message, 'AUTHORITY_VERSION', 'the refusal carries its code and nothing that could leak a value');
  // The research trace is redacted BY KEY NAME, and the raw values never reach the event.
  const receipt = {version: 1, taskId: 'T1', actionId: 'A1', parentSessionId: 'S1', attemptId: 'X1', epoch: 1, executorDeviceId: 'mech', bootId: 'boot', providerId: 'cpu', inputDigest: 'a'.repeat(64), policyVersion: 3, outcome: 'SUCCEEDED', reservationId: 'R1', apiKey: 'sk-live-NOT-A-REAL-KEY', token: 'ghp_NOT_A_REAL_TOKEN', password: 'not-a-real-password', credentialRef: 'cred-NOT-A-REAL-REF'};
  const event = toResearchEvent(receipt, {observedAt: '2026-10-07T00:00:00.000Z', policyVersion: 3});
  const trace = JSON.stringify(event);
  for (const secret of ['sk-live-NOT-A-REAL-KEY', 'ghp_NOT_A_REAL_TOKEN', 'not-a-real-password', 'cred-NOT-A-REAL-REF']) {
    assert.ok(!trace.includes(secret), secret + ' must not appear in the research event');
  }
  assert.deepEqual(event.privacy.redactedKeys, ['apiKey', 'credentialRef', 'password', 'token']);
  assert.match(event.privacy.policy, /REDACTED_BY_NAME/);
  // Consent/revoke/sharing are NOT published as a user capability before the 715 UI wiring: the projection exposes
  // status only, and says so.
  const controls = buildFabricProjection({version: 1, reservations: [], attempts: []}, {backendConfigured: false}).controls;
  assert.deepEqual(Object.keys(controls).sort(), ['enabled', 'reason', 'scope']);
  assert.equal(controls.enabled, false);
  assert.equal(controls.reason, 'NOT_CONFIGURED');
  assert.equal(controls.scope, 'APPROVED_LOCAL_CPU_ONLY');
  assert.equal(buildFabricProjection({version: 1, reservations: [], attempts: []}, {backendConfigured: true}).sharingDoesNotImplyExecutionReadiness, true);
});

// Workbook sub-task 4: "明确硬约束冲突解释与可逆opt-out".
test('PCF706-09 an incompatible hard constraint is explained and the opt-out is reversible', () => {
  // A stage cannot be skipped, and a canary needs a named Owner approval with a bounded share.
  assert.throws(() => advancePolicyStage('OFFLINE_EVALUATED', 'ENABLED_REVERSIBLE'), {code: 'POLICY_STAGE_SKIPPED:OFFLINE_EVALUATED->ENABLED_REVERSIBLE'});
  assert.equal(refusal(() => advancePolicyStage('SHADOW_OBSERVED', 'CANARY_APPROVED')).code, 'CANARY_OWNER_APPROVAL_REQUIRED');
  assert.equal(refusal(() => advancePolicyStage('SHADOW_OBSERVED', 'CANARY_APPROVED', {ownerApprovalRef: 'owner:1', canaryShare: 0.9})).code, 'CANARY_SHARE_INVALID');
  const canary = advancePolicyStage('SHADOW_OBSERVED', 'CANARY_APPROVED', {ownerApprovalRef: 'owner:1', canaryShare: 0.25});
  assert.equal(canary.reversible, true);
  assert.equal(canary.rollbackTo, 'SHADOW_OBSERVED');
  // A held-out evaluation cannot be scored on its own training trace.
  assert.equal(refusal(() => evaluateHeldOut({trainingTrace: ['w1'], heldOutWorkloads: ['w1', 'w2'], score: () => 1})).code, 'TRAIN_TEST_OVERLAP:w1');
  // The opt-out is always available, needs no approval, and restores the proven deterministic order.
  const rolledBack = rollbackPolicy();
  assert.equal(rolledBack.enabled, false);
  assert.equal(rolledBack.revertedTo, 'DETERMINISTIC_FALLBACK');
});

// Workbook sub-task 3: "对dispatch、artifact transfer、executor start、result publish重验同意" - the artifact gate
// re-reads the authority on its own, and a revocation between the two gates leaves no task behind.
test('PCF706-10 consent is revalidated at artifact transfer, not only at submission', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pcf706-art-'));
  const store = new Store(dir);
  const context = {sessionId: 'session', deviceId: 'alien'};
  let calls = 0;
  const readAuthority = async caller => {
    calls += 1;
    return {version: 1, authorized: calls === 1 && caller.sessionId === context.sessionId && caller.deviceId === context.deviceId, expiresAt: Date.now() + 60000,
      originDeviceId: 'alien', allowedDevices: ['alien'], dataScopes: ['PUBLIC'], sharingConsent: false, cloudConsent: false, budget: 0};
  };
  const service = createFabricService({store, artifactRoot: join(dir, 'artifacts'), deviceId: 'alien', readAuthority});
  try {
    // The submission-time read succeeds; the authority is revoked before the input artifact is written.
    await assert.rejects(() => service.submit({appId: 'cpu-sum', idempotencyKey: 'k1', parentSessionId: 'session', input: {values: [1, 2]}}, context), {code: 'ARTIFACT_UNAUTHORIZED'});
    assert.ok(calls >= 2, 'the artifact gate read the authority independently of the submission gate');
    assert.equal(store.list('tasks').length, 0, 'a refusal at the artifact gate created no task');
    assert.equal(store.list('actions').length, 0);
  } finally { await service.stop(); store.db.close(); await rm(dir, {recursive: true, force: true}); }
});

// Workbook acceptance: "多请求竞争额度仍不越界" - there is no allowance ledger in PCF to enforce the aggregate.
test('PCF706 acceptance: concurrent requests competing for one allowance cannot exceed it', {skip: 'NOT_IMPLEMENTED: PCF-706 验收 "多请求竞争额度仍不越界" - policy.mjs is a pure resolver: it re-derives budget from the authority facts on every call and keeps no remaining-allowance state, and assertPolicy checks each request against the full budget (fee<=policy.budget), so two concurrent requests each claiming the whole allowance are both authorised; aggregate non-exceedance is not enforced anywhere in the PCF modules.'}, () => {
  assert.fail('a spend ledger must refuse the second concurrent claim once the allowance is committed');
});
