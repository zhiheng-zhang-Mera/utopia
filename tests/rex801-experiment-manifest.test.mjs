// REX-801 — the experiment registry and the Research control contract, on a real gateway.
//
// This file answers the workbook's user-facing question — "can an experiment be described, validated and
// inspected through the product rather than through a document?" — and it attacks the same manifest hazards the
// contract test does, but through the actual HTTP surface, because a refusal that only exists in a unit test is
// not a control a user has.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createGateway } from '../services/dev-gateway/server.mjs';
import { createExperimentRegistry } from '../services/dev-gateway/research/registry.mjs';

const manifest = (overrides = {}) => ({
  experimentId: 'strict-target-convergence',
  question: 'Does a strictly targeted task converge on the named device?',
  topology: 'TWO_HOST_MESH',
  hosts: ['Alien-Win', 'Mech-Win'],
  workers: ['Alien-Win', 'Mech-Win'],
  controlSurfaces: ['Alien-Web'],
  variables: { independent: ['targetDeviceRef'], dependent: ['timeToComplete'], controls: ['taskType'] },
  repetitions: 3,
  seedPolicy: 'PER_REPETITION',
  requiredCapabilities: ['research.evidence.review'],
  stopConditions: [{ kind: 'MAX_REPETITIONS', value: 3 }],
  artifactPolicy: { retention: 'SUMMARY_ONLY' },
  acceptance: { primary: 'All three repetitions complete on the named device.' },
  softwareRefs: ['utopia@0e9bea3ce739b979e582a428af8fb233045a5e75'],
  ...overrides,
});

