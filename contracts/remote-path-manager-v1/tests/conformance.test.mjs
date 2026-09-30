// Conformance tests for RF-006 — secure transport path manager + relay fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DIRECT_CLASSES, PATH_PREFERENCE, PathManagerError, RELAY_MODE, TRANSPORT_ADAPTER_PORT, TRANSPORT_CLASSES,
  createPathManager, findSecretFields,
} from '../index.mjs';

const T0 = '2026-01-01T00:00:00Z';
const TRUST = { device_id: 'device:peer-a', installation_id: 'installation:1', trust_state: 'TRUSTED' };
const PEER = { device_id: 'device:peer-a', installation_id: 'installation:1' };
const ENVELOPE = { protected: true, payload_ref: 'blob:1', nonce: 'n-1' };

/**
 * A transport adapter double. `behaviour` decides availability and whether the adapter is honest about
 * authentication/encryption, so a test can swap a whole transport implementation.
 */
function adapterFor(transport_class, behaviour = {}) {
  const calls = { probe: 0, connect: 0, send: 0, close: 0 };
  const sent = [];
  let counter = 0;
  return {
    calls,
    sent,
    adapter: {
      transport_class,
      probe() { calls.probe += 1; return behaviour.available === false ? { available: false, reason: behaviour.reason ?? 'NOT_AVAILABLE' } : { available: true, latency_ms: behaviour.latency_ms ?? 5 }; },
      connect() {
        calls.connect += 1;
        if (behaviour.failConnect) throw new Error('connect failed');
        counter += 1;
        return {
          path_ref: `path:${transport_class}:${counter}`,
          authenticated: behaviour.authenticated !== false,
          encrypted: behaviour.encrypted !== false,
          peer_authorized: behaviour.peer_authorized === true,
          plaintext_access: behaviour.plaintext_access === true,
          latency_ms: behaviour.latency_ms ?? 5,
          quality: behaviour.quality ?? 'GOOD',
          transport_ref: `${behaviour.label ?? transport_class}-impl`,
        };
      },
      send({ envelope, relay_plaintext_access }) { calls.send += 1; sent.push({ envelope, relay_plaintext_access }); return { accepted: true, bytes: JSON.stringify(envelope).length }; },
      close() { calls.close += 1; return { closed: true }; },
    },
  };
}

const managerWith = (spec = {}, policy = {}) => {
  const built = {};
  for (const transport_class of TRANSPORT_CLASSES) {
    if (spec[transport_class] === null) continue;
    built[transport_class] = adapterFor(transport_class, spec[transport_class] ?? {}).adapter;
  }
  return createPathManager({ adapters: built, clock: () => T0, policy });
};

const failure = operation => {
  try {
    operation();
  } catch (error) {
    assert.ok(error instanceof PathManagerError, `expected a PathManagerError, got ${error?.name}: ${error?.message}`);
    return error;
  }
  throw new Error('expected a refusal, but nothing was thrown');
};

test('callers use one Fabric surface while the transport implementation is swapped underneath', () => {
  const directOnly = managerWith({ NAT_TRAVERSAL: null, RELAY: null });
  const relayOnly = managerWith({ LAN_DIRECT: null, INTERNET_DIRECT: null, NAT_TRAVERSAL: null });

  // The same caller code runs against both implementations.
  const sessionFor = manager => {
    const session = manager.connect({ peer: PEER, trust: TRUST, session_intent: 'EXCLUSIVE', exclusive_action_key: 'action:1' });
    const sent = manager.send({ session_ref: session.session_ref, envelope: ENVELOPE, command_ref: 'command:1', action_key: 'action:1' });
    const metadata = manager.pathMetadata({ session_ref: session.session_ref });
    manager.close({ session_ref: session.session_ref });
    return { session, sent, metadata };
  };
  const viaDirect = sessionFor(directOnly);
  const viaRelay = sessionFor(relayOnly);

  assert.equal(viaDirect.session.path.transport_class, 'LAN_DIRECT');
  assert.equal(viaDirect.session.path.direct, true);
  assert.equal(viaRelay.session.path.transport_class, 'RELAY');
  assert.equal(viaRelay.session.path.relay, true);
  // The caller saw one normalized descriptor shape in both cases.
  assert.deepEqual(Object.keys(viaDirect.session.path).sort(), Object.keys(viaRelay.session.path).sort());
  assert.deepEqual(Object.keys(viaDirect.sent).sort(), Object.keys(viaRelay.sent).sort());
  assert.equal(viaDirect.sent.sent, true);
  assert.equal(viaRelay.sent.sent, true);
  assert.equal(TRANSPORT_ADAPTER_PORT.interface, 'TransportAdapterPort');
  assert.equal(TRANSPORT_ADAPTER_PORT.carries_business_semantics, false);
  assert.deepEqual([...TRANSPORT_CLASSES], ['LAN_DIRECT', 'INTERNET_DIRECT', 'NAT_TRAVERSAL', 'RELAY']);
  assert.deepEqual([...DIRECT_CLASSES], ['LAN_DIRECT', 'INTERNET_DIRECT', 'NAT_TRAVERSAL']);
});

