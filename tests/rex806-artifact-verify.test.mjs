// REX-806 verifier probes: the independent recomputation must fail on a tampered artifact, or it is decoration.
//
// The first version of this file read the published artifact from an absolute path on the machine that wrote it, so all
// six probes failed on any other host - CI found that, the author's local run could not. The fixture is therefore built
// HERE from the module, into a temp directory, and the verifier is run against that: a probe that only passes on one
// machine is not a probe.
//
// stdio is ignored and only the exit status is read, so nothing depends on capturing another process's output.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {buildArtifact, artifactFiles, checksumsFor} from '../services/dev-gateway/research/artifact.mjs';

const VERIFIER = resolve('scripts/verify-research-artifact.mjs');
const run = dir => spawnSync(process.execPath, [VERIFIER, dir], {stdio: 'ignore'}).status;

const receipt = () => ({
  campaignId: 'campaign-verify-0000-4000-8000-000000000001', scenarioId: 'WAIT', state: 'COMPLETED', reason: 'REPETITIONS_FINISHED',
  seedPolicy: 'derived:seed(campaign,index)', campaignSeed: 'verify', repetitions: 1, warmup: 0, timeout: 30000, limits: {},
  totalRuns: 1, startedAt: 1000, finishedAt: 8000,
  runs: [{index: 0, state: 'MEASURED', reason: null, seed: 3, warmup: false, measured: true, durationMs: 7000, result: {taskRef: 'Q-verify', state: 'COMPLETED', assignedNodeId: 'w-b', result: {waitedMs: 6000}}}],
  context: {experimentId: 'verify-exp', manifestIdentity: 'id', manifest: {topology: 'TWO_HOST_MESH', hosts: ['w-a', 'w-b'], workers: ['w-a', 'w-b'], controlSurfaces: ['surface'], repetitions: 1, seedPolicy: 'PER_REPETITION', baseSeed: 3, stopConditions: [], acceptance: {}, softwareRefs: []}, targetDeviceRef: null},
  summary: {planned: 1, accounted: 1, warmup: 0, measured: 1, timedOut: 0, failed: 0, excluded: 0, cancelled: 0, skipped: 0, interrupted: 0, terminalAccountingComplete: true},
});
const task = () => ({id: 'Q-verify', type: 'WAIT', state: 'COMPLETED', createdAt: '2026-10-06T10:00:00.000Z', updatedAt: '2026-10-06T10:00:07.000Z', assignedNodeId: 'w-b', researchRunRef: 'campaign-verify-0000-4000-8000-000000000001:0', result: {waitedMs: 6000}});

const fixture = async fn => {
  const dir = await mkdtemp(join(tmpdir(), 'rex806-verify-'));
  try {
    const artifact = buildArtifact({cityId: 'city-verify', generatedAt: '2026-10-06T10:00:10.000Z', receipts: [receipt()], tasks: [task()]});
    const files = artifactFiles(artifact);
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    await writeFile(join(dir, 'checksums.json'), JSON.stringify(checksumsFor(files), null, 2) + '\n');
    return await fn(dir);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
};

test('REX806 V1: the verifier passes an untampered artifact', async () => {
  await fixture(async dir => {
    assert.equal(run(dir), 0, 'a package that agrees with itself must verify');
  });
});

test('REX806 V2: a tampered metric value is caught', async () => {
  await fixture(async dir => {
    const path = join(dir, 'metrics.csv');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace(/(completion_time_ms,G1,)(\d+)/, (_all, prefix) => `${prefix}1`));
    assert.equal(run(dir), 1, 'a changed completion time must not verify');
  });
});

test('REX806 V3: an emptied NOT_MEASURED reason is caught', async () => {
  await fixture(async dir => {
    const path = join(dir, 'metrics.csv');
    const text = await readFile(path, 'utf8');
    // Blank the reason of the first unavailable metric while leaving the row in place: the shape still looks complete.
    await writeFile(path, text.replace(/^([a-z_]+,[A-Z0-9]+,NOT_MEASURED,)[^,]*/m, '$1'));
    assert.equal(run(dir), 1, 'a row that stopped explaining itself must not verify');
  });
});

test('REX806 V4: a missing section is caught', async () => {
  await fixture(async dir => {
    await rm(join(dir, 'tables.json'));
    assert.equal(run(dir), 1, 'a package missing a named section must not verify');
  });
});

test('REX806 V5: a changed dataset timestamp is caught', async () => {
  await fixture(async dir => {
    const path = join(dir, 'normalized-dataset.json');
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    const row = parsed.rows.find(entry => entry.measured === true && entry.taskUpdatedAt);
    row.taskUpdatedAt = new Date(Date.parse(row.taskUpdatedAt) + 60000).toISOString();
    await writeFile(path, JSON.stringify(parsed, null, 2) + '\n');
    assert.equal(run(dir), 1, 'a dataset whose timestamps no longer support the reported median must not verify');
  });
});

test('REX806 V6: a fabricated intervention count is caught', async () => {
  await fixture(async dir => {
    const path = join(dir, 'metrics.csv');
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace(/^intervention_count,.*$/m, 'intervention_count,G3,0,,,fabricated'));
    assert.equal(run(dir), 1, 'an intervention count of zero with no observed window must not verify');
  });
});
