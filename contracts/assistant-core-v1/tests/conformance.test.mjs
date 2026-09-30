// BA-002 conformance suite for the Assistant Core / Shared Brain runtime.
//
// Covers the task's acceptance requirements: cross-embodiment visibility of
// committed material, embodiment-local context without leakage, assistant
// survival across embodiment disconnect, typed promotion instead of implicit
// sharing, version-checked concurrent promotion, and recovery that keeps
// one-logical-assistant/many-projections while rejecting stale local scratch.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
 ASSISTANT_CORE_CONTRACT, ASSISTANT_CORE_VERSION, ASSISTANT_PROFILE_PORT, AssistantCoreError,
 AUDIENCE_VISIBILITY, DISCLOSURE_AUDIENCES, DURABLE_KINDS, MEMORY_SCOPES, TRANSIENT_ONLY_KINDS,
 assertProfileReference, createAssistantCore, createDeterministicProfilePort,
 findForbiddenCoreStateFields, probeProfilePortConformance, restoreAssistantCore
} from '../index.mjs';

const TS = '2026-09-30T12:00:00.000Z';
const LATER = '2026-09-30T12:05:00.000Z';
const expectCode = (fn, code) => {
 try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
 assert.fail(`expected the call to fail with ${code}`);
};

const newCore = (options = {}) => createAssistantCore({ clock: () => TS, profilePort: createDeterministicProfilePort({ profiles: { 'butler-a': { profile_ref: 'profile-a', profile_revision: 3 } } }), ...options });

const bootstrap = () => {
 const core = newCore();
 core.createAssistant('butler-a');
 const mech = core.connectEmbodiment('butler-a', { deviceId: 'mech-android' });
 const alien = core.connectEmbodiment('butler-a', { deviceId: 'alien-web' });
 return { core, mech, alien };
};

const promoteFact = (core, embodiment, payload, overrides = {}) => core.promote(embodiment.embodimentRef, {
 kind: 'FACT', payload, scope: 'ASSISTANT_PRIVATE', audience: 'OWNER_PRIVATE',
 expectedRevision: core.assistantStatus(embodiment.assistantId).coreRevision,
 idempotencyKey: `key-${JSON.stringify(payload)}`, at: TS, ...overrides
});

test('a committed record from one embodiment is visible to another embodiment of the same assistant', () => {
 const { core, mech, alien } = bootstrap();
 const promoted = promoteFact(core, mech, { statement: 'Owner prefers 24h time' });
 assert.equal(promoted.replayed, false);
 assert.equal(promoted.coreRevision, 2);
 // the other embodiment sees the same authoritative record
 const alienView = core.projectContext(alien.embodimentRef, { scopes: ['ASSISTANT_PRIVATE'] });
 assert.equal(alienView.records.length, 1);
 assert.equal(alienView.records[0].payload.statement, 'Owner prefers 24h time');
 assert.equal(alienView.records[0].promoted_by.device_id, 'mech-android');
 assert.equal(alienView.core_revision, 2);
 // and so does a fresh read of the authoritative state
 assert.equal(core.readDurable('butler-a').length, 1);
 assert.equal(core.assistantStatus('butler-a').coreRevision, 2);
 assert.equal(core.causalLog('butler-a').some(event => event.event_type === 'DURABLE_RECORD_PROMOTED'), true);
});

test('two embodiments keep different local context while sharing one authoritative identity', () => {
 const { core, mech, alien } = bootstrap();
 core.setTransientState(mech.embodimentRef, { kind: 'TOKEN_CONTEXT', value: { window: 'mech-only' } });
 core.setTransientState(alien.embodimentRef, { kind: 'UI_TRANSIENT', value: { screen: 'settings' } });
 promoteFact(core, mech, { statement: 'shared fact' });
 const mechView = core.projectContext(mech.embodimentRef, { scopes: ['ASSISTANT_PRIVATE'] });
 const alienView = core.projectContext(alien.embodimentRef, { scopes: ['ASSISTANT_PRIVATE'] });
 // same logical assistant, same durable truth, different local context
 assert.equal(mechView.assistant_id, alienView.assistant_id);
 assert.equal(mechView.profile_ref.profile_ref, 'profile-a');
 assert.deepEqual(mechView.profile_ref, alienView.profile_ref);
 assert.deepEqual(mechView.records, alienView.records);
 assert.deepEqual(Object.keys(mechView.local_transient), ['TOKEN_CONTEXT']);
 assert.deepEqual(Object.keys(alienView.local_transient), ['UI_TRANSIENT']);
 assert.equal(JSON.stringify(alienView).includes('mech-only'), false);
 assert.equal(JSON.stringify(mechView).includes('settings'), false);
 assert.equal(mechView.embodiment_ref !== alienView.embodiment_ref, true);
});

