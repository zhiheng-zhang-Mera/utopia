/**
 * UTOPIA · City Foundation — city-node-network — device-identity tests (RF-001).
 *
 * Every "Required acceptance" line of
 * `Digital-City/mission-book/remote/RF-001-node-identity-installation-lifecycle.md`
 * is exercised below, together with the negative and security cases that make the
 * positive ones meaningful. The suite is deterministic: entropy is pinned and instants
 * are parameters, so nothing here depends on the clock or on randomness.
 *
 * Test names state the property, not the implementation, so a correction host can read
 * the list and see which claim each one defends.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICE_IDENTITY_AUTHORITY_FIELDS,
  DEVICE_IDENTITY_FIELDS,
  DEVICE_IDENTITY_KIND,
  DEVICE_INSTALLATION_KIND,
  IDENTITY_REJECTION_CODES,
  IDENTITY_SCHEMA_VERSION,
  KEY_FINGERPRINT_PATTERN,
  MAC_AUTHORITY,
  MAC_EVIDENCE_ROLE,
  METADATA_AUTHORITY,
  PRESENTATION_VERDICTS,
  IdentityLifecycleError,
  assertActiveKey,
  assertDeviceIdentity,
  assertInstallation,
  canonicalJson,
  createInstallation,
  credentialFingerprint,
  credentialLeakScan,
  detectCredentialClones,
  deviceIdentityDigest,
  deviceIdentityDocument,
  deviceIdentityFromDocument,
  deviceMetadata,
  enrollDevice,
  enrollInstallation,
  fingerprintKeyMaterial,
  instantOf,
  isLocallyAdministeredMac,
  macPairingEvidence,
  migrateDeviceIdentity,
  mintCredentialId,
  mintDeviceId,
  mintInstallationId,
  mintInstanceId,
  normalizeMac,
  quarantineInstallation,
  randomEntropy,
  rebindInstallation,
  recordNetworkMetadata,
  reinstallInstallation,
  renameDevice,
  resolveInstallationPresentation,
  retireDevice,
  retireInstallation,
  revokeDeviceKey,
  rotateDeviceKey,
  serializeDeviceIdentity,
  serializeInstallation,
  trustFromMacEvidence,
  validateDeviceIdentity,
  validateInstallation,
} from '../index.mjs';

/* ------------------------------------------------------------------ fixtures */

/** Pin 16 bytes of "entropy" so every minted id in this suite is a literal. */
const entropy = (pair) => Uint8Array.from(Buffer.from(pair.repeat(16).slice(0, 32), 'hex'));

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const T1 = Date.parse('2026-01-02T00:00:00.000Z');
const T2 = Date.parse('2026-01-03T00:00:00.000Z');

const DEVICE = mintDeviceId(entropy('11'));
const OTHER_DEVICE = mintDeviceId(entropy('12'));
const INSTALLATION = mintInstallationId(entropy('22'));
const INSTANCE = mintInstanceId(entropy('33'));
const CREDENTIAL = mintCredentialId(entropy('44'));
const SECRET = 'correct-horse-battery-staple';

/** A globally-unique (bit 0x02 clear) MAC and a locally-administered (randomised) one. */
const GLOBAL_MAC = '3c:22:fb:11:22:33';
const RANDOM_MAC = '02:11:22:33:44:55';

const baseDevice = () => enrollDevice({
  deviceId: DEVICE,
  displayName: 'Alien Workstation',
  nowMs: T0,
  publicKeyMaterial: 'pk-device-1',
  metadata: { platform: 'win32', os: 'Windows 11', arch: 'x64' },
});

const baseInstallation = () => createInstallation({
  installationId: INSTALLATION,
  instanceId: INSTANCE,
  credentialId: CREDENTIAL,
  credentialSecret: SECRET,
  nowMs: T0,
  deviceId: DEVICE,
});

const presentation = (overrides = {}) => ({
  installationId: INSTALLATION,
  instanceId: INSTANCE,
  credentialId: CREDENTIAL,
  credentialFingerprint: credentialFingerprint(SECRET),
  ...overrides,
});

/* ------------------------------------------------- 1. identity is not network */

test('an IP or hostname change does not change device_id', () => {
  const before = recordNetworkMetadata(baseDevice(), {
    hostnames: ['alien-laptop'],
    networkAddresses: ['192.168.1.10'],
  });
  const after = recordNetworkMetadata(before, {
    hostnames: ['alien-laptop.lan', 'alien-laptop'],
    networkAddresses: ['10.0.0.42', 'fe80::1'],
  });
  assert.equal(after.deviceId, before.deviceId);
  assert.equal(after.deviceId, DEVICE);
  assert.equal(after.activeKeyId, before.activeKeyId);
  assert.deepEqual(after.keys, before.keys);
  assert.deepEqual(after.metadata.networkAddresses, ['10.0.0.42', 'fe80::1']);
});

test('metadata is declared non-authoritative and device_id is not derived from it', () => {
  assert.equal(METADATA_AUTHORITY, 'NOT_AUTHORITY');
  assert.deepEqual([...DEVICE_IDENTITY_AUTHORITY_FIELDS], ['deviceId', 'keys', 'activeKeyId']);
  const device = baseDevice();
  for (const field of DEVICE_IDENTITY_AUTHORITY_FIELDS) {
    assert.ok(Object.hasOwn(device, field), `${field} is present`);
    assert.ok(!Object.hasOwn(device.metadata ?? {}, field), `${field} is not a metadata field`);
  }
});

test('a device with no network observation at all is valid (network is not required for identity)', () => {
  const device = baseDevice();
  assert.deepEqual(device.metadata.networkAddresses, []);
  assert.deepEqual(device.metadata.hostnames, []);
  assert.equal(validateDeviceIdentity(device).valid, true);
});

/* ---------------------------------------------------------- 2. rename is metadata */

