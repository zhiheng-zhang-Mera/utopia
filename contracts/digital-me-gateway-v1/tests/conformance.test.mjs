// BA-005 conformance suite â€?Digital-Me context gateway.
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
 createDigitalMePortDouble, findForbiddenCanonicalFields, isIsoInstant, recordDepthExceeded,
 rebuildDeviceEphemeralContext, validateRecord
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

/* --------------------------------- 9. regressions (Correction, host Alien) */

// Every refusal is paired with the legitimate neighbour that must still pass.

test('record fields named after Object.prototype members are refused', () => {
  for (const name of Object.getOwnPropertyNames(Object.prototype)) {
    const probe = Object.defineProperty({ ...record() }, name, { value: 'SMUGGLED', enumerable: true, configurable: true, writable: true });
    assert.equal(validateRecord(probe).ok, false, `record.${name} must not be canonical`);
  }
  const hidden = { ...record() };
  Object.defineProperty(hidden, 'transport', { value: 'RF', enumerable: false, configurable: true, writable: true });
  assert.equal(validateRecord(hidden).ok, false, 'a non-enumerable own field must be refused too');
  // neighbour: an ordinary unknown field is still refused, and a clean record is still valid
  assert.equal(validateRecord({ ...record(), transport: 'RF' }).ok, false);
  assert.equal(validateRecord(record()).ok, true);
  assert.equal({}.SMUGGLED, undefined, 'no prototype pollution');
});

test('a replayed or future-dated record is never served as current', () => {
  const year = 365 * 24 * 3600 * 1000;
  const future = gatewayAt(T0);
  future.port.__mutate('record-1', { observed_at: ISO(T0 + 10 * year), ttl_ms: 1 });
  const served = future.gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] });
  assert.equal(served.projection.facts.length, 0, 'a record dated ten years ahead is not current evidence');
  assert.deepEqual([...served.projection.stale], ['fact-time-format']);
  // the ttl cannot claim permanence either: an unbounded ttl is refused rather than served
  assert.equal(validateRecord(record({ ttl_ms: Number.MAX_SAFE_INTEGER })).ok, false);
  const eternal = gatewayAt(T0);
  eternal.port.__mutate('record-1', { ttl_ms: Number.MAX_SAFE_INTEGER });
  expectCode(() => eternal.gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] }), 'INVALID_RECORD');
  // neighbours: ordinary skew is tolerated, and honest in-window records are still served
  const skewed = gatewayAt(T0 - 60_000);
  assert.equal(skewed.gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] }).projection.facts.length, 1);
  assert.equal(gatewayAt(T0).gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] }).projection.facts.length, 1);
  assert.equal(validateRecord(record({ ttl_ms: 1000 })).ok, true);
});

test('a policy grant is read from the policy itself, never from the prototype chain', () => {
  for (const name of ['toString', 'valueOf', 'constructor', '__proto__', 'hasOwnProperty']) {
    const { gateway } = gatewayAt(T0);
    const verdict = gateway.query({ assistantRef: name, purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] });
    assert.equal(verdict.granted, false, `${name} is not a known assistant`);
    assert.equal(verdict.code, 'UNKNOWN_ASSISTANT');
  }
  // an inherited grant must not confer access on an assistant that does not own one
  const inheritedPolicy = { policy_ref: 'policy-inherited', assistants: Object.assign(Object.create({ 'assistant-evil': { scopes: ALL, purposes: ['ANSWER_USER'], audiences: AUDIENCES, allow_values: true } }), policy.assistants) };
  const port = createDigitalMePortDouble({ records: records(), values: {} });
  const inherited = createDigitalMeGateway({ port, policy: inheritedPolicy, clock: () => T0 });
  assert.equal(inherited.query({ assistantRef: 'assistant-evil', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] }).code, 'UNKNOWN_ASSISTANT');
  // a malformed grant is a typed refusal rather than an untyped crash
  const malformed = createDigitalMeGateway({ port, policy: { assistants: { 'assistant-broken': { scopes: 'all' } } }, clock: () => T0 });
  assert.equal(malformed.query({ assistantRef: 'assistant-broken', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] }).code, 'UNKNOWN_ASSISTANT');
  // neighbours: real assistants still receive their authorized projection
  assert.equal(gatewayAt(T0).gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] }).granted, true);
  assert.equal(gatewayAt(T0).gateway.query({ assistantRef: 'assistant-stranger', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] }).code, 'UNKNOWN_ASSISTANT');
});

