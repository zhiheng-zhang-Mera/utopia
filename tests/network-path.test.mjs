// Cross-network reachability: which mechanism applies, and where the honest limits are.
//
// The point of these tests is NOT that the module can pick a mechanism - it is that it refuses to pretend a path
// exists when none does, and that it names the Owner decision instead of spinning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { OWNER_AUTHORITY, PATHS, choosePath, planGroupPaths } from '../apps/web/network-path.js';

test('same LAN is direct, and it is chosen FIRST so the common case pays for nothing', () => {
  const out = choosePath({ selfAddress: '192.168.1.10', peerAddress: '192.168.1.20', transport: 'lan', relayAvailable: true, overlayPresent: true });
  assert.equal(out.path, 'direct');
  assert.equal(out.action.kind, 'connect');
  assert.equal(out.ownerDecision, null);
  assert.match(out.reason, /this network/);
});

test('a peer that cannot be dialled uses the outbound relay when one exists - no account, no router change', () => {
  const out = choosePath({ selfAddress: '192.168.1.10', peerAddress: '203.0.113.9', transport: 'remote', relayAvailable: true });
  assert.equal(out.path, 'relay-in-city');
  assert.equal(out.action.kind, 'dial-outbound');
  assert.equal(out.ownerDecision, null, 'this option needs nothing from the Owner, which is why it is preferred');
});

test('an overlay the user ALREADY has beats asking them to create one', () => {
  const out = choosePath({ peerAddress: '100.64.0.7', transport: 'remote', overlayPresent: true });
  assert.equal(out.path, 'overlay');
  assert.equal(out.ownerDecision, null, 'it is already present, so there is nothing to decide');
});

test('a forwarded port is offered WITH its cost, as an Owner decision rather than a silent choice', () => {
  const out = choosePath({ peerAddress: '203.0.113.9', transport: 'remote', inboundForwarded: true });
  assert.equal(out.path, 'inbound-forward');
  assert.equal(out.ownerDecision.authority, OWNER_AUTHORITY['inbound-forward']);
  assert.match(out.ownerDecision.question, /exposed to the internet/);
});

test('two PCs on different networks with no relay and no overlay get an HONEST none plus the Owner question', () => {
  const out = choosePath({ selfAddress: '192.168.1.10', peerAddress: '198.51.100.4', transport: 'remote' });
  assert.equal(out.path, 'none');
  assert.equal(out.action, null, 'no action is invented');
  assert.equal(out.ownerDecision.authority, OWNER_AUTHORITY.overlay);
  assert.match(out.ownerDecision.question, /relay|overlay|port-forward/);
});

test('a /24 mismatch is only used to prefer a direct attempt, never to claim reachability', () => {
  const near = choosePath({ selfAddress: '192.168.1.10', peerAddress: '192.168.1.77', transport: 'remote' });
  const far = choosePath({ selfAddress: '192.168.1.10', peerAddress: '10.0.0.5', transport: 'remote' });
  assert.equal(near.path, 'direct', 'the same /24 is worth trying directly');
  assert.equal(far.path, 'none', 'a different /24 is NOT assumed reachable just because an address exists');
});

test('loopback and Bluetooth are direct, with their reasons stated', () => {
  assert.equal(choosePath({ peerAddress: '127.0.0.1' }).path, 'direct');
  assert.match(choosePath({ peerAddress: '127.0.0.1' }).reason, /this machine/);
  const ble = choosePath({ peerAddress: '192.168.4.4', transport: 'bluetooth' });
  assert.equal(ble.path, 'direct');
  assert.match(ble.reason, /bootstrap/);
});

test('the group plan reports the HARDEST peer as what the group requires, not the easiest', () => {
  const plan = planGroupPaths({
    selfAddress: '192.168.1.10',
    relayAvailable: true,
    peers: [
      { peerRef: 'same-lan', address: '192.168.1.30', transport: 'lan' },
      { peerRef: 'other-network', address: '203.0.113.9', transport: 'remote' },
    ],
  });
  assert.equal(plan.perPeer.length, 2);
  assert.equal(plan.perPeer.find(p => p.peerRef === 'same-lan').path, 'direct');
  assert.equal(plan.perPeer.find(p => p.peerRef === 'other-network').path, 'relay-in-city');
  assert.equal(plan.requiredPath, 'relay-in-city', 'the group needs what the hardest peer needs');
  assert.deepEqual([...plan.mechanisms].sort(), ['direct', 'relay-in-city']);
  assert.match(plan.reason, /needs nothing from the user/);
});

test('when every peer needs the Owner, the plan says so and lists them rather than offering a spinner', () => {
  const plan = planGroupPaths({
    selfAddress: '192.168.1.10',
    peers: [
      { peerRef: 'city-a', address: '203.0.113.9', transport: 'remote' },
      { peerRef: 'city-b', address: '198.51.100.4', transport: 'remote' },
    ],
  });
  assert.deepEqual([...plan.needsOwner].sort(), ['city-a', 'city-b']);
  assert.equal(plan.requiredPath, 'none');
  assert.match(plan.reason, /Owner decision/);
});

test('an empty group and junk input are answered, not thrown at', () => {
  assert.equal(planGroupPaths({}).perPeer.length, 0);
  assert.equal(planGroupPaths({ peers: null }).requiredPath, 'none');
  assert.match(planGroupPaths({}).reason, /no peers/);
});

test('the preference list is exported so the order is reviewable rather than buried', () => {
  assert.deepEqual(PATHS, ['direct', 'relay-in-city', 'overlay', 'inbound-forward', 'public-relay', 'none']);
  assert.equal(OWNER_AUTHORITY['public-relay'], 'third-party-trust', 'a third-party relay is named as a trust decision, not omitted');
});