test('rename changes display metadata without changing authority', () => {
  const before = baseDevice();
  const after = renameDevice(before, 'Renamed Workstation');
  assert.equal(after.displayName, 'Renamed Workstation');
  assert.equal(after.deviceId, before.deviceId);
  assert.deepEqual(after.keys, before.keys);
  assert.equal(after.activeKeyId, before.activeKeyId);
  assert.equal(after.createdAt, before.createdAt);
  assert.equal(after.state, before.state);
  assert.deepEqual(after.metadata, before.metadata);
});

test('rename does not mutate the document it was given', () => {
  const before = baseDevice();
  const frozen = JSON.parse(JSON.stringify(before));
  renameDevice(before, 'Something Else');
  assert.deepEqual(JSON.parse(JSON.stringify(before)), frozen);
});

test('two devices may share a display name: a name is never an identity', () => {
  const a = enrollDevice({ deviceId: DEVICE, displayName: 'Laptop', nowMs: T0, publicKeyMaterial: 'pk-a' });
  const b = enrollDevice({ deviceId: OTHER_DEVICE, displayName: 'Laptop', nowMs: T0, publicKeyMaterial: 'pk-b' });
  assert.equal(a.displayName, b.displayName);
  assert.notEqual(a.deviceId, b.deviceId);
  assert.notEqual(a.keys[0].fingerprint, b.keys[0].fingerprint);
});

test('an empty or non-string rename is refused', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    assert.throws(() => renameDevice(baseDevice(), bad), IdentityLifecycleError);
  }
});

/* ------------------------------------------------------------ 3. key lifecycle */

test('key rotation moves activeKeyId and demotes the previous key to ROTATED history', () => {
  const before = baseDevice();
  const after = rotateDeviceKey(before, { keyId: 'key-2', publicKeyMaterial: 'pk-device-2', nowMs: T1 });
  assert.equal(after.activeKeyId, 'key-2');
  const old = after.keys.find((key) => key.keyId === 'key-1');
  assert.equal(old.state, 'ROTATED');
  assert.equal(old.retiredAt, instantOf(T1));
  assert.equal(after.keys.length, 2, 'the rotated key is retained as history, not deleted');
  assert.equal(after.deviceId, before.deviceId);
});

test('a rotated key is no longer authority even though it is still recorded', () => {
  const rotated = rotateDeviceKey(baseDevice(), { keyId: 'key-2', publicKeyMaterial: 'pk-device-2', nowMs: T1 });
  assert.throws(() => assertActiveKey(rotated, 'key-1'), (error) => error.code === 'key_not_active');
  assert.equal(assertActiveKey(rotated, 'key-2').keyId, 'key-2');
});

test('a device always has exactly one active key and it always exists', () => {
  const device = rotateDeviceKey(rotateDeviceKey(baseDevice(), { keyId: 'key-2', publicKeyMaterial: 'p2', nowMs: T1 }), { keyId: 'key-3', publicKeyMaterial: 'p3', nowMs: T2 });
  assert.equal(device.keys.filter((key) => key.state === 'ACTIVE').length, 1);
  assert.equal(device.keys.find((key) => key.keyId === device.activeKeyId).state, 'ACTIVE');
  assert.equal(validateDeviceIdentity(device).valid, true);
});

test('a duplicate key handle is refused', () => {
  assert.throws(
    () => rotateDeviceKey(baseDevice(), { keyId: 'key-1', publicKeyMaterial: 'pk-again', nowMs: T1 }),
    (error) => error.code === 'key',
  );
});

test('revoking the active key is refused; a rotated key may be revoked', () => {
  const device = rotateDeviceKey(baseDevice(), { keyId: 'key-2', publicKeyMaterial: 'pk-2', nowMs: T1 });
  assert.throws(() => revokeDeviceKey(device, 'key-2', T2), (error) => error.code === 'active_key');
  const revoked = revokeDeviceKey(device, 'key-1', T2);
  assert.equal(revoked.keys.find((key) => key.keyId === 'key-1').state, 'REVOKED');
});

test('a retired device cannot rotate a key', () => {
  const retired = retireDevice(baseDevice(), T1);
  assert.throws(
    () => rotateDeviceKey(retired, { keyId: 'key-2', publicKeyMaterial: 'pk-2', nowMs: T2 }),
    (error) => error.code === 'device_retired',
  );
});

test('retirement is terminal and recorded with its instant', () => {
  const retired = retireDevice(baseDevice(), T1);
  assert.equal(retired.state, 'RETIRED');
  assert.equal(retired.retiredAt, instantOf(T1));
  assert.throws(() => retireDevice(retired, T2), (error) => error.code === 'already_retired');
});

/* ------------------------------------------------------ 4. reinstall / rebind */

test('a reinstall mints a new installation_id and does not inherit the logical device', () => {
  const next = reinstallInstallation(baseInstallation(), {
    installationId: mintInstallationId(entropy('23')),
    instanceId: mintInstanceId(entropy('34')),
    credentialId: mintCredentialId(entropy('45')),
    credentialSecret: 'new-secret',
    nowMs: T1,
  });
  assert.equal(next.retired.state, 'RETIRED');
  assert.equal(next.retired.retiredAt, instantOf(T1));
  assert.notEqual(next.installation.installationId, INSTALLATION);
  assert.notEqual(next.installation.instanceId, INSTANCE);
  assert.equal(next.installation.deviceId, null, 'the fresh installation is not silently attached to the old device');
  assert.equal(next.installation.state, 'UNBOUND');
  assert.equal(next.installation.rebind.required, true);
  assert.equal(next.installation.rebind.reason, 'reinstall');
});

