// THE LIVE PROBES ARE EVIDENCE INSTRUMENTS, AND AN INSTRUMENT THAT ONLY RUNS WHERE IT WAS WRITTEN IS NOT EVIDENCE.
//
// These three probes are cited by the capability records as the live measurements behind "the owner can make a machine
// run an allowlisted program" and "a job record is not a secret store". Two things therefore have to stay true, and
// neither is self-enforcing:
//
//   1. THEY CARRY NO DEPLOYMENT IDENTITY. This capability is a SYSTEM-LEVEL one - eligibility is decided by the
//      capability a node advertises and the node id the owner names - so a probe with a City URL, a host path or a
//      device id baked into it would quietly contradict the property the record claims. Measured while writing this
//      guard: the remote-operation probe DID hardcode the checkout path as the workspace, so it could only ever have
//      been run on this machine. Fixed there, and pinned here.
//   2. THEY REFUSE BEFORE THEY TOUCH ANYTHING. A missing City or credential must be a named exit 2, not a stack trace or
//      a half-run that leaves a task behind - the same rule the study instrument follows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const probes = [
  ['remote-operation live probe', 'evidence/raw/capability-city-remote-operation/live-probe.mjs'],
  ['agent-job credential probe', 'evidence/raw/capability-city-agent-job/credential-probe.mjs'],
  ['agent-job consumption probe', 'evidence/raw/capability-city-agent-job/consumption-probe.mjs']
].map(([name, path]) => ({name, path, file: resolve(root, path), source: readFileSync(resolve(root, path), 'utf8')}));

test('PROBES 1: every probe carries no deployment identity and takes its inputs as parameters', () => {
  for (const probe of probes) {
    // A City URL or an address baked in would make the probe a fixed-device instrument.
    assert.ok(!/172\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(probe.source), `${probe.name} bakes in a host address`);
    assert.ok(!/ProgramData/.test(probe.source), `${probe.name} bakes in a host state path`);
    assert.ok(!/\bdev-[0-9a-f]{8,}/.test(probe.source), `${probe.name} bakes in a device id`);
    // A quoted drive-letter path is a path to somebody's checkout; the probes may build paths from a flag instead.
    assert.ok(!/['"][A-Za-z]:\//.test(probe.source), `${probe.name} bakes in an absolute path`);
    // The inputs are parameters or environment, and a missing one is refused by name.
    for (const parameter of ['--city', '--config']) assert.match(probe.source, new RegExp(parameter.replace('-', '\\-')), `${probe.name} must take ${parameter}`);
    assert.match(probe.source, /process\.exit\(2\)/, `${probe.name} must refuse with exit 2`);
    // Node builtins and the repository's own modules only: an evidence instrument that needs an install is not runnable
    // from a bare checkout.
    const specifiers = [...probe.source.matchAll(/^\s*import\s+[^'"]*['"]([^'"]+)['"]/gm)].map(m => m[1]);
    assert.ok(specifiers.length > 0, `${probe.name} imports something`);
    assert.deepEqual(specifiers.filter(s => !s.startsWith('node:') && !s.startsWith('.')), [],
      `${probe.name} must import only Node builtins or repository files`);
  }
  // The remote-operation probe needs a workspace to run programs in, and it comes from the caller rather than the file.
  const remoteOperation = probes[0];
  assert.match(remoteOperation.source, /value\('cwd'/, 'the workspace must be a parameter');
  assert.match(remoteOperation.source, /cwd: CWD/, 'and every dispatch must use it');
});

test('PROBES 2: a credential-shaped literal is allowed only as an obvious fake', () => {
  // The agent-job probes MUST use a credential-shaped string to prove the refusal, and a real token must never be used
  // to demonstrate it. So credential shapes are permitted exactly when the token body is one repeated character.
  const fakes = [];
  for (const probe of probes) {
    for (const match of probe.source.matchAll(/\bgh[pousr]_([A-Za-z0-9]{8,})|\bsk-([A-Za-z0-9_-]{12,})/g)) {
      const body = match[1] ?? match[2];
      fakes.push({probe: probe.name, literal: match[0].slice(0, 12) + '...'});
      assert.equal(new Set(body).size, 1, `${probe.name} carries a credential-shaped literal that is not an obvious fake`);
    }
  }
  assert.ok(fakes.length > 0, 'at least one probe uses a fake credential shape, or this check is vacuous');
});

test('PROBES 3: a probe invoked with no inputs refuses by name and does nothing else', () => {
  for (const probe of probes) {
    const run = spawnSync(process.execPath, [probe.file], {encoding: 'utf8', timeout: 30000});
    assert.equal(run.status, 2, `${probe.name} without inputs must exit 2, got ${run.status}\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /--city/, `${probe.name} must name what is missing`);
    assert.equal(run.stdout.trim(), '', `${probe.name} must not print a result when it refused`);
  }
});
