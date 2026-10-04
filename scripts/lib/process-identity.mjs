// Resolving the identity of a recorded PID before the recovery pilot kills it.
//
// WHY THIS MODULE EXISTS. scripts/device-recovery-pilot.mjs read a PID from .runtime/processes.json
// and confirmed it with one PowerShell call before killing it:
//
//     const actual = JSON.parse(execFileSync('powershell.exe', ['-NoProfile','-Command',
//       `Get-CimInstance Win32_Process -Filter 'ProcessId = ${Number(pid)}' |
//        Select-Object CommandLine | ConvertTo-Json -Compress`], {windowsHide:true}).toString());
//     if(!actual?.CommandLine?.includes(expected)) throw Error('Recorded process identity mismatch');
//
// REPRODUCED ON THIS HOST, deterministically, and it is NOT a host-specific limitation: when the
// recorded PID is not a live process, `Get-CimInstance` matches nothing, so `ConvertTo-Json` emits
// NOTHING and the call still exits 0 with an empty string. `JSON.parse('')` then throws
//
//     SyntaxError: Unexpected end of JSON input
//
// So the check dies with a JavaScript parse error rather than a clear diagnostic, whenever the
// recorded PID is stale - for instance after a prior restart bumped it. That is a defect in the
// shared harness on every host, not a capability gap on one machine, and it is worth separating from
// the genuine "no such executable" case:
//
//   - LIVE pid, CIM works            -> command line available, verify it (unchanged behaviour)
//   - PID not live, CIM works        -> EMPTY output. NOT an error: the process we wanted stopped is
//                                       already stopped, so the kill is simply unnecessary.
//   - CIM unusable (missing, policy,
//     spawn failure)                 -> fall back to tasklist image name, which still catches the
//                                       realistic mistake of a recycled PID belonging to something
//                                       that is plainly not node.
//
// Distinguishing those three matters because collapsing them is what produced the bug: the old code
// treated "already gone" as "identity mismatch", so a recoverable state became a crash. The status
// is returned and RECORDED in the run's evidence rather than swallowed, so a reader can see which
// case a run actually hit instead of inferring that verification succeeded.

import {execFileSync} from 'node:child_process';

export const IDENTITY_STATUSES = ['verified', 'mismatch', 'already-gone', 'weak', 'unavailable', 'invalid-pid'];

const defaultExec = (file, args) =>
  execFileSync(file, args, {windowsHide: true, maxBuffer: 8 * 1024 * 1024}).toString();

const clean = (raw) => String(raw ?? '').replace(/^\uFEFF/, '').trim();

/**
 * A PID must be a positive integer before it reaches a command line.
 * Without this, `Number('42; rm -rf /')` is NaN, the filter reads `ProcessId = NaN`, nothing matches,
 * and a nonsense PID is then misreported as "already gone" - a silent skip of the kill rather than a
 * loud complaint about a corrupt processes.json.
 */
const pidOf = (pid) => {
  const n = Number(pid);
  return Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * Command line from `ConvertTo-Json -Compress` output.
 * Returns null for EMPTY output (no matching process) and null for output that is not JSON at all -
 * the caller distinguishes those by looking at the raw text, so unparseable output is never silently
 * reported as "no such process".
 */
export const commandLineFromJson = (raw) => {
  const text = clean(raw);
  if (text === '' || text === 'null') return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  for (const row of rows) {
    const cl = row && (row.CommandLine ?? row.commandLine);
    if (typeof cl === 'string' && cl.trim() !== '') return cl;
  }
  return null;
};

/** Image name from `tasklist /FO CSV /NH`. Returns null when tasklist reported no match. */
export const imageNameFromTasklist = (raw) => {
  for (const line of clean(raw).split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line.trim());
    if (m) return m[1];
  }
  return null;
};

const requirePid = (pid) => {
  const n = pidOf(pid);
  if (n === null) throw Error(`invalid pid: ${JSON.stringify(pid)}`);
  return n;
};

export const cimArgs = (pid) => ['-NoProfile', '-Command',
  `Get-CimInstance Win32_Process -Filter 'ProcessId = ${requirePid(pid)}' | Select-Object CommandLine | ConvertTo-Json -Compress`];

export const tasklistArgs = (pid) => ['/FI', `PID eq ${requirePid(pid)}`, '/FO', 'CSV', '/NH'];

/**
 * Resolve what the recorded PID actually is.
 * Returns `{status, verified, via, commandLine, imageName?, detail?}`; never throws for a probe
 * failure, so the caller decides what a given status means.
 */
export const resolveProcessIdentity = ({pid, expected, exec = defaultExec}) => {
  if (pidOf(pid) === null) {
    return {status: 'invalid-pid', verified: false, via: null, commandLine: null,
      detail: `processes.json recorded a non-numeric pid: ${JSON.stringify(pid)}`};
  }
  let raw = null;
  let cimFailed = null;
  try {
    raw = exec('powershell.exe', cimArgs(pid));
  } catch (e) {
    cimFailed = e;
  }

  if (!cimFailed) {
    const commandLine = commandLineFromJson(raw);
    if (commandLine !== null) {
      return commandLine.includes(expected)
        ? {status: 'verified', verified: true, via: 'cim', commandLine}
        : {status: 'mismatch', verified: false, via: 'cim', commandLine};
    }
    // Empty output means CIM found no such process. Anything else non-empty but unparseable is a
    // probe problem, not evidence of absence, so it falls through to the weaker probe instead.
    if (clean(raw) === '' || clean(raw) === 'null') {
      return {status: 'already-gone', verified: false, via: 'cim', commandLine: null};
    }
    cimFailed = Error(`unparseable CIM output: ${clean(raw).slice(0, 120)}`);
  }

  try {
    const imageName = imageNameFromTasklist(exec('tasklist', tasklistArgs(pid)));
    if (imageName !== null) {
      return {status: 'weak', verified: false, via: 'tasklist', commandLine: null, imageName};
    }
    return {status: 'already-gone', verified: false, via: 'tasklist', commandLine: null};
  } catch (e) {
    return {status: 'unavailable', verified: false, via: null, commandLine: null,
      detail: String(cimFailed?.message ?? e?.message ?? e)};
  }
};

/** Statuses for which the recorded process should still be killed. */
export const shouldKill = (status) => status === 'verified' || status === 'mismatch' || status === 'weak'
  || status === 'unavailable';

/**
 * Statuses that must abort the run before anything is killed: the PID either belongs to something
 * that is plainly not our process, or is not a PID at all.
 */
export const isFatalIdentity = (status) => status === 'mismatch' || status === 'invalid-pid';

/** @deprecated kept for callers written against the earlier name. */
export const isFatalMismatch = isFatalIdentity;