test('an unbound reinstalled installation can do nothing until it is explicitly rebound', () => {
  const { installation } = reinstallInstallation(baseInstallation(), {
    installationId: mintInstallationId(entropy('23')),
    instanceId: mintInstanceId(entropy('34')),
    credentialId: mintCredentialId(entropy('45')),
    credentialSecret: 'new-secret',
    nowMs: T1,
  });
  const verdict = resolveInstallationPresentation(installation, {
    installationId: installation.installationId,
    instanceId: installation.instanceId,
    credentialId: installation.credential.credentialId,
    credentialFingerprint: installation.credential.fingerprint,
  });
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.verdict, 'UNBOUND');
  assert.equal(verdict.code, 'installation_unbound');
});

test('rebinding requires explicit proof and refuses to invent it', () => {
  const { installation } = reinstallInstallation(baseInstallation(), {
    installationId: mintInstallationId(entropy('23')),
    instanceId: mintInstanceId(entropy('34')),
    credentialId: mintCredentialId(entropy('45')),
    credentialSecret: 'new-secret',
    nowMs: T1,
  });
  for (const proof of [undefined, null, {}, { kind: '' }, 'owner-said-so']) {
    assert.throws(
      () => rebindInstallation(installation, { deviceId: DEVICE, proof, nowMs: T2 }),
      (error) => error.code === 'rebind_proof_required',
    );
  }
});

test('an explicit rebind binds the reinstalled installation to the surviving logical device', () => {
  const { installation } = reinstallInstallation(baseInstallation(), {
    installationId: mintInstallationId(entropy('23')),
    instanceId: mintInstanceId(entropy('34')),
    credentialId: mintCredentialId(entropy('45')),
    credentialSecret: 'new-secret',
    nowMs: T1,
  });
  const bound = rebindInstallation(installation, {
    deviceId: DEVICE,
    proof: { kind: 'owner_approval', reference: 'owner-2026-01-03' },
    nowMs: T2,
  });
  assert.equal(bound.state, 'BOUND');
  assert.equal(bound.deviceId, DEVICE);
  assert.equal(bound.boundAt, instantOf(T2));
  assert.equal(bound.rebind.required, false);
  assert.equal(resolveInstallationPresentation(bound, {
    installationId: bound.installationId,
    instanceId: bound.instanceId,
    credentialId: bound.credential.credentialId,
    credentialFingerprint: bound.credential.fingerprint,
  }).accepted, true);
});

test('an installation already bound to one device cannot be re-pointed at another', () => {
  assert.throws(
    () => rebindInstallation(baseInstallation(), { deviceId: OTHER_DEVICE, proof: { kind: 'owner_approval' }, nowMs: T1 }),
    (error) => error.code === 'already_bound',
  );
});

test('a reinstall must actually mint new identities', () => {
  const current = baseInstallation();
  assert.throws(
    () => reinstallInstallation(current, {
      installationId: current.installationId,
      instanceId: mintInstanceId(entropy('34')),
      credentialId: mintCredentialId(entropy('45')),
      credentialSecret: 'x',
      nowMs: T1,
    }),
    (error) => error.code === 'installation_id',
  );
  assert.throws(
    () => reinstallInstallation(current, {
      installationId: mintInstallationId(entropy('23')),
      instanceId: current.instanceId,
      credentialId: mintCredentialId(entropy('45')),
      credentialSecret: 'x',
      nowMs: T1,
    }),
    (error) => error.code === 'instance_id',
  );
});

test('enrollment refuses to create a bound installation without a device', () => {
  assert.throws(
    () => enrollInstallation({ installationId: INSTALLATION, instanceId: INSTANCE, credentialId: CREDENTIAL, credentialSecret: SECRET, nowMs: T0 }),
    (error) => error.code === 'device_id',
  );
});

/* -------------------------------------------------- 5. clone detection/quarantine */

test('a credential presented from a different physical instance is detected as a clone', () => {
  const verdict = resolveInstallationPresentation(baseInstallation(), presentation({ instanceId: mintInstanceId(entropy('99')) }));
  assert.equal(verdict.accepted, false);
  assert.equal(verdict.verdict, 'CLONE_DETECTED');
  assert.equal(verdict.code, 'clone_detected');
});

test('a matching presentation is accepted', () => {
  const verdict = resolveInstallationPresentation(baseInstallation(), presentation());
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.verdict, 'ACCEPTED');
  assert.equal(verdict.code, null);
});

test('a wrong credential is reported as a mismatch, not as a clone', () => {
  const verdict = resolveInstallationPresentation(baseInstallation(), presentation({ credentialFingerprint: credentialFingerprint('stolen') }));
  assert.equal(verdict.verdict, 'CREDENTIAL_MISMATCH');
  assert.equal(verdict.code, 'credential_mismatch');
});

test('an unknown installation id is refused before anything else is considered', () => {
  const verdict = resolveInstallationPresentation(baseInstallation(), presentation({ installationId: mintInstallationId(entropy('77')) }));
  assert.equal(verdict.verdict, 'UNKNOWN_INSTALLATION');
});

test('a malformed presentation is refused without throwing', () => {
  for (const bad of [null, undefined, 'x', 42, []]) {
    const verdict = resolveInstallationPresentation(baseInstallation(), bad);
    assert.equal(verdict.accepted, false);
    assert.equal(verdict.verdict, 'MALFORMED_PRESENTATION');
  }
});

test('quarantining a cloned installation is terminal and cannot be undone by the clone', () => {
  const quarantined = quarantineInstallation(baseInstallation(), {
    nowMs: T2,
    code: 'clone_detected',
    detail: `instance ${mintInstanceId(entropy('99'))} presented a credential enrolled from ${INSTANCE}`,
  });
  assert.equal(quarantined.state, 'QUARANTINED');
  assert.equal(quarantined.quarantine.at, instantOf(T2));
  assert.equal(quarantined.quarantine.code, 'clone_detected');

  const clone = resolveInstallationPresentation(quarantined, presentation({ instanceId: mintInstanceId(entropy('99')) }));
  assert.equal(clone.verdict, 'QUARANTINED');
  const matching = resolveInstallationPresentation(quarantined, presentation());
  assert.equal(matching.verdict, 'QUARANTINED', 'the enrolled instance is refused too, so a clone cannot be cleared by anyone');
  assert.throws(
    () => rebindInstallation(quarantined, { deviceId: DEVICE, proof: { kind: 'owner_approval' }, nowMs: T2 }),
    (error) => error.code === 'quarantined',
  );
});

