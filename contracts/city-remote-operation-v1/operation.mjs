// City -> node remote operation (v1).
//
// This is the one place in the product where the City owner can make another machine RUN A PROGRAM. Everything that
// makes that safe has to be here rather than in the caller, because the caller is the thing being bounded. The shape
// is narrow on purpose, and each narrowing below is a decision with a reason rather than a habit:
//
//   NO SHELL, EVER. The node spawns `executable` with `argv` and `shell:false`. A consequence worth stating instead of
//   papering over: `;`, `|`, `&&`, `$(...)`, backticks and quotes inside an argument are INERT DATA, and this module
//   therefore does NOT reject them. Rejecting them would imply a shell exists somewhere and would buy a feeling of
//   safety rather than safety. What is rejected is anything that cannot be an argv element at all (a NUL byte, a
//   non-string, an over-long value) - those are the shapes that break the guarantee that argv is data.
//
//   AN ALLOWLIST, NOT A PATTERN. The owner names the executables that may be run, at City startup. A blocklist or a
//   "dangerous command" regex would be an infinite game; an allowlist is one decision made once, by the person who
//   owns the machines, and it is refused by NAME so the operator learns the list instead of guessing it.
//
//   A WORKSPACE, NOT A FREE PATH. The working directory must live inside a declared workspace root. `..`, an absolute
//   path outside every root, and a path that normalises outside are all the same refusal.
//
//   BOUNDS ARE CLAMPED, NOT TRUSTED. A caller may ask for less; it cannot ask for more than the ceiling, and it cannot
//   make an unbounded run by omitting the field.
//
//   NO ENVIRONMENT INJECTION in v1. The node runs with its own environment. Letting the City set environment variables
//   would be a second, quieter way to change what a program does, and it is not needed for the purpose this exists for.
//
//   A PURPOSE IS REQUIRED. An unexplained remote execution is refused: the audit is the product feature, not a
//   by-product.
//
//   OFF BY DEFAULT. `enabled` must be explicitly true, and the allowlist and workspace roots must be explicitly
//   declared. Nothing here turns itself on.
import {createHash} from 'node:crypto';

export const REMOTE_OPERATION_VERSION = 1;
export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 1_800_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 262_144;
export const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_ARGUMENTS = 512;
export const MAX_ARGUMENT_LENGTH = 8_192;
export const MAX_PURPOSE_LENGTH = 500;

export const OPERATION_STATES = Object.freeze(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'REFUSED', 'CANCELLED']);

const refuse = (code, message) => { throw Object.assign(new Error(message ?? code), {code}); };
const isText = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const isIdentifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(value);

/** Normalise a path for containment checks. Purely textual: the node does no filesystem call to decide it. */
export function normalizePath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const unified = value.replace(/\\/g, '/');
  const absolute = unified.startsWith('/') || /^[A-Za-z]:\//.test(unified);
  const parts = [];
  for (const segment of unified.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { if (parts.length === 0) return null; parts.pop(); continue; }
    parts.push(segment);
  }
  const drive = /^([A-Za-z]):$/.exec(parts[0] ?? '');
  if (drive) parts.shift();
  return {absolute, drive: drive ? drive[1].toLowerCase() : null, parts};
}

/**
 * Is `candidate` inside one of `roots`? Both sides are normalised the same way and compared segment by segment, so
 * `C:/work/../work/x` and `C:/work/x` agree, and `/work/../etc` is refused rather than silently collapsed to `/etc`.
 */
export function isInsideWorkspace(candidate, roots) {
  const target = normalizePath(candidate);
  if (!target || !target.absolute) return false;
  for (const root of roots ?? []) {
    const base = normalizePath(root);
    if (!base || !base.absolute) continue;
    if ((base.drive ?? null) !== (target.drive ?? null)) continue;
    if (base.parts.length > target.parts.length) continue;
    if (base.parts.every((segment, index) => segment.toLowerCase() === target.parts[index].toLowerCase())) return true;
  }
  return false;
}

