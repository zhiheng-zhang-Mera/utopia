// GAI-001 conformance suite — General AI Gateway core contracts and action vocabulary.
//
// Covers the workbook's acceptance lines: legacy routes stay backward-compatible; GENERAL_AI has
// stable typed backend/provenance references; malformed/unknown route/state/version is refused
// rather than guessed; idempotency-key reuse for a different request is refused; partial output
// cannot mark an Action terminal; no schema carries raw credential bytes; and the repository
// runtime has no dependency on the historical product.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
 ACTION_IN_FLIGHT_STATUSES, ACTION_ROUTES_V1, ACTION_STATUSES, ACTION_TERMINAL_STATUSES,
 ATTENTION_KINDS, BUDGET_DECISIONS, CHANNELS, GAI_CONTRACT_VERSION, GAI_ERROR_CODES,
 GAI_PORT_CONTRACTS, GENERAL_AI_GATEWAY_CONTRACT, GENERAL_AI_ROUTE, GeneralAiGatewayError,
 JEV_TRIAGE_PORT, LEGACY_ACTION_ROUTES, ROUTING_OUTCOMES, ROUTING_PRIORITY,
 applyApiEscalation, applyDeviceSwitch, asAdvisoryAssessment, assessWithJevTriage,
 assertActionRoute, attentionForDecision, checkIdempotentReuse, createDeterministicJevTriageDouble,
 createDeterministicRemoteExecutionDouble, decideRoute, describeGaiPort, fingerprintGeneralAiRequest,
 findRawSecretFields, nextActionStatus, probeGaiPortConformance, scanForForbiddenProductDependency,
 validateActionRoute, validateApiSwitchProposal, validateAttentionRequest, validateConversation,
 validateDeviceSwitchProposal, validateEscalationReceipt, validateGeneralAiRequest,
 validateInputBundle, validateModelDescriptor, validatePartialResult, validateProviderAccount,
 validateProviderDescriptor, validateResultEnvelope, validateUsageRecord
} from '../index.mjs';
import { ACTION_ROUTES as GATEWAY_ACTION_ROUTES, ACTION_STATUSES as GATEWAY_ACTION_STATUSES } from '../../../services/dev-gateway/actions.mjs';

const TS = '2026-09-30T12:00:00.000Z';
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

const baseRequest = (overrides = {}) => ({
  contract_version: GAI_CONTRACT_VERSION,
  route: GENERAL_AI_ROUTE,
  request_id: 'request-1',
  action_id: null,
  channel: 'WEB',
  provider_ref: null,
  model_ref: null,
  account_ref: null,
  conversation_id: null,
  input_bundle: { text: 'summarise this', files: [], images: [], references: [], contextRefs: [] },
  interaction_device_ref: 'mech-android',
  execution_device_ref: null,
  idempotency_key: 'key-1',
  requested_at: TS,
  ...overrides,
});

/* ------------------------------------------------- 1. route vocabulary */

test('GENERAL_AI is reserved as a user-level route and the legacy routes are untouched', () => {
  assert.deepEqual([...ACTION_ROUTES_V1], ['ROOM', 'CAPABILITY', 'CITY_TASK', 'GENERAL_AI']);
  assert.deepEqual([...LEGACY_ACTION_ROUTES], ['ROOM', 'CAPABILITY', 'CITY_TASK']);
  for (const route of LEGACY_ACTION_ROUTES) assert.equal(validateActionRoute(route).ok, true, route);
  assert.equal(validateActionRoute(GENERAL_AI_ROUTE).ok, true);
  assert.equal(assertActionRoute(GENERAL_AI_ROUTE), GENERAL_AI_ROUTE);
  assert.equal(GENERAL_AI_GATEWAY_CONTRACT.default_channel, 'WEB');
  assert.equal(GENERAL_AI_GATEWAY_CONTRACT.interaction_device_may_differ_from_execution_device, true);
});