test('a retired installation is refused even when the credential still matches', () => {
  const retired = retireInstallation(baseInstallation(), T1);
  assert.equal(resolveInstallationPresentation(retired, presentation()).verdict, 'RETIRED');
  assert.throws(() => retireInstallation(retired, T2), (error) => error.code === 'already_retired');
});

test('a retired installation cannot be quarantined, so history is not rewritten', () => {
  assert.throws(
    () => quarantineInstallation(retireInstallation(baseInstallation(), T1), { nowMs: T2, code: 'x', detail: 'y' }),
    (error) => error.code === 'installation_retired',
  );
});

test('a population scan finds two records sharing one installation identity under two instances', () => {
  const original = baseInstallation();
  const clone = createInstallation({
    installationId: INSTALLATION,
    instanceId: mintInstanceId(entropy('99')),
    credentialId: CREDENTIAL,
    credentialFingerprint: credentialFingerprint(SECRET),
    nowMs: T1,
    deviceId: DEVICE,
  });
  const findings = detectCredentialClones([original, clone]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].installationId, INSTALLATION);
  assert.deepEqual(findings[0].instances, [INSTANCE, mintInstanceId(entropy('99'))].sort());
});

test('a population scan finds one installation identity carrying two credential fingerprints', () => {
  const original = baseInstallation();
  const rotated = createInstallation({
    installationId: INSTALLATION,
    instanceId: INSTANCE,
    credentialId: mintCredentialId(entropy('45')),
    credentialSecret: 'rotated-secret',
    nowMs: T1,
    deviceId: DEVICE,
  });
  const findings = detectCredentialClones([original, rotated]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].credentialFingerprints.length, 2);
});

test('a population scan reports nothing for a healthy population', () => {
  const second = createInstallation({
    installationId: mintInstallationId(entropy('23')),
    instanceId: mintInstanceId(entropy('34')),
    credentialId: mintCredentialId(entropy('45')),
    credentialSecret: 'other-secret',
    nowMs: T1,
    deviceId: DEVICE,
  });
  assert.deepEqual(detectCredentialClones([baseInstallation(), second]), []);
});

test('a population scan refuses a malformed record instead of ignoring it', () => {
  assert.throws(
    () => detectCredentialClones([baseInstallation(), { installationId: 'nope' }]),
    (error) => error.code === 'schema_version' && error.detail.includes('schemaVersion'),
  );
});

/* ------------------------------------------------------------- 6. the MAC rule */

test('a missing MAC does not block a valid pairing path', () => {
  for (const missing of [null, undefined, '', '   ', 'unavailable', 'N/A', 'none', 'unknown', '00:00:00:00:00:00']) {
    const evidence = macPairingEvidence([missing]);
    assert.equal(evidence.entries[0].value, null);
    assert.equal(evidence.canBlockPairing, false);
    assert.equal(evidence.unavailable, 1);
  }
});

test('a randomised MAC does not block a valid pairing path', () => {
  const evidence = macPairingEvidence([RANDOM_MAC]);
  assert.equal(evidence.entries[0].value, RANDOM_MAC);
  assert.equal(evidence.entries[0].randomized, true);
  assert.equal(evidence.canBlockPairing, false);
  assert.equal(evidence.authoritative, false);
});

test('MAC randomisation is recognised from the locally-administered bit, not from a guess', () => {
  assert.equal(isLocallyAdministeredMac(RANDOM_MAC), true);
  assert.equal(isLocallyAdministeredMac(GLOBAL_MAC), false);
  assert.equal(isLocallyAdministeredMac('00:00:00:00:00:00'), false, 'an unusable MAC is not "randomised"');
  const second = Number.parseInt(RANDOM_MAC.slice(0, 2), 16);
  const first = Number.parseInt(GLOBAL_MAC.slice(0, 2), 16);
  assert.equal((second & 0x02) === 0x02, true);
  assert.equal((first & 0x02) === 0x02, false);
});

test('MAC formatting, case and separators are normalised and never rejected', () => {
  assert.equal(normalizeMac('3C-22-FB-11-22-33'), GLOBAL_MAC);
  assert.equal(normalizeMac('  3c:22:fb:11:22:33  '), GLOBAL_MAC);
  assert.equal(normalizeMac('3c22fb112233'), GLOBAL_MAC);
  assert.equal(normalizeMac('not-a-mac'), null);
  assert.equal(normalizeMac(12345), null);
});

test('multiple NICs are all representable and none of them is privileged', () => {
  const evidence = macPairingEvidence([GLOBAL_MAC, RANDOM_MAC, null]);
  assert.equal(evidence.entries.length, 3);
  assert.equal(evidence.randomized, 1);
  assert.equal(evidence.unavailable, 1);
  assert.equal(evidence.authoritative, false);
  assert.equal(evidence.role, MAC_EVIDENCE_ROLE);
  assert.equal(evidence.authority, MAC_AUTHORITY);
});

test('spoofed MAC evidence alone cannot impersonate a trusted node', () => {
  const verdict = trustFromMacEvidence();
  assert.equal(verdict.granted, false);
  assert.equal(verdict.code, 'mac_not_authority');
  assert.equal(trustFromMacEvidence(GLOBAL_MAC).granted, false);
  assert.equal(trustFromMacEvidence([GLOBAL_MAC, RANDOM_MAC]).granted, false);
});