function probe(app) {
  const request = (path, body, token = 'ctl', method = null) => fetch(`${app.url}/api/v0/${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { request, node: (path, data) => request(`node/${path}`, data, 'node-token') };
}

test('an experiment can be listed, validated, registered, inspected, seeded — without ever being run', async () => {
  const dir = await mkdtemp(resolve('.scratch-rex801-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    const { request } = probe(app);

    // Nothing is registered to begin with, and the response states what this contract does NOT do.
    const empty = await (await request('research/experiments')).json();
    assert.deepEqual(empty.experiments, []);
    assert.deepEqual(empty.broken, []);
    assert.equal(empty.research.ownsTaskState, false);
    assert.equal(empty.research.grantsFaultAuthority, false);
    assert.equal(empty.research.executesExperiments, false);
    // The contract publishes its own vocabulary, so a caller can build a valid manifest from the response.
    assert.ok(empty.research.topologies.includes('TWO_HOST_MESH'));
    assert.ok(empty.research.seedPolicies.includes('PER_REPETITION'));
    assert.ok(empty.research.stopConditionKinds.includes('MAX_WALL_CLOCK_MS'));
    assert.ok(empty.research.artifactRetention.includes('NONE'));
    // The capability vocabulary is the LIVE bridge list, not a constant repeated here: the id below is one this
    // City really provides, which is why the manifests in this file can pass the unknown-capability gate.
    assert.ok(empty.research.capabilityVocabulary.includes('research.evidence.review'));
    assert.equal(empty.research.capabilityVocabulary.includes('task.execute.safe'), false, 'task capabilities are not City capability ids and must not be accepted as such');

    // Validate-before-run does not register.
    const validation = await (await request('research/experiments/validate', { manifest: manifest() })).json();
    assert.equal(validation.validation.ok, true);
    assert.equal(validation.validation.registeredNothing, true);
    assert.equal(validation.validation.executesNothing, true);
    assert.deepEqual((await (await request('research/experiments')).json()).experiments, [], 'validation must not register');

    // Register, then inspect.
    const created = await (await request('research/experiments', { manifest: manifest() })).json();
    assert.equal(created.registered, true);
    assert.equal(created.status, 'VALIDATED');
    assert.equal(created.replayed, false);
    const listed = await (await request('research/experiments')).json();
    assert.equal(listed.experiments.length, 1);
    assert.equal(listed.experiments[0].experimentId, 'strict-target-convergence');
    assert.equal(listed.experiments[0].topology, 'TWO_HOST_MESH');
    assert.equal(listed.experiments[0].repetitions, 3);
    const inspected = await (await request('research/experiments/strict-target-convergence')).json();
    assert.equal(inspected.experiment.manifest.question, manifest().question);
    assert.equal(inspected.experiment.manifest.defaultsInvented, false);

    // Re-registering identical content is idempotent; different content under the same id is refused.
    const replay = await (await request('research/experiments', { manifest: manifest() })).json();
    assert.equal(replay.replayed, true);
    const changed = await request('research/experiments', { manifest: manifest({ question: 'A different question.' }) });
    assert.equal(changed.status, 409);
    assert.equal((await changed.json()).errorCode, 'IMMUTABLE_MANIFEST');

    // The seed sequence is available and deterministic across calls.
    const seedsA = await (await request('research/experiments/strict-target-convergence/seeds')).json();
    const seedsB = await (await request('research/experiments/strict-target-convergence/seeds')).json();
    assert.deepEqual(seedsA.seeds, seedsB.seeds);
    assert.equal(seedsA.seeds.sequence.length, 3);
    assert.equal(new Set(seedsA.seeds.sequence.map(entry => entry.seed)).size, 3);

    // There is no run endpoint, and asking for one is an explicit 404 rather than a surprise.
    assert.equal((await request('research/experiments/strict-target-convergence/run', {})).status, 404);
    // Import-by-URL is refused with a reason, not silently unsupported.
    const importById = await request('research/experiments/remote-thing/register', {});
    assert.equal(importById.status, 400);
    assert.equal((await importById.json()).errorCode, 'IMPORT_REQUIRES_INLINE_MANIFEST');

    // An unknown experiment is a typed 404.
    assert.equal((await request('research/experiments/never-registered')).status, 404);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the research routes require the control credential: a worker cannot certify the experiment it runs', async () => {
  const dir = await mkdtemp(resolve('.scratch-rex801-auth-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    const { request } = probe(app);
    // A node credential is a correct credential for node routes and a wrong one here.
    assert.equal((await request('research/experiments', null, 'node-token')).status, 401);
    assert.equal((await request('research/experiments', { manifest: manifest() }, 'node-token')).status, 401);
    assert.equal((await request('research/experiments', null, 'wrong')).status, 401);
    // And the control credential works.
    assert.equal((await request('research/experiments', null, 'ctl')).status, 200);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('an invalid manifest is refused with every issue at once, and the rejection is stored as evidence', async () => {
  const dir = await mkdtemp(resolve('.scratch-rex801-reject-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    const { request } = probe(app);

    // Four independent faults in one manifest: unknown capability, impossible topology, conflicting variable,
    // and a short SHA. A caller must be able to see all four in one response.
    const bad = manifest({
      requiredCapabilities: ['research.evidence.review', 'gpu.render.frames'],
      controlSurfaces: [],
      variables: { independent: ['latency'], dependent: ['latency'] },
      softwareRefs: ['utopia@0e9bea3'],
    });
    const refused = await request('research/experiments', { manifest: bad });
    assert.equal(refused.status, 422);
    const body = await refused.json();
    assert.equal(body.errorCode, 'REJECTED');
    const codes = body.issues.map(entry => entry.code);
    for (const expected of ['UNKNOWN_CAPABILITY', 'TOPOLOGY_IMPOSSIBLE', 'CONFLICTING_VARIABLES', 'MALFORMED_SOFTWARE_REF']) {
      assert.ok(codes.includes(expected), `expected ${expected} in ${JSON.stringify(codes)}`);
    }
    // The rejection is persisted, so the evidence survives this request.
    assert.equal(existsSync(resolve(dir, 'research', 'experiments', 'strict-target-convergence.json')), true);
    const listed = await (await request('research/experiments')).json();
    assert.equal(listed.experiments.length, 1);
    assert.equal(listed.experiments[0].status, 'REJECTED');
    assert.ok(listed.experiments[0].issueCount >= 4);
    // A rejected experiment has no seed sequence: there is nothing to run.
    assert.equal((await request('research/experiments/strict-target-convergence/seeds')).status, 404);
    // And a valid manifest may not overwrite the rejection with a different id? No: the same id may be fixed and
    // re-registered, because a rejection is not a published description. That is the one permitted transition.
    const fixed = await (await request('research/experiments', { manifest: manifest() })).json();
    assert.equal(fixed.registered, true);
    assert.equal(fixed.status, 'VALIDATED');
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('manifests survive a gateway restart, and a broken file is reported instead of silently dropped', async () => {
  const dir = await mkdtemp(resolve('.scratch-rex801-restart-'));
  let app;
  try {
    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    assert.equal((await (await probe(app).request('research/experiments', { manifest: manifest() })).json()).registered, true);
    const before = await (await probe(app).request('research/experiments/strict-target-convergence/seeds')).json();
    await app.close();

    app = await createGateway({ host: '127.0.0.1', port: 0, dir, token: 'ctl', nodeToken: 'node-token' });
    const { request } = probe(app);
    const after = await (await request('research/experiments/strict-target-convergence/seeds')).json();
    assert.deepEqual(after.seeds, before.seeds, 'the seed sequence must survive a restart unchanged');
    assert.equal((await (await request('research/experiments')).json()).experiments.length, 1);

    // A file whose name is not an experiment id, or whose contents are unreadable, must be REPORTED: silently
    // ignoring it would make a damaged register look like a register that never had that experiment. The stored
    // experiment is still readable through the API even while a damaged sibling file sits beside it.
    await writeFile(resolve(dir, 'research', 'experiments', 'NOT-AN-ID.json'), '{}', 'utf8');
    await writeFile(resolve(dir, 'research', 'experiments', 'broken-one.json'), '{ not json', 'utf8');
    const listed = await (await request('research/experiments')).json();
    assert.equal(listed.experiments.length, 1, 'the valid experiment is still the only experiment');
    assert.equal(listed.broken.length, 2);
    assert.ok(listed.broken.some(entry => entry.reason === 'FILE_NAME_IS_NOT_AN_EXPERIMENT_ID'));
    assert.ok(listed.broken.some(entry => entry.reason?.startsWith('UNREADABLE')));
    // And a damaged sibling does not stop the healthy experiment from being inspected or seeded.
    assert.equal((await (await request('research/experiments/strict-target-convergence')).json()).experiment.status, 'VALIDATED');
    assert.equal((await (await request('research/experiments/strict-target-convergence/seeds')).json()).seeds.sequence.length, 3);
  } finally { if (app) await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('the registry itself refuses task-domain keys and never offers an update', async () => {
  const dir = await mkdtemp(resolve('.scratch-rex801-registry-'));
  try {
    const registry = createExperimentRegistry({ dir, knownCapabilities: ['research.evidence.review'] });
    assert.equal(registry.ownsTaskState, false);
    assert.equal(registry.grantsFaultAuthority, false);
    assert.equal(registry.editableAfterRegistration, false);
    assert.equal(typeof registry.update, 'undefined', 'a describe-before-run registry must not be editable');
    assert.throws(() => registry.register(manifest({ tasks: [] })), error => error.code === 'NOT_A_MANIFEST_STORE');
    const result = registry.register(manifest());
    assert.equal(result.record.status, 'VALIDATED');
    // The stored document carries the manifest and the verdict, and no task or execution field.
    const stored = JSON.parse(await readFile(resolve(dir, 'strict-target-convergence.json'), 'utf8'));
    for (const key of ['tasks', 'assignedNodeId', 'executionState', 'results']) assert.equal(Object.hasOwn(stored, key), false, `${key} must not be stored`);
    assert.equal(stored.manifest.defaultsInvented, false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
