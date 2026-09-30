/**
 * UTOPIA · City Core — capability-aware routing and node self-inspection.
 *
 * Ported from the Codex-Boss donor `src/shared/capability-router.ts` and
 * `src/shared/node-capabilities.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * A scheduler must never assign work to a node that lacks the capability or whose
 * observed state cannot accept work:
 *   - FAILED / DISABLED / RECOVERING candidates are excluded, with the reason recorded;
 *   - a candidate missing a required capability is excluded, with the missing ids;
 *   - READY and DEGRADED candidates are admitted (DEGRADED under explicit risk, and
 *     always listed in `degraded` — never silently);
 *   - an unobserved capability is never treated as present, and an unobserved state is
 *     UNKNOWN.
 *
 * Self-inspection derives per-capability verdicts and a node state from concrete
 * observed facts only. A capability is READY only when the probe actually observed it:
 * a fake or absent observation can only yield DEGRADED / UNKNOWN / FAILED.
 *
 * The donor exports two different functions named `nodeStateFor`. The
 * self-inspection one is exported here as `probeNodeStateFor`; the heartbeat one lives
 * in `./fleet.mjs` as `fleetNodeStateFor`. They are deliberately not merged.
 */

import {
  CANDIDATE_STATES_EXCLUDED,
  COMPUTE_CAPABILITY_ID,
  PROBE_NODE_READY_REASON,
  STATE_EXCLUSION_PREFIX,
  UNOBSERVED_MODULE_STATE,
} from './contracts.mjs';

/**
 * Capability-aware eligibility over candidates, in input order.
 *
 * `blocked` is the ids of the state-based exclusions only: it is derived from the
 * recorded reason prefix, not recomputed, so a missing-capability exclusion can never
 * appear there. `degraded` lists the DEGRADED candidates that were still admitted.
 *
 * @param {Array<{id: string, capabilities: string[]}>} candidates
 * @param {Record<string, string>} states       observed module state per candidate id
 * @param {string[]} requiredCapabilities
 * @returns {{selected: string[], excluded: Array<{id: string, reason: string}>, degraded: string[], blocked: string[]}}
 */
export function eligibleCandidates(candidates, states, requiredCapabilities) {
  const selected = [];
  const excluded = [];
  const degraded = [];
  for (const candidate of candidates) {
    const state = states[candidate.id] ?? UNOBSERVED_MODULE_STATE;
    if (CANDIDATE_STATES_EXCLUDED.includes(state)) {
      excluded.push({ id: candidate.id, reason: `${STATE_EXCLUSION_PREFIX}${state} cannot accept work` });
      continue;
    }
    const missing = requiredCapabilities.filter((capability) => !candidate.capabilities.includes(capability));
    if (missing.length) {
      excluded.push({ id: candidate.id, reason: `missing capability: ${missing.join(',')}` });
      continue;
    }
    if (state === 'DEGRADED') degraded.push(candidate.id);
    selected.push(candidate.id);
  }
  return {
    selected,
    excluded,
    degraded,
    blocked: excluded.filter((item) => item.reason.startsWith(STATE_EXCLUSION_PREFIX)).map((item) => item.id),
  };
}

/**
 * Deterministic derivation: observed facts only → no fake READY.
 *
 * The donor's checks, in its order:
 *   compute    READY with ≥1 core and memory > 0, else FAILED
 *   memory     READY when free memory was observed, DEGRADED when only total was, else FAILED
 *   runtime    READY only when the node runtime was observed, else UNKNOWN
 *   gpu        READY only when a GPU was observed, else UNKNOWN
 *   web-ai     READY only when a provider was OBSERVED logged in, else DEGRADED
 *   browser    READY only when a browser runtime was observed, else UNKNOWN
 *   native-tools  READY when available, else DEGRADED
 *   network    READY when proxied or a provider was directly reachable, else DEGRADED
 *
 * @param {object} data a node probe record
 * @returns {Array<{id: string, status: string, detail: string}>}
 */