test('MAC never enters an authority-bearing field of a device document', () => {
  const device = recordNetworkMetadata(baseDevice(), { macAddresses: [GLOBAL_MAC] });
  assert.equal(device.metadata.macAddresses[0].value, GLOBAL_MAC);
  assert.equal(device.metadata.macAddresses[0].source, 'reported');
  for (const field of DEVICE_IDENTITY_AUTHORITY_FIELDS) {
    assert.ok(!JSON.stringify(device[field]).includes('22:33'), `${field} does not carry a MAC`);
  }
});

/* ------------------------------------------- 7. schema versioning and migration */

test('the document discriminators keep a device and an installation distinguishable', () => {
  assert.equal(baseDevice().kind, DEVICE_IDENTITY_KIND);
  assert.equal(baseInstallation().kind, DEVICE_INSTALLATION_KIND);
  assert.notEqual(DEVICE_IDENTITY_KIND, DEVICE_INSTALLATION_KIND);
});

test('a wrong schema version is refused by both validators', () => {
  const device = { ...deviceIdentityDocument(baseDevice()), schemaVersion: 2 };
  const installation = { ...JSON.parse(serializeInstallation(baseInstallation())), schemaVersion: 0 };
  assert.equal(validateDeviceIdentity(device).code, 'schema_version');
  assert.equal(validateInstallation(installation).code, 'schema_version');
});

test('malformed device records are refused with a specific code', () => {
  const good = deviceIdentityDocument(baseDevice());
  const cases = [
    ['missing', null],
    ['malformed', []],
    ['malformed', 'device'],
    ['kind', { ...good, kind: 'city.something-else' }],
    ['device_id', { ...good, deviceId: 'dev-NOTHEX' }],
    ['device_id', { ...good, deviceId: 'ins-11111111111111111111111111111111' }],
    ['instant', { ...good, createdAt: 'yesterday' }],
    ['instant', { ...good, createdAt: '2026-01-01T00:00:00Z' }],
    ['display_name', { ...good, displayName: '' }],
    ['malformed', { ...good, state: 'ONLINE' }],
    ['already_retired', { ...good, state: 'RETIRED' }],
    ['key_list', { ...good, keys: [] }],
    ['key', { ...good, keys: [{ ...good.keys[0], keyId: 'BAD ID' }] }],
    ['key', { ...good, keys: [good.keys[0], good.keys[0]] }],
    ['key', { ...good, keys: [{ ...good.keys[0], fingerprint: 'sha256:short' }] }],
    ['key', { ...good, keys: [{ ...good.keys[0], algorithm: 'rsa' }] }],
    ['key', { ...good, keys: [{ ...good.keys[0], state: 'RETIRED' }] }],
    ['active_key', { ...good, activeKeyId: 'key-missing' }],
    ['key_not_active', { ...good, keys: [{ ...good.keys[0], state: 'ROTATED' }] }],
    ['metadata', { ...good, metadata: undefined }],
    ['metadata', { ...good, metadata: { ...good.metadata, hostnames: 'nope' } }],
    ['metadata', { ...good, metadata: { ...good.metadata, macAddresses: [{ value: 'ZZ:ZZ', randomized: false, source: 'os' }] } }],
    ['metadata', { ...good, metadata: { ...good.metadata, macAddresses: [{ value: '3c:22:fb:11:22:33', randomized: true, source: 'os' }] } }],
    ['metadata', { ...good, metadata: { ...good.metadata, macAddresses: [{ value: null, randomized: false, source: 'bluetooth' }] } }],
  ];
  for (const [code, candidate] of cases) {
    const verdict = validateDeviceIdentity(candidate);
    assert.equal(verdict.valid, false, `${code} case must be refused`);
    assert.equal(verdict.code, code);
    assert.ok(IDENTITY_REJECTION_CODES.includes(verdict.code), `${code} is a declared rejection code`);
  }
});

test('malformed installation records are refused with a specific code', () => {
  const good = JSON.parse(serializeInstallation(baseInstallation()));
  const unbound = JSON.parse(serializeInstallation(createInstallation({
    installationId: INSTALLATION,
    instanceId: INSTANCE,
    credentialId: CREDENTIAL,
    credentialSecret: SECRET,
    nowMs: T0,
  })));
  const cases = [
    ['missing', undefined],
    ['malformed', []],
    ['kind', { ...good, kind: DEVICE_IDENTITY_KIND }],
    ['installation_id', { ...good, installationId: 'INS-1' }],
    ['instance_id', { ...good, instanceId: 'instance-1' }],
    ['malformed', { ...good, state: 'PAIRED' }],
    ['installation_unbound', { ...good, state: 'BOUND', deviceId: null }],
    ['already_bound', { ...unbound, deviceId: DEVICE }],
    ['credential', { ...good, credential: { ...good.credential, credentialId: 'CRED' } }],
    ['credential', { ...good, credential: { ...good.credential, fingerprint: 'md5:abc' } }],
    ['malformed', { ...good, rebind: { required: 'yes' } }],
    ['rebind_proof_required', { ...unbound, rebind: { required: false, reason: null } }],
    ['installation_retired', { ...good, state: 'RETIRED' }],
    ['malformed', { ...good, state: 'QUARANTINED' }],
    ['malformed', { ...good, quarantine: { at: instantOf(T1), code: '', detail: '' } }],
    ['malformed', { ...good, boundAt: null }],
  ];
  for (const [code, candidate] of cases) {
    const verdict = validateInstallation(candidate);
    assert.equal(verdict.valid, false, `${code} case must be refused`);
    assert.equal(verdict.code, code);
  }
});

test('the assert helpers throw with the validator code attached', () => {
  assert.throws(() => assertDeviceIdentity({ schemaVersion: 9 }), (error) => {
    assert.equal(error.code, 'schema_version');
    assert.ok(error.detail.length > 0);
    return true;
  });
  assert.throws(() => assertInstallation(null), (error) => error.code === 'missing');
});

