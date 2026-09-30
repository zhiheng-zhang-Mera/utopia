// BA-005 conformance suite — Digital-Me context gateway.
//
// Acceptance: different assistants receive different authorized scopes from the same Digital-Me; a denied
// scope returns a typed refusal with no partial leakage; assistant profile/relationship changes never
// change canonical records; a private/audience-restricted fact is not surfaced through another audience
// without disclosure authorization; device-ephemeral context disappears and rebuilds without corrupting
// durable assistant memory; and scope allow/deny, audience boundary, absence, staleness, provenance and
// cross-assistant isolation are all covered.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 AUDIENCES, AUDIENCE_VISIBILITY, DIGITAL_ME_GATEWAY_CONTRACT, DIGITAL_ME_PORT, DigitalMeError,
 FORBIDDEN_CANONICAL_FIELDS, MEMORY_SCOPES, QUERY_PURPOSES, createDigitalMeGateway,
 createDigitalMePortDouble, findForbiddenCanonicalFields, rebuildDeviceEphemeralContext, validateRecord
} from '../index.mjs';

const T0 = Date.parse('2026-09-30T12:00:00.000Z');
const ISO = ms => new Date(ms).toISOString();
const TTL = 60_000;
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

const record = (overrides = {}) => ({
  record_id: 'record-1',
  scope: 'USER_GLOBAL_CANONICAL',
  audience: 'OWNER_PRIVATE',
  fact_ref: 'fact-time-format',
  value_ref: 'value-1',
  sensitivity: 'NORMAL',
  observed_at: ISO(T0),
  ttl_ms: TTL,
  disclosure_authorized: false,
  ...overrides,
});

const records = () => [
  record(),
  record({ record_id: 'record-2', fact_ref: 'fact-private-note', scope: 'ASSISTANT_PRIVATE', audience: 'OWNER_PRIVATE', value_ref: 'value-2' }),
  record({ record_id: 'record-3', fact_ref: 'fact-shared-project', scope: 'PROJECT_TASK', audience: 'SHARED_DEVICE', value_ref: 'value-3', disclosure_authorized: true }),
  record({ record_id: 'record-4', fact_ref: 'fact-public-pref', scope: 'AUDIENCE_CHANNEL', audience: 'PUBLIC_CHANNEL', value_ref: 'value-4' }),
  record({ record_id: 'record-5', fact_ref: 'fact-device-scratch', scope: 'DEVICE_EPHEMERAL', audience: 'OWNER_PRIVATE', value_ref: 'value-5' }),
];

const policy = {
  policy_ref: 'policy-1',
  assistants: {
    'assistant-butler': { scopes: ['USER_GLOBAL_CANONICAL', 'ASSISTANT_PRIVATE', 'PROJECT_TASK', 'DEVICE_EPHEMERAL'], purposes: ['ANSWER_USER', 'PLAN_TASK'], audiences: AUDIENCES, allow_values: true },
    'assistant-companion': { scopes: ['ASSISTANT_PRIVATE'], purposes: ['ANSWER_USER'], audiences: ['OWNER_PRIVATE'], allow_values: false },
    'assistant-guest': { scopes: ['AUDIENCE_CHANNEL'], purposes: ['ANSWER_USER'], audiences: ['PUBLIC_CHANNEL'], allow_values: false },
  },
};

const gatewayAt = (clockMs = T0) => {
  const port = createDigitalMePortDouble({ records: records(), values: { 'value-1': 'value-for-value-1', 'value-2': 'private-note', 'value-3': 'shared-project', 'value-4': 'public-pref', 'value-5': 'device-scratch' } });
  return { port, gateway: createDigitalMeGateway({ port, policy, clock: () => clockMs }) };
};
const ALL = ['USER_GLOBAL_CANONICAL', 'ASSISTANT_PRIVATE', 'PROJECT_TASK', 'DEVICE_EPHEMERAL'];

/* ------------------------------------------------ 1. different assistants, different scopes */

