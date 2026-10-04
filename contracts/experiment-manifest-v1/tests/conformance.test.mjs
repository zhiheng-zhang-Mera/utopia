// REX-801 — Experiment manifest contract conformance.
//
// The manifest exists so that an experiment is *described before it runs*. That makes three properties
// non-negotiable, and this file attacks each of them:
//
//   1. a missing field is an issue, never a fabricated default;
//   2. an impossible topology / unknown capability / conflicting variable is refused, not smoothed over;
//   3. the same manifest always yields the same seeds, on any host, forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ARTIFACT_RETENTION,
  EXPERIMENT_MANIFEST_CONTRACT_VERSION,
  ExperimentManifestError,
  SEED_POLICIES,
  TOPOLOGIES,
  assertExperimentManifest,
  assertNotATaskStore,
  deriveSeed,
  experimentVariables,
  parseSoftwareRef,
  seedSequence,
  validateExperimentManifest,
} from '../manifest.mjs';

const CAPABILITIES = ['task.execute.safe', 'filesystem.temp', 'research.evidence.review'];

/** A minimal, entirely valid manifest. Every "invalid" case below is this with one deliberate change. */
const valid = (overrides = {}) => ({
  experimentId: 'mesh-convergence-01',
  question: 'Does a strict-targeted task converge on the named device when a second device is online?',
  hypothesis: 'The named device and only the named device completes the run.',
  topology: 'TWO_HOST_MESH',
  hosts: ['Alien-Win', 'Mech-Win'],
  workers: ['Alien-Win', 'Mech-Win'],
  controlSurfaces: ['Alien-Web'],
  variables: { independent: ['targetDeviceRef'], dependent: ['timeToComplete'], controls: ['taskType'] },
  repetitions: 5,
  seedPolicy: 'PER_REPETITION',
  baseSeed: 7,
  requiredCapabilities: ['task.execute.safe'],
  stopConditions: [{ kind: 'MAX_REPETITIONS', value: 5 }, { kind: 'MAX_WALL_CLOCK_MS', value: 600000 }],
  artifactPolicy: { retention: 'SUMMARY_ONLY' },
  acceptance: { primary: 'All five repetitions complete on the named device.', minimumSuccessfulRuns: 5 },
  softwareRefs: ['utopia@0e9bea3ce739b979e582a428af8fb233045a5e75'],
  scenarioRef: 'scenario:strict-target-away',
  faultProfileRef: null,
  ...overrides,
});

test('a well-formed manifest validates, and carries no invented defaults', () => {
  const verdict = validateExperimentManifest(valid(), { knownCapabilities: CAPABILITIES });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.issues));
  assert.deepEqual([...verdict.issues], []);
  const manifest = verdict.manifest;
  assert.equal(manifest.contractVersion, EXPERIMENT_MANIFEST_CONTRACT_VERSION);
  assert.equal(manifest.defaultsInvented, false, 'the manifest must state that nothing was defaulted');
  assert.equal(manifest.topologyDescription, TOPOLOGIES.TWO_HOST_MESH.description);
  assert.deepEqual([...manifest.requiredCapabilities], ['task.execute.safe']);
  assert.equal(manifest.references.referenceIsNotAuthorisation, true, 'a fault profile reference is not a grant');
  assert.equal(manifest.references.faultProfileRef, null);
  assert.deepEqual(manifest.softwareRefs.map(ref => ref.commitSha), ['0e9bea3ce739b979e582a428af8fb233045a5e75']);
});