/**
 * Turn a requested operation into the frozen form the City persists and the node executes, or refuse by name.
 * Every refusal code is the diagnosis: a caller that is refused should be able to fix the request without asking.
 */
export function normalizeRemoteOperation(spec, {enabled = false, allowlist = [], workspaceRoots = []} = {}) {
  if (enabled !== true) refuse('REMOTE_OPERATION_DISABLED', 'remote operation is not enabled on this City');
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) refuse('OPERATION_SPEC_REQUIRED');
  const allowed = new Set((allowlist ?? []).filter(isIdentifier).map(name => name.toLowerCase()));
  if (allowed.size === 0) refuse('REMOTE_OPERATION_ALLOWLIST_EMPTY', 'no executable is allowed on this City');

  // The executable is a NAME resolved on the node's own PATH. An absolute path is refused: a path would let a caller
  // name a file the allowlist never agreed to, which is exactly the confusion the allowlist exists to prevent.
  if (!isIdentifier(spec.executable)) refuse('EXECUTABLE_REQUIRED', 'executable must be a plain program name');
  if (!allowed.has(spec.executable.toLowerCase())) refuse('EXECUTABLE_NOT_ALLOWED', `executable "${spec.executable}" is not on this City's allowlist`);

  if (!Array.isArray(spec.argv)) refuse('ARGV_REQUIRED', 'argv must be an array of strings');
  if (spec.argv.length > MAX_ARGUMENTS) refuse('ARGV_TOO_MANY', `argv carries more than ${MAX_ARGUMENTS} arguments`);
  const argv = [];
  for (const [index, argument] of spec.argv.entries()) {
    if (typeof argument !== 'string') refuse('ARGV_INVALID', `argv[${index}] is not a string`);
    if (argument.includes('\0')) refuse('ARGV_INVALID', `argv[${index}] contains a NUL byte`);
    if (argument.length > MAX_ARGUMENT_LENGTH) refuse('ARGV_TOO_LONG', `argv[${index}] exceeds ${MAX_ARGUMENT_LENGTH} characters`);
    argv.push(argument);
  }

  if (!isText(spec.cwd, 1024)) refuse('WORKING_DIRECTORY_REQUIRED', 'cwd is required: a remote command must say where it runs');
  const roots = (workspaceRoots ?? []).filter(root => normalizePath(root)?.absolute);
  if (roots.length === 0) refuse('REMOTE_OPERATION_WORKSPACE_UNSET', 'this City declares no workspace root');
  if (!isInsideWorkspace(spec.cwd, roots)) refuse('WORKING_DIRECTORY_OUTSIDE_WORKSPACE', `cwd "${spec.cwd}" is not inside a declared workspace root`);

  if (!isText(spec.purpose, MAX_PURPOSE_LENGTH)) refuse('PURPOSE_REQUIRED', 'purpose is required: an unexplained remote execution is refused');

  const timeoutMs = spec.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : spec.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) refuse('BOUNDS_INVALID', 'timeoutMs must be a positive integer');
  if (timeoutMs > MAX_TIMEOUT_MS) refuse('TIMEOUT_EXCEEDS_LIMIT', `timeoutMs exceeds the ${MAX_TIMEOUT_MS} ms ceiling`);

  const maxOutputBytes = spec.maxOutputBytes === undefined ? DEFAULT_MAX_OUTPUT_BYTES : spec.maxOutputBytes;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) refuse('BOUNDS_INVALID', 'maxOutputBytes must be a positive integer');
  if (maxOutputBytes > MAX_OUTPUT_BYTES) refuse('OUTPUT_LIMIT_EXCEEDS_LIMIT', `maxOutputBytes exceeds the ${MAX_OUTPUT_BYTES} byte ceiling`);

  // Environment overrides are refused by PRESENCE, not by inspecting what they contain: the refusal has to be visible
  // to a caller that sends an empty object too, otherwise "no environment injection" would depend on the payload.
  if (spec.env !== undefined) refuse('ENVIRONMENT_OVERRIDE_REFUSED', 'this City does not let a caller set the node environment');

  const body = {
    schemaVersion: REMOTE_OPERATION_VERSION,
    executable: spec.executable,
    argv: Object.freeze(argv),
    cwd: spec.cwd,
    purpose: spec.purpose,
    timeoutMs,
    maxOutputBytes,
    shell: false,
    environmentInjection: false,
  };
  return Object.freeze({...body, operationDigest: operationDigest(body)});
}