test('a historical product name is not a route, and an unknown route is refused not guessed', () => {
  const forbidden = expectCode(() => assertActionRoute('BOSS'), 'FORBIDDEN_ROUTE');
  assert.equal(forbidden.detail.includes('historical product name'), true);
  assert.equal(validateActionRoute('boss').ok, false);
  assert.equal(validateActionRoute('Codex-Boss').ok, false);
  assert.equal(expectCode(() => assertActionRoute('SUPER_AI'), 'INVALID_ROUTE').code, 'INVALID_ROUTE');
  assert.equal(validateActionRoute('').ok, false);
  assert.equal(validateActionRoute(null).ok, false);
});

test('the gateway route vocabulary is exactly the contract vocabulary', () => {
  assert.deepEqual([...GATEWAY_ACTION_ROUTES].sort(), [...ACTION_ROUTES_V1].sort());
  assert.deepEqual([...GATEWAY_ACTION_STATUSES].sort(), [...ACTION_STATUSES].sort());
});

/* ------------------------------------------------- 2. envelopes */

test('a canonical general-AI request validates and keeps typed backend references', () => {
  assert.deepEqual(validateGeneralAiRequest(baseRequest()), { ok: true, errors: [] });
  const routed = baseRequest({ provider_ref: 'provider-1', model_ref: 'model-1', account_ref: 'account-1', conversation_id: 'conversation-1', execution_device_ref: 'alien-web' });
  assert.deepEqual(validateGeneralAiRequest(routed), { ok: true, errors: [] });
  // interaction device may differ from execution device
  assert.notEqual(routed.interaction_device_ref, routed.execution_device_ref);
});

test('unknown version, channel, state and malformed input are refused', () => {
  assert.equal(validateGeneralAiRequest(baseRequest({ contract_version: 2 })).ok, false);
  assert.equal(validateGeneralAiRequest(baseRequest({ channel: 'TELEPATHY' })).ok, false);
  assert.equal(validateGeneralAiRequest(baseRequest({ route: 'ROOM' })).ok, false);
  assert.equal(validateGeneralAiRequest(baseRequest({ mood: 'happy' })).ok, false);
  assert.equal(validateGeneralAiRequest(baseRequest({ input_bundle: { text: 'x' } })).ok, false);
  assert.equal(validateInputBundle({ text: 'x', files: [], images: [], references: [], contextRefs: [] }).ok, true);
  assert.equal(validateInputBundle({ text: 'x', files: [], images: [], references: [], contextRefs: [], extra: 1 }).ok, false);
  expectCode(() => nextActionStatus('NOT_A_STATUS', { status: 'RUNNING' }), 'UNKNOWN_STATUS');
  expectCode(() => nextActionStatus('RUNNING', { status: 'PROBABLY_DONE' }), 'UNKNOWN_STATUS');
});

test('no canonical envelope may carry raw credential, cookie or token bytes', () => {
  const withSecret = baseRequest({ credential: 'raw-cookie-bytes' });
  const verdict = validateGeneralAiRequest(withSecret);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.errors.some(error => error.includes('raw secret')), true);
  assert.deepEqual(findRawSecretFields({ credential_ref: 'handle://1', access_token: 'x' }, ''), ['.access_token']);
  assert.deepEqual(findRawSecretFields({ credential_ref: 'handle://1', session_handle: 'h' }, ''), []);
  // handles are the supported shape everywhere a credential is referenced
  assert.equal(validateProviderDescriptor({ contract_version: 1, provider_ref: 'p', display_name: 'P', channels: ['WEB'], auth_status: 'AUTHENTICATED', health: 'HEALTHY', credential_ref: 'handle://1' }).ok, true);
  assert.equal(validateProviderDescriptor({ contract_version: 1, provider_ref: 'p', display_name: 'P', channels: ['WEB'], auth_status: 'AUTHENTICATED', health: 'HEALTHY', credential_ref: null }).ok, true);
  assert.equal(validateProviderDescriptor({ contract_version: 1, provider_ref: 'p', display_name: 'P', channels: ['WEB'], auth_status: 'AUTHENTICATED', health: 'HEALTHY', api_key: 'raw' }).ok, false);
  assert.equal(validateProviderAccount({ contract_version: 1, account_ref: 'a', provider_ref: 'p', credential_ref: 'handle://1', status: 'AUTHENTICATED', created_at: TS }).ok, true);
  assert.equal(validateConversation({ contract_version: 1, conversation_id: 'c', provider_ref: 'p', model_ref: 'm', backend_thread_ref: 'handle://thread', created_at: TS, updated_at: TS }).ok, true);
});