test('a missing field is reported, never defaulted', () => {
  // Each removal must produce a MISSING_FIELD (or a shape error) naming that exact path. The point is not that
  // validation fails — it is that nothing silently substitutes a value.
  const cases = [
    ['experimentId', undefined, 'experimentId'],
    ['question', undefined, 'question'],
    ['topology', undefined, 'topology'],
    ['repetitions', undefined, 'repetitions'],
    ['seedPolicy', undefined, 'seedPolicy'],
    ['requiredCapabilities', undefined, 'requiredCapabilities'],
    ['stopConditions', undefined, 'stopConditions'],
    ['artifactPolicy', undefined, 'artifactPolicy.retention'],
    ['acceptance', undefined, 'acceptance.primary'],
    ['softwareRefs', undefined, 'softwareRefs'],
    ['variables', undefined, 'variables.independent'],
  ];
  for (const [field, _value, expectedPath] of cases) {
    const input = valid();
    delete input[field];
    const verdict = validateExperimentManifest(input, { knownCapabilities: CAPABILITIES });
    assert.equal(verdict.ok, false, `${field} must be required`);
    assert.ok(verdict.issues.some(entry => entry.path === expectedPath || entry.path.startsWith(expectedPath)),
      `removing ${field} must report ${expectedPath}; got ${JSON.stringify(verdict.issues.map(entry => entry.path))}`);
  }
  // Repetitions of 0 is not "one repetition with no repetition": it is refused.
  assert.equal(validateExperimentManifest(valid({ repetitions: 0 }), { knownCapabilities: CAPABILITIES }).ok, false);
  assert.equal(validateExperimentManifest(valid({ repetitions: 1.5 }), { knownCapabilities: CAPABILITIES }).ok, false);
  // An unknown contract version is refused before anything else is interpreted.
  const wrongVersion = validateExperimentManifest(valid({ contractVersion: 99 }), { knownCapabilities: CAPABILITIES });
  assert.equal(wrongVersion.issues[0].code, 'INCOMPATIBLE_CONTRACT');
});

test('an impossible topology is refused, in each of the ways it can be impossible', () => {
  const cases = [
    ['too few hosts', valid({ hosts: ['Alien-Win'], workers: ['Alien-Win'] }), 'hosts'],
    ['no real worker', valid({ workers: [] }), 'workers'],
    ['no control surface', valid({ controlSurfaces: [] }), 'controlSurfaces'],
    ['a worker that is not a declared host', valid({ workers: ['Alien-Win', 'Some-Other-PC'] }), 'workers'],
  ];
  for (const [label, input, path] of cases) {
    const verdict = validateExperimentManifest(input, { knownCapabilities: CAPABILITIES });
    assert.equal(verdict.ok, false, `${label} must be refused`);
    assert.ok(verdict.issues.some(entry => entry.code === 'TOPOLOGY_IMPOSSIBLE' && entry.path === path),
      `${label}: expected TOPOLOGY_IMPOSSIBLE at ${path}; got ${JSON.stringify(verdict.issues)}`);
  }
  // An unknown topology name is its own refusal, not an impossible shape.
  const unknown = validateExperimentManifest(valid({ topology: 'TEN_HOST_CLUSTER' }), { knownCapabilities: CAPABILITIES });
  assert.equal(unknown.ok, false);
  assert.ok(unknown.issues.some(entry => entry.code === 'UNKNOWN_TOPOLOGY'));
  // A topology that requires Android must actually name an Android control surface.
  const android = validateExperimentManifest(valid({ topology: 'ANDROID_CONTROL_SURFACE', hosts: ['Alien-Win'], workers: [], controlSurfaces: ['Alien-Web'] }), { knownCapabilities: CAPABILITIES });
  assert.ok(android.issues.some(entry => entry.code === 'TOPOLOGY_IMPOSSIBLE' && entry.path === 'controlSurfaces'));
  const androidOk = validateExperimentManifest(valid({ topology: 'ANDROID_CONTROL_SURFACE', hosts: ['Alien-Win'], workers: [], controlSurfaces: ['android-PERM00'] }), { knownCapabilities: CAPABILITIES });
  assert.equal(androidOk.ok, true, JSON.stringify(androidOk.issues));
});