test('path selection prefers a usable direct route and falls back to relay honestly', () => {
  const manager = managerWith({ LAN_DIRECT: { available: false, reason: 'NO_LOCAL_NETWORK' }, INTERNET_DIRECT: { available: false }, NAT_TRAVERSAL: { available: false } });
  assert.deepEqual([...PATH_PREFERENCE], ['LAN_DIRECT', 'INTERNET_DIRECT', 'NAT_TRAVERSAL', 'RELAY']);
  const candidates = manager.candidatesFor({ peer: PEER, trust: TRUST });
  assert.deepEqual(candidates.map(entry => [entry.transport_class, entry.available]), [
    ['LAN_DIRECT', false], ['INTERNET_DIRECT', false], ['NAT_TRAVERSAL', false], ['RELAY', true],
  ]);
  assert.equal(candidates[0].reason, 'NO_LOCAL_NETWORK');

  const session = manager.connect({ peer: PEER, trust: TRUST });
  assert.equal(session.path.transport_class, 'RELAY');
  assert.equal(session.selection_reason, 'RELAY_FALLBACK');
  assert.equal(session.relay_used, true);
  assert.equal(session.direct_preferred, false);
  assert.equal(session.path.relay_mode, RELAY_MODE);
  assert.equal(session.path.direct, false);
  assert.deepEqual(session.attempts.filter(entry => entry.adopted).map(entry => entry.transport_class), ['RELAY']);
  assert.equal(session.attempts.filter(entry => entry.adopted !== true).length, 3);

  // When a direct path is usable it wins, even with relay available.
  const direct = managerWith({ LAN_DIRECT: { latency_ms: 1 } });
  const preferred = direct.connect({ peer: PEER, trust: TRUST });
  assert.equal(preferred.path.transport_class, 'LAN_DIRECT');
  assert.equal(preferred.selection_reason, 'PREFERRED_DIRECT');
  assert.equal(preferred.relay_used, false);
  assert.equal(preferred.path.path_quality_grants_permission, false);
  assert.equal(preferred.permission_granted, false, 'path quality and reachability are never permission');

  // An unusable LAN class does not make the LAN path silently mandatory.
  const noTrust = failure(() => manager.connect({ peer: PEER, trust: { device_id: 'device:peer-a', trust_state: 'UNPAIRED' } }));
  assert.equal(noTrust.code, 'TRUST_REQUIRED');
  assert.equal(noTrust.status, 409);
  assert.equal(failure(() => manager.connect({ peer: {}, trust: TRUST })).code, 'INVALID_PEER');
  assert.equal(failure(() => managerWith({}, { preference: ['TELEPATHY'] })).code, 'INVALID_ADAPTER');
});