test('different assistants receive different authorized scopes from the same Digital-Me', () => {
  const { gateway } = gatewayAt();
  const butler = gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ALL });
  const companion = gateway.query({ assistantRef: 'assistant-companion', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['ASSISTANT_PRIVATE', 'USER_GLOBAL_CANONICAL'] });
  assert.equal(butler.granted, true);
  assert.equal(companion.granted, false, 'the companion is not authorized for the canonical scope');
  assert.equal(companion.code, 'SCOPE_DENIED');
  assert.equal(butler.projection.facts.length >= 2, true);
  // the companion still gets its own authorized scope, and sees nothing from the canonical one
  const companionOnly = gateway.query({ assistantRef: 'assistant-companion', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['ASSISTANT_PRIVATE'] });
  assert.deepEqual(companionOnly.projection.facts.map(fact => fact.fact_ref), ['fact-private-note']);
  assert.equal(companionOnly.projection.facts.every(fact => fact.scope === 'ASSISTANT_PRIVATE'), true);
  assert.equal(gateway.policyRef(), 'policy-1');
});

test('a denied scope is a typed refusal with no partial leakage', () => {
  const { gateway } = gatewayAt();
  const denied = gateway.query({ assistantRef: 'assistant-companion', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL', 'ASSISTANT_PRIVATE'] });
  assert.equal(denied.granted, false);
  assert.equal(denied.code, 'SCOPE_DENIED');
  assert.equal(denied.projection, null, 'a refusal carries no projection at all');
  assert.equal(JSON.stringify(denied).includes('fact-private-note'), false);
  assert.equal(JSON.stringify(denied).includes('value-1'), false);
  // the other denial axes are distinguishable
  assert.equal(gateway.query({ assistantRef: 'assistant-butler', purpose: 'SAFETY_CHECK', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] }).code, 'PURPOSE_DENIED');
  assert.equal(gateway.query({ assistantRef: 'assistant-companion', purpose: 'ANSWER_USER', audience: 'PUBLIC_CHANNEL', scopes: ['ASSISTANT_PRIVATE'] }).code, 'AUDIENCE_DENIED');
  assert.equal(gateway.query({ assistantRef: 'assistant-unknown', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['ASSISTANT_PRIVATE'] }).code, 'UNKNOWN_ASSISTANT');
  assert.equal(gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['NOT_A_SCOPE'] }).code, 'UNKNOWN_SCOPE');
  expectCode(() => gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: [] }), 'INVALID_QUERY');
});

/* ------------------------------------------------ 2. canonical identity is read-only */

test('assistant profile and relationship changes never change canonical records', () => {
  const { port, gateway } = gatewayAt();
  const before = port.__snapshot();
  const privateState = gateway.recordAssistantPrivateState({ assistantRef: 'assistant-companion', relationshipMode: 'companion', facts: ['likes concise answers'] });
  assert.equal(privateState.stored_in_digital_me, false);
  assert.equal(privateState.relationship_mode, 'companion');
  expectCode(() => gateway.write(), 'DIGITAL_ME_WRITE_FORBIDDEN');
  assert.deepEqual(port.__snapshot(), before, 'canonical records are byte-identical after an assistant change');
  // a canonical record that carries assistant or authority state is refused
  const poisoned = validateRecord({ ...record(), assistant_ref: 'assistant-butler' });
  assert.equal(poisoned.ok, false);
  assert.equal(poisoned.errors.some(error => error.includes('canonical user identity')), true);
  assert.deepEqual(findForbiddenCanonicalFields({ nested: { relationship_mode: 'companion' } }, ''), ['.nested.relationship_mode']);
  assert.equal(FORBIDDEN_CANONICAL_FIELDS.includes('grants'), true);
  assert.equal(DIGITAL_ME_PORT.writable, false);
  assert.equal(DIGITAL_ME_PORT.assistant_direct_database_access, false);
});

/* ------------------------------------------------ 3. knowledge is not disclosure authority */

