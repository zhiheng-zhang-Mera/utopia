import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const record = path.join(repoRoot, 'scripts', 'record-mission-event.mjs');
const finalize = path.join(repoRoot, 'scripts', 'finalize-mission-episode.mjs');

function run(script, cwd, args) {
  return execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' }).trim();
}
function event(cwd, role, host, type, outcome, summary) {
  run(record, cwd, ['--mission','MB-001','--role',role,'--host',host,'--type',type,'--outcome',outcome,'--summary',summary,'--source-ref','donor@abc1234','--target-ref','mission/MB-001-core-os']);
}

test('records mission events and finalizes a verified episode', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'utopia-evolution-'));
  await mkdir(cwd, { recursive: true });
  event(cwd,'migration','Mech','ATTEMPT_STARTED','INFO','start');
  event(cwd,'migration','Mech','TEST_FAIL','FAIL','parity failed');
  event(cwd,'migration','Mech','REPAIR_APPLIED','REPAIRED','repair');
  event(cwd,'migration','Mech','MIGRATION_COMPLETE','PASS','migration done');
  event(cwd,'verification','Alien','VERIFIER_FINDING','INFO','independent review found no remaining blocker');
  event(cwd,'verification','Alien','CI_RESULT','PASS','required CI green');
  event(cwd,'verification','Alien','VERIFICATION_COMPLETE','PASS','verified');
  run(finalize,cwd,['--mission','MB-001','--migration-host','Mech','--verification-host','Alien','--branch-sha','abcdef1234567','--ci-run','run-1']);

  const episode = JSON.parse(await readFile(path.join(cwd,'data-records','evolution','episodes','mission-book','MB-001','episode.json'),'utf8'));
  assert.equal(episode.status,'VERIFIED');
  assert.equal(episode.participants.migrationHost,'Mech');
  assert.equal(episode.participants.verificationHost,'Alien');
  assert.equal(episode.learning.authority,'EXPERIENCE_ONLY');
  assert.equal(episode.metrics.testFailures,1);
  assert.equal(episode.metrics.repairs,1);
  await assert.rejects(readFile(path.join(cwd,'data-records','evolution','inbox','mission-book','MB-001','events.jsonl'),'utf8'));
});

test('refuses same host for migration and verification', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'utopia-evolution-same-host-'));
  event(cwd,'migration','Alien','MIGRATION_COMPLETE','PASS','migration done');
  event(cwd,'verification','Alien','VERIFIER_FINDING','INFO','reviewed');
  event(cwd,'verification','Alien','CI_RESULT','PASS','ci green');
  event(cwd,'verification','Alien','VERIFICATION_COMPLETE','PASS','verified');
  const result = spawnSync(process.execPath,[finalize,'--mission','MB-001','--migration-host','Alien','--verification-host','Alien','--branch-sha','abcdef1234567','--ci-run','run-2'],{cwd,encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/must differ/);
});
