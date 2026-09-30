/**
 * UTOPIA · Research Institute — structured research command suite.
 *
 * The command-spec gate and the executable allow-list, restated from the Codex-Boss
 * donor `src/shared/research-command.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * The module describes a command; it never spawns one. Both refusals asserted here are
 * refusals of the donor's own gate — `executableAllowed` is deliberately NOT part of
 * it, so an unlisted-but-bare executable is still a valid spec.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED_EXECUTABLES, executableAllowed, validateCommandSpec } from '../index.mjs';

const spec = () => ({ executable: 'python', args: ['-m', 'pytest', 'tests'], cwd: '/work', purpose: 'TEST', timeoutMs: 60000 });

/** Run a refusal and return its message, so the donor's exact text is asserted. */
function refusal(run) {
  try {
    run();
  } catch (error) {
    return error.message;
  }
  return null;
}

test('the allow-list names the donor executable families and strips path and Windows suffixes', () => {
  assert.deepEqual(ALLOWED_EXECUTABLES, ['python', 'python3', 'py', 'node', 'npm', 'pnpm', 'git', 'pytest', 'tsx', 'npx', 'electron']);
  for (const executable of ALLOWED_EXECUTABLES) {
    assert.equal(executableAllowed(executable), true, executable);
  }
  assert.equal(executableAllowed('python'), true);
  assert.equal(executableAllowed('/usr/bin/python3'), true);
  assert.equal(executableAllowed('C:\\Python311\\python.exe'), true);
  assert.equal(executableAllowed('node.exe'), true);
  assert.equal(executableAllowed('npm.cmd'), true);
  assert.equal(executableAllowed('pytest.bat'), true);
  assert.equal(executableAllowed('PYTHON'), true, 'the comparison is case-insensitive');
  assert.equal(executableAllowed('Node.EXE'), true);
  assert.equal(executableAllowed('ruby'), false);
  assert.equal(executableAllowed(''), false);
  assert.equal(executableAllowed('python3.11'), false, 'only the declared suffixes are stripped');
  assert.equal(executableAllowed('/usr/bin/'), false);
});

test('the command gate accepts a complete spec', () => {
  const complete = { ...spec(), expectedOutputs: ['report.json'], environment: { LC_ALL: 'C' } };
  assert.equal(refusal(() => validateCommandSpec(complete)), null);
  assert.equal(refusal(() => validateCommandSpec(spec())), null);
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), expectedOutputs: [] })), null, 'an empty expectedOutputs array is valid');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), environment: {} })), null);
  for (const purpose of ['EXPERIMENT', 'ANALYSIS', 'TEST', 'BUILD', 'DATA_PROCESSING']) {
    assert.equal(refusal(() => validateCommandSpec({ ...spec(), purpose })), null, purpose);
  }
});

test('the command gate refuses with the donor messages, in the donor order', () => {
  assert.equal(refusal(() => validateCommandSpec(null)), 'Research command requires an executable');
  assert.equal(refusal(() => validateCommandSpec(undefined)), 'Research command requires an executable');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), executable: '' })), 'Research command requires an executable');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), executable: '   ' })), 'Research command requires an executable');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), executable: 'python -c "print(1)"' })), 'Research executable must be a bare path/name (no shell metacharacters)');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), executable: 'python\nrm -rf /' })), 'Research executable must be a bare path/name (no shell metacharacters)');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), executable: 'python\r' })), 'Research executable must be a bare path/name (no shell metacharacters)');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), args: undefined })), 'Invalid research args');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), args: ['a'.repeat(4001)] })), 'Invalid research args');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), args: Array.from({ length: 101 }, () => 'a') })), 'Invalid research args');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), args: [1, 'b'] })), 'Invalid research args');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), cwd: ' ' })), 'Research command requires a cwd');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), cwd: 7 })), 'Research command requires a cwd');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), purpose: 'ANALYSIS ' })), 'Invalid research purpose');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), timeoutMs: 999 })), 'Invalid research timeout');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), timeoutMs: 3_600_001 })), 'Invalid research timeout');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), expectedOutputs: ['ok', ''] })), 'Invalid expected outputs');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), expectedOutputs: ['a'.repeat(501)] })), 'Invalid expected outputs');
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), expectedOutputs: Array.from({ length: 21 }, () => 'o') })), 'Invalid expected outputs');
});

test('a bare executable outside the allow-list is still a valid spec: the donor does not mix the two gates', () => {
  assert.equal(executableAllowed('ruby'), false);
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), executable: 'ruby' })), null);
  assert.equal(refusal(() => validateCommandSpec({ ...spec(), executable: './scripts/run.sh' })), null);
});