test('an unauthenticated or unencrypted path is never adopted, not even on the LAN', () => {
  // A LAN path that is not authenticated must be refused, and the manager must not fall back to it later.
  // Every other class is unavailable here, so the only candidates are the two dishonest ones.
  const manager = managerWith({ LAN_DIRECT: { authenticated: false }, INTERNET_DIRECT: { encrypted: false }, NAT_TRAVERSAL: null, RELAY: null });
  const refused = failure(() => manager.connect({ peer: PEER, trust: TRUST }));
  assert.equal(refused.attempts[0].reason, 'UNAUTHENTICATED_PATH_REFUSED');
  assert.equal(refused.attempts[1].reason, 'PLAINTEXT_PATH_REFUSED');
  assert.equal(refused.degraded, true);
  assert.equal(refused.connected, false);
  assert.equal(refused.status, 409);
  assert.equal(manager.auditTrail().some(entry => entry.event === 'PATH_REFUSED_UNAUTHENTICATED'), true);
  assert.equal(manager.auditTrail().some(entry => entry.event === 'PATH_REFUSED_PLAINTEXT'), true);

  // A relay path held to the same requirement.
  const relayOnly = managerWith({ LAN_DIRECT: null, INTERNET_DIRECT: null, NAT_TRAVERSAL: null, RELAY: { authenticated: false } });
  const relayRefused = failure(() => relayOnly.connect({ peer: PEER, trust: TRUST }));
  assert.equal(relayRefused.attempts.find(entry => entry.transport_class === 'RELAY').reason, 'UNAUTHENTICATED_PATH_REFUSED', 'a relay is not exempt from authentication');

  // With one honest path available the manager skips the dishonest ones and adopts the honest one.
  const mixed = managerWith({ LAN_DIRECT: { authenticated: false }, INTERNET_DIRECT: {} });
  const session = mixed.connect({ peer: PEER, trust: TRUST });
  assert.equal(session.path.transport_class, 'INTERNET_DIRECT');
  assert.equal(session.path.authenticated, true);
  assert.equal(session.path.encrypted, true);
  assert.equal(session.attempts[0].adopted, false);
});

test('a relay forwards opaque payloads and can never authorize a peer', () => {
  const relaying = managerWith({ LAN_DIRECT: null, INTERNET_DIRECT: null, NAT_TRAVERSAL: null, RELAY: {} });
  const session = relaying.connect({ peer: PEER, trust: TRUST });
  assert.equal(session.path.relay, true);
  assert.equal(session.path.relay_mode, 'OPAQUE_FORWARD');
  assert.equal(session.path.relay_plaintext_access, false);
  const sent = relaying.send({ session_ref: session.session_ref, envelope: ENVELOPE, command_ref: 'command:1' });
  assert.equal(sent.relay_plaintext_access, false, 'the relay is told it has no plaintext access');
  assert.equal(sent.permission_granted, false);

  // A plaintext payload may not be handed to any path, and certainly not to a relay.
  const plaintext = failure(() => relaying.send({ session_ref: session.session_ref, envelope: { plaintext: true, body: 'secret' }, command_ref: 'command:2' }));
  assert.equal(plaintext.code, 'PAYLOAD_MUST_BE_PROTECTED');
  assert.equal(failure(() => relaying.send({ session_ref: session.session_ref, envelope: { protected: false }, command_ref: 'command:3' })).code, 'PAYLOAD_MUST_BE_PROTECTED');

  // A relay that claims to have authorized the peer is refused outright.
  for (const hostile of [{ peer_authorized: true }, { plaintext_access: true }]) {
    const hostileManager = managerWith({ LAN_DIRECT: null, INTERNET_DIRECT: null, NAT_TRAVERSAL: null, RELAY: hostile });
    const refusal = failure(() => hostileManager.connect({ peer: PEER, trust: TRUST }));
    assert.equal(refusal.code, 'RELAY_CANNOT_AUTHORIZE');
    assert.equal(hostileManager.auditTrail().some(entry => entry.event === 'RELAY_AUTHORIZATION_REFUSED'), true);
  }
  // Relay is not mandatory: policy can disable it, and then a missing direct path is an honest failure.
  const relayDisabled = managerWith({ LAN_DIRECT: null, INTERNET_DIRECT: null, NAT_TRAVERSAL: null }, { allow_relay: false });
  const disabled = failure(() => relayDisabled.connect({ peer: PEER, trust: TRUST }));
  assert.equal(disabled.code, 'NO_USABLE_PATH');
  assert.equal(disabled.attempts.some(entry => entry.reason === 'RELAY_DISABLED_BY_POLICY'), true);
});