test('an unknown capability is refused against the supplied vocabulary, and nothing is assumed', () => {
  const verdict = validateExperimentManifest(valid({ requiredCapabilities: ['task.execute.safe', 'gpu.render.frames'] }), { knownCapabilities: CAPABILITIES });
  assert.equal(verdict.ok, false);
  const capabilityIssue = verdict.issues.find(entry => entry.code === 'UNKNOWN_CAPABILITY');
  assert.ok(capabilityIssue);
  assert.match(capabilityIssue.message, /gpu\.render\.frames/);
  // An EMPTY vocabulary is not a licence to accept everything: with no known capabilities, every requirement is
  // unknown. This is the "do not fabricate" rule applied to the vocabulary itself.
  const noVocabulary = validateExperimentManifest(valid(), { knownCapabilities: [] });
  assert.equal(noVocabulary.ok, false);
  assert.ok(noVocabulary.issues.some(entry => entry.code === 'UNKNOWN_CAPABILITY'));
});

test('conflicting and duplicated variables are refused', () => {
  const both = validateExperimentManifest(valid({ variables: { independent: ['latency'], dependent: ['latency'] } }), { knownCapabilities: CAPABILITIES });
  assert.equal(both.ok, false);
  assert.ok(both.issues.some(entry => entry.code === 'CONFLICTING_VARIABLES'));
  const duplicated = validateExperimentManifest(valid({ variables: { independent: ['latency', 'latency'], dependent: ['time'] } }), { knownCapabilities: CAPABILITIES });
  assert.equal(duplicated.ok, false);
  assert.ok(duplicated.issues.some(entry => entry.code === 'DUPLICATE_VARIABLE'));
  // The pure helper reports the same thing without needing a whole manifest.
  const helper = experimentVariables({ independent: ['a'], dependent: ['a'] });
  assert.ok(helper.issues.some(entry => entry.code === 'CONFLICTING_VARIABLES'));
});

test('software identity must be exact: a short SHA or a branch name is refused by name', () => {
  assert.equal(parseSoftwareRef('utopia@0e9bea3ce739b979e582a428af8fb233045a5e75').exact, true);
  assert.equal(parseSoftwareRef('dsh@1.0.0-alien-rebuild').exact, false, 'a version label is allowed for components that have no commit');
  for (const bad of ['utopia@0e9bea3', 'utopia@abc1234', '0e9bea3ce739b979e582a428af8fb233045a5e75', 'utopia', 'utopia@']) {
    assert.throws(() => parseSoftwareRef(bad), error => error instanceof ExperimentManifestError && error.code === 'MALFORMED_SOFTWARE_REF', `${bad} must be refused`);
  }
  // A branch or tag name is a label, not an anchor: it is accepted only as the explicit-label form and is
  // marked `exact: false`, so a caller can refuse to treat it as an immutable baseline.
  assert.equal(parseSoftwareRef('utopia@main').exact, false);
  assert.equal(parseSoftwareRef('utopia@v1.2.3').exact, false);
  // The refusal message for a short SHA says why, because "looks like a SHA but is not one" is the whole hazard.
  try { parseSoftwareRef('utopia@0e9bea3'); } catch (error) { assert.match(error.detail, /short commit SHA/); }
  const verdict = validateExperimentManifest(valid({ softwareRefs: ['utopia@abc1234'] }), { knownCapabilities: CAPABILITIES });
  assert.equal(verdict.ok, false);
  assert.ok(verdict.issues.some(entry => entry.code === 'MALFORMED_SOFTWARE_REF'));
});

