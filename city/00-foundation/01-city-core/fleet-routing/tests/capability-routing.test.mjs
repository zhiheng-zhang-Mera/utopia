/**
 * UTOPIA · City Core — capability-aware routing and self-inspection suite.
 *
 * The eligibility rules restate the Codex-Boss donor `src/shared/capability-router.ts`,
 * and the verdicts and node state restate `src/shared/node-capabilities.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. The donor's two `nodeStateFor` functions
 * are exercised separately: `fleetNodeStateFor` (heartbeat) in fleet.test.mjs and
 * `probeNodeStateFor` (self-inspection) here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPABILITY_IDS,
  CAPABILITY_STATUSES,
  MODULE_STATES,
  PROBE_NODE_READY_REASON,
  UNOBSERVED_MODULE_STATE,
  capabilityVerdict,
  capabilityVerdicts,
  eligibleCandidates,
  fleetNodeStateFor,
  inspectNode,
  moduleState,
  nodeProbeData,
  probeNodeStateFor,
  probeNodeStateRecord,
  routerCandidate,
  routedResult,
} from '../index.mjs';

/** A probe record reporting only facts the caller states. */
function probe(overrides = {}) {
  return {
    nodeId: 'node-1',
    os: { platform: 'linux', arch: 'x64', version: '6.1' },
    cpu: { cores: 8, model: 'observed-cpu', loadPercent: 12 },
    gpu: [{ name: 'observed-gpu', vramMb: 8192 }],
    memory: { totalMb: 32768, freeMb: 16384 },
    runtimes: { node: '24.0.0', python: '3.12.0', browser: 'chromium', shell: 'bash' },
    webLoggedInProviders: ['provider-observed'],
    nativeToolsAvailable: true,
    network: { region: 'r1', directReachableProviders: ['provider-observed'], proxyCapable: false },
    currentTaskCount: 0,
    sampledAt: '2026-09-29T12:00:00.000Z',
    ...overrides,
  };
}

function verdictMap(verdicts) {
  return Object.fromEntries(verdicts.map((verdict) => [verdict.id, verdict]));
}

test('the routing vocabulary is the donor vocabulary, with an unobserved default', () => {
  assert.deepEqual(MODULE_STATES, [
    'UNINITIALIZED',
    'CHECKING',
    'READY',
    'DEGRADED',
    'FAILED',
    'DISABLED',
    'RECOVERING',
    'UNKNOWN',
  ]);
  assert.deepEqual(CAPABILITY_STATUSES, ['READY', 'DEGRADED', 'FAILED', 'DISABLED', 'UNKNOWN']);
  assert.equal(UNOBSERVED_MODULE_STATE, 'UNKNOWN');
  assert.deepEqual(CAPABILITY_IDS, [
    'compute',
    'memory',
    'runtime',
    'gpu',
    'web-ai',
    'browser',
    'native-tools',
    'network',
  ]);
  assert.throws(() => moduleState('READYISH'), TypeError);
  assert.throws(() => capabilityVerdict({ id: 'compute', status: 'PROBABLY', detail: 'x' }), TypeError);
  assert.throws(() => capabilityVerdict({ id: 'quantum', status: 'READY', detail: 'x' }), TypeError);
});

test('states that cannot accept work are excluded with their reason', () => {
  const candidates = [
    { id: 'a', capabilities: ['compute'] },
    { id: 'b', capabilities: ['compute'] },
    { id: 'c', capabilities: ['compute'] },
    { id: 'd', capabilities: ['compute'] },
    { id: 'e', capabilities: ['compute'] },
  ];
  const result = eligibleCandidates(
    candidates,
    { a: 'FAILED', b: 'DISABLED', c: 'RECOVERING', d: 'READY', e: 'DEGRADED' },
    ['compute'],
  );
  assert.deepEqual(result.selected, ['d', 'e']);
  assert.deepEqual(result.excluded, [
    { id: 'a', reason: 'state FAILED cannot accept work' },
    { id: 'b', reason: 'state DISABLED cannot accept work' },
    { id: 'c', reason: 'state RECOVERING cannot accept work' },
  ]);
  assert.deepEqual(result.degraded, ['e'], 'a DEGRADED candidate is admitted and reported');
  assert.deepEqual(result.blocked, ['a', 'b', 'c'], 'blocked lists the state exclusions only');
});

