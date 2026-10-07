// CITY-REMOTE-OPERATION v1 — the contract that lets the City owner make a node run a program.
//
// Every test below attacks a REFUSAL or a guarantee rather than demonstrating the happy path twice: the value of this
// contract is what it will not do.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeRemoteOperation,
  validateRemoteOperationReceipt,
  operationDigest,
  isInsideWorkspace,
  REMOTE_OPERATION_EXPOSURE,
  MAX_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
} from '../contracts/city-remote-operation-v1/operation.mjs';

const ENABLED = {enabled: true, allowlist: ['git', 'node', 'corepack'], workspaceRoots: ['D:/work/utopia']};
const spec = overrides => ({executable: 'git', argv: ['rev-parse', 'HEAD'], cwd: 'D:/work/utopia', purpose: 'read the exact head under test', ...overrides});
const refuses = (code, requested, context = {}) => assert.throws(() => normalizeRemoteOperation(requested, {...ENABLED, ...context}), error => error.code === code, `expected ${code}`);

test('default-off is a refusal, not a silent no-op', () => {
  refuses('REMOTE_OPERATION_DISABLED', spec(), {enabled: false});
  refuses('REMOTE_OPERATION_DISABLED', spec(), {enabled: undefined});
});

test('an executable is refused by NAME against the allowlist, and an empty allowlist is its own refusal', () => {
  refuses('EXECUTABLE_NOT_ALLOWED', spec({executable: 'cmd'}));
  refuses('EXECUTABLE_NOT_ALLOWED', spec({executable: 'powershell'}));
  refuses('REMOTE_OPERATION_ALLOWLIST_EMPTY', spec(), {allowlist: []});
  // A path is not a name: naming C:/Windows/System32/cmd.exe must not sneak past a list that never agreed to it.
  refuses('EXECUTABLE_REQUIRED', spec({executable: '../../Windows/System32/cmd.exe'}));
  refuses('EXECUTABLE_REQUIRED', spec({executable: 'C:/Windows/System32/cmd.exe'}));
});

test('argv is data, and the shapes that cannot be an argv element are the ones refused', () => {
  refuses('ARGV_REQUIRED', spec({argv: 'rev-parse HEAD'}));
  refuses('ARGV_INVALID', spec({argv: ['ok', 7]}));
  refuses('ARGV_INVALID', spec({argv: ['ok', 'has\0nul']}));
  refuses('ARGV_TOO_LONG', spec({argv: ['x'.repeat(9000)]}));
  refuses('ARGV_TOO_MANY', spec({argv: Array(600).fill('x')}));
  // Shell metacharacters are INERT because no shell is ever used, so they are deliberately NOT refused: rejecting them
  // would imply a shell exists and would be security theatre. The test pins that decision in both directions.
  const withMetacharacters = normalizeRemoteOperation(spec({argv: ['log', '--grep=a; b | c && d $(e) `f` "g"']}), ENABLED);
  assert.equal(withMetacharacters.argv[1], '--grep=a; b | c && d $(e) `f` "g"');
  assert.equal(withMetacharacters.shell, false, 'the operation states that it is shell-free');
});

test('the working directory must be inside a declared workspace root', () => {
  refuses('WORKING_DIRECTORY_REQUIRED', spec({cwd: undefined}));
  refuses('WORKING_DIRECTORY_OUTSIDE_WORKSPACE', spec({cwd: 'D:/work/utopia/../../etc'}));
  refuses('WORKING_DIRECTORY_OUTSIDE_WORKSPACE', spec({cwd: 'D:/other'}));
  refuses('WORKING_DIRECTORY_OUTSIDE_WORKSPACE', spec({cwd: 'D:/work/utopia-secrets'}));
  refuses('WORKING_DIRECTORY_OUTSIDE_WORKSPACE', spec({cwd: 'relative/dir'}));
  refuses('REMOTE_OPERATION_WORKSPACE_UNSET', spec(), {workspaceRoots: []});
  // Containment is decided textually and the escape is refused rather than collapsed into a legal path.
  assert.equal(isInsideWorkspace('D:/work/utopia/sub/dir', ['D:/work/utopia']), true);
  assert.equal(isInsideWorkspace('D:/work/utopia/../utopia/sub', ['D:/work/utopia']), true);
  assert.equal(isInsideWorkspace('D:\\work\\utopia\\sub', ['D:/work/utopia']), true);
  assert.equal(isInsideWorkspace('D:/work/utopia/../secrets', ['D:/work/utopia']), false);
  assert.equal(isInsideWorkspace('/work/utopia/../../etc', ['/work/utopia']), false);
  assert.equal(isInsideWorkspace('D:/work/utopia', ['D:/other']), false);
});

test('a purpose is required and environment injection is refused by presence', () => {
  refuses('PURPOSE_REQUIRED', spec({purpose: ''}));
  refuses('PURPOSE_REQUIRED', spec({purpose: 'x'.repeat(900)}));
  refuses('ENVIRONMENT_OVERRIDE_REFUSED', spec({env: {PATH: 'D:/evil'}}));
  // Presence, not content: an EMPTY env object is refused too, so "no environment injection" cannot depend on payload.
  refuses('ENVIRONMENT_OVERRIDE_REFUSED', spec({env: {}}));
});