test('a SENSITIVE record is not released like an ordinary one', () => {
  const sensitive = gatewayAt(T0);
  sensitive.port.__mutate('record-1', { sensitivity: 'SENSITIVE' });
  const verdict = sensitive.gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] });
  assert.equal(verdict.projection.facts.length, 0);
  assert.deepEqual([...verdict.projection.withheld], [{ fact_ref: 'fact-time-format', reason: 'SENSITIVITY_NOT_PERMITTED' }]);
  assert.equal(verdict.granted, true, 'the query is still granted; only the record is withheld');
  // explicitly authorized sensitive data is still released, and NORMAL data is unaffected
  const authorized = gatewayAt(T0);
  authorized.port.__mutate('record-1', { sensitivity: 'SENSITIVE', disclosure_authorized: true });
  assert.equal(authorized.gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] }).projection.facts.length, 1);
  assert.equal(gatewayAt(T0).gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] }).projection.facts.length, 1);
});

test('a cyclic or over-deep record is a typed refusal, not a stack overflow', () => {
  const loop = [];
  loop.push(loop);
  const cyclic = { ...record() };
  cyclic.extra = loop;
  assert.equal(validateRecord(cyclic).ok, false);
  let deep = 'leaf';
  for (let index = 0; index < 200; index += 1) deep = { next: deep };
  const nested = { ...record(), extra: deep };
  assert.equal(recordDepthExceeded(nested), true);
  assert.equal(validateRecord(nested).ok, false);
  // neighbours: a shallow record is still valid, and the forbidden-field scan still works
  assert.equal(recordDepthExceeded(record()), false);
  assert.deepEqual([...findForbiddenCanonicalFields({ a: { persona: 'x' } }, '')], ['.a.persona']);
  assert.equal(validateRecord(record()).ok, true);
});

test('a calendar-impossible instant is refused, not merely shape-checked', () => {
  assert.equal(isIsoInstant('2026-13-45T99:99:99Z'), false);
  assert.equal(isIsoInstant('2026-02-30T00:00:00.000Z'), false);
  assert.equal(validateRecord(record({ observed_at: '2026-13-45T99:99:99Z' })).ok, false);
  // neighbours: both accepted spellings of a real instant still pass
  assert.equal(isIsoInstant('2026-09-30T12:00:00Z'), true);
  assert.equal(isIsoInstant('2026-09-30T12:00:00.000Z'), true);
  assert.equal(validateRecord(record({ observed_at: '2026-09-30T12:00:00Z' })).ok, true);
});

test('a record must be a bare own-property object', () => {
  // the same forbidden field that is refused as an own key was accepted through a prototype
  const inherited = Object.assign(Object.create({ persona: 'companion' }), record());
  assert.equal(validateRecord(inherited).ok, false, 'an inherited payload is not a canonical record');
  class RecordLike { constructor() { Object.assign(this, record()); } }
  assert.equal(validateRecord(new RecordLike()).ok, false, 'a class instance is not a canonical record');
  // neighbours: a plain record and a null-prototype record are both canonical
  assert.equal(validateRecord(record()).ok, true);
  assert.equal(validateRecord(Object.assign(Object.create(null), record())).ok, true);
  assert.deepEqual([...findForbiddenCanonicalFields(record())], []);
});

test('assistant-private memory belongs to the assistant that owns it', () => {
  const owned = gatewayAt(T0);
  owned.port.__mutate('record-2', { owner_assistant_ref: 'assistant-butler' });
  const mine = owned.gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['ASSISTANT_PRIVATE'] });
  assert.equal(mine.projection.facts.length, 1);
  // the rival holds the same scope grant but not the fact
  const rival = createDigitalMeGateway({ port: owned.port, policy: { policy_ref: 'policy-1', assistants: { 'assistant-rival': { scopes: ['ASSISTANT_PRIVATE'], purposes: ['ANSWER_USER'], audiences: AUDIENCES, allow_values: true } } }, clock: () => T0 });
  const theirs = rival.query({ assistantRef: 'assistant-rival', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['ASSISTANT_PRIVATE'] });
  assert.equal(theirs.projection.facts.length, 0, 'another assistant may not read owned private memory');
  assert.deepEqual([...theirs.projection.withheld], [{ fact_ref: 'fact-private-note', reason: 'NOT_THE_OWNER' }]);
  // neighbours: an unowned private record is still readable by a granted assistant (the optional field
  // is what the Development fixtures predate), and the owner still sees their own
  assert.equal(gatewayAt(T0).gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['ASSISTANT_PRIVATE'] }).projection.facts.length, 1);
});

test('the port hands out copies, and refuses two records under one id', () => {
  const { port } = gatewayAt(T0);
  const withObject = createDigitalMePortDouble({ records: records(), values: { 'value-obj': { nested: 1 } } });
  const first = withObject.resolveValue('value-obj');
  first.value.mutated = 'by-the-caller';
  assert.equal(withObject.resolveValue('value-obj').value.mutated, undefined, 'a caller may not rewrite canonical values');
  const readRecords = port.listRecords({});
  readRecords[0].fact_ref = 'rewritten';
  assert.equal(port.listRecords({})[0].fact_ref, 'fact-time-format');
  // a duplicate id used to collapse silently
  expectCode(() => createDigitalMePortDouble({ records: [record(), record()] }), 'INVALID_RECORD');
  // neighbours: distinct ids are fine and reads still work
  assert.equal(createDigitalMePortDouble({ records: [record(), record({ record_id: 'record-2' })] }).listRecords({}).length, 2);
  assert.equal(port.resolveValue('value-1').value_ref, 'value-1');
});

