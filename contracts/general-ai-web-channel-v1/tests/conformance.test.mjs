// GAI-003 conformance suite ¡ª General AI Web channel.
//
// Acceptance: Web is the default execution channel; persistent profile/login survives an allowed
// restart/reopen where the platform permits it; channel state is honest and typed; execution is refused in
// a non-executable state; partial output is never reported as final; and raw browser state never enters
// City state. Real-provider proof is a programme-integration gate and is recorded, never fabricated.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
 CHANNEL_STATES, DEFAULT_CHANNEL, EXECUTABLE_STATES, EXECUTION_STATES, FORBIDDEN_PERSISTED_FIELDS,
 GENERAL_AI_WEB_CHANNEL_CONTRACT, WEB_CHANNEL_ADAPTER_PORT, WEB_CHANNEL_CODES, WebChannelError,
 createWebChannel, createWebChannelAdapterDouble,
 findForbiddenPersistedFields, realProviderAcceptanceStatus
} from '../index.mjs';

const TS = '2026-09-30T12:00:00.000Z';
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected the call to fail with ${code}`);
};

/** A minimal neutral handle store double: values live here, never in the channel. */
function createDeterministicHandleStore() {
  const handles = new Map();
  let counter = 0;
  return Object.freeze({
    putHandle({ kind, value }) { counter += 1; const handle_ref = `handle:${kind}:${counter}`; handles.set(handle_ref, { kind, value }); return { handle_ref, kind }; },
    resolveHandle(handleRef) { const entry = handles.get(handleRef); if (!entry) throw new Error('unknown handle'); return { handle_ref: handleRef, kind: entry.kind, value: entry.value }; },
    __size: () => handles.size,
  });
}

const setup = ({ state = 'READY', script = [] } = {}) => {
  const handleStore = createDeterministicHandleStore();
  const profile = handleStore.putHandle({ kind: 'BROWSER_PROFILE', value: 'cookie-bytes-live-only' });
  const adapter = createWebChannelAdapterDouble({ state, script });
  const channel = createWebChannel({ adapter, handleStore, clock: () => TS });
  return { handleStore, profile, adapter, channel };
};

/* ------------------------------------------------ 1. Web is the default channel */

test('Web is the default execution channel and execution is bound to a profile handle', () => {
  const { channel, profile } = setup();
  const session = channel.open({ providerRef: 'provider-alpha', accountRef: 'account-1', profileHandleRef: profile.handle_ref });
  assert.equal(session.provider_ref, 'provider-alpha');
  assert.equal(session.profile_handle_ref, profile.handle_ref);
  assert.equal(session.raw_cookies_in_state, false);
  assert.equal(channel.provider.default_channel, DEFAULT_CHANNEL);
  const started = channel.execute(session.session_ref, { request: { request_ref: 'request-1' } });
  assert.equal(started.channel, 'WEB');
  assert.equal(started.accepted, true);
  assert.equal(DEFAULT_CHANNEL, 'WEB');
  assert.equal(GENERAL_AI_WEB_CHANNEL_CONTRACT.default_channel, 'WEB');
  assert.equal(GENERAL_AI_WEB_CHANNEL_CONTRACT.execution_bound_to_ephemeral_windows, false);
  assert.equal(WEB_CHANNEL_ADAPTER_PORT.provider_neutral, true);
  assert.equal(WEB_CHANNEL_ADAPTER_PORT.reimplements_remote_mouse_logic, false);
  assert.equal(WEB_CHANNEL_ADAPTER_PORT.uses_generic_computer_use_primitives, true);
});

/* ------------------------------------------------ 2. honest channel state */

test('a channel state that cannot execute is a typed refusal', () => {
  const cases = [
    ['AUTH_REQUIRED', 'CHANNEL_AUTH_REQUIRED'],
    ['RATE_LIMITED', 'CHANNEL_RATE_LIMITED'],
    ['PAGE_CHANGED', 'CHANNEL_PAGE_CHANGED'],
    ['BUSY_GENERATING', 'CHANNEL_BUSY'],
    ['DOWN', 'CHANNEL_DOWN'],
    ['UNKNOWN', 'CHANNEL_UNKNOWN'],
  ];
  for (const [state, code] of cases) {
    const { channel, profile } = setup({ state });
    const session = channel.open({ providerRef: 'provider-alpha', profileHandleRef: profile.handle_ref });
    assert.equal(session.state, state, state);
    assert.equal(channel.healthy(session.session_ref).state, state);
    expectCode(() => channel.execute(session.session_ref, { request: { request_ref: 'request-1' } }), code);
  }
  // only READY executes
  assert.deepEqual([...EXECUTABLE_STATES], ['READY']);
  assert.deepEqual([...CHANNEL_STATES], ['READY', 'AUTH_REQUIRED', 'RATE_LIMITED', 'PAGE_CHANGED', 'BUSY_GENERATING', 'DOWN', 'UNKNOWN']);
  // a state change is observed on the next touch, so a stale READY cannot be used
  const { channel, adapter, profile } = setup();
  const session = channel.open({ providerRef: 'provider-alpha', profileHandleRef: profile.handle_ref });
  adapter.__setState('AUTH_REQUIRED');
  expectCode(() => channel.execute(session.session_ref, { request: { request_ref: 'request-2' } }), 'CHANNEL_AUTH_REQUIRED');
  assert.equal(GENERAL_AI_WEB_CHANNEL_CONTRACT.partial_reported_as_final, false);
});

/* ------------------------------------------------ 3. partial vs final */

test('partial output is never reported as the final result', () => {
  const { channel, profile } = setup({ script: [{ partials: ['thinking', 'working'], final: { text: 'the answer' } }] });
  const session = channel.open({ providerRef: 'provider-alpha', profileHandleRef: profile.handle_ref });
  const started = channel.execute(session.session_ref, { request: { request_ref: 'request-1' } });
  const observing = channel.observe(started.execution_ref);
  assert.equal(observing.state, 'RUNNING');
  assert.deepEqual(observing.partials, ['thinking', 'working']);
  assert.equal(observing.final, null, 'a running execution has no final result');
  assert.equal(observing.partial_is_final, false);
  const completed = channel.complete(started.execution_ref);
  assert.equal(completed.state, 'SUCCEEDED');
  assert.deepEqual(completed.final, { text: 'the answer' });
  assert.equal(completed.conversation_ref, 'conversation-1', 'the thread reference is captured for reopening');
  assert.equal(completed.partial_is_final, false);
  expectCode(() => channel.complete(started.execution_ref), 'EXECUTION_ALREADY_FINISHED');
  assert.deepEqual([...EXECUTION_STATES], ['RUNNING', 'CANCELLED', 'SUCCEEDED', 'FAILED']);
});

test('cancel is typed and idempotent', () => {
  const { channel, profile } = setup();
  const session = channel.open({ providerRef: 'provider-alpha', profileHandleRef: profile.handle_ref });
  const started = channel.execute(session.session_ref, { request: { request_ref: 'request-1' } });
  const cancelled = channel.cancel(started.execution_ref);
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.idempotent, false);
  const again = channel.cancel(started.execution_ref);
  assert.equal(again.cancelled, false);
  assert.equal(again.idempotent, true);
  assert.equal(channel.observe(started.execution_ref).final, null);
  expectCode(() => channel.observe('web-execution-99'), 'UNKNOWN_EXECUTION');
  expectCode(() => channel.execute('web-session-99', { request: { request_ref: 'x' } }), 'UNKNOWN_SESSION');
  expectCode(() => channel.execute(session.session_ref, {}), 'INVALID_WEB_REQUEST');
});

/* ------------------------------------------------ 4. restart / persistence */

test('a persistent login survives an allowed restart when the profile handle still resolves', () => {
  const { channel, handleStore, profile } = setup();
  const session = channel.open({ providerRef: 'provider-alpha', accountRef: 'account-1', profileHandleRef: profile.handle_ref });
  const started = channel.execute(session.session_ref, { request: { request_ref: 'request-1' } });
  channel.complete(started.execution_ref);
  const persisted = channel.persist(session.session_ref);
  assert.equal(persisted.profile_handle_ref, profile.handle_ref);
  assert.deepEqual(persisted.conversation_refs, ['conversation-1']);
  assert.equal(JSON.stringify(persisted).includes('cookie-bytes-live-only'), false, 'the raw profile value stays in the store');

  // a fresh channel object stands in for a host restart
  const restartedAdapter = createWebChannelAdapterDouble({});
  const restarted = createWebChannel({ adapter: restartedAdapter, handleStore, clock: () => TS });
  const restored = restarted.restore(persisted);
  assert.equal(restored.restored, true);
  assert.equal(restored.state, 'READY');
  assert.deepEqual(restored.conversation_refs, ['conversation-1'], 'the conversation reopens');
  assert.equal(restarted.execute(restored.session_ref, { request: { request_ref: 'request-2' } }).accepted, true);
  assert.equal(GENERAL_AI_WEB_CHANNEL_CONTRACT.restart_restore_requires_resolvable_handle, true);
});

test('a profile that cannot be resolved reports AUTH_REQUIRED instead of a silent fresh login', () => {
  const { channel, profile } = setup();
  const session = channel.open({ providerRef: 'provider-alpha', profileHandleRef: profile.handle_ref });
  const persisted = channel.persist(session.session_ref);
  // the store no longer knows the handle (for example the platform refused to persist the profile)
  const emptyStore = createDeterministicHandleStore();
  const restarted = createWebChannel({ adapter: createWebChannelAdapterDouble({}), handleStore: emptyStore, clock: () => TS });
  const restored = restarted.restore(persisted);
  assert.equal(restored.restored, false);
  assert.equal(restored.state, 'AUTH_REQUIRED');
  assert.equal(restored.reason, 'PROFILE_HANDLE_UNRESOLVED');
  assert.equal(WEB_CHANNEL_ADAPTER_PORT.methods.includes('recover'), true);
});

/* ------------------------------------------------ 5. no raw browser state */

test('raw cookies, storage and tokens never enter persisted City state', () => {
  const { channel, profile } = setup();
  const session = channel.open({ providerRef: 'provider-alpha', profileHandleRef: profile.handle_ref });
  const persisted = channel.persist(session.session_ref);
  assert.deepEqual(findForbiddenPersistedFields(persisted), []);
  expectCode(() => channel.restore({ ...persisted, cookies: [{ name: 'sid', value: 'x' }] }), 'RAW_COOKIE_IN_CITY_STATE');
  expectCode(() => channel.restore({ ...persisted, storage_state: { origins: [] } }), 'RAW_COOKIE_IN_CITY_STATE');
  assert.deepEqual(findForbiddenPersistedFields({ nested: { local_storage: {} } }, ''), ['.nested.local_storage']);
  assert.equal(FORBIDDEN_PERSISTED_FIELDS.includes('cookies'), true);
  assert.equal(GENERAL_AI_WEB_CHANNEL_CONTRACT.raw_cookies_in_city_state, false);
  expectCode(() => channel.open({ providerRef: 'provider-alpha' }), 'INVALID_WEB_REQUEST');
  expectCode(() => createWebChannel({ handleStore: { resolveHandle: () => ({}) } }), 'ADAPTER_REQUIRED');
  const { handleStore } = setup();
  expectCode(() => createWebChannel({ adapter: createWebChannelAdapterDouble({}) }), 'HANDLE_STORE_REQUIRED');
  assert.equal(GENERAL_AI_WEB_CHANNEL_CONTRACT.profile_handle_store, 'neutral 00-Foundation SecureHandleStorePort');
  assert.equal(handleStore.__size(), 1);
});

/* ------------------------------------------------ 6. real-provider honesty */

test('real-provider acceptance is recorded, never fabricated', () => {
  const deferred = realProviderAcceptanceStatus({ providerAvailable: false });
  assert.equal(deferred.status, 'REAL_PROVIDER_ACCEPTANCE_DEFERRED_TO_PROGRAMME_INTEGRATION');
  assert.equal(deferred.fabricated, false);
  assert.equal(deferred.evidence_ref, null);
  // an available provider without a concrete evidence reference is still not a performed acceptance
  assert.equal(realProviderAcceptanceStatus({ providerAvailable: true }).status, 'REAL_PROVIDER_ACCEPTANCE_DEFERRED_TO_PROGRAMME_INTEGRATION');
  assert.equal(realProviderAcceptanceStatus({ providerAvailable: true, evidenceRef: 'run-1' }).status, 'PERFORMED');
  assert.equal(GENERAL_AI_WEB_CHANNEL_CONTRACT.real_provider_acceptance, 'PROGRAMME_INTEGRATION_GATE');
  assert.equal(new Set(WEB_CHANNEL_CODES).size, WEB_CHANNEL_CODES.length);
  assert.equal(new WebChannelError('X', 'y').status, 409);
  assert.equal(GENERAL_AI_WEB_CHANNEL_CONTRACT.provider_page_knowledge_location, 'BELOW_THE_ADAPTER');
});

/* --------------------------------- 8. regressions (Correction, host Alien) */
// Every refusal is paired with the legitimate neighbour that must still pass.

import { createWebChannel as makeChannel, createWebChannelAdapterDouble as makeAdapter, isIsoInstant as instantOk, findForbiddenPersistedFields as scanForbidden } from '../index.mjs';

const handlesFor = refs => new Map(refs.map(ref => [ref, { handle_ref: ref }]));
const harness = (refs = ['handle-A', 'handle-B']) => {
  const handles = handlesFor(refs);
  const adapter = makeAdapter({ state: 'READY' });
  return { adapter, channel: makeChannel({ adapter, handleStore: { resolveHandle: ref => handles.get(ref) || null }, clock: () => null }) };
};

test('a restore may not take over a live session', () => {
  const { channel } = harness();
  const live = channel.open({ providerRef: 'provider-alpha', profileHandleRef: 'handle-A' });
  const error = expectCode(() => channel.restore({ web_channel_version: 1, session_ref: live.session_ref, provider_ref: 'provider-beta', account_ref: 'account-someone-else', profile_handle_ref: 'handle-B', conversation_refs: ['conversation-from-another-account'] }), 'INVALID_WEB_REQUEST');
  assert.equal(error.message.includes('already live'), true);
  assert.equal(channel.persist(live.session_ref).provider_ref, 'provider-alpha', 'the live session keeps its own provider');
  assert.equal(channel.persist(live.session_ref).profile_handle_ref, 'handle-A');
  assert.deepEqual([...channel.conversations(live.session_ref)], []);
  // neighbours: a restore onto an unused ref still works, and it reports the session it created
  const restored = channel.restore({ web_channel_version: 1, session_ref: 'web-session-9', profile_handle_ref: 'handle-B', conversation_refs: ['conversation-9'] });
  assert.equal(restored.restored, true);
  assert.equal(restored.session_ref, 'web-session-9');
  assert.deepEqual([...channel.conversations('web-session-9').map(entry => entry.session_ref)], ['web-session-9']);
});

test('a persisted state must be this module version and cannot hide raw browser state', () => {
  const { channel } = harness();
  expectCode(() => channel.restore({ web_channel_version: 999, session_ref: 's-1', profile_handle_ref: 'handle-A', conversation_refs: [] }), 'INVALID_WEB_REQUEST');
  expectCode(() => channel.restore({ session_ref: 's-2', profile_handle_ref: 'handle-A', conversation_refs: [] }), 'INVALID_WEB_REQUEST');
  const sneaky = { web_channel_version: 1, session_ref: 's-3', profile_handle_ref: 'handle-A', conversation_refs: [] };
  Object.defineProperty(sneaky, 'cookies', { value: 'RAW-COOKIE-BYTES', enumerable: false, configurable: true, writable: true });
  assert.deepEqual([...scanForbidden(sneaky)], ['state.cookies'], 'a non-enumerable own cookie field is still raw browser state');
  expectCode(() => channel.restore(sneaky), 'RAW_COOKIE_IN_CITY_STATE');
  // neighbours: the enumerable form is refused too, and a clean version-1 state is accepted
  expectCode(() => channel.restore({ web_channel_version: 1, session_ref: 's-4', profile_handle_ref: 'handle-A', conversation_refs: [], cookies: 'RAW' }), 'RAW_COOKIE_IN_CITY_STATE');
  assert.equal(harness().channel.restore({ web_channel_version: 1, session_ref: 's-5', profile_handle_ref: 'handle-A', conversation_refs: [] }).restored, true);
});

test('a persisted instant must be a real instant', () => {
  const { channel } = harness();
  expectCode(() => channel.restore({ web_channel_version: 1, session_ref: 's-6', profile_handle_ref: 'handle-A', conversation_refs: [], opened_at: 'nonsense' }), 'INVALID_WEB_REQUEST');
  expectCode(() => channel.restore({ web_channel_version: 1, session_ref: 's-7', profile_handle_ref: 'handle-A', conversation_refs: [], opened_at: 1e21 }), 'INVALID_WEB_REQUEST');
  expectCode(() => harness().channel.open({ providerRef: 'provider-alpha', profileHandleRef: 'handle-A', at: 'nonsense' }), 'INVALID_WEB_REQUEST');
  expectCode(() => harness().channel.open({ providerRef: 'provider-alpha', profileHandleRef: 'handle-A', at: '2026-13-45T99:99:99Z' }), 'INVALID_WEB_REQUEST');
  // neighbours: real instants are accepted and stored, and unresolved handles are still AUTH_REQUIRED
  const opened = harness().channel.open({ providerRef: 'provider-alpha', profileHandleRef: 'handle-A', at: '2026-09-30T12:00:00.000Z' });
  assert.equal(opened.opened_at, '2026-09-30T12:00:00.000Z');
  assert.equal(instantOk('2026-13-45T99:99:99Z'), false);
  assert.equal(instantOk('2026-09-30T12:00:00Z'), true);
  assert.equal(harness().channel.restore({ web_channel_version: 1, session_ref: 's-8', profile_handle_ref: 'handle-missing', conversation_refs: [] }).state, 'AUTH_REQUIRED');
});
test('a persisted state must be a bare own-property object, and accountRef a reference', () => {
  const { channel } = harness();
  const inherited = Object.assign(Object.create({ profile_handle_ref: 'handle-A', session_ref: 's-inherited' }), { web_channel_version: 1 });
  expectCode(() => channel.restore(inherited), 'INVALID_WEB_REQUEST');
  class Persisted { constructor() { Object.assign(this, { web_channel_version: 1, session_ref: 's-class', profile_handle_ref: 'handle-A' }); } }
  expectCode(() => channel.restore(new Persisted()), 'INVALID_WEB_REQUEST');
  assert.equal(harness().channel.restore(Object.assign(Object.create(null), { web_channel_version: 1, session_ref: 's-null', profile_handle_ref: 'handle-A' })).restored, true);
  // accountRef may be null or a reference, never raw credential material
  expectCode(() => harness().channel.open({ providerRef: 'provider-alpha', profileHandleRef: 'handle-A', accountRef: 'ghp_0123456789abcdefghijklmnopqrstuvwxyz' }), 'INVALID_WEB_REQUEST');
  expectCode(() => harness().channel.open({ providerRef: 'provider-alpha', profileHandleRef: 'handle-A', accountRef: 'a b c' }), 'INVALID_WEB_REQUEST');
  assert.equal(harness().channel.open({ providerRef: 'provider-alpha', profileHandleRef: 'handle-A', accountRef: 'account-1' }).account_ref, 'account-1');
  assert.equal(harness().channel.open({ providerRef: 'provider-alpha', profileHandleRef: 'handle-A' }).account_ref, null);
});

test('a completion whose session is gone is refused, and case-variant raw state is still raw state', () => {
  const { channel } = harness();
  const live = channel.open({ providerRef: 'provider-alpha', profileHandleRef: 'handle-A' });
  channel.execute(live.session_ref, { request: { request_ref: 'req-1' } });
  channel.close(live.session_ref);
  expectCode(() => channel.complete('web-execution-1'), 'UNKNOWN_SESSION');
  assert.equal(channel.observe('web-execution-1').state, 'RUNNING', 'the execution was not marked successful');
  // neighbours: a live session still completes and records the thread
  const other = harness();
  const s = other.channel.open({ providerRef: 'provider-alpha', profileHandleRef: 'handle-A' });
  other.channel.execute(s.session_ref, { request: { request_ref: 'req-2' } });
  assert.equal(other.channel.complete('web-execution-1').state, 'SUCCEEDED');
  assert.deepEqual([...other.channel.conversations(s.session_ref).map(entry => entry.conversation_ref)], ['conversation-1']);
  // case variants of a raw-state name are the same raw state
  assert.deepEqual([...scanForbidden({ Cookies: 'raw' })], ['state.Cookies']);
  expectCode(() => harness().channel.restore({ web_channel_version: 1, session_ref: 's-case', profile_handle_ref: 'handle-A', Cookies: 'raw' }), 'RAW_COOKIE_IN_CITY_STATE');
  assert.deepEqual([...scanForbidden({ profile_handle_ref: 'h', conversation_refs: [] })], []);
});