test('a v1 document migrates to itself and is reported as unmigrated', () => {
  const device = baseDevice();
  const result = migrateDeviceIdentity(device, { nowMs: T1 });
  assert.equal(result.migrated, false);
  assert.equal(result.from, 'device-identity-v1');
  assert.deepEqual(deviceIdentityDocument(result.device), deviceIdentityDocument(device));
});

test('a live gateway node row upgrades to a v1 device identity', () => {
  // This is the shape services/dev-gateway/server.mjs writes on POST /api/v0/node/register.
  const row = {
    id: DEVICE,
    devicePrincipalId: DEVICE,
    displayName: 'Alien Workstation',
    metadata: { platform: 'win32' },
    agentVersion: '0.1.0',
    capabilities: ['engineering.worker'],
    online: true,
    lastHeartbeatAt: instantOf(T0),
  };
  const result = migrateDeviceIdentity(row, { nowMs: T1 });
  assert.equal(result.migrated, true);
  assert.equal(result.from, 'legacy-gateway-node-row');
  assert.equal(result.device.deviceId, DEVICE);
  assert.equal(result.device.displayName, 'Alien Workstation');
  assert.equal(result.device.metadata.platform, 'win32');
  assert.equal(result.device.activeKeyId, 'legacy-gateway');
  assert.equal(result.device.state, 'ACTIVE');
  assert.equal(validateDeviceIdentity(result.device).valid, true);
});

test('a legacy row with no key material yields a placeholder reference, not an invented key', () => {
  const result = migrateDeviceIdentity({ id: DEVICE, displayName: 'X', metadata: {} }, { nowMs: T1 });
  const key = result.device.keys[0];
  assert.equal(key.keyId, 'legacy-gateway');
  assert.match(key.fingerprint, KEY_FINGERPRINT_PATTERN);
  assert.equal(key.fingerprint, fingerprintKeyMaterial(canonicalJson({ id: DEVICE, agentVersion: null })));
});

test('an unknown future schema version is refused rather than guessed at', () => {
  assert.throws(
    () => migrateDeviceIdentity({ schemaVersion: 99, deviceId: DEVICE }, { nowMs: T1 }),
    (error) => error.code === 'schema_version',
  );
});

test('a legacy row whose id is not a device identity is refused', () => {
  assert.throws(() => migrateDeviceIdentity({ id: 'node-1', displayName: 'X' }, { nowMs: T1 }), (error) => error.code === 'device_id');
});

test('a migration requires an instant because it must not read the clock itself', () => {
  assert.throws(() => migrateDeviceIdentity({ id: DEVICE, displayName: 'X' }, {}), (error) => error.code === 'instant');
});

/* --------------------------------------- 8. canonical form, digests and secrets */

test('canonical serialisation is independent of key insertion order', () => {
  const device = baseDevice();
  const document = deviceIdentityDocument(device);
  const reversed = Object.fromEntries(Object.entries(document).reverse());
  assert.equal(canonicalJson(document), canonicalJson(reversed));
  assert.equal(deviceIdentityDigest(device), deviceIdentityDigest(deviceIdentityFromDocument(reversed)));
});

test('a rename changes the digest but not the device id', () => {
  const before = baseDevice();
  const after = renameDevice(before, 'Renamed');
  assert.notEqual(deviceIdentityDigest(after), deviceIdentityDigest(before));
  assert.equal(after.deviceId, before.deviceId);
});

test('the serialised identity is a JSON document carrying exactly the declared fields', () => {
  const document = JSON.parse(serializeDeviceIdentity(baseDevice()));
  assert.deepEqual(Object.keys(document).sort(), [...DEVICE_IDENTITY_FIELDS].sort());
  assert.equal(document.schemaVersion, IDENTITY_SCHEMA_VERSION);
});

test('a credential secret never appears in a serialised installation document', () => {
  const installation = baseInstallation();
  const scan = credentialLeakScan(serializeInstallation(installation), SECRET);
  assert.equal(scan.secretPresent, false);
  assert.equal(scan.fingerprintPresent, true, 'the fingerprint is stored, the secret is not');
  assert.ok(!JSON.stringify(installation).includes(SECRET));
});

test('credential fingerprints are reproducible and secret-specific', () => {
  assert.equal(credentialFingerprint(SECRET), credentialFingerprint(SECRET));
  assert.notEqual(credentialFingerprint(SECRET), credentialFingerprint(`${SECRET}!`));
  assert.match(credentialFingerprint(SECRET), KEY_FINGERPRINT_PATTERN);
  assert.throws(() => credentialFingerprint(''), (error) => error.code === 'credential');
  assert.throws(() => credentialFingerprint(undefined), (error) => error.code === 'credential');
});

test('a secret is refused everywhere a fingerprint is offered in its place', () => {
  assert.throws(
    () => createInstallation({ installationId: INSTALLATION, instanceId: INSTANCE, credentialId: CREDENTIAL, credentialSecret: '', nowMs: T0, deviceId: DEVICE }),
    (error) => error.code === 'credential',
  );
});

/* --------------------------------------------------------- 9. purity and inputs */

test('minting refuses entropy that is not exactly 16 bytes', () => {
  for (const bad of [undefined, null, 'abcd', new Uint8Array(8), new Uint8Array(32), 42]) {
    assert.throws(() => mintDeviceId(bad), (error) => error.code === 'malformed');
  }
});

test('minted ids carry their type prefix and 32 hex digits', () => {
  assert.match(mintDeviceId(entropy('ab')), /^dev-[0-9a-f]{32}$/);
  assert.match(mintInstallationId(entropy('ab')), /^ins-[0-9a-f]{32}$/);
  assert.match(mintInstanceId(entropy('ab')), /^inst-[0-9a-f]{32}$/);
  assert.match(mintCredentialId(entropy('ab')), /^cred-[0-9a-f]{32}$/);
});