test('disconnecting one embodiment does not terminate the assistant while another remains', () => {
 const { core, mech, alien } = bootstrap();
 assert.deepEqual(core.assistantStatus('butler-a').devices, ['alien-web', 'mech-android']);
 assert.equal(core.assistantStatus('butler-a').embodiments, 2);
 const closed = core.disconnectEmbodiment(mech.embodimentRef);
 assert.equal(closed.remainingEmbodiments, 1);
 assert.equal(closed.assistantActive, true);
 const status = core.assistantStatus('butler-a');
 assert.equal(status.active, true);
 assert.equal(status.embodiments, 1);
 assert.deepEqual(status.devices, ['alien-web']);
 // the surviving embodiment still works
 const promoted = promoteFact(core, alien, { statement: 'survivor keeps working' });
 assert.equal(promoted.replayed, false);
 // and the disconnected handle is gone
 expectCode(() => core.setTransientState(mech.embodimentRef, { kind: 'TOKEN_CONTEXT', value: {} }), 'EMBODIMENT_NOT_CONNECTED');
 assert.deepEqual(core.disconnectEmbodiment(alien.embodimentRef).assistantActive, false);
});

test('embodiment-local transient state never leaks into shared state unless promoted', () => {
 const { core, mech, alien } = bootstrap();
 core.setTransientState(mech.embodimentRef, { kind: 'SCRATCH_REASONING', value: { draft: 'unfinished idea' } });
 core.setTransientState(mech.embodimentRef, { kind: 'PLAN_DRAFT', value: { steps: ['a', 'b'] } });
 const snapshot = core.snapshot();
 assert.equal(JSON.stringify(snapshot).includes('unfinished idea'), false);
 assert.equal(JSON.stringify(snapshot).includes('PLAN_DRAFT'), false);
 assert.equal(core.readDurable('butler-a').length, 0);
 assert.equal(core.projectContext(alien.embodimentRef).records.length, 0);
 // a durable kind can never be smuggled in as transient, and scratch can never be
 // committed as-is
 expectCode(() => core.setTransientState(mech.embodimentRef, { kind: 'FACT', value: {} }), 'DURABLE_KIND_REQUIRES_PROMOTION');
 expectCode(() => core.setTransientState(mech.embodimentRef, { kind: 'MOOD', value: {} }), 'UNKNOWN_TRANSIENT_KIND');
 for (const kind of TRANSIENT_ONLY_KINDS) {
  expectCode(() => core.promote(mech.embodimentRef, { kind, payload: {}, expectedRevision: 1, idempotencyKey: `k-${kind}` }), 'EPHEMERAL_STATE_CANNOT_BE_PROMOTED_AS_IS');
 }
 // the explicit promotion path is what makes local material shared
 core.promote(mech.embodimentRef, { kind: 'PLAN_ARTIFACT', payload: { steps: ['a', 'b'] }, scope: 'PROJECT_TASK', expectedRevision: 1, idempotencyKey: 'plan-key', at: TS });
 assert.equal(core.readDurable('butler-a', { kinds: ['PLAN_ARTIFACT'] }).length, 1);
});

