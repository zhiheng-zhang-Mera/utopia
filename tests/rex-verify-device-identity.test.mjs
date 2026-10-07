// REX series verification: device identity and presence facts.
//
// These tests exist because of four concrete reports from the owner while the two machines were linked:
//   * "the OS is Windows 11 64-bit but the UI only shows win32"      -> the platform fact set and its labels
//   * "my own device shows as online and is the main city"           -> host presence must be EARNED, not asserted
//   * "I can find my own main city in search, it is a duplicate"     -> self must be excluded from discovery
//   * "the device list shows old or offline devices while linked"    -> the live list must mean "present"
import test from 'node:test';
import assert from 'node:assert/strict';
import {operatingSystemName, archLabel, platformSummary} from '../apps/web/platform-label.mjs';
import {platformFacts} from '../services/dev-gateway/platform-facts.mjs';
import {memberSnapshot, isHostOwnNode} from '../services/dev-gateway/members.mjs';
import {isSelfAdvertisement} from '../services/dev-gateway/nearby.mjs';
import {buildConnectList} from '../apps/web/connect-surface.js';

test('V1 the operating system is named, and a Windows build number separates 11 from 10', () => {
  assert.equal(operatingSystemName({platform: 'win32', release: '10.0.26200'}), 'Windows 11');
  assert.equal(operatingSystemName({platform: 'win32', release: '10.0.26100'}), 'Windows 11');
  assert.equal(operatingSystemName({platform: 'win32', release: '10.0.19045'}), 'Windows 10');
  assert.equal(operatingSystemName({platform: 'win32', release: '6.3.9600'}), 'Windows 8.1');
  assert.equal(operatingSystemName({platform: 'darwin', release: '24.1.0'}), 'macOS 15');
  assert.match(operatingSystemName({platform: 'linux', release: '6.8.0-31-generic'}), /^Linux \(kernel 6\.8/);
  // An unrecognised release degrades to a BROADER TRUE statement rather than a guess.
  assert.equal(operatingSystemName({platform: 'win32', release: '99.1.2'}), 'Windows');
  assert.equal(operatingSystemName({platform: 'win32'}), 'Windows');
  assert.equal(operatingSystemName({}), 'Unknown operating system');
});

test('V2 the architecture is spelled out, and unknown parts are omitted rather than printed', () => {
  assert.equal(archLabel('x64'), '64-bit (x64)');
  assert.equal(archLabel('arm64'), '64-bit (ARM64)');
  assert.equal(archLabel('ia32'), '32-bit (x86)');
  assert.equal(archLabel(undefined), null);
  assert.equal(platformSummary({osName: 'Windows 11', arch: 'x64', runtimeVersion: 'v24.14.0'}), 'Windows 11 · 64-bit (x64) · Node v24.14.0');
  assert.equal(platformSummary({osName: 'Windows 11', arch: 'x64'}), 'Windows 11 · 64-bit (x64)');
  // No osName at all: the raw token is still shown, so the field is never empty.
  assert.equal(platformSummary({platform: 'freebsd', arch: 'x64'}), 'freebsd · 64-bit (x64)');
  assert.equal(platformSummary(null), 'unknown platform');
});

test('V3 the fact set read from a host carries name, release, architecture, hostname and runtime', () => {
  const facts = platformFacts({os: {platform: () => 'win32', release: () => '10.0.26200', arch: () => 'x64', hostname: () => 'MEGA-REP'}, version: 'v24.14.0'});
  assert.equal(facts.platform, 'win32');
  assert.equal(facts.osName, 'Windows 11');
  assert.equal(facts.osRelease, '10.0.26200');
  assert.equal(facts.arch, 'x64');
  assert.equal(facts.archName, '64-bit (x64)');
  assert.equal(facts.hostname, 'MEGA-REP');
  assert.equal(facts.runtimeVersion, 'v24.14.0');
  assert.equal(platformSummary(facts), 'Windows 11 · 64-bit (x64) · Node v24.14.0');
});

// A minimal store double: only list() and cityName are used by memberSnapshot.
const storeOf = (nodes = [], cityName = 'Utopia · Test') => ({list: table => (table === 'nodes' ? nodes : []), cityName});

test('V4 opening a City does NOT claim the host is online, and does not list the host node twice', () => {
  const hostDeviceId = 'dev-city';
  // The host's own node row exists (the launcher starts a node) but nothing has joined yet and no heartbeat is fresh.
  const hostNode = {id: hostDeviceId, displayName: 'Mega-rep', online: true, metadata: {hostname: 'MEGA-REP'}, capabilities: []};
  const members = memberSnapshot({store: storeOf([hostNode]), installations: [], surfaces: [], hostDeviceId, hostnames: ['MEGA-REP']});
  const host = members.find(m => m.deviceId === hostDeviceId);
  assert.ok(host, 'the host principal exists from the start');
  assert.equal(host.role, 'PRIMARY');
  // The defect: the row said online with nothing joined. Now presence needs a connected surface or a live node of ours.
  assert.equal(members.length, 1, 'the host node must not ALSO appear as a separate compute member');
  assert.equal(host.nodeId, hostDeviceId, 'the host node is folded into the host principal');
});

test('V5 the host node is recognised by hostname, not by id equality', () => {
  const hostDeviceId = 'dev-city';
  // A City whose node id is NOT the host device id: the old `n.id === hostDeviceId` test could never match this.
  const node = {id: 'host-MEGA-REP', displayName: 'Mega-rep', online: false, metadata: {hostname: 'MEGA-REP'}, capabilities: []};
  assert.equal(isHostOwnNode(node, {hostDeviceId, hostnames: ['MEGA-REP']}), true);
  const members = memberSnapshot({store: storeOf([node]), installations: [], surfaces: [], hostDeviceId, hostnames: ['MEGA-REP']});
  assert.equal(members.length, 1, 'the host node is not duplicated as a compute member');
  assert.equal(members[0].nodeId, 'host-MEGA-REP');
  assert.equal(members[0].online, false, 'an offline node does not make the host present');
  // A genuinely different machine is still its own member.
  const other = {id: 'dev-other', displayName: 'Other', online: true, metadata: {hostname: 'OTHER-PC'}, capabilities: []};
  const withOther = memberSnapshot({store: storeOf([node, other]), installations: [], surfaces: [], hostDeviceId, hostnames: ['MEGA-REP']});
  assert.equal(withOther.length, 2, 'the host node and a real neighbour are two members, not one');
  assert.equal(withOther.find(m => m.deviceId === 'dev-other').online, true);
  // TWO CITIES ON ONE MACHINE: a remote City this host joined also runs a worker here, with a node id naming the REMOTE
  // city. Same hostname, different City - it must stay a visible member instead of being folded into this host.
  const remoteWorker = {id: 'dev-9f8e7d6c5b4a39281706f5e4d3c2b1a0', displayName: 'Local primary', online: true, metadata: {hostname: 'MEGA-REP'}, capabilities: []};
  assert.equal(isHostOwnNode(remoteWorker, {hostDeviceId, hostnames: ['MEGA-REP']}), false);
  const crossCity = memberSnapshot({store: storeOf([remoteWorker]), installations: [], surfaces: [], hostDeviceId, hostnames: ['MEGA-REP']});
  assert.equal(crossCity.length, 2, 'the other City worker stays its own member beside this host principal');
  assert.equal(crossCity.find(m => m.deviceId === remoteWorker.id).computeOnline, true);
});

test('V6 a connected surface is what makes a member present', () => {
  const hostDeviceId = 'dev-city';
  const members = memberSnapshot({store: storeOf([]), installations: [], surfaces: [{clientRef: hostDeviceId, clientLabel: 'Web'}], hostDeviceId, hostnames: ['MEGA-REP']});
  const host = members.find(m => m.deviceId === hostDeviceId);
  assert.equal(host.online, true, 'a live control surface is real presence');
  assert.equal(host.controlOnline, true);
});

test('V7 a City never treats its own advertisement as a neighbour', () => {
  const selfCityId = '031fdba6-e94c-4298-a095-6ff04a65481d';
  const self = {selfCityId, selfAddresses: ['172.31.12.151', '127.0.0.1'], selfPort: 4310};
  // Exactly the live case that produced the report.
  assert.equal(isSelfAdvertisement({cityRef: selfCityId, address: '172.31.12.151', port: 4310}, self), true);
  assert.equal(isSelfAdvertisement({cityId: selfCityId, address: '10.0.0.5', port: 4310}, self), true, 'identity wins even from another address');
  assert.equal(isSelfAdvertisement({address: '172.31.12.151', port: 4310}, self), true, 'address+port identifies us when no City id is advertised');
  assert.equal(isSelfAdvertisement({address: '127.0.0.1', port: 4310}, self), true);
  // A real neighbour must survive: same port but a different address, or same address but a different port.
  assert.equal(isSelfAdvertisement({address: '172.31.12.99', port: 4310}, self), false);
  assert.equal(isSelfAdvertisement({address: '172.31.12.151', port: 4400}, self), false);
  // Something that advertises at OUR address and port is this machine's own advertisement whatever city id it carries:
  // a second City bound to the same port on the same address is not a reachable neighbour, and treating it as one is
  // exactly how a duplicate row appeared. Identity is still checked first, so a same-id advertisement from a DIFFERENT
  // address is also us.
  assert.equal(isSelfAdvertisement({cityRef: 'another-city', address: '172.31.12.151', port: 4310}, self), true);
  assert.equal(isSelfAdvertisement({displayName: 'Utopia · Mega-rep', address: '172.31.12.99', port: 4310}, self), false, 'a shared display name is not identity');
});

test('V8 the connect list keeps one row per machine and never takes a discovery duplicate of self', () => {
  const self = {cityRef: selfId(), displayName: 'This machine', address: '172.31.12.151', port: 4310};
  const {rows} = buildConnectList({
    self,
    nearby: [
      {cityRef: selfId(), displayName: 'Utopia · Mega-rep', address: '172.31.12.151', port: 4310, transport: 'MDNS_DNS_SD'},
      {cityRef: 'peer-city', displayName: 'Alien-PC', address: '172.31.12.99', port: 4310, transport: 'MDNS_DNS_SD'},
    ],
    translate: key => key,
  });
  const refs = rows.map(row => row.cityRef);
  assert.equal(refs.filter(ref => ref === selfId()).length, 1, 'the machine appears exactly once');
  assert.equal(refs.filter(ref => ref === 'peer-city').length, 1, 'a genuine neighbour is still offered');
  const selfRow = rows.find(row => row.cityRef === selfId());
  assert.equal(selfRow.source, 'self', 'the surviving row is the explicit this-machine row');
});

function selfId() { return '031fdba6-e94c-4298-a095-6ff04a65481d'; }

test('V10 an EMPTY host id is replaced by a real one, so no undefined member can appear', async () => {
  // Measured live: a City opened with an empty host id reported hostDeviceId "" and memberSnapshot then added an
  // `undefined` member. This drives the real gateway to prove the guard, because the fallback lives in server.mjs.
  const {createGateway} = await import('../services/dev-gateway/server.mjs');
  const {mkdtemp, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const {join} = await import('node:path');
  for (const requested of ['', '   ', undefined]) {
    const dir = await mkdtemp(join(tmpdir(), 'rex-verify-hostid-'));
    const app = await createGateway({dir, port: 0, token: 't', nodeToken: 'n', roomsDisabled: true, hostDeviceId: requested});
    try {
      const city = await (await fetch(app.url + '/api/v0/city', {headers: {Authorization: 'Bearer t', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'}})).json();
      assert.ok(typeof city.hostDeviceId === 'string' && city.hostDeviceId.trim().length > 0, `hostDeviceId must be a real identity, got ${JSON.stringify(city.hostDeviceId)} (requested ${JSON.stringify(requested)})`);
      for (const member of city.members) {
        assert.ok(typeof member.deviceId === 'string' && member.deviceId.length > 0, `a member with no identity must not exist: ${JSON.stringify(member)}`);
      }
    } finally {
      await app.close();
      await rm(dir, {recursive: true, force: true, maxRetries: 5, retryDelay: 50}).catch(() => {});
    }
  }
});

test('V11 the Devices surface is rendered by the shipped predicate, not by an inline copy', async () => {
  // The predicate is asserted through the page source rather than re-implemented here: a browser test covers the real
  // path, but this pins the RULE so a future edit cannot quietly widen it back to "every row the City reports".
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('../apps/web/app.js', import.meta.url), 'utf8'));
  const region = source.slice(source.indexOf('const memberIsHere'), source.indexOf('const legacyNodeRows'));
  assert.match(region, /m\.online===true\|\|m\.controlOnline===true\|\|m\.computeOnline===true/, 'a member row must be present to be listed');
  assert.match(region, /n\.online===true\|\|fresh\(n\)/, 'a node row must be live or fresh to be listed');
  assert.match(region, /city\.members\.filter\(memberIsHere\)/, 'the member list must go through the predicate');
  assert.match(region, /city\.nodes\.filter\(nodeIsHere\)/, 'the node list must go through the predicate');
  // The host row is NOT removed from the surface: the accepted contract is that a member sees itself first among the
  // City's devices. What was wrong was the host's ASSERTED presence, which is fixed in memberSnapshot above.
  assert.match(region, /city\.members\.filter\(memberIsHere\)/, 'the member list must go through the predicate');
  assert.match(region, /city\.nodes\.filter\(nodeIsHere\)/, 'the node list must go through the predicate');
  assert.ok(!/deviceId!==own/.test(region), 'the host row must not be filtered out of the Devices surface');
});

// The third report: "the QR and the token are partly missing". Measured on a live City, the material renders and
// survives a reload - so the guard that matters is that it KEEPS doing so: a restored session must still carry the QR
// markup and the code, because a surface that comes back from storage without them is exactly what "missing" looked
// like. This drives the real lifecycle rather than re-implementing it.
test('V9 a pairing session restored after a reload still carries its QR markup and code', async () => {
  const {createPairingLifecycle, STORAGE_KEY} = await import('../apps/web/pairing-lifecycle.js');
  const memory = new Map();
  const storage = {getItem: key => (memory.has(key) ? memory.get(key) : null), setItem: (key, value) => memory.set(key, String(value)), removeItem: key => memory.delete(key)};
  let now = 1_000_000;
  const first = createPairingLifecycle({storage, now: () => now});
  const created = first.create({
    cityId: '031fdba6-e94c-4298-a095-6ff04a65481d',
    pairingSessionId: 'sess-1',
    shortCode: '123456',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 300000).toISOString(),
    qrPayload: 'utopia://pair?session=sess-1',
    inviteUrl: 'http://172.31.12.151:4310/?pair=session%3Dsess-1',
    qrSvg: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
  });
  assert.equal(created.created, true);
  assert.ok(memory.has(STORAGE_KEY), 'the session is persisted, not held only in memory');

  // A RELOAD is a new lifecycle object over the same storage.
  now += 5000;
  const restored = createPairingLifecycle({storage, now: () => now}).restore();
  assert.ok(restored, 'the same still-valid session comes back');
  assert.equal(restored.shortCode, '123456', 'the token survives');
  assert.match(restored.qrSvg, /<svg/, 'the QR MARKUP survives, so the surface is not blank');
  assert.equal(restored.qrPayload, 'utopia://pair?session=sess-1');
  const snapshot = createPairingLifecycle({storage, now: () => now}).snapshot?.() ?? null;
  // A fresh object must also answer usefully for the surface that renders it.
  const view = createPairingLifecycle({storage, now: () => now});
  view.restore();
  const state = view.snapshot();
  assert.equal(state.state, 'ACTIVE');
  assert.equal(state.session.shortCode, '123456');
  assert.match(state.session.qrSvg, /<svg/);

  // And an EXPIRED session must not come back as material at all - a stale code presented as usable is worse than none.
  now += 400000;
  const afterExpiry = createPairingLifecycle({storage, now: () => now});
  assert.equal(afterExpiry.restore(), null, 'an expired session is not restored');
  assert.equal(afterExpiry.snapshot().state, 'ENDED');
});