test('path loss migrates without a new logical device or a duplicated command', () => {
  const built = {};
  const doubles = {};
  for (const transport_class of TRANSPORT_CLASSES) {
    if (transport_class === 'NAT_TRAVERSAL') continue;
    const double = adapterFor(transport_class, transport_class === 'LAN_DIRECT' ? {} : {});
    doubles[transport_class] = double;
    built[transport_class] = double.adapter;
  }
  const manager = createPathManager({ adapters: built, clock: () => T0 });
  const session = manager.connect({ peer: PEER, trust: TRUST, session_intent: 'EXCLUSIVE', exclusive_action_key: 'action:1' });
  assert.equal(session.path.transport_class, 'LAN_DIRECT');
  const firstSend = manager.send({ session_ref: session.session_ref, envelope: ENVELOPE, command_ref: 'command:1', action_key: 'action:1' });
  assert.equal(firstSend.sent, true);

  const lost = manager.onPathLost({ path_ref: session.path.path_ref });
  assert.equal(lost.reported, true);
  assert.equal(lost.connected, false);
  assert.equal(lost.device_changed, false);
  assert.equal(lost.session_ref, session.session_ref);
  assert.equal(lost.alternative_available, true);

  const migrated = manager.migrate({ session_ref: session.session_ref, reason: 'PATH_LOST' });
  assert.equal(migrated.session_ref, session.session_ref, 'the logical session is unchanged');
  assert.equal(migrated.device_id, session.device_id, 'the logical device is unchanged');
  assert.equal(migrated.logical_device_changed, false);
  assert.equal(migrated.path_derived_identity, false);
  assert.equal(migrated.migrated_from, 'LAN_DIRECT');
  assert.equal(migrated.migrated_to, 'INTERNET_DIRECT');
  assert.equal(migrated.commands_replayed, false);
  assert.equal(migrated.concurrent_authoritative_sessions, 1);
  assert.equal(migrated.old_path_closed, true);
  assert.equal(doubles.LAN_DIRECT.calls.close, 1);
  assert.equal(manager.sessionFor(PEER.device_id).session_ref, session.session_ref);

  // Replaying the command that was already delivered is refused rather than resent.
  const duplicate = manager.send({ session_ref: session.session_ref, envelope: ENVELOPE, command_ref: 'command:1', action_key: 'action:1' });
  assert.equal(duplicate.sent, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.adapter_called, false);
  assert.equal(duplicate.side_effect_repeated, false);
  assert.equal(doubles.INTERNET_DIRECT.calls.send, 0, 'a failover retry did not duplicate the command');
  const next = manager.send({ session_ref: session.session_ref, envelope: ENVELOPE, command_ref: 'command:2', action_key: 'action:1' });
  assert.equal(next.sent, true);
  assert.equal(doubles.INTERNET_DIRECT.calls.send, 1);

  // When nothing is left the failure is honest and the session is not silently "connected".
  const stranded = createPathManager({ adapters: { LAN_DIRECT: doubles.LAN_DIRECT.adapter }, clock: () => T0 });
  const lonely = stranded.connect({ peer: PEER, trust: TRUST });
  stranded.onPathLost({ path_ref: lonely.path.path_ref });
  const exhausted = failure(() => stranded.migrate({ session_ref: lonely.session_ref }));
  assert.equal(exhausted.code, 'NO_USABLE_PATH');
  assert.equal(exhausted.degraded, true);
  assert.equal(exhausted.connected, false);
  assert.equal(exhausted.authoritative_sessions, 1);
});

