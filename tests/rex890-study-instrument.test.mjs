// THE STUDY INSTRUMENT MUST TRAVEL WITH THE STUDY.
//
// The study produced the artifact package that the opposite host reproduces, so "reproducible" has to include the
// instrument: it must live in the tree, start from a bare checkout, and not look for the credential in a path only the
// development host has. Measured before this was fixed: the script existed ONLY outside the repository and read the
// City token from one machine's absolute path, so nobody who fetched the branch could re-run the study that produced
// the package. That is the same declared-versus-available gap as the trace pointers, one level up.
//
// Two smaller properties are pinned here as well, because both were measured defects: a deliberate skip must be
// reported as NOT_RUN rather than as a failure (this programme's own rule), and the source run to replay must be chosen
// so the ablation can demonstrate its mechanism rather than by coin flip.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync, mkdtempSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

const script = resolve(import.meta.dirname, '..', 'scripts', 'rex890-dev-study.mjs');
const source = readFileSync(script, 'utf8');

test('STUDY-INSTRUMENT 1: the study script lives in the tree and runs from a bare checkout',()=>{
  const specifiers=[...source.matchAll(/^\s*import\s+[^'"]*['"]([^'"]+)['"]/gm)].map(m=>m[1]);
  assert.ok(specifiers.length>0,'the study must import something, or this check is vacuous');
  assert.deepEqual(specifiers.filter(s=>!s.startsWith('node:')),[],'the study must not depend on a package');
  assert.match(source,/globalThis\.WebSocket/,'the control surface must use the built-in WebSocket');
  assert.match(source,/import\.meta\.dirname/,'the checkout must default to this repository, not to a caller-supplied path');
});

test('STUDY-INSTRUMENT 2: nothing about one deployment is baked into the study',()=>{
  // A study that only runs on the machine it was written on is not reproducible, however good its results are.
  for(const pattern of [/ProgramData/,/172\.31\.\d+\.\d+/,/D:\/utopia/i,/\bdev-[0-9a-f]{8,}/]){
    assert.ok(!pattern.test(source),`the study script bakes in a deployment detail: ${pattern}`);
  }
  // The credential comes from a file or the environment, and a missing one is refused by name before anything runs.
  assert.match(source,/--config <json with token>/,'the documented credential input is a file');
  assert.match(source,/a City token is required/,'a missing credential must be refused by name');
  assert.match(source,/missing \$\{missing\.join/,'missing --city/--out must be refused by name');
});

test('STUDY-INSTRUMENT 3: a deliberate skip is NOT_RUN, and never counted as a failure',()=>{
  // Measured: with a handoff job waiting in the City, the fault-targeting probe is skipped on purpose (probing would
  // steal that work) and the study reported 20/21 - a failure that was not one. The rule this programme applies
  // everywhere else is that NOT_RUN is not FAIL, and the instrument now applies it to itself.
  assert.match(source,/ok === null \? 'NOT_RUN'/,'the recorder must be able to say NOT_RUN');
  assert.match(source,/record\('the fault targeting check is NOT_RUN to avoid stealing queued work', null,/,'the deliberate skip must record NOT_RUN, not false');
  assert.match(source,/const failed = results\.filter\(r => r\.status === 'FAIL'\)/,'the tally must count failures by status');
  assert.match(source,/not run \(deliberately, and named rather than counted as failures\)/,'and must report them separately');
});

test('STUDY-INSTRUMENT 4: the replay source is chosen so the ablation can demonstrate its mechanism',()=>{
  // The ablation fixes placement to the campaign's first worker, so a source run that was placed there cannot show a
  // change. Choosing "the first measured run" made that element a coin flip on the seed; on 2026-10-08 it came up wrong
  // and the study scored 18/20 with nothing wrong with the City.
  assert.match(source,/r\.result\.assignedNodeId !== fixedWorker/,'the source run must be one the mechanism can move');
  assert.match(source,/the replay source run is chosen so the ablation can demonstrate its mechanism/,'and the choice must be recorded');
});

test('STUDY-INSTRUMENT 5: the manifest declares the software identity the study OBSERVED, never a remembered one',()=>{
  // The manifest used to carry the literal 'utopia@185d043e...', a commit remembered from an earlier round while the
  // tree moved on. A remembered identity is false the moment anything changes - the same defect the reproduction
  // harness was repaired for (a22f9f5). The study must ask the checkout it is running from.
  assert.match(source,/execFileSync\('git', \['-C', CHECKOUT, 'rev-parse', 'HEAD'\]/,'the identity must be observed from the checkout');
  assert.match(source,/softwareRefs: \[software\.ref\]/,'the manifest must declare what was observed');
  assert.match(source,/SOFTWARE_IDENTITY_UNOBSERVABLE/,'and an unobservable identity must refuse rather than invent one');
  // No 40-character utopia ref may be written into the source at all: whatever is there would be a guess.
  assert.ok(!/utopia@[0-9a-f]{40}/.test(source),'the study must not carry a hardcoded software ref');
});

test('STUDY-INSTRUMENT 6: a checkout nobody can attribute is refused before the City is touched',()=>{
  // The refusal has to be real, not just present in the source: run the study with its checkout pointed at a directory
  // that is not a git checkout, and require exit 2, the named reason, and NO side effects - no experiment registered,
  // no control surface opened, not even its output directory created. No City is needed, which is the point: a study
  // that cannot say what software it is must stop before it perturbs anything.
  const dir = mkdtempSync(join(tmpdir(), 'rex890-not-a-checkout-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({token: 'fixture-only'}));
  const run = spawnSync(process.execPath, [script, '--city', 'http://127.0.0.1:1', '--out', join(dir, 'out'),
    '--config', join(dir, 'config.json'), '--checkout', dir], {encoding: 'utf8', timeout: 60000});
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stderr, /SOFTWARE_IDENTITY_UNOBSERVABLE/);
  assert.equal(existsSync(join(dir, 'out')), false, 'the study must refuse before creating anything');
  assert.ok(!/phase\('0/.test(run.stdout), 'and before it contacts the City');
});