test('minting is pure: the same entropy yields the same id, different entropy does not', () => {
  assert.equal(mintDeviceId(entropy('ab')), mintDeviceId(entropy('ab')));
  assert.notEqual(mintDeviceId(entropy('ab')), mintDeviceId(entropy('cd')));
});

test('randomEntropy produces 16 usable bytes each call', () => {
  const a = randomEntropy();
  const b = randomEntropy();
  assert.equal(a.length, 16);
  assert.equal(b.length, 16);
  assert.notDeepEqual([...a], [...b]);
  assert.match(mintDeviceId(a), /^dev-[0-9a-f]{32}$/);
});

test('instants are parameters and a bad instant is refused with a code', () => {
  assert.equal(instantOf(T0), '2026-01-01T00:00:00.000Z');
  for (const bad of [undefined, null, 'now', NaN, Infinity, {}]) {
    assert.throws(() => instantOf(bad), (error) => error.code === 'instant');
  }
});

test('the metadata builder tolerates a partial observation set', () => {
  const metadata = deviceMetadata({ platform: 'linux' });
  assert.equal(metadata.platform, 'linux');
  assert.equal(metadata.os, null);
  assert.deepEqual(metadata.hostnames, []);
  assert.deepEqual(metadata.macAddresses, []);
});

/* ------------------------------------------------------ 10. declaration sanity */

test('the exported vocabularies are frozen and internally consistent', () => {
  assert.ok(Object.isFrozen(PRESENTATION_VERDICTS));
  assert.ok(PRESENTATION_VERDICTS.includes('ACCEPTED'));
  assert.equal(new Set(PRESENTATION_VERDICTS).size, PRESENTATION_VERDICTS.length);
  assert.equal(new Set(IDENTITY_REJECTION_CODES).size, IDENTITY_REJECTION_CODES.length);
  assert.equal(IDENTITY_SCHEMA_VERSION, 1);
});

test('every lifecycle refusal raised by the ladder is a declared rejection code', () => {
  const raised = [
    resolveInstallationPresentation(baseInstallation(), null),
    resolveInstallationPresentation(baseInstallation(), presentation({ installationId: mintInstallationId(entropy('77')) })),
    resolveInstallationPresentation(baseInstallation(), presentation({ credentialFingerprint: credentialFingerprint('x') })),
    resolveInstallationPresentation(baseInstallation(), presentation({ instanceId: mintInstanceId(entropy('99')) })),
    resolveInstallationPresentation(retireInstallation(baseInstallation(), T1), presentation()),
    resolveInstallationPresentation(quarantineInstallation(baseInstallation(), { nowMs: T1, code: 'clone_detected', detail: '' }), presentation()),
  ];
  for (const verdict of raised) {
    assert.equal(verdict.accepted, false);
    assert.ok(IDENTITY_REJECTION_CODES.includes(verdict.code), `${verdict.code} is declared`);
  }
  for (const verdict of raised) assert.ok(PRESENTATION_VERDICTS.includes(verdict.verdict));
});

/* ------------------------------------------- 12. correction round (host: Mech)
 *
 * Repairs made by the Correction host after independent adversarial probing. Each test
 * below fails on the pre-correction branch head b1ee127 and passes on the corrected head.
 * They are grouped so a reader can see exactly what the Correction changed and why.
 */

test('C1 a retired device cannot present key authority', () => {
  const retired = retireDevice(baseDevice(), T1);
  assert.equal(retired.state, 'RETIRED');
  // the key set is preserved as history, so the refusal must come from the device state
  assert.equal(retired.keys[0].state, 'ACTIVE');
  assert.throws(() => assertActiveKey(retired, 'key-1'), (error) => error.code === 'device_retired');
});

test('C2 a migrated legacy placeholder key is identity, never authentication', () => {
  const migrated = migrateDeviceIdentity({
    id: DEVICE,
    devicePrincipalId: DEVICE,
    displayName: 'gateway-row',
    metadata: { platform: 'win32' },
    agentVersion: '0.2.0',
  }, { nowMs: T0 });
  assert.equal(migrated.migrated, true);
  assert.equal(migrated.device.keys[0].material, 'PLACEHOLDER');
  assert.equal(migrated.device.keys[0].keyId, 'legacy-gateway');
  assert.throws(
    () => assertActiveKey(migrated.device, 'legacy-gateway'),
    (error) => error.code === 'key_material_missing',
  );
  // a real enrollment/rotation replaces the placeholder without moving device_id
  const rotated = rotateDeviceKey(migrated.device, { keyId: 'key-2', publicKeyMaterial: 'pk-real', nowMs: T1 });
  assert.equal(rotated.deviceId, migrated.device.deviceId);
  assert.equal(rotated.keys.find((key) => key.keyId === 'legacy-gateway').state, 'ROTATED');
  assert.equal(rotated.keys.find((key) => key.keyId === 'key-2').material, 'PUBLIC_KEY_MATERIAL');
  assert.equal(assertActiveKey(rotated, 'key-2').keyId, 'key-2');
});

test('C2 every v1 key must state a known material kind', () => {
  const document = deviceIdentityDocument(baseDevice());
  assert.equal(document.keys[0].material, 'PUBLIC_KEY_MATERIAL');
  const missing = validateDeviceIdentity({ ...document, keys: [{ ...document.keys[0], material: undefined }] });
  assert.equal(missing.valid, false);
  assert.equal(missing.code, 'key');
  const invented = validateDeviceIdentity({ ...document, keys: [{ ...document.keys[0], material: 'TRUST_ME' }] });
  assert.equal(invented.valid, false);
  assert.equal(invented.code, 'key');
});