test('one exclusive action can never end up with two authoritative sessions', () => {
  const manager = managerWith({});
  const first = manager.connect({ peer: PEER, trust: TRUST, session_intent: 'EXCLUSIVE', exclusive_action_key: 'action:1' });
  // A racing second connect for the same action is idempotent, not a second session.
  const raced = manager.connect({ peer: PEER, trust: TRUST, session_intent: 'EXCLUSIVE', exclusive_action_key: 'action:1' });
  assert.equal(raced.reused, true);
  assert.equal(raced.session_ref, first.session_ref);
  assert.equal(raced.selection_reason, 'REUSED_SESSION');
  assert.equal(raced.authoritative_sessions, 1);
  assert.equal(manager.sessions().length, 1);

  // A different exclusive action for the same device is refused rather than doubled.
  const conflicting = failure(() => manager.connect({ peer: PEER, trust: TRUST, session_intent: 'EXCLUSIVE', exclusive_action_key: 'action:2' }));
  assert.equal(conflicting.code, 'SESSION_ALREADY_ACTIVE');
  assert.equal(conflicting.concurrent_authoritative_sessions, 1);
  assert.equal(conflicting.session_ref, first.session_ref);
  assert.equal(failure(() => manager.connect({ peer: PEER, trust: TRUST, session_intent: 'EXCLUSIVE' })).code, 'ACTION_KEY_REQUIRED');
  assert.equal(failure(() => manager.connect({ peer: PEER, trust: TRUST, session_intent: 'MAYBE' })).code, 'INVALID_REQUEST');
  assert.equal(failure(() => manager.send({ session_ref: first.session_ref, envelope: ENVELOPE, command_ref: 'command:1' })).code, 'ACTION_KEY_REQUIRED');
  assert.equal(manager.sessions().length, 1, 'a refused race created no session');

  // Closing releases the peer so a later, genuinely new session can be opened.
  manager.close({ session_ref: first.session_ref });
  assert.equal(manager.sessionFor(PEER.device_id), null);
  const second = manager.connect({ peer: PEER, trust: TRUST, session_intent: 'EXCLUSIVE', exclusive_action_key: 'action:2' });
  assert.notEqual(second.session_ref, first.session_ref);
  assert.equal(second.exclusive_action_key, 'action:2');
  assert.equal(failure(() => manager.migrate({ session_ref: 'session:nope' })).status, 404);
  assert.equal(failure(() => manager.send({ session_ref: 'session:nope', envelope: ENVELOPE, command_ref: 'c' })).code, 'UNKNOWN_SESSION');
  assert.equal(failure(() => manager.onPathLost({ path_ref: 'path:nope' })).code, 'UNKNOWN_PATH');
});

test('path metadata is bounded, secret-free and frozen', () => {
  const manager = managerWith({});
  const session = manager.connect({ peer: PEER, trust: TRUST });
  const metadata = manager.pathMetadata({ session_ref: session.session_ref });
  assert.deepEqual(findSecretFields(metadata), [], 'path metadata carries no key material or tokens');
  for (const forbidden of ['session_key', 'secret', 'token', 'psk', 'key_material', 'credential_ref']) {
    assert.equal(JSON.stringify(metadata).includes(forbidden), false, `metadata must not expose ${forbidden}`);
  }
  assert.equal(metadata.identifies_device, false, 'a path is not an identity');
  assert.equal(metadata.authenticated, true);
  assert.equal(metadata.encrypted, true);
  assert.equal(metadata.quality, 'GOOD');
  assert.equal(metadata.latency_ms, 5);

  assert.throws(() => { metadata.path_ref = 'path:hijacked'; }, TypeError, 'descriptors are frozen');
  assert.throws(() => { session.path.transport_class = 'RELAY'; }, TypeError);
  const sent = manager.send({ session_ref: session.session_ref, envelope: ENVELOPE, command_ref: 'command:1' });
  assert.throws(() => { sent.sent = false; }, TypeError);

  assert.equal(failure(() => manager.connect({ peer: PEER, trust: TRUST, nickname: 'x' })).code, 'SESSION_ALREADY_ACTIVE', 'the existing session is protected before anything else');
  assert.equal(failure(() => createPathManager({ adapters: 'nope' })).code, 'INVALID_ADAPTER');
  assert.equal(failure(() => createPathManager({ adapters: {}, clock: 'now' })).code, 'INVALID_CLOCK');
  assert.throws(() => createPathManager({ adapters: {}, policy: { preference: [] } }), error => error.code === 'INVALID_ADAPTER');
  const other = managerWith({});
  assert.equal(other.sessions().length, 0, 'managers share no state');
  assert.equal(manager.policy().policy_ref, 'policy:rf-path-default');
  assert.equal(manager.transportPort().methods.includes('connect'), true);
});