test('provider, model, attention, usage and proposal envelopes validate strictly', () => {
  assert.equal(validateModelDescriptor({ contract_version: 1, model_ref: 'm', provider_ref: 'p', display_name: 'M', capabilities: ['text'], context_window: 128000 }).ok, true);
  assert.equal(validateModelDescriptor({ contract_version: 1, model_ref: 'm', provider_ref: 'p', display_name: 'M', capabilities: ['text'], context_window: 'big' }).ok, false);
  assert.equal(validateAttentionRequest({ contract_version: 1, attention_id: 'a-1', action_id: 'A-1', kind: 'USER_CONFIRMATION', question: 'Use API?', blocking: true, created_at: TS }).ok, true);
  assert.equal(validateAttentionRequest({ contract_version: 1, attention_id: 'a-1', action_id: 'A-1', kind: 'RING_LOUDLY', question: 'Use API?', blocking: true, created_at: TS }).ok, false);
  assert.equal(validateUsageRecord({ contract_version: 1, usage_ref: 'u-1', action_id: 'A-1', channel: 'API', provider_ref: 'p', input_tokens: 10, output_tokens: 20, cost_micros: 5, recorded_at: TS }).ok, true);
  assert.equal(validateDeviceSwitchProposal({ contract_version: 1, proposal_ref: 'p-1', action_id: 'A-1', from_device_ref: 'mech-android', to_device_ref: 'alien-web', reason: 'local blocked', requires_user_confirmation: true, created_at: TS }).ok, true);
  assert.equal(validateDeviceSwitchProposal({ contract_version: 1, proposal_ref: 'p-1', action_id: 'A-1', from_device_ref: 'mech-android', to_device_ref: 'alien-web', reason: 'local blocked', requires_user_confirmation: false, created_at: TS }).ok, false);
  assert.equal(validateApiSwitchProposal({ contract_version: 1, proposal_ref: 'p-2', action_id: 'A-1', from_channel: 'WEB', to_channel: 'API', reason: 'web unavailable', requires_user_confirmation: true, budget_ref: null, created_at: TS }).ok, true);
  assert.equal(validateEscalationReceipt({ contract_version: 1, receipt_ref: 'r-1', action_id: 'A-1', from_channel: 'WEB', to_channel: 'API', confirmed_by_ref: 'owner', confirmed_at: TS, budget_decision: 'APPROVED' }).ok, true);
  assert.equal(validateEscalationReceipt({ contract_version: 1, receipt_ref: 'r-1', action_id: 'A-1', from_channel: 'API', to_channel: 'API', confirmed_by_ref: 'owner', confirmed_at: TS, budget_decision: 'APPROVED' }).ok, false);
  assert.deepEqual(BUDGET_DECISIONS, ['APPROVED', 'REJECTED', 'NOT_EVALUATED']);
  assert.deepEqual(CHANNELS, ['WEB', 'API']);
  assert.equal(ATTENTION_KINDS.includes('USER_CONFIRMATION'), true);
});

/* ------------------------------------------------- 3. status rules */