const canonical = value => Array.isArray(value)
  ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object'
    ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
    : JSON.stringify(value);

export const operationDigest = value => createHash('sha256').update(canonical(value)).digest('hex');

/**
 * The City's check on what came back. A node's receipt is an observation, never an authority: the City re-derives the
 * digest from the operation it dispatched and refuses a receipt that describes a different one, so a node cannot
 * answer a question it was not asked. Output is bounded again here because the City does not get to trust the node's
 * own truncation either.
 */
export function validateRemoteOperationReceipt(operation, receipt, {maxOutputBytes = MAX_OUTPUT_BYTES} = {}) {
  const fail = code => Object.freeze({valid: false, code, acceptanceAuthority: false});
  try {
    if (operation === null || typeof operation !== 'object') return fail('OPERATION_REQUIRED');
    if (operation.shell !== false) return fail('OPERATION_NOT_SHELL_FREE');
    if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) return fail('RECEIPT_REQUIRED');
    if (receipt.operationDigest !== operation.operationDigest) return fail('RECEIPT_OPERATION_MISMATCH');
    if (!OPERATION_STATES.includes(receipt.state)) return fail('RECEIPT_STATE_INVALID');
    for (const key of ['stdout', 'stderr']) {
      const value = receipt[key];
      if (typeof value !== 'string') return fail('RECEIPT_OUTPUT_INVALID');
      if (Buffer.byteLength(value) > maxOutputBytes) return fail('RECEIPT_OUTPUT_OVER_LIMIT');
    }
    const exitCode = receipt.exitCode;
    if (exitCode !== null && !Number.isSafeInteger(exitCode)) return fail('RECEIPT_EXIT_CODE_INVALID');
    if (typeof receipt.timedOut !== 'boolean') return fail('RECEIPT_TIMEOUT_FLAG_REQUIRED');
    // A COMPLETED operation whose exit code is not zero is a contradiction: the state is the whole point of the
    // receipt, so it is refused rather than quietly reinterpreted.
    if (receipt.state === 'COMPLETED' && exitCode !== 0) return fail('RECEIPT_COMPLETED_WITHOUT_SUCCESS');
    if (receipt.state === 'FAILED' && exitCode === 0 && receipt.timedOut !== true) return fail('RECEIPT_FAILED_WITHOUT_CAUSE');
    return Object.freeze({
      valid: true,
      state: receipt.state,
      exitCode,
      timedOut: receipt.timedOut,
      stdoutBytes: Buffer.byteLength(receipt.stdout),
      stderrBytes: Buffer.byteLength(receipt.stderr),
      acceptanceAuthority: false,
    });
  } catch { return fail('RECEIPT_UNREADABLE'); }
}

/**
 * The exposure decision this capability lives under, kept beside the contract so the answer cannot drift away from the
 * thing it describes. DIRECT_CONTROL per CONSTRUCTION_RULES 14A: the owner initiates it, must see accepted/running/
 * refused/completed, and must be able to stop it - so a UI that only documents it is not completion.
 */
export const REMOTE_OPERATION_EXPOSURE = Object.freeze({
  capabilityId: 'CAP-CITY-REMOTE-OPERATION-001',
  exposureClass: 'DIRECT_CONTROL',
  surface: 'CITY_ADVANCED',
  nesting: 'L4_TECHNICAL',
  requiresConfirmation: true,
  cancellable: true,
  defaultEnabled: false,
});
