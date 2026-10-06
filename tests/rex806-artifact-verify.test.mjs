// REX-806 verifier probes: the independent recomputation must fail on a tampered artifact, or it is decoration.
//
// Each probe takes a good package, breaks exactly one thing, and asserts that the verifier notices. stdio is ignored and
// only the exit status is read, so nothing here depends on capturing another process's output.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, mkdir, cp, readFile, writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

const VERIFIER = resolve('scripts/verify-research-artifact.mjs');
const GOOD = resolve('D:/utopia-chat/dc/mission-book/reports/REX-806/artifact');
const run = dir => spawnSync(process.execPath, [VERIFIER, dir], {stdio: 'ignore'}).status;

const fixture = async fn => {
  const dir = await mkdtemp(join(tmpdir(), 'rex806-verify-'));
  try {
    if (!existsSync(GOOD)) { assert.ok(false, `the published artifact is not present at ${GOOD}`); }
    await cp(GOOD, dir, {recursive: true});
    return await fn(dir);
  } finally {
    await rm(dir, {recursive: true, force: true});
  }
};

test('REX806 V1: the verifier passes the published artifact', async () => {
  await fixture(async dir => {
    assert.equal(run(dir), 0, 'the published package must verify');
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