test('partial output cannot mark an Action terminal and terminal status is final', () => {
  assert.equal(nextActionStatus('QUEUED', { status: 'RUNNING', source: 'CHANNEL' }), 'RUNNING');
  assert.equal(nextActionStatus('RUNNING', { status: 'WAITING_CONFIRMATION', source: 'CHANNEL' }), 'WAITING_CONFIRMATION');
  for (const terminal of ACTION_TERMINAL_STATUSES) {
    expectCode(() => nextActionStatus('RUNNING', { status: terminal, source: 'PARTIAL' }), 'PARTIAL_RESULT_CANNOT_COMPLETE');
  }
  expectCode(() => nextActionStatus('SUCCEEDED', { status: 'RUNNING', source: 'CHANNEL' }), 'TERMINAL_STATUS_IS_FINAL');
  expectCode(() => nextActionStatus('CANCELLED', { status: 'SUCCEEDED', source: 'CHANNEL' }), 'TERMINAL_STATUS_IS_FINAL');
  assert.equal(validatePartialResult({ contract_version: 1, action_id: 'A-1', sequence: 1, delta: 'partial', status: 'RUNNING', at: TS }).ok, true);
  assert.equal(validatePartialResult({ contract_version: 1, action_id: 'A-1', sequence: 1, delta: 'partial', status: 'SUCCEEDED', at: TS }).ok, false);
  assert.deepEqual([...ACTION_IN_FLIGHT_STATUSES], ['QUEUED', 'RUNNING', 'WAITING_CONFIRMATION']);
});

test('a partial result carries in-flight status and a result envelope carries a terminal one', () => {
  const partial = validatePartialResult({ contract_version: 1, action_id: 'A-1', sequence: 2, delta: 'more', status: 'RUNNING', at: TS });
  assert.equal(partial.ok, true);
  const result = validateResultEnvelope({
    contract_version: 1, action_id: 'A-1', status: 'SUCCEEDED', output: 'done', usage_ref: 'u-1',
    provenance: { source: 'web-channel', provider_ref: 'p', model_ref: 'm', channel: 'WEB' }, completed_at: TS,
  });
  assert.equal(result.ok, true, result.errors.join(' | '));
  assert.equal(validateResultEnvelope({ contract_version: 1, action_id: 'A-1', status: 'RUNNING', output: null, usage_ref: null, provenance: { source: 's', provider_ref: null, model_ref: null, channel: 'WEB' }, completed_at: TS }).ok, false);
});

/* ------------------------------------------------- 4. idempotency */

test('an idempotency key replayed for the same request returns the first result', () => {
  const request = baseRequest();
  const fingerprint = fingerprintGeneralAiRequest(request);
  const existing = { action_id: 'A-1', status: 'RUNNING', request_fingerprint: fingerprint };
  assert.deepEqual(checkIdempotentReuse(existing, request), { replayed: true, actionId: 'A-1', status: 'RUNNING' });
  assert.deepEqual(checkIdempotentReuse(null, request), { replayed: false });
  // key order must not matter
  const reordered = { ...request, input_bundle: { contextRefs: [], references: [], images: [], files: [], text: 'summarise this' } };
  assert.equal(fingerprintGeneralAiRequest(reordered), fingerprint);
});