test('a private fact is not surfaced through another audience without disclosure authorization', () => {
  const { gateway } = gatewayAt();
  // the butler may read the private fact internally
  const internal = gateway.query({ assistantRef: 'assistant-butler', purpose: 'PLAN_TASK', audience: 'OWNER_PRIVATE', scopes: ['ASSISTANT_PRIVATE'] });
  assert.equal(internal.projection.facts.some(fact => fact.fact_ref === 'fact-private-note'), true);
  // the same fact is not automatically disclosable in a shared audience
  const shared = gateway.query({ assistantRef: 'assistant-butler', purpose: 'PLAN_TASK', audience: 'SHARED_DEVICE', scopes: ['ASSISTANT_PRIVATE', 'PROJECT_TASK'] });
  assert.equal(shared.projection.facts.some(fact => fact.fact_ref === 'fact-private-note'), false);
  // The audience matrix would permit OWNER_PRIVATE into SHARED_DEVICE, so the block here is the
  // disclosure rule itself: knowing the fact privately is not authority to surface it.
  assert.equal(shared.projection.withheld.some(entry => entry.fact_ref === 'fact-private-note' && entry.reason === 'DISCLOSURE_NOT_AUTHORIZED'), true);
  assert.equal(shared.projection.facts.some(fact => fact.fact_ref === 'fact-shared-project'), true, 'an authorized shared fact is visible');
  // a public projection sees only public facts, and the reason is reported
  const publicView = gateway.query({ assistantRef: 'assistant-guest', purpose: 'ANSWER_USER', audience: 'PUBLIC_CHANNEL', scopes: ['AUDIENCE_CHANNEL'] });
  assert.deepEqual(publicView.projection.facts.map(fact => fact.fact_ref), ['fact-public-pref']);
  const blocked = gateway.query({ assistantRef: 'assistant-butler', purpose: 'PLAN_TASK', audience: 'PUBLIC_CHANNEL', scopes: ['ASSISTANT_PRIVATE'] });
  assert.equal(blocked.projection.facts.length, 0);
  assert.equal(blocked.projection.withheld.some(entry => entry.reason === 'AUDIENCE_NOT_PERMITTED'), true);
  assert.deepEqual(AUDIENCE_VISIBILITY.PUBLIC_CHANNEL, ['PUBLIC_CHANNEL']);
  assert.equal(DIGITAL_ME_GATEWAY_CONTRACT.knowledge_is_disclosure_authority, false);
});

/* ------------------------------------------------ 4. isolation, least data, staleness */

test('cross-assistant private memory is never visible to another assistant', () => {
  const { gateway } = gatewayAt();
  const guest = gateway.query({ assistantRef: 'assistant-guest', purpose: 'ANSWER_USER', audience: 'PUBLIC_CHANNEL', scopes: ['AUDIENCE_CHANNEL'] });
  assert.equal(guest.projection.facts.every(fact => fact.scope === 'AUDIENCE_CHANNEL'), true);
  const companion = gateway.query({ assistantRef: 'assistant-companion', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['ASSISTANT_PRIVATE'] });
  assert.equal(companion.projection.facts.every(fact => fact.scope === 'ASSISTANT_PRIVATE'), true);
  // both read the same port, and neither sees the other's scope
  assert.equal(DIGITAL_ME_GATEWAY_CONTRACT.cross_assistant_private_memory_visible, false);
  assert.equal(DIGITAL_ME_GATEWAY_CONTRACT.bulk_dump_by_default, false);
});