test('concurrent promotion attempts are settled by revision checks, not last-writer-wins', () => {
 const { core, mech, alien } = bootstrap();
 const staleRevision = core.assistantStatus('butler-a').coreRevision;
 const first = core.promote(mech.embodimentRef, { kind: 'CHECKPOINT', payload: { at: 1 }, expectedRevision: staleRevision, idempotencyKey: 'cp-1', at: TS });
 assert.equal(first.coreRevision, 2);
 // the second writer captured the same revision before the first commit
 const conflict = expectCode(() => core.promote(alien.embodimentRef, { kind: 'CHECKPOINT', payload: { at: 2 }, expectedRevision: staleRevision, idempotencyKey: 'cp-2', at: LATER }), 'STALE_REVISION');
 assert.equal(conflict.detail, `expected ${staleRevision}, current 2`);
 const records = core.readDurable('butler-a');
 assert.equal(records.length, 1);
 assert.deepEqual(records[0].payload, { at: 1 });
 // the loser can retry against the current revision without silent overwrite
 const retry = core.promote(alien.embodimentRef, { kind: 'CHECKPOINT', payload: { at: 2 }, expectedRevision: core.assistantStatus('butler-a').coreRevision, idempotencyKey: 'cp-2', at: LATER });
 assert.equal(retry.coreRevision, 3);
 assert.deepEqual(core.readDurable('butler-a').map(record => record.payload.at), [1, 2]);
 expectCode(() => core.promote(mech.embodimentRef, { kind: 'FACT', payload: {}, idempotencyKey: 'cp-9' }), 'REVISION_CHECK_REQUIRED');
 expectCode(() => core.promote(mech.embodimentRef, { kind: 'FACT', payload: {}, expectedRevision: 'one', idempotencyKey: 'cp-8' }), 'REVISION_CHECK_REQUIRED');
});

test('promotion is idempotent and rejects key reuse with a different payload', () => {
 const { core, mech } = bootstrap();
 const first = core.promote(mech.embodimentRef, { kind: 'FACT', payload: { a: 1, b: 2 }, expectedRevision: 1, idempotencyKey: 'same-key', at: TS });
 assert.equal(first.replayed, false);
 const replay = core.promote(mech.embodimentRef, { kind: 'FACT', payload: { b: 2, a: 1 }, expectedRevision: 1, idempotencyKey: 'same-key', at: LATER });
 assert.equal(replay.replayed, true);
 assert.equal(replay.record.record_id, first.record.record_id);
 assert.equal(replay.coreRevision, 2);
 assert.equal(core.readDurable('butler-a').length, 1);
 expectCode(() => core.promote(mech.embodimentRef, { kind: 'FACT', payload: { a: 9 }, expectedRevision: 2, idempotencyKey: 'same-key', at: TS }), 'IDEMPOTENCY_KEY_REUSE');
 assert.equal(core.readDurable('butler-a').length, 1);
 expectCode(() => core.promote(mech.embodimentRef, { kind: 'FACT', payload: {}, expectedRevision: 2 }), 'INVALID_IDEMPOTENCY_KEY');
});

test('authoritative state never holds user identity, authority or raw secrets', () => {
 const { core, mech } = bootstrap();
 const revision = () => core.assistantStatus('butler-a').coreRevision;
 const forbidden = [
  ['PROMOTION_AUTHORITY_FORBIDDEN', { digital_me: { userId: 'owner' } }],
  ['PROMOTION_AUTHORITY_FORBIDDEN', { user_identity: { name: 'owner' } }],
  ['PROMOTION_AUTHORITY_FORBIDDEN', { permissions: ['act:device.control'] }],
  ['PROMOTION_AUTHORITY_FORBIDDEN', { nested: { execution_lease: { scope: 'exclusive' } } }],
  ['PROMOTION_SECRET_FORBIDDEN', { access_token: 'raw' }],
  ['PROMOTION_SECRET_FORBIDDEN', { nested: { api_key: 'raw' } }]
 ];
 for (const [code, payload] of forbidden) {
  expectCode(() => core.promote(mech.embodimentRef, { kind: 'FACT', payload, expectedRevision: revision(), idempotencyKey: `bad-${JSON.stringify(payload)}`, at: TS }), code);
 }
 assert.equal(core.readDurable('butler-a').length, 0);
 // a profile is referenced, never copied
 expectCode(() => assertProfileReference({ profile_ref: 'p', profile_revision: 1, personality: 'warm' }), 'INVALID_PROFILE_REFERENCE');
 expectCode(() => assertProfileReference({ profile_ref: 'p', profile_revision: 0 }), 'INVALID_PROFILE_REFERENCE');
 assert.deepEqual(assertProfileReference({ profile_ref: 'p', profile_revision: 1 }), { profile_ref: 'p', profile_revision: 1 });
 assert.deepEqual(findForbiddenCoreStateFields({ ok: 1, credential_ref: 'handle', secret: 'x' }), [{ path: 'payload.secret', reason: 'raw-secret' }]);
 // a handle reference is not a secret
 const ok = core.promote(mech.embodimentRef, { kind: 'MEMORY_REFERENCE', payload: { credential_ref: 'secure-handle://1' }, expectedRevision: revision(), idempotencyKey: 'handle-key', at: TS });
 assert.equal(ok.replayed, false);
});