test('the same idempotency key bound to a different request is refused', () => {
  const existing = { action_id: 'A-1', status: 'RUNNING', request_fingerprint: fingerprintGeneralAiRequest(baseRequest()) };
  const error = expectCode(() => checkIdempotentReuse(existing, baseRequest({ input_bundle: { text: 'a different ask', files: [], images: [], references: [], contextRefs: [] } })), 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(error.status, 400);
  expectCode(() => checkIdempotentReuse(existing, baseRequest({ channel: 'API' })), 'IDEMPOTENCY_KEY_REUSED');
});

/* ------------------------------------------------- 5. routing policy */

test('a deterministic local answer never reaches a general-AI channel', () => {
  const decision = decideRoute({ localResult: { answer: 'hash computed' }, webAvailableOnCurrentDevice: true });
  assert.equal(decision.outcome, 'LOCAL_RESULT');
  assert.equal(decision.priority, 'DETERMINISTIC_LOCAL');
  assert.equal(decision.channel, null);
  assert.equal(decision.requiresUserConsent, false);
});

test('Web is the default channel and JEV failure degrades instead of blocking', () => {
  const web = decideRoute({ webAvailableOnCurrentDevice: true });
  assert.equal(web.outcome, 'WEB_SUBMIT');
  assert.equal(web.channel, 'WEB');
  assert.equal(web.requiresUserConsent, false);
  const degraded = decideRoute({ webAvailableOnCurrentDevice: true, jev: { degraded: true } });
  assert.equal(degraded.outcome, 'WEB_SUBMIT');
  assert.equal(degraded.jevDegraded, true);
  assert.equal(degraded.reason, 'JEV_UNAVAILABLE_DEGRADED');
});

test('Web failure does not silently trigger API, and API needs explicit user consent', () => {
  const proposed = decideRoute({ lastWebAttemptFailed: true, apiAvailable: true });
  assert.equal(proposed.outcome, 'PROPOSE_API_SWITCH');
  assert.equal(proposed.reason, 'WEB_FAILED_CONSENT_REQUIRED');
  assert.equal(proposed.requiresUserConsent, true);
  assert.equal(proposed.channel, null, 'no channel is chosen before consent');
  const noApi = decideRoute({ lastWebAttemptFailed: true, apiAvailable: false });
  assert.equal(noApi.outcome, 'REFUSED');
  assert.equal(noApi.reason, 'NO_CHANNEL_AVAILABLE');
  const consentNeeded = decideRoute({ apiAvailable: true });
  assert.equal(consentNeeded.outcome, 'PROPOSE_API_SWITCH');
  assert.equal(consentNeeded.reason, 'API_CONSENT_REQUIRED');
});

test('budget policy runs after consent and can never substitute for it', () => {
  const awaitingBudget = decideRoute({ apiAvailable: true, userConfirmedApi: true, budgetDecision: 'NOT_EVALUATED' });
  assert.equal(awaitingBudget.outcome, 'AWAIT_BUDGET_DECISION');
  assert.equal(awaitingBudget.priority, 'BUDGET_POLICY');
  const rejected = decideRoute({ apiAvailable: true, userConfirmedApi: true, budgetDecision: 'REJECTED' });
  assert.equal(rejected.outcome, 'REFUSED');
  assert.equal(rejected.reason, 'BUDGET_REJECTED');
  const admitted = decideRoute({ apiAvailable: true, userConfirmedApi: true, budgetDecision: 'APPROVED', budgetRef: 'budget-1' });
  assert.equal(admitted.outcome, 'API_SUBMIT');
  assert.equal(admitted.channel, 'API');
  assert.equal(admitted.budgetRef, 'budget-1');
  // budget approval without consent never reaches API execution
  const approvedNoConsent = decideRoute({ apiAvailable: true, budgetDecision: 'APPROVED' });
  assert.equal(approvedNoConsent.outcome, 'PROPOSE_API_SWITCH');
  assert.equal(GENERAL_AI_GATEWAY_CONTRACT.budget_approval_substitutes_for_consent, false);
});

test('another device is proposed, never chosen, and the interaction device does not move', () => {
  const proposal = decideRoute({ webAvailableOnOtherDevice: true, otherDeviceRef: 'alien-web' });
  assert.equal(proposal.outcome, 'PROPOSE_OTHER_DEVICE');
  assert.equal(proposal.requiresUserConsent, true);
  assert.equal(proposal.targetDeviceRef, 'alien-web');
  // presence on another device without a usable reference is not enough
  assert.equal(decideRoute({ webAvailableOnOtherDevice: true }).outcome, 'REFUSED');
  expectCode(() => applyDeviceSwitch({ action_id: 'A-1', to_device_ref: 'alien-web', from_device_ref: 'mech-android', requires_user_confirmation: true }), 'USER_CONSENT_REQUIRED');
  const applied = applyDeviceSwitch({ action_id: 'A-1', to_device_ref: 'alien-web', from_device_ref: 'mech-android', requires_user_confirmation: true }, { confirmedByRef: 'owner', confirmedAt: TS });
  assert.equal(applied.execution_device_ref, 'alien-web');
  assert.equal(applied.interaction_device_ref, 'mech-android');
  assert.equal(applied.interaction_follows_execution, false);
});

test('API escalation requires a user confirmation reference, not a budget decision', () => {
  const proposal = { action_id: 'A-1', requires_user_confirmation: true };
  expectCode(() => applyApiEscalation(proposal, { budgetDecision: 'APPROVED' }), 'USER_CONSENT_REQUIRED');
  expectCode(() => applyApiEscalation(proposal, { confirmedByRef: 'owner', confirmedAt: TS, budgetDecision: 'REJECTED' }), 'BUDGET_REJECTED');
  const receipt = applyApiEscalation(proposal, { confirmedByRef: 'owner', confirmedAt: TS, budgetDecision: 'APPROVED' });
  assert.equal(receipt.to_channel, 'API');
  assert.equal(receipt.confirmed_by_ref, 'owner');
  assert.equal(receipt.budget_decision, 'APPROVED');
  assert.equal(validateEscalationReceipt(receipt).ok, true);
});

test('a decision that needs the user becomes an attention request', () => {
  const consent = attentionForDecision(decideRoute({ apiAvailable: true }), { actionId: 'A-1', question: 'Use the API?', createdAt: TS });
  assert.equal(consent.kind, 'USER_CONFIRMATION');
  assert.equal(consent.blocking, true);
  assert.equal(validateAttentionRequest(consent).ok, true);
  const budget = attentionForDecision(decideRoute({ apiAvailable: true, userConfirmedApi: true }), { actionId: 'A-1', question: 'Budget?', createdAt: TS });
  assert.equal(budget.kind, 'BUDGET_APPROVAL');
  const refused = attentionForDecision(decideRoute({ apiAvailable: false }), { actionId: 'A-1', question: 'No channel', createdAt: TS });
  assert.equal(refused.kind, 'PROVIDER_UNAVAILABLE');
  assert.equal(refused.blocking, false);
  expectCode(() => attentionForDecision(decideRoute({ webAvailableOnCurrentDevice: true }), { actionId: 'A-1', question: 'x', createdAt: TS }), 'MALFORMED_ENVELOPE');
  assert.equal(ROUTING_OUTCOMES.includes('AWAIT_BUDGET_DECISION'), true);
  assert.deepEqual([...ROUTING_PRIORITY][0], 'DETERMINISTIC_LOCAL');
  assert.deepEqual([...ROUTING_PRIORITY].at(-1), 'API_EXECUTION');
});

/* ------------------------------------------------- 6. advisory JEV */

test('JEV output is advisory and a JEV failure degrades instead of blocking', () => {
  assert.equal(JEV_TRIAGE_PORT.can_execute, false);
  assert.equal(JEV_TRIAGE_PORT.can_grant_permission, false);
  const double = createDeterministicJevTriageDouble({ assessments: { hard: { intent: 'hard', complexity: 'HARD', risk: 'HIGH', routeRecommendation: 'API_SWITCH_PROPOSAL', confidence: 0.9, needsGeneralAI: true, preferredChannel: 'API' } } });
  const advisory = assessWithJevTriage(double, { input_bundle: { text: 'hard' } });
  assert.equal(advisory.degraded, false);
  assert.equal(advisory.assessment.advisory, true);
  assert.equal(advisory.assessment.grantedAuthority, false);
  assert.equal(advisory.assessment.executedAnything, false);
  // a confident HIGH risk recommendation still cannot execute or authorise anything
  const decision = decideRoute({ webAvailableOnCurrentDevice: false, apiAvailable: true, jev: advisory });
  assert.equal(decision.outcome, 'PROPOSE_API_SWITCH');
  assert.equal(decision.requiresUserConsent, true);
  const failing = assessWithJevTriage(createDeterministicJevTriageDouble({ failure: 'JEV_TIMEOUT' }), {});
  assert.equal(failing.degraded, true);
  assert.equal(failing.reason, 'JEV_FAILED:JEV_TIMEOUT');
  assert.equal(assessWithJevTriage(null, {}).degraded, true);
  assert.equal(assessWithJevTriage({ assess: () => null }, {}).reason, 'JEV_RETURNED_NOTHING');
  expectCode(() => asAdvisoryAssessment({ intent: 'x', complexity: 'IMPOSSIBLE', risk: 'LOW', confidence: 0.5, needsGeneralAI: true }), 'MALFORMED_ENVELOPE');
});

/* ------------------------------------------------- 7. ports */

test('programme ports are versioned, and non-conforming subjects are refused', () => {
  const remote = createDeterministicRemoteExecutionDouble();
  assert.deepEqual(probeGaiPortConformance('RemoteExecutionPort', remote), { ok: true, port: 'RemoteExecutionPort', version: 1, missing: [], nonFunctions: [], extensions: [] });
  const partial = { dispatch: async () => ({}) };
  const probe = probeGaiPortConformance('RemoteExecutionPort', partial);
  assert.equal(probe.ok, false);
  assert.equal(probe.missing.includes('listCandidateEndpoints'), true);
  assert.equal(probeGaiPortConformance('GeneralAiGatewayPort', { ...Object.fromEntries(GAI_PORT_CONTRACTS.GeneralAiGatewayPort.map(method => [method, () => {}])) }).ok, true);
  assert.equal(describeGaiPort('GeneralAiGatewayPort').transportNeutral, true);
  assert.equal(describeGaiPort('JevTriagePort').providerNeutral, true);
  expectCode(() => describeGaiPort('TurboPort'), 'MALFORMED_ENVELOPE');
});

test('the deterministic remote double never fakes a completed run', async () => {
  const endpoint = { endpoint_ref: 'alien-web', device_ref: 'alien', readiness: 'READY' };
  const double = createDeterministicRemoteExecutionDouble({ endpoints: [endpoint], script: [{ status: 'RUNNING', delta: 'partial' }, { status: 'SUCCEEDED', delta: 'final' }] });
  assert.deepEqual(await double.listCandidateEndpoints(), [endpoint]);
  assert.deepEqual(await double.dispatch('A-1', baseRequest()), { actionId: 'A-1', dispatched: true });
  assert.equal((await double.subscribe('A-1')).status, 'RUNNING');
  assert.equal((await double.subscribe('A-1')).status, 'SUCCEEDED');
  assert.deepEqual(await double.cancel('A-1'), { actionId: 'A-1', cancelled: true });
  assert.deepEqual(await double.requestAttention('A-1', { attention_id: 'att-1' }), { actionId: 'A-1', attentionId: 'att-1', delivered: true });
  await assert.rejects(() => double.subscribe('unknown'), error => error.code === 'MALFORMED_ENVELOPE');
});

/* ------------------------------------------------- 8. no historical dependency */

test('the repository carries no runtime dependency on the historical product', () => {
  const root = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  const skip = new Set(['node_modules', '.git', '.mission-book', '.runtime', 'build', 'dist']);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walk(full); continue; }
      if (!/\.(?:mjs|cjs|js|json|ya?ml|gradle|kts|ps1)$/i.test(entry)) continue;
      if (entry === 'package-lock.json' || entry === 'pnpm-lock.yaml') continue;
      files.push({ path: full.replace(root, '').replace(/\\/g, '/'), text: readFileSync(full, 'utf8') });
    }
  };
  for (const dir of ['contracts', 'services', 'apps', 'platform', 'scripts', 'tests', 'city']) walk(join(root, dir));
  files.push({ path: 'package.json', text: readFileSync(join(root, 'package.json'), 'utf8') });
  assert.equal(files.length > 50, true, `the scan actually walked source files (${files.length})`);
  assert.deepEqual(scanForForbiddenProductDependency(files), []);
  // the scanner does detect real linkage, so the empty result above is not vacuous.
  // The product token is composed at runtime so this suite is itself scan-clean.
  const PRODUCT = 'boss';
  const positives = [
    [{ path: 'services/example.mjs', text: `import x from '${PRODUCT}-client';\n` }, 'MODULE_IMPORT'],
    [{ path: 'package.json', text: `{"dependencies":{"codex-${PRODUCT}":"^1.0.0"}}` }, 'PACKAGE_DEPENDENCY'],
    [{ path: 'package.json', text: `{"devDependencies":{"@scope/${PRODUCT}-sdk":"1.0.0"}}` }, 'PACKAGE_DEPENDENCY'],
    [{ path: 'package.json', text: `{"workspaces":["packages/${PRODUCT}-cli"]}` }, 'REPO_LINKAGE'],
    [{ path: 'services/example.mjs', text: `spawn('codex-${PRODUCT}', [])\n` }, 'PROCESS_OR_ENDPOINT'],
    [{ path: 'services/example.mjs', text: `const url = 'https://github.com/example/codex-${PRODUCT}';\n` }, 'HOST_REFERENCE'],
    [{ path: 'services/example.mjs', text: `require('./vendor/${PRODUCT}-client')\n` }, 'MODULE_IMPORT'],
    [{ path: 'scripts/setup.ps1', text: `git submodule add example/${PRODUCT} tools/${PRODUCT}` }, 'REPO_LINKAGE'],
  ];
  for (const [file, rule] of positives) {
    const found = scanForForbiddenProductDependency([file]);
    assert.equal(found.length, 1, JSON.stringify(file));
    assert.equal(found[0].rule, rule, JSON.stringify(file));
  }
  // prose, comments and the detector's own vocabulary are not dependencies
  assert.deepEqual(scanForForbiddenProductDependency([{ path: 'docs/notes.md', text: `Codex-${PRODUCT} is a tombstone` }]), []);
  assert.deepEqual(scanForForbiddenProductDependency([{ path: 'services/example.mjs', text: `// ${PRODUCT.toUpperCase()} is not a route\nconst FORBIDDEN = /${PRODUCT}/i;\n` }]), []);
  assert.deepEqual(scanForForbiddenProductDependency([{ path: 'services/example.mjs', text: 'const note = "a historical product name is not a dependency";\n' }]), []);
  // a provenance manifest that *describes* a past donor is a record, not a dependency edge
  const donor = `{"module":"task-lifecycle","donor":{"commit":"abc","repository":"https://github.com/example/other"},"notes":["the donor's TaskStatus/${PRODUCT}Task runtime vocabulary"],"files":{"tests/donor-${PRODUCT}/recovery-model.test.mjs":"22 tests from Codex-${PRODUCT} tests/unit/recovery-model.test.ts"}}`;
  assert.deepEqual(scanForForbiddenProductDependency([{ path: 'city/00-foundation/01-city-core/task-lifecycle/DONOR.json', text: donor }]), []);
});

/* ------------------------------------------------- 9. contract surface */

test('the contract publishes its routing guarantees and error vocabulary', () => {
  assert.equal(GENERAL_AI_GATEWAY_CONTRACT.user_level_route, 'GENERAL_AI');
  assert.equal(GENERAL_AI_GATEWAY_CONTRACT.forbidden_route, 'BOSS');
  assert.equal(GENERAL_AI_GATEWAY_CONTRACT.api_channel_requires_user_consent, true);
  assert.equal(GENERAL_AI_GATEWAY_CONTRACT.jev_is_advisory_only, true);
  assert.equal(GENERAL_AI_GATEWAY_CONTRACT.raw_secrets_in_canonical_state, false);
  assert.equal(GAI_ERROR_CODES.includes('PARTIAL_RESULT_CANNOT_COMPLETE'), true);
  assert.equal(GAI_ERROR_CODES.includes('IDEMPOTENCY_KEY_REUSED'), true);
  assert.equal(GAI_ERROR_CODES.includes('FORBIDDEN_ROUTE'), true);
  assert.equal(new Set(GAI_ERROR_CODES).size, GAI_ERROR_CODES.length);
  assert.equal(new GeneralAiGatewayError('X', 'y').status, 400);
});