export function capabilityVerdicts(data) {
  const verdicts = [];
  const compute =
    data.cpu.cores >= 1 && data.memory.totalMb > 0
      ? { status: 'READY', detail: `${data.cpu.cores} cores` }
      : { status: 'FAILED', detail: 'no compute/memory observed' };
  verdicts.push({ id: COMPUTE_CAPABILITY_ID, ...compute });

  verdicts.push(
    data.memory.totalMb > 0
      ? {
          id: 'memory',
          status: data.memory.freeMb === undefined ? 'DEGRADED' : 'READY',
          detail: `${data.memory.totalMb} MB`,
        }
      : { id: 'memory', status: 'FAILED', detail: 'no memory observed' },
  );

  verdicts.push({
    id: 'runtime',
    status: data.runtimes.node ? 'READY' : 'UNKNOWN',
    detail: `node=${data.runtimes.node ?? 'absent'}`,
  });
  verdicts.push({
    id: 'gpu',
    status: data.gpu.length ? 'READY' : 'UNKNOWN',
    detail: data.gpu.length ? data.gpu[0].name : 'no gpu observed',
  });

  // Web-AI is READY only when a provider was OBSERVED logged in — never assumed.
  verdicts.push(
    data.webLoggedInProviders.length
      ? { id: 'web-ai', status: 'READY', detail: data.webLoggedInProviders.join(',') }
      : { id: 'web-ai', status: 'DEGRADED', detail: 'no logged-in web AI observed' },
  );

  verdicts.push({
    id: 'browser',
    status: data.runtimes.browser ? 'READY' : 'UNKNOWN',
    detail: `browser=${data.runtimes.browser ?? 'absent'}`,
  });
  verdicts.push({
    id: 'native-tools',
    status: data.nativeToolsAvailable ? 'READY' : 'DEGRADED',
    detail: data.nativeToolsAvailable ? 'native tools available' : 'native tools absent',
  });
  verdicts.push({
    id: 'network',
    status: data.network.proxyCapable || data.network.directReachableProviders.length ? 'READY' : 'DEGRADED',
    detail: `direct=${data.network.directReachableProviders.length} proxy=${data.network.proxyCapable}`,
  });
  return verdicts;
}

/**
 * Node state from self-inspection verdicts.
 *
 * A FAILED compute verdict fails the whole node. Otherwise any DEGRADED capability
 * degrades it, naming the ids. Optional extras left UNKNOWN (GPU, browser) do NOT
 * block the node, so a machine without a GPU is still READY.
 *
 * Exported as `probeNodeStateFor`: the donor's other `nodeStateFor` is
 * `fleetNodeStateFor` in `./fleet.mjs`, and the two must not be confused.
 *
 * @param {object} data     the node probe record (kept for the donor's signature)
 * @param {Array<{id: string, status: string, detail: string}>} verdicts
 * @returns {{state: string, reason: string}}
 */
export function probeNodeStateFor(data, verdicts) {
  const compute = verdicts.find((item) => item.id === COMPUTE_CAPABILITY_ID);
  if (!compute) throw new TypeError(`verdicts must include the ${COMPUTE_CAPABILITY_ID} verdict`);
  if (compute.status === 'FAILED') return { state: 'FAILED', reason: compute.detail };
  const degraded = verdicts.filter((item) => item.status === 'DEGRADED');
  if (degraded.length) {
    return { state: 'DEGRADED', reason: `degraded: ${degraded.map((item) => item.id).join(', ')}` };
  }
  return { state: 'READY', reason: PROBE_NODE_READY_REASON };
}

/** Self-inspect a probe record once: verdicts plus the node state they imply. */
export function inspectNode(data) {
  const verdicts = capabilityVerdicts(data);
  return { verdicts, nodeState: probeNodeStateFor(data, verdicts) };
}