test('stop conditions and artifact policy are explicit, and an unknown kind is refused', () => {
  const noStops = validateExperimentManifest(valid({ stopConditions: [] }), { knownCapabilities: CAPABILITIES });
  assert.equal(noStops.ok, false);
  assert.ok(noStops.issues.some(entry => entry.code === 'MISSING_FIELD' && entry.path === 'stopConditions'));
  // A run must be bounded by its own repetition count, or the declared repetitions mean nothing.
  const unbounded = validateExperimentManifest(valid({ stopConditions: [{ kind: 'MANUAL' }] }), { knownCapabilities: CAPABILITIES });
  assert.equal(unbounded.ok, false);
  assert.ok(unbounded.issues.some(entry => entry.message.includes('MAX_REPETITIONS')));
  const unknownKind = validateExperimentManifest(valid({ stopConditions: [{ kind: 'WHEN_BORED', value: 1 }] }), { knownCapabilities: CAPABILITIES });
  assert.ok(unknownKind.issues.some(entry => entry.code === 'UNKNOWN_STOP_CONDITION'));
  const badRetention = validateExperimentManifest(valid({ artifactPolicy: { retention: 'EVERYTHING' } }), { knownCapabilities: CAPABILITIES });
  assert.ok(badRetention.issues.some(entry => entry.code === 'UNKNOWN_ARTIFACT_RETENTION'));
  // NONE is a decision, not an omission.
  assert.equal(validateExperimentManifest(valid({ artifactPolicy: { retention: 'NONE' } }), { knownCapabilities: CAPABILITIES }).ok, true);
  assert.deepEqual([...ARTIFACT_RETENTION], ['NONE', 'SUMMARY_ONLY', 'BOUNDED_TRACE', 'FULL']);
});

test('the seed sequence is deterministic, total and independent of the host', () => {
  const manifest = validateExperimentManifest(valid(), { knownCapabilities: CAPABILITIES }).manifest;
  const first = seedSequence(manifest);
  const second = seedSequence(manifest);
  assert.deepEqual(second, first);
  assert.equal(first.length, 5);
  assert.deepEqual(first.map(entry => entry.repetition), [0, 1, 2, 3, 4]);
  // PER_REPETITION must actually differ per repetition, otherwise "five repetitions" is one run recorded five
  // times — the exact failure a repetition engine exists to prevent.
  assert.equal(new Set(first.map(entry => entry.seed)).size, 5);
  // FIXED must be genuinely fixed across repetitions.
  const fixed = seedSequence(validateExperimentManifest(valid({ seedPolicy: 'FIXED' }), { knownCapabilities: CAPABILITIES }).manifest);
  assert.equal(new Set(fixed.map(entry => entry.seed)).size, 1);
  // PER_VARIANT is stable for a variant and varies across variants.
  const perVariant = seedSequence(validateExperimentManifest(valid({ seedPolicy: 'PER_VARIANT', variables: { independent: ['a', 'b'], dependent: ['m'] }, repetitions: 4 }), { knownCapabilities: CAPABILITIES }).manifest);
  assert.equal(perVariant[0].seed, perVariant[2].seed);
  assert.notEqual(perVariant[0].seed, perVariant[1].seed);
  // deriveSeed is pure and total, including its refusals.
  assert.equal(deriveSeed({ experimentId: 'x', seedPolicy: 'FIXED' }), deriveSeed({ experimentId: 'x', seedPolicy: 'FIXED' }));
  assert.throws(() => deriveSeed({ experimentId: 'x', seedPolicy: 'RANDOM' }), error => error.code === 'UNKNOWN_SEED_POLICY');
  assert.throws(() => deriveSeed({ experimentId: 'x', seedPolicy: 'FIXED', baseSeed: -1 }), error => error.code === 'INVALID_FIELD');
  assert.deepEqual([...SEED_POLICIES], ['FIXED', 'PER_REPETITION', 'PER_VARIANT']);
});

test('a manifest may not carry task-domain keys: this is not a second task database', () => {
  for (const key of ['tasks', 'assignments', 'leases', 'claims', 'assignedNodeId', 'taskId', 'results', 'executionState']) {
    const input = valid();
    input[key] = key === 'assignedNodeId' || key === 'taskId' ? 'task-1' : [];
    assert.throws(() => assertExperimentManifest(input, { knownCapabilities: CAPABILITIES }), error => error.code === 'NOT_A_MANIFEST_STORE', `${key} must be refused`);
  }
  // The guard is about the manifest's OWN keys: a nested object that happens to have a `tasks` key is data a
  // manifest is allowed to describe, and refusing it would be a false positive.
  assert.equal(assertNotATaskStore({ nested: { tasks: [] } }).nested.tasks.length, 0);
  // A clean manifest passes the guard.
  assert.equal(assertNotATaskStore({ experimentId: 'x', scenarioRef: 's' }).experimentId, 'x');
});
