// REX-801 repair guard: an experiment store the City cannot create or list is DEGRADED AND REPORTED, never fatal.
//
// Measured against the merged main on 2026-10-06: `mkdirSync(root, {recursive: true})` in createExperimentRegistry was
// unguarded, so a single file where `<runtime>/research` or `<runtime>/research/experiments` belongs made
// createGateway throw (ENOTDIR / EEXIST) and the City never started. This is the same failure shape the REX-804 review
// blocked on (B1) and that MON-903 (M-1) and REX-803 (R-1) found in their own stores; this file pins the repair.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createGateway} from '../services/dev-gateway/server.mjs';

const headers = {Authorization: 'Bearer owner', 'Content-Type': 'application/json', 'X-City-Api-Version': '0', 'X-City-Schema-Version': '0'};
const manifest = {
  experimentId: 'store-guard-fixture', question: 'Does an unusable experiment store still let the City serve?',
  topology: 'SINGLE_CITY', hosts: ['node-a'], workers: [], controlSurfaces: ['web-fixture'],
  variables: {independent: ['scenario'], dependent: ['completion'], controls: ['taskType']},
  repetitions: 1, seedPolicy: 'PER_REPETITION', baseSeed: 1, requiredCapabilities: ['research.evidence.review'],
  stopConditions: [{kind: 'MAX_REPETITIONS', value: 1}], artifactPolicy: {retention: 'NONE'},
  acceptance: {primary: 'the City keeps serving'}, softwareRefs: ['utopia@' + 'b'.repeat(40)],
};

for (const [label, trap] of [['research (the registry parent)', dir => join(dir, 'research')], ['research/experiments (the registry itself)', dir => join(dir, 'research', 'experiments')]]) {
  test(`REX801 store guard: a file where ${label} belongs cannot stop the City`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rex801-store-guard-'));
    let app = null;
    try {
      await mkdir(join(dir, 'research', 'experiments'), {recursive: true});
      await rm(trap === undefined ? dir : (label.startsWith('research/experiments') ? join(dir, 'research', 'experiments') : join(dir, 'research')), {recursive: true, force: true});
      await writeFile(label.startsWith('research/experiments') ? join(dir, 'research', 'experiments') : join(dir, 'research'), 'a file where a directory belongs');
      app = await createGateway({dir, port: 0, token: 'owner', nodeToken: 'node', roomsDisabled: true});
      const health = await fetch(app.url + '/api/v0/health', {headers});
      assert.equal(health.status, 200, 'the City starts with an unusable experiment store');
      const listed = await (await fetch(app.url + '/api/v0/research/experiments', {headers})).json();
      assert.equal(listed.storeState, 'UNAVAILABLE', 'the surface states the degraded store');
      assert.ok(listed.storeReason);
      assert.ok(listed.broken.some(row => String(row.reason).startsWith('UNLISTABLE')), 'the unusable store is reported in `broken`');
      assert.deepEqual(listed.experiments, []);
      // A registration against an unusable store is answered as "validated but not filed", NOT as a 500.
      const registered = await fetch(app.url + '/api/v0/research/experiments', {method: 'POST', headers, body: JSON.stringify({manifest})});
      assert.equal(registered.status, 200, 'a valid manifest is still validated when it cannot be filed');
      const body = await registered.json();
      assert.equal(body.registered, true);
      assert.equal(body.persisted, false, 'not filed is stated, not implied');
      assert.ok(body.persistFailure);
      assert.equal((await fetch(app.url + '/api/v0/health', {headers})).status, 200, 'the City keeps serving');
    } finally {
      await app?.close();
      await rm(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 50}).catch(() => {});
    }
  });
}
