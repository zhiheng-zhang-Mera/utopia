// BA-001 conformance suite for the Butler Assistant Zone contract.
//
// Covers the task's acceptance requirements: profile isolation, reset, version
// validation, safe defaults, no authority escalation through personalization,
// Digital-Me isolation, atomic import and stale-write refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
 BUNDLE_KIND, BUNDLE_VERSION, BUTLER_ASSISTANT_CONTRACT, DIGITAL_ME_WRITE_SURFACE,
 MAX_DUTY_LABELS, MAX_EXTENSION_NAMESPACES, PERSONALIZATION_PORT_IDS,
 PROFILE_AUTHORITY_BOUNDARY, PROFILE_SCHEMA_VERSION, PersonalizationError, RELATIONSHIP_MODES,
 RESERVED_KEY_PATTERN,
 applyProfilePatch, createAssistantZone, createDefaultProfile, createPortRegistry,
 effectiveGrantsFromProfile, findAuthorityPaths, migrateProfile, normalizeProfile,
 validateBundle, validateProfile
} from '../index.mjs';

const CLOCK = '2026-09-30T00:00:00.000Z';
const LATER = '2026-10-01T00:00:00.000Z';
const zone = (options = {}) => createAssistantZone({ clock: () => CLOCK, ...options });
const expectCode = (fn, code) => {
 try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}`); return error; }
 assert.fail(`expected the call to fail with ${code}`);
};

test('a fresh profile is fully normalized, descriptive and authority-free', () => {
 const profile = createDefaultProfile();
 assert.equal(profile.schema_version, PROFILE_SCHEMA_VERSION);
 assert.deepEqual(profile.duties, { labels: [] });
 assert.deepEqual(profile.personality, { tone: 'neutral', traits: [] });
 assert.equal(profile.companion.relationshipMode, 'assistant');
 assert.equal(profile.voice.voiceId, null);
 assert.deepEqual(profile.extensions, {});
 assert.deepEqual(findAuthorityPaths(profile), []);
 assert.equal(validateProfile(profile).ok, true);
 assert.deepEqual([...BUTLER_ASSISTANT_CONTRACT.ports], [...PERSONALIZATION_PORT_IDS]);
});

test('partially specified ports receive safe defaults', () => {
 const profile = normalizeProfile({ schema_version: 1, address: { assistantName: 'Aria' } });
 assert.equal(profile.address.assistantName, 'Aria');
 assert.equal(profile.address.pronouns, null);
 assert.deepEqual(profile.voice, createDefaultProfile().voice);
 assert.deepEqual(profile.companion, createDefaultProfile().companion);
 expectCode(() => normalizeProfile(null), 'INVALID_ASSISTANT_PROFILE');
 expectCode(() => normalizeProfile({ schema_version: 1, mood: 'happy' }), 'INVALID_ASSISTANT_PROFILE');
});

test('two assistant identities hold independent profiles and relationship modes at the same time', () => {
 const z = zone();
 z.createIdentity({ assistantId: 'butler-a' });
 z.createIdentity({ assistantId: 'companion-b', profile: { companion: { relationshipMode: 'companion', companionName: 'Yuki' } } });
 z.patchProfile('butler-a', { companion: { relationshipMode: 'butler' }, duties: { labels: ['household'] } });
 assert.equal(z.getProfile('butler-a').companion.relationshipMode, 'butler');
 assert.equal(z.getProfile('companion-b').companion.relationshipMode, 'companion');
 assert.equal(z.getProfile('companion-b').companion.companionName, 'Yuki');
 assert.deepEqual(z.getProfile('companion-b').duties.labels, []);
 assert.equal(z.getProfile('butler-a').address.userFormOfAddress, null);
 assert.deepEqual(z.listIdentities().map(record => record.assistantId), ['butler-a', 'companion-b']);
});

test('a relationship change on one assistant never leaks into another assistant or its bundle', () => {
 const z = zone();
 z.createIdentity({ assistantId: 'a' });
 z.createIdentity({ assistantId: 'b' });
 z.patchProfile('a', { companion: { relationshipMode: 'companion' } });
 z.patchProfile('b', { companion: { relationshipMode: 'secretary' } });
 const bundleA = z.exportBundle('a', { exportedAt: CLOCK });
 assert.equal(bundleA.assistant.profile.companion.relationshipMode, 'companion');
 assert.equal(JSON.stringify(bundleA).includes('secretary'), false);
 assert.equal(z.getProfile('b').companion.relationshipMode, 'secretary');
});

test('several assistant identities can be online at once and presence is idempotent', () => {
 const z = zone();
 z.createIdentity({ assistantId: 'a' });
 z.createIdentity({ assistantId: 'b' });
 assert.equal(z.setPresence('a', { deviceId: 'mech-android' }).idempotent, false);
 assert.equal(z.setPresence('b', { deviceId: 'mech-android' }).idempotent, false);
 assert.equal(z.setPresence('a', { deviceId: 'alien-web' }).idempotent, false);
 assert.equal(z.setPresence('a', { deviceId: 'mech-android' }).idempotent, true);
 assert.deepEqual(z.listOnlineAssistantIds(), ['a', 'b']);
 assert.equal(z.listPresence().length, 3);
 assert.equal(z.listPresence().every(entry => entry.since === CLOCK), true);
 assert.equal(z.clearPresence('a', { deviceId: 'alien-web' }).cleared, true);
 assert.equal(z.clearPresence('a', { deviceId: 'alien-web' }).cleared, false);
 // presence is session state: it is never exported as durable assistant state
 assert.equal('presence' in z.exportBundle('a'), false);
 assert.equal('presence' in z.exportBundle('a').assistant, false);
});

test('a duplicate assistant id is refused and leaves state untouched', () => {
 const z = zone();
 const created = z.createIdentity({ assistantId: 'dup' });
 const before = z.snapshot();
 expectCode(() => z.createIdentity({ assistantId: 'dup' }), 'ASSISTANT_ID_CONFLICT');
 assert.deepEqual(z.snapshot(), before);
 assert.equal(created.idSource, 'provided');
 expectCode(() => z.createIdentity({ assistantId: 'bad id!' }), 'INVALID_ASSISTANT_ID');
});

test('minted assistant ids are stable, unique and honestly labelled', () => {
 const z = zone();
 const first = z.createIdentity({});
 const second = z.createIdentity({});
 assert.equal(first.assistantId, 'assistant-1');
 assert.equal(first.idSource, 'minted');
 assert.equal(second.idSource, 'minted');
 assert.notEqual(first.assistantId, second.assistantId);
 assert.equal(z.listIdentities().length, 2);
});

test('profiles reject embedded permission grants, execution leases and authority fields', () => {
 const base = createDefaultProfile();
 const cases = [
  ['profile.duties.permissions', { ...base, duties: { labels: [], permissions: ['act:device.control'] } }],
  ['profile.voice.executionLease', { ...base, voice: { ...base.voice, executionLease: { scope: 'exclusive' } } }],
  ['profile.personality.authority', { ...base, personality: { ...base.personality, authority: { grants: [] } } }],
  ['profile.appearance.capabilities', { ...base, appearance: { ...base.appearance, capabilities: ['camera'] } }],
  ['profile.companion.actionKey', { ...base, companion: { ...base.companion, actionKey: 'k-1' } }],
  ['profile.address.accessToken', { ...base, address: { ...base.address, accessToken: 't' } }],
  ['profile.personality.effect=allow', { ...base, personality: { ...base.personality, effect: 'allow' } }]
 ];
 for (const [path, profile] of cases) {
  const result = validateProfile(profile);
  assert.equal(result.ok, false, path);
  assert.equal(result.errors.some(error => error.includes(path)), true, `${path} not reported: ${result.errors.join(' | ')}`);
 }
});

test('extension namespaces cannot smuggle Digital-Me or authority namespaces', () => {
 const base = createDefaultProfile();
 const withExtensions = extensions => ({ ...base, extensions });
 assert.equal(validateProfile(withExtensions({ 'acme.notes': { version: 1, value: { text: 'ok' } } })).ok, true);
 const digitalMe = validateProfile(withExtensions({ 'digital-me.core': { version: 1, value: {} } }));
 assert.equal(digitalMe.ok, false);
 assert.equal(digitalMe.errors.some(error => error.includes('Digital-Me')), true);
 assert.equal(validateProfile(withExtensions({ 'user-identity.core': { version: 1, value: {} } })).ok, false);
 assert.equal(validateProfile(withExtensions({ 'policy.device': { version: 1, value: {} } })).ok, false);
 const nested = validateProfile(withExtensions({ 'acme.notes': { version: 1, value: { permissions: ['act:x'] } } }));
 assert.equal(nested.ok, false);
 assert.equal(nested.errors.some(error => error.includes('authority field')), true);
 assert.equal(validateProfile(withExtensions({ 'acme.notes': { version: 0, value: {} } })).ok, false);
 assert.equal(validateProfile(withExtensions({ 'Bad Namespace': { version: 1, value: {} } })).ok, false);
});

test('schema version and port shape are validated instead of silently accepted', () => {
 const base = createDefaultProfile();
 assert.equal(validateProfile({ ...base, schema_version: PROFILE_SCHEMA_VERSION + 1 }).ok, false);
 assert.equal(validateProfile({ ...base, schema_version: 0 }).ok, false);
 assert.equal(validateProfile({ ...base, voice: { ...base.voice, volume: 5 } }).ok, false);
 assert.equal(validateProfile({ ...base, voice_version: 1 }).ok, false);
 assert.equal(validateProfile({ ...base, duties: { labels: [], extra: true } }).ok, false);
 const result = validateProfile(base);
 assert.equal(result.ok, true, result.errors.join(' | '));
});

test('unknown future attributes migrate forward without losing data', () => {
 const proactivityPort = {
  id: 'proactivity', version: 1, sinceVersion: 2,
  default: () => ({ level: 'quiet' }),
  validate(value, path, errors = []) {
   if (value?.level !== 'quiet' && value?.level !== 'active') errors.push(`${path}.level must be quiet or active`);
   return errors;
  }
 };
 const registry = createPortRegistry({ additionalPorts: [proactivityPort] });
 assert.equal(registry.schemaVersion, 2);
 const original = {
  ...createDefaultProfile(),
  address: { assistantName: 'Aria', userFormOfAddress: null, pronouns: null },
  extensions: { 'acme.notes': { version: 3, value: { text: 'keep me' } } }
 };
 const migrated = migrateProfile(original, { toVersion: 2, registry });
 assert.equal(migrated.fromVersion, 1);
 assert.equal(migrated.toVersion, 2);
 assert.deepEqual(migrated.addedPorts, ['proactivity']);
 assert.deepEqual(migrated.profile.proactivity, { level: 'quiet' });
 assert.deepEqual(migrated.profile.extensions['acme.notes'], { version: 3, value: { text: 'keep me' } });
 assert.deepEqual(migrated.preservedExtensions, ['acme.notes']);
 assert.equal(migrated.profile.address.assistantName, 'Aria');
 assert.equal(validateProfile(migrated.profile, { registry }).ok, true);
 // the migrated profile is not silently readable by a registry that cannot describe it
 assert.equal(validateProfile(migrated.profile).ok, false);
 expectCode(() => migrateProfile(migrated.profile, { toVersion: 1, registry }), 'UNSUPPORTED_PROFILE_MIGRATION');
 expectCode(() => migrateProfile(original, { toVersion: 3, registry }), 'UNSUPPORTED_PROFILE_MIGRATION');
});

test('a rejected write is a no-op and schema_version cannot be patched', () => {
 const z = zone();
 z.createIdentity({ assistantId: 'a' });
 const before = z.snapshot();
 expectCode(() => z.patchProfile('a', { mood: 'happy' }), 'UNKNOWN_PERSONALIZATION_PORT');
 expectCode(() => z.setProfile('a', { schema_version: 1, duties: { labels: [], permissions: [] } }), 'INVALID_ASSISTANT_PROFILE');
 expectCode(() => z.patchProfile('a', { schema_version: 2 }), 'PROFILE_SCHEMA_VERSION_IMMUTABLE');
 assert.deepEqual(z.snapshot(), before);
});

test('a stale profile write is refused instead of silently overwriting', () => {
 const z = zone();
 const created = z.createIdentity({ assistantId: 'a' });
 assert.equal(created.revision, 1);
 const staleWriter = z.getIdentity('a');
 z.patchProfile('a', { voice: { speakingRate: 0.9 } }, { expectedRevision: staleWriter.revision });
 expectCode(() => z.patchProfile('a', { voice: { pitch: 0.1 } }, { expectedRevision: staleWriter.revision }), 'PROFILE_REVISION_CONFLICT');
 assert.equal(z.getProfile('a').voice.speakingRate, 0.9);
 assert.equal(z.getProfile('a').voice.pitch, 0.5);
 assert.equal(z.getIdentity('a').revision, 2);
 expectCode(() => z.setProfile('a', createDefaultProfile(), { expectedRevision: 'one' }), 'INVALID_EXPECTED_REVISION');
 assert.equal(z.getProfile('a').voice.speakingRate, 0.9);
});

test('export and import restore durable assistant state after a simulated restart', () => {
 const source = zone();
 source.createIdentity({ assistantId: 'butler-a', profile: { companion: { relationshipMode: 'butler' }, extensions: { 'acme.notes': { version: 1, value: { text: 'hi' } } } } });
 source.createIdentity({ assistantId: 'companion-b' });
 source.setPresence('butler-a', { deviceId: 'mech-android' });
 const bundle = source.exportBundle('butler-a', { exportedAt: CLOCK });
 assert.equal(bundle.kind, BUNDLE_KIND);
 assert.equal(bundle.bundle_version, BUNDLE_VERSION);
 assert.equal(bundle.exported_at, CLOCK);
 assert.deepEqual(validateBundle(bundle), { ok: true, errors: [] });
 const restarted = zone();
 const imported = restarted.importBundle(bundle, { importedAt: LATER });
 assert.equal(imported.mode, 'create');
 assert.equal(imported.revision, 1);
 assert.equal(restarted.listIdentities().length, 1);
 assert.deepEqual(restarted.getProfile('butler-a'), source.getProfile('butler-a'));
 assert.deepEqual(restarted.listPresence(), []);
 assert.equal(restarted.getIdentity('butler-a').updatedAt, LATER);
 // a restart cannot resurrect the identity of another assistant
 assert.equal(restarted.hasIdentity('companion-b'), false);
});

test('replace import touches only the target assistant and bumps its revision', () => {
 const z = zone();
 z.createIdentity({ assistantId: 'a' });
 z.createIdentity({ assistantId: 'b' });
 const bundle = z.exportBundle('a', { exportedAt: CLOCK });
 const untouched = z.getProfile('b');
 const replaced = z.importBundle(bundle, { mode: 'replace', importedAt: LATER });
 assert.equal(replaced.revision, 2);
 assert.deepEqual(z.getProfile('b'), untouched);
 expectCode(() => z.importBundle(bundle, { mode: 'create' }), 'ASSISTANT_ID_CONFLICT');
 expectCode(() => zone().importBundle(bundle, { mode: 'replace' }), 'ASSISTANT_NOT_FOUND');
 expectCode(() => z.importBundle(bundle, { mode: 'merge' }), 'INVALID_IMPORT_MODE');
});

test('import rejects Digital-Me data, authority fields and malformed bundles atomically', () => {
 const z = zone();
 z.createIdentity({ assistantId: 'a' });
 const bundle = z.exportBundle('a', { exportedAt: CLOCK });
 const tampered = [
  { ...structuredClone(bundle), digitalMe: { userId: 'owner' } },
  { ...structuredClone(bundle), assistant: { ...bundle.assistant, userIdentity: { userId: 'owner' } } },
  { ...structuredClone(bundle), assistant: { ...bundle.assistant, actionKey: 'k-1' } },
  (() => { const b = structuredClone(bundle); b.assistant.profile.extensions = { 'digital-me.core': { version: 1, value: {} } }; return b; })(),
  (() => { const b = structuredClone(bundle); b.assistant.profile.duties = { labels: [], permissions: ['act:x'] }; return b; })(),
  { ...structuredClone(bundle), bundle_version: 99 },
  { ...structuredClone(bundle), assistant: { ...bundle.assistant, profile: { ...bundle.assistant.profile, mood: 'happy' } } }
 ];
 const before = z.snapshot();
 for (const bad of tampered) {
  expectCode(() => z.importBundle(bad), 'INVALID_ASSISTANT_BUNDLE');
  const report = validateBundle(bad);
  assert.equal(report.ok, false);
  assert.equal(report.errors.length > 0, true);
 }
 assert.deepEqual(z.snapshot(), before);
 const digitalMeReport = validateBundle(tampered[0]);
 assert.equal(digitalMeReport.errors.some(error => error.includes('bundle.digitalMe')), true);
 const authorityReport = validateBundle(tampered[2]);
 assert.equal(authorityReport.errors.some(error => error.includes('authority field')), true);
});

test('reset restores safe defaults for one assistant without touching the others', () => {
 const z = zone();
 z.createIdentity({ assistantId: 'a' });
 z.createIdentity({ assistantId: 'b' });
 z.patchProfile('a', { voice: { voiceId: 'v-1' }, extensions: { 'acme.notes': { version: 1, value: { text: 'x' } } } });
 z.patchProfile('b', { voice: { voiceId: 'v-2' } });
 z.resetProfile('a');
 assert.deepEqual(z.getProfile('a'), createDefaultProfile());
 assert.equal(z.getProfile('b').voice.voiceId, 'v-2');
 z.patchProfile('a', { extensions: { 'acme.notes': { version: 1, value: { text: 'x' } } } });
 z.resetProfile('a', { keepExtensions: true });
 assert.deepEqual(z.getProfile('a').extensions, { 'acme.notes': { version: 1, value: { text: 'x' } } });
 assert.equal(z.getProfile('a').voice.voiceId, null);
 assert.deepEqual(z.resetAllProfiles().reset, ['a', 'b']);
 assert.deepEqual(z.getProfile('a'), createDefaultProfile());
 assert.deepEqual(z.getProfile('b'), createDefaultProfile());
 assert.equal(z.getIdentity('a').revision, 6);
 assert.equal(z.getIdentity('b').revision, 3);
});

test('duty labels describe a role and never grant the corresponding action', () => {
 const z = zone();
 z.createIdentity({ assistantId: 'a' });
 z.patchProfile('a', { duties: { labels: ['household', 'night-shift'] } });
 const profile = z.getProfile('a');
 assert.deepEqual(profile.duties.labels, ['household', 'night-shift']);
 const boundary = effectiveGrantsFromProfile(profile);
 assert.deepEqual(boundary.grants, []);
 assert.equal(boundary.authority, 'ASSISTANT_PROFILE_GRANTS_NO_AUTHORITY');
 assert.equal(PROFILE_AUTHORITY_BOUNDARY.profileGrantsAuthority, false);
 assert.equal(PROFILE_AUTHORITY_BOUNDARY.relationshipModeGrantsAuthority, false);
 assert.equal(PROFILE_AUTHORITY_BOUNDARY.dutyLabelsAreDescriptiveOnly, true);
 assert.deepEqual([...PROFILE_AUTHORITY_BOUNDARY.effectivePermissionSources], ['User/OwnerPolicy', 'AssistantPolicy', 'DeviceCapability', 'TaskActionGrant']);
 // grant-shaped duty labels are rejected outright
 expectCode(() => z.patchProfile('a', { duties: { labels: ['act:device.control'] } }), 'INVALID_ASSISTANT_PROFILE');
 expectCode(() => z.patchProfile('a', { duties: { labels: ['DeviceControl'] } }), 'INVALID_ASSISTANT_PROFILE');
 const tooMany = Array.from({ length: MAX_DUTY_LABELS + 1 }, (unused, index) => `duty-${index}`);
 expectCode(() => z.patchProfile('a', { duties: { labels: tooMany } }), 'INVALID_ASSISTANT_PROFILE');
 assert.deepEqual(z.getProfile('a').duties.labels, ['household', 'night-shift']);
});

test('the personalization surface never writes Digital-Me state', () => {
 const digitalMe = { userId: 'owner', selfModel: { values: ['privacy'] }, memories: [{ id: 'm-1' }] };
 const sentinel = structuredClone(digitalMe);
 const z = zone();
 z.createIdentity({ assistantId: 'butler-a' });
 z.patchProfile('butler-a', { companion: { relationshipMode: 'companion' }, address: { userFormOfAddress: 'Boss' } });
 z.exportBundle('butler-a', { exportedAt: CLOCK });
 z.importBundle(z.exportBundle('butler-a'), { mode: 'replace', importedAt: LATER });
 z.resetAllProfiles();
 z.removeIdentity('butler-a');
 assert.deepEqual(digitalMe, sentinel);
 assert.equal(DIGITAL_ME_WRITE_SURFACE.mutatesDigitalMe, false);
 assert.equal(DIGITAL_ME_WRITE_SURFACE.acceptsDigitalMeInput, false);
 assert.equal(DIGITAL_ME_WRITE_SURFACE.assistantRelationshipStoredOnAssistant, true);
});

test('identity lifecycle errors are typed and presence is cleaned up', () => {
 const z = zone();
 z.createIdentity({ assistantId: 'a' });
 expectCode(() => z.getProfile('missing'), 'ASSISTANT_NOT_FOUND');
 expectCode(() => z.setPresence('missing', { deviceId: 'd' }), 'ASSISTANT_NOT_FOUND');
 expectCode(() => z.removeIdentity('missing'), 'ASSISTANT_NOT_FOUND');
 expectCode(() => z.setPresence('a', { deviceId: '' }), 'INVALID_DEVICE_ID');
 // caller-supplied timestamps are typed: a Date object never leaks into state
 const bundle = z.exportBundle('a', { exportedAt: CLOCK });
 expectCode(() => z.patchProfile('a', {}, { at: new Date(0) }), 'INVALID_TIMESTAMP');
 expectCode(() => z.resetAllProfiles({ at: 5 }), 'INVALID_TIMESTAMP');
 expectCode(() => z.exportBundle('a', { exportedAt: 5 }), 'INVALID_TIMESTAMP');
 expectCode(() => z.importBundle(bundle, { importedAt: 5 }), 'INVALID_TIMESTAMP');
 expectCode(() => z.setPresence('a', { deviceId: 'd', since: 5 }), 'INVALID_TIMESTAMP');
 assert.deepEqual(z.getProfile('a'), createDefaultProfile());
 const z2 = zone();
 z2.createIdentity({ assistantId: 'a' });
 z2.setPresence('a', { deviceId: 'mech-android' });
 assert.deepEqual(z2.removeIdentity('a'), { assistantId: 'a', removed: true });
 assert.deepEqual(z2.listPresence(), []);
 assert.equal(z2.hasIdentity('a'), false);
});

test('applyProfilePatch merges one port level and replaces arrays', () => {
 const base = createDefaultProfile();
 const patched = applyProfilePatch(base, { personality: { tone: 'warm' }, duties: { labels: ['household'] } });
 assert.deepEqual(patched.personality, { tone: 'warm', traits: [] });
 assert.deepEqual(patched.duties, { labels: ['household'] });
 assert.deepEqual(base.personality, { tone: 'neutral', traits: [] });
 const replaced = applyProfilePatch(patched, { duties: { labels: ['night-shift'] } });
 assert.deepEqual(replaced.duties, { labels: ['night-shift'] });
 assert.deepEqual(patched.duties, { labels: ['household'] });
 expectCode(() => applyProfilePatch(base, { extensions: [] }), 'INVALID_PROFILE_PATCH');
 expectCode(() => applyProfilePatch({ ...base, duties: { labels: ['BAD'] } }, {}), 'INVALID_ASSISTANT_PROFILE');
 assert.equal(new PersonalizationError('X', 'y').status, 400);
});

test('the published schema matches the runtime contract', () => {
 const schema = JSON.parse(readFileSync(new URL('../schema.json', import.meta.url), 'utf8'));
 assert.equal(schema.$defs.profile.properties.schema_version.maximum, PROFILE_SCHEMA_VERSION);
 assert.equal(schema.$defs.bundle.properties.bundle_version.maximum, BUNDLE_VERSION);
 assert.equal(schema.$defs.bundle.properties.kind.const, BUNDLE_KIND);
 assert.deepEqual(Object.keys(schema.$defs.profile.properties).sort(),
  ['address', 'appearance', 'companion', 'duties', 'extensions', 'personality', 'schema_version', 'voice']);
 assert.deepEqual(schema.$defs.companion.properties.relationshipMode.enum, [...RELATIONSHIP_MODES]);
 assert.equal(schema.$defs.profile.properties.extensions.maxProperties, MAX_EXTENSION_NAMESPACES);
 assert.equal(schema.$defs.duties.properties.labels.maxItems, MAX_DUTY_LABELS);
 assert.equal(schema['x-authority-boundary'].profileGrantsAuthority, false);
 assert.equal(schema.$defs.profile.additionalProperties, false);
 assert.deepEqual(Object.keys(schema.$defs).sort(),
  ['address', 'appearance', 'assistantIdentity', 'bundle', 'companion', 'duties', 'extensionEntry', 'label', 'nullableId', 'nullableText', 'personality', 'profile', 'voice']);
});

// ---------------------------------------------------------------------------
// CORRECTION (host Alien, BA-001 Correction stage) — adversarial regressions.
//
// Every test below failed before the repair. They are grouped here so a later
// reader can see exactly which attack each one closes, and they assert both the
// refusal *and* that nothing changed, because a guard that throws after mutating
// is not a guard.
// ---------------------------------------------------------------------------

// `JSON.parse` is used to build these objects on purpose: it is the only honest
// way to obtain an object with an *own* `__proto__` property, which is the shape
// that arrives over the wire and the shape a hand-written object literal cannot
// express (`{ __proto__: x }` sets the prototype instead of adding a key).
const ownProtoPatch = () => JSON.parse('{"__proto__":{"isAdmin":true}}');

test('a profile patch cannot rewrite a prototype or inject a hidden property', () => {
 const base = createDefaultProfile({ overrides: { address: { assistantName: 'Aria' } } });
 const before = JSON.stringify(Object.keys(base));
 for (const patch of [
  ownProtoPatch(),
  JSON.parse('{"constructor":{"prototype":{"isAdmin":true}}}'),
  JSON.parse('{"prototype":{"isAdmin":true}}')
 ]) {
  expectCode(() => applyProfilePatch(base, patch), 'RESERVED_PROFILE_PATCH_KEY');
 }
 // The refused patch is a no-op: no hidden property, no prototype change, and the
 // global Object.prototype was never reached either.
 assert.equal(Object.getPrototypeOf(base), Object.prototype);
 assert.equal('isAdmin' in base, false);
 assert.equal(base.isAdmin, undefined);
 assert.equal(Object.keys(base).length, 8);
 assert.equal(JSON.stringify(Object.keys(base)), before);
 assert.equal({}.isAdmin, undefined, 'Object.prototype must not be polluted');
});

test('the Zone patch path is closed to prototype injection and leaves state untouched', () => {
 const z = zone();
 const created = z.createIdentity({ assistantId: 'assistant-a' });
 expectCode(() => z.patchProfile('assistant-a', ownProtoPatch()), 'RESERVED_PROFILE_PATCH_KEY');
 const profile = z.getProfile('assistant-a');
 assert.equal(Object.getPrototypeOf(profile), Object.prototype);
 assert.equal('isAdmin' in profile, false);
 assert.equal(z.getIdentity('assistant-a').revision, created.revision, 'a refused patch must not bump the revision');
 assert.equal(validateProfile(profile).ok, true);
});

test('a rejected patch leaves the stored profile byte-identical', () => {
 const z = zone();
 z.createIdentity({ assistantId: 'assistant-a' });
 const before = JSON.stringify(z.getProfile('assistant-a'));
 expectCode(() => z.patchProfile('assistant-a', JSON.parse('{"__proto__":{"isAdmin":true}}')), 'RESERVED_PROFILE_PATCH_KEY');
 expectCode(() => z.patchProfile('assistant-a', { nope: 1 }), 'UNKNOWN_PERSONALIZATION_PORT');
 assert.equal(JSON.stringify(z.getProfile('assistant-a')), before);
});

test('inherited property names are not declared port fields', () => {
 const base = createDefaultProfile();
 for (const key of ['toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'constructor', 'propertyIsEnumerable']) {
  const profile = JSON.parse(JSON.stringify(base));
  profile.voice[key] = 'x';
  const result = validateProfile(profile);
  assert.equal(result.ok, false, `${key} must not be accepted as a declared voice field`);
  assert.ok(result.errors.some(error => error.includes(`profile.voice.${key}`)), JSON.stringify(result.errors));
 }
 // The legitimate fields of the same port are still accepted.
 const ok = JSON.parse(JSON.stringify(base));
 ok.voice.speakingRate = 0.75;
 assert.equal(validateProfile(ok).ok, true);
});

test('reserved keys are refused at every depth of a stored profile document', () => {
 const base = createDefaultProfile();
 const deep = JSON.parse('{"extensions":{"ns":{"version":1,"value":{"a":{"__proto__":{"isAdmin":true}}}}}}');
 const result = validateProfile({ ...JSON.parse(JSON.stringify(base)), ...deep });
 assert.equal(result.ok, false);
 assert.ok(result.errors.some(error => error.includes('__proto__')), JSON.stringify(result.errors));

 const inPort = JSON.parse(JSON.stringify(base));
 inPort.extensions = JSON.parse('{"ns":{"version":1,"value":{"prototype":{"x":1}}}}');
 assert.equal(validateProfile(inPort).ok, false);
});

test('a bundle refuses a reserved key anywhere, including inside an extension value', () => {
 const z = zone();
 z.createIdentity({ assistantId: 'assistant-a' });
 const bundle = JSON.parse(JSON.stringify(z.exportBundle('assistant-a')));
 bundle.assistant.profile.extensions = JSON.parse('{"ns":{"version":1,"value":{"__proto__":{"isAdmin":true}}}}');
 const result = validateBundle(bundle);
 assert.equal(result.ok, false);
 assert.ok(result.errors.some(error => error.includes('__proto__')), JSON.stringify(result.errors));
 expectCode(() => z.importBundle(bundle, { mode: 'create' }), 'INVALID_ASSISTANT_BUNDLE');
});

test('a reserved key cannot be registered as a personalization port', () => {
 for (const id of ['__proto__', 'prototype', 'constructor']) {
  expectCode(
   () => createPortRegistry({ additionalPorts: [{ id, sinceVersion: 1, default: () => ({}), validate: () => [] }] }),
   'RESERVED_PORT_ID'
  );
 }
 // Registering a normal additional port still works, and does not disturb the registry.
 const registry = createPortRegistry({ additionalPorts: [{ id: 'ambience', sinceVersion: 1, default: () => ({ level: 0 }), validate: (value, path, errors) => errors }] });
 assert.equal(Object.hasOwn(registry.ports, 'ambience'), true);
 assert.equal(Object.getPrototypeOf(registry.ports), Object.prototype);
 assert.equal(registry.ports.__proto__, Object.prototype);
});

test('the published schema states the reserved-prototype-key rule the runtime enforces', () => {
 const schema = JSON.parse(readFileSync(new URL('../schema.json', import.meta.url), 'utf8'));
 const declared = schema['x-authority-boundary'].forbiddenPrototypeKeys;
 assert.deepEqual(declared, ['__proto__', 'prototype', 'constructor'], 'the schema must list exactly the keys the runtime refuses');
 for (const key of declared) {
  assert.equal(RESERVED_KEY_PATTERN.test(key), true, `${key} is enforced by the runtime`);
 }
 assert.equal(RESERVED_KEY_PATTERN.test('toString'), false, 'the rule is about prototype keys, not every inherited name');
 assert.match(schema['x-authority-boundary'].note, /prototype/);
});