test('blocked never lists a capability exclusion, even when both exclusion kinds occur', () => {
  const result = eligibleCandidates(
    [
      { id: 'state-failed', capabilities: ['compute'] },
      { id: 'missing-cap', capabilities: ['compute'] },
      { id: 'both-wrong', capabilities: [] },
      { id: 'fine', capabilities: ['compute', 'gpu'] },
    ],
    { 'state-failed': 'FAILED', 'missing-cap': 'READY', 'both-wrong': 'DISABLED', fine: 'READY' },
    ['compute', 'gpu'],
  );
  assert.deepEqual(result.selected, ['fine']);
  assert.deepEqual(result.blocked, ['state-failed', 'both-wrong'], 'a DISABLED candidate is blocked even when it also lacks a capability');
  assert.deepEqual(result.excluded, [
    { id: 'state-failed', reason: 'state FAILED cannot accept work' },
    { id: 'missing-cap', reason: 'missing capability: gpu' },
    { id: 'both-wrong', reason: 'state DISABLED cannot accept work' },
  ]);
  assert.deepEqual(result.degraded, []);
});

test('a missing requirement is named in full, and an unobserved state is UNKNOWN', () => {
  const result = eligibleCandidates(
    [{ id: 'plain', capabilities: ['compute'] }],
    {},
    ['compute', 'gpu', 'browser'],
  );
  assert.deepEqual(result.selected, []);
  assert.deepEqual(result.excluded, [{ id: 'plain', reason: 'missing capability: gpu,browser' }]);
  assert.deepEqual(result.blocked, [], 'UNKNOWN is not a blocked state');
  assert.deepEqual(result.degraded, []);

  // UNKNOWN with every capability present is selected, and `blocked` stays empty
  const unknownReady = eligibleCandidates([{ id: 'plain', capabilities: ['compute'] }], {}, ['compute']);
  assert.deepEqual(unknownReady.selected, ['plain']);
  assert.deepEqual(unknownReady.degraded, [], 'UNKNOWN is not DEGRADED');
  assert.deepEqual(unknownReady.blocked, []);

  // an unobserved state is never treated as READY-equivalent for a refused state
  const unknownFailed = eligibleCandidates([{ id: 'plain', capabilities: ['compute'] }], { plain: 'FAILED' }, ['compute']);
  assert.deepEqual(unknownFailed.blocked, ['plain']);
});

test('candidate order is preserved and empty requirements admit state-eligible candidates', () => {
  const candidates = [
    { id: 'third', capabilities: [] },
    { id: 'first', capabilities: [] },
    { id: 'second', capabilities: [] },
  ];
  const result = eligibleCandidates(candidates, { third: 'DEGRADED', first: 'READY', second: 'DEGRADED' }, []);
  assert.deepEqual(result.selected, ['third', 'first', 'second']);
  assert.deepEqual(result.degraded, ['third', 'second']);
  assert.deepEqual(eligibleCandidates([], {}, ['compute']), { selected: [], excluded: [], degraded: [], blocked: [] });
});

test('self-inspection reports every capability in the donor order from observed facts only', () => {
  const verdicts = capabilityVerdicts(probe());
  assert.deepEqual(verdicts.map((verdict) => verdict.id), [...CAPABILITY_IDS]);
  assert.deepEqual(verdicts.map((verdict) => verdict.status), new Array(8).fill('READY'));
  const byId = verdictMap(verdicts);
  assert.equal(byId.compute.detail, '8 cores');
  assert.equal(byId.memory.detail, '32768 MB');
  assert.equal(byId.runtime.detail, 'node=24.0.0');
  assert.equal(byId.gpu.detail, 'observed-gpu');
  assert.equal(byId['web-ai'].detail, 'provider-observed');
  assert.equal(byId.browser.detail, 'browser=chromium');
  assert.equal(byId.network.detail, 'direct=1 proxy=false');
  assert.equal(probeNodeStateFor(probe(), verdicts).state, 'READY');
});

test('an unobserved web-AI provider and an absent GPU are never READY', () => {
  const bare = probe({
    gpu: [],
    runtimes: { node: '24.0.0' },
    webLoggedInProviders: [],
    nativeToolsAvailable: false,
    network: { directReachableProviders: [], proxyCapable: false },
  });
  const byId = verdictMap(capabilityVerdicts(bare));
  assert.equal(byId['web-ai'].status, 'DEGRADED', 'no logged-in web provider observed is DEGRADED, never READY');
  assert.equal(byId['web-ai'].detail, 'no logged-in web AI observed');
  assert.equal(byId.gpu.status, 'UNKNOWN', 'an absent GPU is UNKNOWN');
  assert.equal(byId.browser.status, 'UNKNOWN', 'an absent browser is UNKNOWN');
  assert.equal(byId.runtime.status, 'READY');
  assert.equal(byId['native-tools'].status, 'DEGRADED');
  assert.equal(byId.network.status, 'DEGRADED');

  // UNKNOWN extras do not block the node; the DEGRADED verdicts do name themselves
  const state = probeNodeStateFor(bare, capabilityVerdicts(bare));
  assert.deepEqual(state, { state: 'DEGRADED', reason: 'degraded: web-ai, native-tools, network' });
  assert.equal(state.reason.includes('gpu'), false, 'an UNKNOWN extra is not part of the degraded reason');
  assert.equal(state.reason.includes('browser'), false);
});