test('least data by default, with values only when the purpose needs them', () => {
  const withValues = gatewayAt().gateway.query({ assistantRef: 'assistant-butler', purpose: 'RESOLVE_PREFERENCE', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] });
  assert.equal(withValues.granted, false, 'the butler is not authorized for that purpose');
  const noValues = gatewayAt().gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] });
  assert.equal(noValues.projection.facts[0].value, null, 'a reference travels, not the value');
  assert.equal(noValues.projection.facts[0].value_ref, 'value-1');
  const withValuesRequested = gatewayAt().gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'], includeValues: true });
  assert.equal(withValuesRequested.projection.facts[0].value, 'value-for-value-1');
  // a policy that forbids values withholds them even when asked
  const strict = createDigitalMeGateway({ port: createDigitalMePortDouble({ records: records(), values: { 'value-1': 'value-for-value-1' } }), policy: { policy_ref: 'p2', assistants: { a: { scopes: ['USER_GLOBAL_CANONICAL'], purposes: ['ANSWER_USER'], audiences: ['OWNER_PRIVATE'], allow_values: false } } }, clock: () => T0 });
  assert.equal(strict.query({ assistantRef: 'a', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'], includeValues: true }).projection.facts[0].value, null);
  assert.equal(DIGITAL_ME_GATEWAY_CONTRACT.least_data_by_default, true);
});

test('stale context is reported rather than served, and device-ephemeral context is never durable', () => {
  const stale = gatewayAt(T0 + TTL + 1).gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] });
  assert.deepEqual([...stale.projection.stale], ['fact-time-format']);
  assert.equal(stale.projection.facts.length, 0, 'a stale fact is not served as current');
  const fresh = gatewayAt(T0).gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] });
  assert.deepEqual([...fresh.projection.stale], []);
  assert.equal(fresh.projection.facts.length, 1);
  // device-ephemeral records are never part of a durable projection
  const butler = gatewayAt().gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ALL });
  assert.equal(butler.projection.facts.some(fact => fact.scope === 'DEVICE_EPHEMERAL'), false);
  assert.equal(butler.projection.withheld.some(entry => entry.reason === 'DEVICE_EPHEMERAL_NOT_DURABLE'), true);
  const rebuilt = rebuildDeviceEphemeralContext({ deviceRef: 'device-phone', sessionRef: 'session-2', entries: [{ key: 'screen', value: 'chat' }], at: ISO(T0) });
  assert.equal(rebuilt.durable, false);
  assert.equal(rebuilt.merged_into_durable_memory, false);
  assert.equal(rebuildDeviceEphemeralContext({ deviceRef: 'device-phone' }).entries.length, 0, 'a rebuild starts empty rather than restoring a stale session');
  expectCode(() => rebuildDeviceEphemeralContext({}), 'INVALID_QUERY');
  assert.equal(DIGITAL_ME_GATEWAY_CONTRACT.device_ephemeral_is_durable, false);
});

test('every projection carries provenance, and the surface is strict', () => {
  const { gateway } = gatewayAt();
  const granted = gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'], taskRef: 'task-1', deviceRef: 'device-phone' });
  assert.deepEqual(granted.projection.provenance, {
    assistant_ref: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE',
    scopes: ['USER_GLOBAL_CANONICAL'], policy_ref: 'policy-1', decided_at: T0,
  });
  assert.equal(granted.projection.task_ref, 'task-1');
  assert.equal(granted.projection.device_ref, 'device-phone');
  // a refusal carries the same provenance so a denial is auditable too
  const denied = gateway.query({ assistantRef: 'assistant-companion', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] });
  assert.equal(denied.provenance.policy_ref, 'policy-1');
  assert.equal(denied.provenance.decided_at, T0);

  assert.equal(validateRecord(record()).ok, true);
  assert.equal(validateRecord(record({ scope: 'EVERYTHING' })).ok, false);
  assert.equal(validateRecord(record({ audience: 'EVERYONE' })).ok, false);
  assert.equal(validateRecord(record({ sensitivity: 'SORTOF' })).ok, false);
  assert.equal(validateRecord(record({ observed_at: 'yesterday' })).ok, false);
  assert.equal(validateRecord(record({ extra: 1 })).ok, false);
  expectCode(() => createDigitalMeGateway({ policy }), 'PORT_REQUIRED');
  expectCode(() => createDigitalMeGateway({ port: createDigitalMePortDouble({}), policy: {} }), 'UNKNOWN_ASSISTANT');
  assert.equal(new DigitalMeError('X', 'y').status, 403);
  assert.deepEqual([...MEMORY_SCOPES], ['USER_GLOBAL_CANONICAL', 'ASSISTANT_PRIVATE', 'PROJECT_TASK', 'AUDIENCE_CHANNEL', 'DEVICE_EPHEMERAL']);
  assert.deepEqual([...QUERY_PURPOSES].length, 4);
});