test('C3 a reinstall must mint a new installation credential', () => {
  const current = baseInstallation();
  const fresh = { installationId: mintInstallationId(entropy('23')), instanceId: mintInstanceId(entropy('34')), nowMs: T1 };
  // reusing the credential handle
  assert.throws(
    () => reinstallInstallation(current, { ...fresh, credentialId: CREDENTIAL, credentialSecret: 'brand-new-secret' }),
    (error) => error.code === 'credential_reuse',
  );
  // reusing the credential secret under a new handle
  assert.throws(
    () => reinstallInstallation(current, { ...fresh, credentialId: mintCredentialId(entropy('55')), credentialSecret: SECRET }),
    (error) => error.code === 'credential_reuse',
  );
  // reusing the fingerprint directly
  assert.throws(
    () => reinstallInstallation(current, { ...fresh, credentialId: mintCredentialId(entropy('55')), credentialFingerprint: current.credential.fingerprint }),
    (error) => error.code === 'credential_reuse',
  );
  // a genuinely fresh credential is still accepted
  const next = reinstallInstallation(current, { ...fresh, credentialId: mintCredentialId(entropy('55')), credentialSecret: 'fresh-secret' });
  assert.equal(next.installation.state, 'UNBOUND');
  assert.notEqual(next.installation.credential.fingerprint, current.credential.fingerprint);
});

test('C4 a population scan finds one credential shared by two installation identities', () => {
  const shared = createInstallation({
    installationId: mintInstallationId(entropy('55')),
    instanceId: mintInstanceId(entropy('66')),
    credentialId: CREDENTIAL,
    credentialSecret: SECRET,
    nowMs: T0,
    deviceId: OTHER_DEVICE,
  });
  const findings = detectCredentialClones([baseInstallation(), shared]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].reason, 'REUSED_CREDENTIAL');
  assert.equal(findings[0].credentialFingerprint, credentialFingerprint(SECRET));
  assert.deepEqual(findings[0].installationIds, [INSTALLATION, mintInstallationId(entropy('55'))].sort());
  // the same installation identity under two instances is a different fact, reported once
  const clone = createInstallation({
    installationId: INSTALLATION,
    instanceId: mintInstanceId(entropy('99')),
    credentialId: CREDENTIAL,
    credentialSecret: SECRET,
    nowMs: T0,
    deviceId: DEVICE,
  });
  const identityFindings = detectCredentialClones([baseInstallation(), clone]);
  assert.equal(identityFindings.length, 1);
  assert.equal(identityFindings[0].reason, 'SHARED_INSTALLATION_IDENTITY');
  assert.equal(identityFindings[0].installationId, INSTALLATION);
});

test('C5 a quarantined installation can be retired and keeps its quarantine evidence', () => {
  const quarantined = quarantineInstallation(baseInstallation(), { nowMs: T1, code: 'clone_detected', detail: 'two instances' });
  const retired = retireInstallation(quarantined, T1);
  assert.equal(retired.state, 'RETIRED');
  assert.equal(retired.retiredAt, instantOf(T1));
  assert.deepEqual(retired.quarantine, quarantined.quarantine);
  assert.equal(validateInstallation(retired).valid, true);
  assert.equal(resolveInstallationPresentation(retired, presentation()).verdict, 'RETIRED');
  assert.throws(() => retireInstallation(retired, T1), (error) => error.code === 'already_retired');
});

test('C5 a reinstall from a quarantined installation works and preserves the quarantine record', () => {
  const quarantined = quarantineInstallation(baseInstallation(), { nowMs: T1, code: 'clone_detected', detail: 'two instances' });
  const { retired, installation } = reinstallInstallation(quarantined, {
    installationId: mintInstallationId(entropy('55')),
    instanceId: mintInstanceId(entropy('66')),
    credentialId: mintCredentialId(entropy('77')),
    credentialSecret: 'fresh-secret',
    nowMs: T1,
  });
  assert.equal(retired.state, 'RETIRED');
  assert.deepEqual(retired.quarantine, quarantined.quarantine);
  assert.equal(installation.state, 'UNBOUND');
  assert.equal(installation.deviceId, null);
  assert.equal(installation.rebind.required, true);
});

test('C5 a quarantine block is legal only on a quarantined or already-quarantined-retired record', () => {
  const withBlock = { ...baseInstallation(), quarantine: { at: instantOf(T1), code: 'clone_detected', detail: '' } };
  const verdict = validateInstallation(withBlock);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.code, 'malformed');
  assert.match(verdict.detail, /quarantine block/);
  const missingBlock = validateInstallation({
    ...quarantineInstallation(baseInstallation(), { nowMs: T1, code: 'clone_detected', detail: '' }),
    state: 'QUARANTINED',
    quarantine: null,
  });
  assert.equal(missingBlock.valid, false);
  assert.match(missingBlock.detail, /must carry its quarantine block/);
});

test('C6 MAC pairing evidence accepts one address, several, or none, and refuses other shapes', () => {
  assert.equal(macPairingEvidence().entries.length, 0);
  assert.equal(macPairingEvidence(null).entries.length, 0);
  assert.equal(macPairingEvidence(GLOBAL_MAC).entries.length, 1);
  assert.equal(macPairingEvidence(GLOBAL_MAC).entries[0].value, GLOBAL_MAC);
  assert.equal(macPairingEvidence(GLOBAL_MAC).canBlockPairing, false);
  assert.equal(macPairingEvidence([GLOBAL_MAC, RANDOM_MAC]).entries.length, 2);
  assert.equal(macPairingEvidence([GLOBAL_MAC, RANDOM_MAC]).randomized, 1);
  assert.throws(() => macPairingEvidence(42), (error) => error.code === 'malformed');
  assert.throws(() => macPairingEvidence({ value: GLOBAL_MAC }), (error) => error.code === 'malformed');
});

test('C6 every correction refusal code is declared in the rejection vocabulary', () => {
  for (const code of ['key_material_missing', 'credential_reuse', 'device_retired']) {
    assert.ok(IDENTITY_REJECTION_CODES.includes(code), `${code} is declared`);
  }
});
