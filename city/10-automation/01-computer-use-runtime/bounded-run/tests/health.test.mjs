/**
 * UTOPIA · 10-automation / Computer Use Runtime — health suite.
 *
 * Restates the DS-Hns donor `app/computer-use/health.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: the three-value status vocabulary,
 * every `BLOCK_REASONS` member and the condition that derives it, the
 * capability → controller table, the usability rule and the capability verdict.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HEALTH_STATUS,
  BLOCK_REASONS,
  CAPABILITY_CONTROLLERS,
  buildHealthSnapshot,
  capabilityVerdict,
  capabilityIsUsable,
  controllerIdsFor,
} from '../health.mjs';

test('the status vocabulary is the donor three', () => {
  assert.deepEqual(HEALTH_STATUS, { HEALTHY: 'healthy', DEGRADED: 'degraded', BLOCKED: 'blocked' });
  assert.equal(Object.keys(HEALTH_STATUS).length, 3);
});

test('the block reasons are the donor five, with the donor strings', () => {
  assert.deepEqual(BLOCK_REASONS, {
    WORKSPACE_UNAVAILABLE: 'workspace_unavailable',
    ALL_CAPABILITIES_UNAVAILABLE: 'all_required_capabilities_unavailable',
    SAFETY_UNAVAILABLE: 'safety_authorization_unavailable',
    RESOURCE_CEILING: 'resource_ceiling_exceeded',
    STATE_INTEGRITY_UNCERTAIN: 'state_integrity_uncertain',
  });
  assert.equal(Object.keys(BLOCK_REASONS).length, 5);
  assert.equal(new Set(Object.values(BLOCK_REASONS)).size, 5);
});

test('the capability → controller table is the donor ten, and it is not the routing table', () => {
  assert.deepEqual(CAPABILITY_CONTROLLERS, {
    browser: ['browser'],
    dom: ['browser'],
    desktop: ['desktop'],
    accessibility: ['desktop'],
    vision: ['vision'],
    screenshot: ['vision'],
    shell: ['shell'],
    process: ['shell'],
    filesystem: ['file'],
    file: ['file'],
  });
  assert.equal(Object.keys(CAPABILITY_CONTROLLERS).length, 10);
});

test('controllerIdsFor maps a capability to its controllers and passes an unknown name through', () => {
  assert.deepEqual(controllerIdsFor('filesystem'), ['file']);
  assert.deepEqual(controllerIdsFor('file'), ['file']);
  assert.deepEqual(controllerIdsFor('browser'), ['browser']);
  assert.deepEqual(controllerIdsFor('dom'), ['browser']);
  assert.deepEqual(controllerIdsFor('accessibility'), ['desktop']);
  assert.deepEqual(controllerIdsFor('vision'), ['vision']);
  assert.deepEqual(controllerIdsFor('screenshot'), ['vision']);
  assert.deepEqual(controllerIdsFor('process'), ['shell']);
  // The donor defect, preserved: an unknown capability is its own controller id
  // rather than an error.
  assert.deepEqual(controllerIdsFor('telepathy'), ['telepathy']);
  assert.deepEqual(controllerIdsFor(''), ['']);
  assert.deepEqual(controllerIdsFor(null), ['']);
});

test('capabilityIsUsable accepts a capability or a controller id and needs a real hit', () => {
  const capabilities = {
    browser: { available: true, degraded: false, reason: null },
    file: { available: false, degraded: true, reason: 'the workspace is gone' },
  };
  assert.equal(capabilityIsUsable(capabilities, 'browser'), true);
  assert.equal(capabilityIsUsable(capabilities, 'dom'), true);
  assert.equal(capabilityIsUsable(capabilities, 'filesystem'), false);
  assert.equal(capabilityIsUsable(capabilities, 'file'), false);
  // Nothing claims this capability at all.
  assert.equal(capabilityIsUsable(capabilities, 'shell'), false);
  assert.equal(capabilityIsUsable(capabilities, 'vision'), false);
  assert.equal(capabilityIsUsable({}, 'browser'), false);
});

test('a healthy snapshot is healthy, and it echoes the donor fields', () => {
  const snapshot = buildHealthSnapshot({
    now: 1000,
    controllers: {
      browser: { available: true, reason: null },
      desktop: {},
    },
    workspace: { ok: true, cwd: 'D:\\A-Utopia' },
    progress: { lastProgressAt: 900, sinceProgressMs: 100, lastVerifiedEffectAt: 950, noOpStreak: 2 },
    stallLevel: 1,
    step: { id: 'step-3', index: 2 },
    allowedCapabilities: ['browser', 'desktop'],
  });

  assert.deepEqual(snapshot, {
    at: 1000,
    status: 'healthy',
    capabilities: {
      browser: { status: 'healthy', available: true, degraded: false, reason: null },
      desktop: { status: 'healthy', available: true, degraded: false, reason: null },
    },
    usableCapabilities: ['browser', 'desktop'],
    degradedCapabilities: [],
    unavailableCapabilities: [],
    blockedReasons: [],
    workspace: { ok: true, cwd: 'D:\\A-Utopia', reason: null },
    activeOwnedProcesses: 0,
    resourcePressure: null,
    lastProgressAt: 900,
    sinceProgressMs: 100,
    lastVerifiedEffectAt: 950,
    noOpStreak: 2,
    stallLevel: 1,
    currentStep: { id: 'step-3', index: 2 },
  });
});

test('the default snapshot is healthy but empty, with the donor defaults', () => {
  const snapshot = buildHealthSnapshot({ now: 7 });
  assert.equal(snapshot.status, 'healthy');
  assert.deepEqual(snapshot.capabilities, {});
  assert.deepEqual(snapshot.usableCapabilities, []);
  assert.deepEqual(snapshot.blockedReasons, []);
  assert.equal(snapshot.workspace, null);
  assert.equal(snapshot.resourcePressure, null);
  assert.equal(snapshot.activeOwnedProcesses, 0);
  assert.equal(snapshot.noOpStreak, 0);
  assert.equal(snapshot.stallLevel, 0);
  assert.equal(snapshot.currentStep, null);
  assert.equal(snapshot.lastProgressAt, null);
});

test('an explicitly degraded probe is degraded while staying available', () => {
  const snapshot = buildHealthSnapshot({
    now: 0,
    controllers: { vision: { available: true, detail: { degraded: true }, reason: 'slow capture' } },
  });
  assert.equal(snapshot.status, 'degraded');
  assert.deepEqual(snapshot.capabilities.vision, { status: 'degraded', available: true, degraded: true, reason: 'slow capture' });
  assert.deepEqual(snapshot.degradedCapabilities, ['vision']);
  assert.deepEqual(snapshot.usableCapabilities, ['vision']);
  assert.deepEqual(snapshot.unavailableCapabilities, []);
});

test('an unavailable controller is degraded, unusable and takes the runtime to degraded', () => {
  const snapshot = buildHealthSnapshot({
    now: 0,
    controllers: {
      browser: { available: false, reason: 'the browser is closed' },
      desktop: { available: true },
    },
  });
  // The donor writes the literal 'unavailable' here, not a HEALTH_STATUS member.
  assert.deepEqual(snapshot.capabilities.browser, { status: 'unavailable', available: false, degraded: true, reason: 'the browser is closed' });
  assert.equal(snapshot.status, 'degraded');
  assert.deepEqual(snapshot.unavailableCapabilities, ['browser']);
  assert.deepEqual(snapshot.degradedCapabilities, ['browser']);
  assert.deepEqual(snapshot.usableCapabilities, ['desktop']);
  assert.deepEqual(snapshot.blockedReasons, []);
});

test('a null controller entry is unavailable, and `available` is only false when it is literally false', () => {
  const snapshot = buildHealthSnapshot({ now: 0, controllers: { shell: null, file: { available: 0 } } });
  assert.equal(snapshot.capabilities.shell.available, false);
  assert.equal(snapshot.capabilities.shell.reason, null);
  // `available: 0` is not `false`, so the donor treats the controller as available.
  assert.equal(snapshot.capabilities.file.available, true);
  assert.equal(snapshot.status, 'degraded');
});

test('a dead channel the contract does not need still degrades the runtime', () => {
  const snapshot = buildHealthSnapshot({
    now: 0,
    controllers: { browser: { available: true }, vision: { available: false } },
    allowedCapabilities: ['browser'],
  });
  assert.equal(snapshot.status, 'degraded');
  assert.deepEqual(snapshot.blockedReasons, []);
});

test('BLOCK_REASONS.WORKSPACE_UNAVAILABLE is derived from the workspace guard', () => {
  const blocked = buildHealthSnapshot({ now: 0, workspace: { ok: false, reason: 'the cwd drifted' } });
  assert.deepEqual(blocked.blockedReasons, [{ code: BLOCK_REASONS.WORKSPACE_UNAVAILABLE, reason: 'the cwd drifted' }]);
  assert.equal(blocked.status, 'blocked');
  assert.deepEqual(blocked.workspace, { ok: false, cwd: null, reason: 'the cwd drifted' });

  const bare = buildHealthSnapshot({ now: 0, workspace: { ok: false } });
  assert.deepEqual(bare.blockedReasons, [{ code: BLOCK_REASONS.WORKSPACE_UNAVAILABLE, reason: 'no verified workspace' }]);

  // `ok` missing is not `false`: the donor treats the workspace as fine.
  const fine = buildHealthSnapshot({ now: 0, workspace: { cwd: 'D:\\A-Utopia' } });
  assert.deepEqual(fine.blockedReasons, []);
  assert.deepEqual(fine.workspace, { ok: true, cwd: 'D:\\A-Utopia', reason: null });
});

test('BLOCK_REASONS.ALL_CAPABILITIES_UNAVAILABLE is derived only when every allowed capability is gone', () => {
  const blocked = buildHealthSnapshot({
    now: 0,
    controllers: { browser: { available: false, reason: 'closed' }, desktop: { available: false, reason: 'gone' } },
    allowedCapabilities: ['browser', 'desktop'],
  });
  assert.deepEqual(blocked.blockedReasons, [{
    code: BLOCK_REASONS.ALL_CAPABILITIES_UNAVAILABLE,
    reason: 'none of the allowed capabilities are usable (browser, desktop)',
  }]);
  assert.equal(blocked.status, 'blocked');

  const oneLeft = buildHealthSnapshot({
    now: 0,
    controllers: { browser: { available: false }, desktop: { available: true } },
    allowedCapabilities: ['desktop'],
  });
  assert.deepEqual(oneLeft.blockedReasons, []);
  assert.equal(oneLeft.status, 'degraded');
  // A controller the contract does not allow is not "required": its absence does
  // not block, but the allowed capability that is missing still does.
  const unrequired = buildHealthSnapshot({
    now: 0,
    controllers: { vision: { available: false } },
    allowedCapabilities: ['browser'],
  });
  assert.deepEqual(unrequired.blockedReasons, [{
    code: BLOCK_REASONS.ALL_CAPABILITIES_UNAVAILABLE,
    reason: 'none of the allowed capabilities are usable (browser)',
  }]);
  assert.equal(unrequired.status, 'blocked');

  const visionNotRequired = buildHealthSnapshot({
    now: 0,
    controllers: { browser: { available: true }, vision: { available: false } },
    allowedCapabilities: ['browser'],
  });
  assert.deepEqual(visionNotRequired.blockedReasons, []);
  assert.equal(visionNotRequired.status, 'degraded');

  const emptyAllowList = buildHealthSnapshot({ now: 0, controllers: {}, allowedCapabilities: [] });
  assert.deepEqual(emptyAllowList.blockedReasons, []);
  assert.equal(emptyAllowList.status, 'healthy');
});

test('BLOCK_REASONS.RESOURCE_CEILING is derived from the evidence snapshot and the process capacity', () => {
  const evidence = buildHealthSnapshot({
    now: 0,
    resources: {
      atCeiling: true,
      screenshots: 32,
      retainedScreenshots: 4,
      droppedScreenshots: 6,
      evidenceBytes: 12345,
      limits: { maxScreenshots: 32, maxEvidenceBytes: 8388608 },
    },
  });
  assert.deepEqual(evidence.blockedReasons, [{
    code: BLOCK_REASONS.RESOURCE_CEILING,
    reason: 'the runtime is at its evidence ceiling: 32 captures held, 6 already dropped, 12345 bytes retained',
  }]);
  assert.equal(evidence.status, 'blocked');
  assert.deepEqual(evidence.resourcePressure, {
    screenshots: 32,
    retainedScreenshots: 4,
    droppedScreenshots: 6,
    evidenceBytes: 12345,
    ceilings: { maxScreenshots: 32, maxEvidenceBytes: 8388608 },
  });

  const processes = buildHealthSnapshot({ now: 0, processes: { atCapacity: true, ownedCount: 5, ceiling: 5 } });
  assert.deepEqual(processes.blockedReasons, [{
    code: BLOCK_REASONS.RESOURCE_CEILING,
    reason: 'the runtime already owns 5 processes (ceiling 5)',
  }]);
  assert.equal(processes.activeOwnedProcesses, 5);

  // Not at the ceiling is not a block, and both ceilings at once produce the
  // reason twice — the donor pushes one entry per condition.
  const both = buildHealthSnapshot({
    now: 0,
    resources: { atCeiling: true, screenshots: 1, droppedScreenshots: 1, evidenceBytes: 0 },
    processes: { atCapacity: true, ownedCount: 1, ceiling: 1 },
  });
  assert.equal(both.blockedReasons.length, 2);
  assert.deepEqual(both.blockedReasons.map((entry) => entry.code), [BLOCK_REASONS.RESOURCE_CEILING, BLOCK_REASONS.RESOURCE_CEILING]);

  const under = buildHealthSnapshot({ now: 0, resources: { atCeiling: false, screenshots: 1 }, processes: { atCapacity: false } });
  assert.deepEqual(under.blockedReasons, []);
  // The donor reads `processes.ownedCount` whenever a process block is supplied,
  // so `undefined` survives into the snapshot rather than becoming 0.
  assert.equal(under.activeOwnedProcesses, undefined);
  assert.equal(buildHealthSnapshot({ now: 0, processes: { ownedCount: 3, atCapacity: false } }).activeOwnedProcesses, 3);
});

test('BLOCK_REASONS.SAFETY_UNAVAILABLE and STATE_INTEGRITY_UNCERTAIN are derived from their flags', () => {
  const safety = buildHealthSnapshot({ now: 0, safetyAvailable: false });
  assert.deepEqual(safety.blockedReasons, [{ code: BLOCK_REASONS.SAFETY_UNAVAILABLE, reason: 'no confirmation channel is available for a destructive action' }]);
  assert.equal(safety.status, 'blocked');

  const integrity = buildHealthSnapshot({ now: 0, stateIntegrity: false });
  assert.deepEqual(integrity.blockedReasons, [{ code: BLOCK_REASONS.STATE_INTEGRITY_UNCERTAIN, reason: 'the runtime cannot vouch for its own state' }]);
  assert.equal(integrity.status, 'blocked');

  // `true` and absence are both "no block": only the literal false blocks.
  assert.deepEqual(buildHealthSnapshot({ now: 0, safetyAvailable: true, stateIntegrity: true }).blockedReasons, []);
  assert.deepEqual(buildHealthSnapshot({ now: 0 }).blockedReasons, []);
});

test('every block reason can appear at once, in the donor order, and blocked outranks degraded', () => {
  const snapshot = buildHealthSnapshot({
    now: 0,
    controllers: { browser: { available: false } },
    allowedCapabilities: ['browser'],
    workspace: { ok: false, reason: 'no workspace' },
    resources: { atCeiling: true, screenshots: 0, droppedScreenshots: 0, evidenceBytes: 0 },
    safetyAvailable: false,
    stateIntegrity: false,
  });
  assert.equal(snapshot.status, 'blocked');
  assert.deepEqual(snapshot.blockedReasons.map((entry) => entry.code), [
    BLOCK_REASONS.WORKSPACE_UNAVAILABLE,
    BLOCK_REASONS.ALL_CAPABILITIES_UNAVAILABLE,
    BLOCK_REASONS.RESOURCE_CEILING,
    BLOCK_REASONS.SAFETY_UNAVAILABLE,
    BLOCK_REASONS.STATE_INTEGRITY_UNCERTAIN,
  ]);
});

test('status is blocked, then degraded, then healthy — in that order of precedence', () => {
  const degradedOnly = buildHealthSnapshot({ now: 0, controllers: { browser: { available: true, detail: { degraded: true } } } });
  assert.equal(degradedOnly.status, 'degraded');
  const blockedButHealthyControllers = buildHealthSnapshot({ now: 0, controllers: { browser: { available: true } }, safetyAvailable: false });
  assert.equal(blockedButHealthyControllers.status, 'blocked');
});

test('capabilityVerdict answers the four donor cases, including the unclaimed capability', () => {
  assert.deepEqual(capabilityVerdict(null, null), { ok: true, reason: 'the action declares no capability' });
  assert.deepEqual(capabilityVerdict({}, ''), { ok: true, reason: 'the action declares no capability' });

  assert.deepEqual(capabilityVerdict(null, 'browser'), { ok: false, reason: 'the runtime has no health snapshot' });
  assert.deepEqual(capabilityVerdict({}, 'browser'), { ok: false, reason: 'the runtime has no health snapshot' });
  assert.deepEqual(capabilityVerdict({ capabilities: null }, 'browser'), { ok: false, reason: 'the runtime has no health snapshot' });

  const unclaimed = capabilityVerdict({ capabilities: { browser: { available: true, degraded: false } } }, 'telepathy');
  assert.deepEqual(unclaimed, { ok: false, reason: 'no controller carries the "telepathy" capability' });

  const healthy = capabilityVerdict({ capabilities: { browser: { available: true, degraded: false, reason: null } } }, 'dom');
  assert.deepEqual(healthy, { ok: true, reason: 'dom is available', controllers: ['browser'] });

  const degraded = capabilityVerdict({ capabilities: { browser: { available: true, degraded: true } } }, 'browser');
  assert.deepEqual(degraded, { ok: true, reason: 'browser is degraded but usable', controllers: ['browser'] });

  const unavailable = capabilityVerdict(
    { capabilities: { file: { available: false, degraded: true, reason: 'the workspace is gone' } } },
    'filesystem',
  );
  assert.deepEqual(unavailable, {
    ok: false,
    reason: 'filesystem is unavailable (file: the workspace is gone)',
    controllers: ['file'],
  });

  const noReason = capabilityVerdict({ capabilities: { file: { available: false, degraded: true, reason: null } } }, 'file');
  assert.deepEqual(noReason, { ok: false, reason: 'file is unavailable (file: unavailable)', controllers: ['file'] });
});

test('capabilityVerdict judges the degraded flag on every controller the table names', () => {
  const capabilities = {
    desktop: { available: false, degraded: true, reason: 'gone' },
    accessibility: { available: true, degraded: false, reason: null },
  };
  // `desktop` names only the `desktop` controller, so a live `accessibility`
  // controller does not rescue it.
  assert.equal(capabilityIsUsable(capabilities, 'desktop'), false);
  assert.deepEqual(capabilityVerdict({ capabilities }, 'desktop'), {
    ok: false,
    reason: 'desktop is unavailable (desktop: gone)',
    controllers: ['desktop'],
  });
  // The runtime is degraded because one controller is gone, even though the
  // allowed capability is fine.
  const snapshot = buildHealthSnapshot({
    now: 0,
    controllers: { desktop: { available: false, reason: 'gone' }, accessibility: { available: true } },
    allowedCapabilities: ['accessibility'],
  });
  assert.equal(snapshot.status, 'degraded');
  assert.deepEqual(snapshot.blockedReasons, []);
});

test('a snapshot built by buildHealthSnapshot feeds capabilityVerdict unchanged', () => {
  const snapshot = buildHealthSnapshot({ now: 0, controllers: { desktop: { available: true, detail: { degraded: true } } } });
  assert.deepEqual(capabilityVerdict(snapshot, 'accessibility'), {
    ok: true,
    reason: 'accessibility is degraded but usable',
    controllers: ['desktop'],
  });
  assert.deepEqual(capabilityVerdict(snapshot, 'browser'), {
    ok: false,
    reason: 'no controller carries the "browser" capability',
  });
});