test('disclosure is limited by audience and requested scopes', () => {
 const { core, mech } = bootstrap();
 core.promote(mech.embodimentRef, { kind: 'FACT', payload: { note: 'private' }, scope: 'ASSISTANT_PRIVATE', audience: 'OWNER_PRIVATE', expectedRevision: 1, idempotencyKey: 'k1', at: TS });
 core.promote(mech.embodimentRef, { kind: 'FACT', payload: { note: 'device' }, scope: 'AUDIENCE_CHANNEL', audience: 'SHARED_DEVICE', expectedRevision: 2, idempotencyKey: 'k2', at: TS });
 core.promote(mech.embodimentRef, { kind: 'FACT', payload: { note: 'public' }, scope: 'AUDIENCE_CHANNEL', audience: 'PUBLIC_CHANNEL', expectedRevision: 3, idempotencyKey: 'k3', at: TS });
 const ownerView = core.projectContext(mech.embodimentRef, { audience: 'OWNER_PRIVATE', scopes: [...MEMORY_SCOPES.filter(scope => scope !== 'DEVICE_EPHEMERAL')] });
 assert.deepEqual(ownerView.records.map(record => record.payload.note), ['private']);
 assert.equal(ownerView.withheld.some(entry => entry.reason === 'AUDIENCE_NOT_PERMITTED'), true);
 const deviceView = core.projectContext(mech.embodimentRef, { audience: 'SHARED_DEVICE', scopes: ['ASSISTANT_PRIVATE', 'AUDIENCE_CHANNEL'] });
 assert.deepEqual(deviceView.records.map(record => record.payload.note), ['private', 'device']);
 const publicView = core.projectContext(mech.embodimentRef, { audience: 'PUBLIC_CHANNEL', scopes: ['AUDIENCE_CHANNEL'] });
 assert.deepEqual(publicView.records.map(record => record.payload.note), ['public']);
 // knowing the record exists does not authorize emitting it in another audience
 assert.equal(AUDIENCE_VISIBILITY.PUBLIC_CHANNEL.includes('OWNER_PRIVATE'), false);
 // a scope that is not requested is never drawn in
 const narrow = core.projectContext(mech.embodimentRef, { audience: 'SHARED_DEVICE', scopes: ['AUDIENCE_CHANNEL'] });
 assert.deepEqual(narrow.records.map(record => record.payload.note), ['device']);
 expectCode(() => core.projectContext(mech.embodimentRef, { audience: 'EVERYONE' }), 'UNKNOWN_DISCLOSURE_AUDIENCE');
 expectCode(() => core.projectContext(mech.embodimentRef, { scopes: ['EVERYTHING'] }), 'UNKNOWN_MEMORY_SCOPE');
 expectCode(() => core.promote(mech.embodimentRef, { kind: 'FACT', payload: {}, scope: 'DEVICE_EPHEMERAL', expectedRevision: 4, idempotencyKey: 'k4' }), 'EPHEMERAL_SCOPE_CANNOT_BE_PROMOTED');
});

test('recovery keeps the logical assistant and its durable records across a restart', () => {
 const { core, mech } = bootstrap();
 promoteFact(core, mech, { statement: 'survives restart' });
 core.setTransientState(mech.embodimentRef, { kind: 'SCRATCH_REASONING', value: { draft: 'lost' } });
 const snapshot = core.snapshot();
 const restarted = restoreAssistantCore(snapshot, { clock: () => LATER });
 assert.equal(restarted.epoch, core.epoch + 1);
 const status = restarted.assistantStatus('butler-a');
 assert.equal(status.active, false);
 assert.equal(status.embodiments, 0);
 assert.equal(status.coreRevision, 2);
 const durable = restarted.readDurable('butler-a');
 assert.equal(durable.length, 1);
 assert.equal(durable[0].payload.statement, 'survives restart');
 assert.equal(durable[0].record_id, 'butler-a:record:1');
 assert.equal(restarted.causalLog('butler-a').length, 2);
 // profile reference is preserved without copying profile fields
 assert.deepEqual(restarted.assistantStatus('butler-a').coreEpoch, 2);
 expectCode(() => restarted.readDurable('butler-b'), 'ASSISTANT_NOT_FOUND');
});