test('bounds are clamped to the ceiling, and omitting them cannot mean unbounded', () => {
  const defaults = normalizeRemoteOperation(spec(), ENABLED);
  assert.ok(defaults.timeoutMs > 0 && defaults.timeoutMs < MAX_TIMEOUT_MS);
  assert.ok(defaults.maxOutputBytes > 0 && defaults.maxOutputBytes < MAX_OUTPUT_BYTES);
  const smaller = normalizeRemoteOperation(spec({timeoutMs: 1000, maxOutputBytes: 1024}), ENABLED);
  assert.equal(smaller.timeoutMs, 1000);
  assert.equal(smaller.maxOutputBytes, 1024);
  refuses('TIMEOUT_EXCEEDS_LIMIT', spec({timeoutMs: MAX_TIMEOUT_MS + 1}));
  refuses('OUTPUT_LIMIT_EXCEEDS_LIMIT', spec({maxOutputBytes: MAX_OUTPUT_BYTES + 1}));
  refuses('BOUNDS_INVALID', spec({timeoutMs: 0}));
  refuses('BOUNDS_INVALID', spec({timeoutMs: 1.5}));
  refuses('BOUNDS_INVALID', spec({maxOutputBytes: -1}));
});

test('the same request digests the same, and a different request does not', () => {
  const one = normalizeRemoteOperation(spec(), ENABLED);
  const two = normalizeRemoteOperation(spec({argv: ['rev-parse', 'HEAD']}), ENABLED);
  assert.equal(one.operationDigest, two.operationDigest, 'argument order is part of the identity');
  const other = normalizeRemoteOperation(spec({argv: ['HEAD', 'rev-parse']}), ENABLED);
  assert.notEqual(one.operationDigest, other.operationDigest);
  assert.notEqual(normalizeRemoteOperation(spec({purpose: 'something else'}), ENABLED).operationDigest, one.operationDigest);
  assert.equal(operationDigest({b: 1, a: [2, 3]}), operationDigest({a: [2, 3], b: 1}), 'key order does not change identity');
});

test('a node receipt is an observation the City re-checks, never an authority', () => {
  const operation = normalizeRemoteOperation(spec(), ENABLED);
  const good = {operationDigest: operation.operationDigest, state: 'COMPLETED', exitCode: 0, timedOut: false, stdout: 'abc', stderr: ''};
  const valid = validateRemoteOperationReceipt(operation, good);
  assert.equal(valid.valid, true);
  assert.equal(valid.acceptanceAuthority, false, 'a receipt never carries acceptance authority');
  assert.equal(valid.stdoutBytes, 3);

  const fails = (code, receipt) => {
    const verdict = validateRemoteOperationReceipt(operation, receipt);
    assert.equal(verdict.valid, false);
    assert.equal(verdict.code, code);
    assert.equal(verdict.acceptanceAuthority, false);
  };
  // A node cannot answer a question it was not asked.
  fails('RECEIPT_OPERATION_MISMATCH', {...good, operationDigest: 'f'.repeat(64)});
  fails('RECEIPT_STATE_INVALID', {...good, state: 'SUCCEEDED'});
  fails('RECEIPT_OUTPUT_INVALID', {...good, stdout: null});
  fails('RECEIPT_EXIT_CODE_INVALID', {...good, exitCode: '0'});
  fails('RECEIPT_TIMEOUT_FLAG_REQUIRED', {...good, timedOut: undefined});
  fails('RECEIPT_COMPLETED_WITHOUT_SUCCESS', {...good, state: 'COMPLETED', exitCode: 3});
  fails('RECEIPT_FAILED_WITHOUT_CAUSE', {...good, state: 'FAILED', exitCode: 0, timedOut: false});
  fails('RECEIPT_REQUIRED', null);
  // The City bounds the output again rather than trusting the node's own truncation.
  const overLimit = validateRemoteOperationReceipt(operation, {...good, stdout: 'x'.repeat(2048)}, {maxOutputBytes: 1024});
  assert.equal(overLimit.valid, false);
  assert.equal(overLimit.code, 'RECEIPT_OUTPUT_OVER_LIMIT');
  assert.equal(validateRemoteOperationReceipt(operation, {...good, stdout: 'x'.repeat(2048)}).valid, true, 'the default ceiling is generous');
  assert.equal(validateRemoteOperationReceipt(operation, {...good, state: 'FAILED', exitCode: 1}).valid, true);
  assert.equal(validateRemoteOperationReceipt(operation, {...good, state: 'FAILED', exitCode: null, timedOut: true}).valid, true);
});

test('the capability ships with its exposure decision attached', () => {
  assert.equal(REMOTE_OPERATION_EXPOSURE.exposureClass, 'DIRECT_CONTROL');
  assert.equal(REMOTE_OPERATION_EXPOSURE.defaultEnabled, false);
  assert.equal(REMOTE_OPERATION_EXPOSURE.requiresConfirmation, true);
  assert.equal(REMOTE_OPERATION_EXPOSURE.cancellable, true);
});
