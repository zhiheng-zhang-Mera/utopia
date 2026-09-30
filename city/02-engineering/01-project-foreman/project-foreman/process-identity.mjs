/**
 * UTOPIA · City · Project Foreman — process ownership identity.
 *
 * Read the OS creation identity for a PID. A PID alone is not an ownership
 * identity on Windows because the kernel may reuse it after a process exits.
 * Unknown is deliberately distinct from dead: recovery may reclaim only when
 * the prior owner is positively shown to be absent or to have a different start
 * identity.
 *
 * Donor provenance: DS-Hns `app/engineering/process-identity.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b, ported from CommonJS to ESM. The
 * PowerShell probe, its timeout, its regex and the `win-filetime:` /
 * `runtime-start:` identity formats are the donor's. The donor gives
 * `probeProcessOwner` an injectable `options.getProcessIdentity` seam, which is
 * preserved; the top-level probe keeps its hard `spawnSync`.
 *
 * @module project-foreman/process-identity
 */

import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

/**
 * Read the OS creation identity for a PID.
 *
 * @param {number} [pid]
 * @returns {{known:boolean, exists:boolean, identity:string|null}}
 */
export function getProcessIdentity(pid = process.pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { known: false, exists: false, identity: null };
  if (process.platform !== 'win32') return { known: false, exists: false, identity: null };

  const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction SilentlyContinue; if ($null -eq $p) { 'ABSENT' } else { [long]([datetime]$p.CreationDate).ToUniversalTime().ToFileTimeUtc() }`;
  let result;
  try {
    result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true
    });
  } catch {
    return { known: false, exists: false, identity: null };
  }
  if (result.error || result.status !== 0) return { known: false, exists: false, identity: null };
  const output = String(result.stdout || '').trim();
  if (output === 'ABSENT') return { known: true, exists: false, identity: null };
  if (!/^\d{10,20}$/.test(output)) return { known: false, exists: false, identity: null };
  return { known: true, exists: true, identity: `win-filetime:${output}` };
}

/**
 * Build the owner identity this runtime presents to the recovery store.
 *
 * @param {object} [options]
 * @param {number} [options.pid]
 * @param {string} [options.instanceId]
 * @param {string} [options.processIdentity]
 * @returns {{instanceId:string, pid:number, processIdentity:string}}
 */
export function createProcessOwner(options = {}) {
  const pid = Number.isSafeInteger(options.pid) && options.pid > 0 ? options.pid : process.pid;
  const identity = typeof options.processIdentity === 'string' && options.processIdentity.trim()
    ? options.processIdentity.trim()
    : (() => {
        const probe = getProcessIdentity(pid);
        if (probe.known && probe.exists && probe.identity) return probe.identity;
        // This identity is stable within the owner process but intentionally not
        // externally comparable. Another shell will classify a live process as
        // UNKNOWN and will not steal its claim.
        const estimatedStart = Math.round(Date.now() - process.uptime() * 1000);
        return `runtime-start:${pid}:${estimatedStart}:${crypto.randomUUID()}`;
      })();
  return {
    instanceId: typeof options.instanceId === 'string' && options.instanceId.trim() ? options.instanceId.trim() : crypto.randomUUID(),
    pid,
    processIdentity: identity
  };
}

/**
 * Classify one saved owner against the OS.
 *
 * @param {object} owner
 * @param {number} owner.pid
 * @param {string} owner.processIdentity
 * @param {object} [options]
 * @param {Function} [options.getProcessIdentity]
 * @returns {boolean|null} true when the same process is live, false when it is gone
 *   or has a different start identity, null when it cannot be told
 */
export function probeProcessOwner(owner, options = {}) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.processIdentity !== 'string' || !owner.processIdentity.trim()) return null;
  const getIdentity = typeof options.getProcessIdentity === 'function' ? options.getProcessIdentity : getProcessIdentity;
  let observation;
  try {
    observation = getIdentity(owner.pid);
  } catch {
    return null;
  }
  if (!observation || observation.known !== true) return null;
  if (observation.exists === false) return false;
  if (observation.exists !== true || typeof observation.identity !== 'string') return null;
  if (owner.processIdentity.startsWith('runtime-start:')) return null;
  return observation.identity === owner.processIdentity;
}