test('a process restart refuses old sessions and stale local scratch as authority', () => {
 const { core, mech } = bootstrap();
 promoteFact(core, mech, { statement: 'before restart' });
 const restarted = restoreAssistantCore(core.snapshot(), { clock: () => LATER });
 // session handles are not durable: a restarted core does not know them at all
 expectCode(() => restarted.promote(mech.embodimentRef, { kind: 'FACT', payload: { statement: 'from stale scratch' }, expectedRevision: 2, idempotencyKey: 'stale-1', at: LATER }), 'EMBODIMENT_NOT_CONNECTED');
 expectCode(() => restarted.setTransientState(mech.embodimentRef, { kind: 'TOKEN_CONTEXT', value: {} }), 'EMBODIMENT_NOT_CONNECTED');
 assert.deepEqual(restarted.attestEmbodiment(mech.embodimentRef), { valid: false, reason: 'UNKNOWN_EMBODIMENT' });
 assert.equal(restarted.readDurable('butler-a').length, 1);
 // reconnecting re-fetches authority and yields a usable session
 const reconnected = restarted.connectEmbodiment('butler-a', { deviceId: 'mech-android', sessionRef: 'session-2' });
 assert.deepEqual(restarted.attestEmbodiment(reconnected.embodimentRef), { valid: true, assistantId: 'butler-a', deviceId: 'mech-android', coreEpoch: restarted.epoch });
 const view = restarted.projectContext(reconnected.embodimentRef, { scopes: ['ASSISTANT_PRIVATE'] });
 assert.equal(view.records.length, 1);
 assert.equal(view.scope_stale, false);
 assert.deepEqual(view.local_transient, {});
 const promoted = restarted.promote(reconnected.embodimentRef, { kind: 'FACT', payload: { statement: 'after reconnect' }, expectedRevision: 2, idempotencyKey: 'fresh-1', at: LATER });
 assert.equal(promoted.coreRevision, 3);
 assert.deepEqual(restarted.readDurable('butler-a').map(record => record.payload.statement), ['before restart', 'after reconnect']);
 // a recovered core also refuses an incompatible snapshot
 expectCode(() => restoreAssistantCore({ core_version: 99, assistants: [] }), 'INCOMPATIBLE_CORE_SNAPSHOT');
 expectCode(() => restoreAssistantCore({ core_version: ASSISTANT_CORE_VERSION, core_epoch: 1, assistants: [{ assistant_id: 'x' }] }), 'INCOMPATIBLE_CORE_SNAPSHOT');
});

test('in-process recovery expires live sessions until the device re-fetches authority', () => {
 const { core, mech, alien } = bootstrap();
 promoteFact(core, mech, { statement: 'durable before reload' });
 core.setTransientState(mech.embodimentRef, { kind: 'SCRATCH_REASONING', value: { draft: 'stale' } });
 const reloaded = core.reloadFromSnapshot(core.snapshot());
 assert.equal(reloaded.coreEpoch, 2);
 assert.equal(reloaded.liveEmbodiments, 2);
 // the expired session cannot promote, write transient state or read a projection as authority
 expectCode(() => core.promote(mech.embodimentRef, { kind: 'FACT', payload: { statement: 'stale scratch' }, expectedRevision: 2, idempotencyKey: 'stale-2', at: LATER }), 'EMBODIMENT_SESSION_EXPIRED');
 expectCode(() => core.setTransientState(alien.embodimentRef, { kind: 'TOKEN_CONTEXT', value: {} }), 'EMBODIMENT_SESSION_EXPIRED');
 assert.deepEqual(core.attestEmbodiment(alien.embodimentRef), { valid: false, reason: 'SESSION_EXPIRED', coreEpoch: 2 });
 const view = core.projectContext(alien.embodimentRef, { scopes: ['ASSISTANT_PRIVATE'] });
 assert.equal(view.scope_stale, true);
 assert.equal(view.records.length, 1);
 // reconnecting against the same live core restores normal operation
 const fresh = core.connectEmbodiment('butler-a', { deviceId: 'alien-web' });
 assert.equal(core.attestEmbodiment(fresh.embodimentRef).valid, true);
 const promoted = core.promote(fresh.embodimentRef, { kind: 'FACT', payload: { statement: 'after re-fetch' }, expectedRevision: 2, idempotencyKey: 'fresh-2', at: LATER });
 assert.equal(promoted.coreRevision, 3);
 assert.deepEqual(core.readDurable('butler-a').map(record => record.payload.statement), ['durable before reload', 'after re-fetch']);
 expectCode(() => core.reloadFromSnapshot({ core_version: 99 }), 'INCOMPATIBLE_CORE_SNAPSHOT');
});