test('compute FAILED fails the node, memory DEGRADED degrades it, READY needs neither', () => {
  const noCompute = probe({ cpu: { cores: 0 }, memory: { totalMb: 0 } });
  const noComputeVerdicts = capabilityVerdicts(noCompute);
  assert.equal(verdictMap(noComputeVerdicts).compute.status, 'FAILED');
  assert.equal(verdictMap(noComputeVerdicts).memory.status, 'FAILED');
  assert.deepEqual(probeNodeStateFor(noCompute, noComputeVerdicts), {
    state: 'FAILED',
    reason: 'no compute/memory observed',
  });

  const noFreeMemory = probe({ memory: { totalMb: 32768 } });
  const noFreeVerdicts = capabilityVerdicts(noFreeMemory);
  assert.equal(verdictMap(noFreeVerdicts).memory.status, 'DEGRADED');
  assert.deepEqual(probeNodeStateFor(noFreeMemory, noFreeVerdicts), {
    state: 'DEGRADED',
    reason: 'degraded: memory',
  });

  const complete = probe();
  assert.deepEqual(probeNodeStateFor(complete, capabilityVerdicts(complete)), {
    state: 'READY',
    reason: PROBE_NODE_READY_REASON,
  });
  assert.equal(PROBE_NODE_READY_REASON, 'node self-inspection complete');

  // the two donor functions named nodeStateFor stay distinct
  const readyProbe = probe();
  assert.equal(probeNodeStateFor(readyProbe, capabilityVerdicts(readyProbe)).state, 'READY');
  assert.equal(fleetNodeStateFor(1_700_000_000_000, { lastHeartbeatAt: 1_700_000_000_000 - 30_000 }), 'OFFLINE');
});

test('inspectNode derives the verdicts and the node state once, from one record', () => {
  const bare = probe({ webLoggedInProviders: [], gpu: [], runtimes: { node: '24.0.0' } });
  const inspection = inspectNode(bare);
  assert.deepEqual(inspection.verdicts, capabilityVerdicts(bare));
  assert.deepEqual(inspection.nodeState, probeNodeStateFor(bare, inspection.verdicts));
  assert.equal(inspection.nodeState.state, 'DEGRADED');

  // a verdict set without compute cannot silently produce a node state
  assert.throws(() => probeNodeStateFor(bare, []), TypeError);
});

test('the self-inspection value shapes validate observed records', () => {
  const validated = nodeProbeData(probe());
  assert.equal(validated.nodeId, 'node-1');
  assert.equal(validated.memory.freeMb, 16384);
  assert.deepEqual(validated.gpu, [{ name: 'observed-gpu', vramMb: 8192 }]);
  assert.deepEqual(validated.runtimes, { node: '24.0.0', python: '3.12.0', browser: 'chromium', shell: 'bash' });
  assert.throws(() => nodeProbeData(probe({ sampledAt: '' })), TypeError);
  assert.throws(() => nodeProbeData(probe({ cpu: { cores: '8' } })), TypeError);
  assert.throws(() => nodeProbeData(probe({ webLoggedInProviders: ['a', 'a'] })), TypeError);

  assert.deepEqual(routerCandidate({ id: 'a', capabilities: ['compute'] }), { id: 'a', capabilities: ['compute'] });
  assert.throws(() => routerCandidate({ id: '', capabilities: [] }), TypeError);
  assert.throws(() => routerCandidate({ id: 'a', capabilities: 'compute' }), TypeError);

  const result = eligibleCandidates([{ id: 'a', capabilities: [] }], { a: 'READY' }, []);
  assert.deepEqual(routedResult(result), result);
  assert.throws(() => routedResult({ selected: ['a'], excluded: [{ id: 'b' }] }), TypeError);
  assert.deepEqual(probeNodeStateRecord({ state: 'READY', reason: PROBE_NODE_READY_REASON }), {
    state: 'READY',
    reason: PROBE_NODE_READY_REASON,
  });
  assert.throws(() => probeNodeStateRecord({ state: 'ONLINE', reason: 'x' }), TypeError);
});