test('a malformed record refuses the whole query before anything is assembled', () => {
  const { port } = gatewayAt(T0);
  port.__mutate('record-2', { ttl_ms: 'not-a-number' });
  const gateway = createDigitalMeGateway({ port, policy, clock: () => T0 });
  const error = expectCode(() => gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL', 'ASSISTANT_PRIVATE'] }), 'INVALID_RECORD');
  assert.equal(error.detail.includes('ttl_ms'), true);
  // nothing was resolved out of the port for the request: the refusal happens before assembly
  assert.equal(port.__reads.some(entry => entry.op === 'resolveValue'), false);
  // neighbours: without the malformed record the same query succeeds
  const clean = gatewayAt(T0).gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] });
  assert.equal(clean.projection.facts.length, 1);
});

test('the gateway does not read authority from a live policy object', () => {
  const livePolicy = { policy_ref: 'policy-1', assistants: { 'assistant-butler': { scopes: ['USER_GLOBAL_CANONICAL'], purposes: ['ANSWER_USER'], audiences: ['OWNER_PRIVATE'], allow_values: false } } };
  const port = createDigitalMePortDouble({ records: records(), values: {} });
  const gateway = createDigitalMeGateway({ port, policy: livePolicy, clock: () => T0 });
  assert.equal(gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] }).granted, true);
  // widening the caller's object after construction must not widen the gateway's authority
  livePolicy.assistants['assistant-butler'].scopes.push('ASSISTANT_PRIVATE');
  livePolicy.assistants['assistant-intruder'] = { scopes: ALL, purposes: ['ANSWER_USER'], audiences: AUDIENCES, allow_values: true };
  assert.equal(gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['ASSISTANT_PRIVATE'] }).code, 'SCOPE_DENIED');
  assert.equal(gateway.query({ assistantRef: 'assistant-intruder', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'] }).code, 'UNKNOWN_ASSISTANT');
  assert.equal(gateway.policyRef(), 'policy-1');
});

test('values are released only for an explicit includeValues boolean', () => {
  for (const flag of ['false', 1, {}, [], 'yes']) {
    const { gateway } = gatewayAt(T0);
    const verdict = gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'], includeValues: flag });
    assert.equal(verdict.projection.facts[0].value, null, `includeValues=${JSON.stringify(flag)} must not release values`);
  }
  // neighbours: the explicit boolean still releases, and a grant is still required
  assert.equal(gatewayAt(T0).gateway.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'], includeValues: true }).projection.facts[0].value, 'value-for-value-1');
  const ungranted = createDigitalMeGateway({ port: createDigitalMePortDouble({ records: records(), values: { 'value-1': 'v' } }), policy: { assistants: { 'assistant-butler': { scopes: ['USER_GLOBAL_CANONICAL'], purposes: ['ANSWER_USER'], audiences: ['OWNER_PRIVATE'], allow_values: false } } }, clock: () => T0 });
  assert.equal(ungranted.query({ assistantRef: 'assistant-butler', purpose: 'ANSWER_USER', audience: 'OWNER_PRIVATE', scopes: ['USER_GLOBAL_CANONICAL'], includeValues: true }).projection.facts[0].value, null);
});

test('device-ephemeral context cannot smuggle durable or sensitive facts', () => {
  expectCode(() => rebuildDeviceEphemeralContext({ deviceRef: 'device-phone', entries: [{ scope: 'ASSISTANT_PRIVATE' }] }), 'INVALID_QUERY');
  expectCode(() => rebuildDeviceEphemeralContext({ deviceRef: 'device-phone', entries: [{ sensitivity: 'SENSITIVE' }] }), 'INVALID_QUERY');
  expectCode(() => rebuildDeviceEphemeralContext({ deviceRef: 'device-phone', entries: ['not-an-entry'] }), 'INVALID_QUERY');
  // neighbours: ordinary entries are accepted, copied and frozen at every level
  const rebuilt = rebuildDeviceEphemeralContext({ deviceRef: 'device-phone', entries: [{ note: 'scratch', meta: { depth: 1 } }] });
  assert.equal(rebuilt.entries[0].note, 'scratch');
  assert.equal(Object.isFrozen(rebuilt.entries[0].meta), true, 'nested state is frozen, not shared');
  assert.throws(() => { rebuilt.entries[0].meta.depth = 2; }, TypeError);
  assert.equal(rebuilt.merged_into_durable_memory, false);
});