test('one expired embodiment does not disturb the other embodiments of the same assistant', () => {
 const { core, mech, alien } = bootstrap();
 promoteFact(core, mech, { statement: 'shared' });
 const restarted = restoreAssistantCore(core.snapshot(), { clock: () => LATER });
 expectCode(() => restarted.disconnectEmbodiment(alien.embodimentRef), 'EMBODIMENT_NOT_CONNECTED');
 assert.equal(restarted.assistantStatus('butler-a').active, false);
 const again = restarted.connectEmbodiment('butler-a', { deviceId: 'alien-web' });
 assert.equal(restarted.assistantStatus('butler-a').embodiments, 1);
 assert.equal(restarted.readDurable('butler-a').length, 1);
 assert.equal(restarted.assistantStatus('butler-a').coreRevision, 2);
 assert.equal(again.coreEpoch, restarted.epoch);
});

test('the assistant profile port is a versioned seam with a deterministic double', () => {
 assert.deepEqual(probeProfilePortConformance(createDeterministicProfilePort()), { ok: true, port: 'AssistantProfilePort', version: 1, missing: [], errors: [] });
 assert.equal(probeProfilePortConformance({}).ok, false);
 assert.equal(probeProfilePortConformance({ resolveProfileReference: 'no' }).missing.includes('resolveProfileReference'), true);
 assert.equal(ASSISTANT_PROFILE_PORT.core_may_store_profile_fields, false);
 assert.equal(ASSISTANT_PROFILE_PORT.integration_status, 'WAITING_FOR_BA001_BUTLER_ZONE_BINDING');
 const port = createDeterministicProfilePort({ profiles: { a: 'profile-a', b: { profile_ref: 'profile-b', profile_revision: 7 } } });
 assert.deepEqual(port.resolveProfileReference('a'), { profile_ref: 'profile-a', profile_revision: 1 });
 assert.deepEqual(port.resolveProfileReference('b'), { profile_ref: 'profile-b', profile_revision: 7 });
 assert.equal(port.resolveProfileReference('missing'), null);
 assert.deepEqual(port.describe().profiles, ['a', 'b']);
 expectCode(() => createAssistantCore({ profilePort: port }).createAssistant('unknown'), 'ASSISTANT_PROFILE_REFERENCE_REQUIRED');
 expectCode(() => newCore().createAssistant(''), 'INVALID_ASSISTANT_ID');
 expectCode(() => newCore().createAssistant('butler-x'), 'ASSISTANT_PROFILE_REFERENCE_REQUIRED');
 const single = newCore();
 single.createAssistant('butler-a');
 expectCode(() => single.createAssistant('butler-a'), 'ASSISTANT_ALREADY_EXISTS');
 assert.equal(single.assistantStatus('butler-a').coreRevision, 1);
});

test('core contract flags state the one-identity-many-projections invariant', () => {
 assert.equal(ASSISTANT_CORE_CONTRACT.one_logical_identity, true);
 assert.equal(ASSISTANT_CORE_CONTRACT.authoritative_state_per_assistant, 1);
 assert.equal(ASSISTANT_CORE_CONTRACT.transient_is_authoritative, false);
 assert.equal(ASSISTANT_CORE_CONTRACT.promotion_requires_revision_check, true);
 assert.equal(ASSISTANT_CORE_CONTRACT.recovery_invalidates_previous_sessions, true);
 assert.equal(DURABLE_KINDS.includes('CHECKPOINT'), true);
 assert.equal(DISCLOSURE_AUDIENCES.length, 3);
 assert.equal(new AssistantCoreError('X', 'y').status, 409);
 const { core, mech } = bootstrap();
 // repeated promotion from two embodiments of one assistant yields one record list
 promoteFact(core, mech, { statement: 'one' });
 assert.equal(core.readDurable('butler-a', { sinceSequence: 1 }).length, 0);
 assert.equal(core.readDurable('butler-a', { sinceSequence: 0 }).length, 1);
});
