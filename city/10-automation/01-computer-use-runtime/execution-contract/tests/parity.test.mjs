/**
 * UTOPIA · Automation District — module boundary, purity and consumption parity.
 *
 * Proves the three things a reader of `DONOR.json` cannot verify from the
 * numbers alone: that the six module files are pure ESM with no file, network,
 * clock, randomness or `require` access, that every JSDoc header names the donor
 * file and the frozen commit, and that the public barrel plus the contract →
 * criteria → typed-failure path actually compose end to end.
 *
 * Donor: DS-Hns `app/computer-use/{constants,errors,action,criteria,contract}.cjs`
 * @ eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as barrel from '../index.mjs';
import { createContract, assertCapability, describeContract, normalizePlan } from '../contract.mjs';
import { normalizeAction } from '../action.mjs';
import { createContract as createContractFromBarrel } from '../index.mjs';
import { evaluateCriteria } from '../criteria.mjs';
import { CODES, ComputerUseError } from '../errors.mjs';
import { resolveComputerUseOptions } from '../contracts.mjs';

const COMMIT = 'eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b';

const MODULES = [
  { file: 'contracts.mjs', donorFiles: ['constants.cjs'] },
  { file: 'errors.mjs', donorFiles: ['errors.cjs'] },
  { file: 'action.mjs', donorFiles: ['action.cjs', 'target.cjs'] },
  { file: 'criteria.mjs', donorFiles: ['criteria.cjs'] },
  { file: 'contract.mjs', donorFiles: ['contract.cjs'] },
  { file: 'index.mjs', donorFiles: ['constants.cjs', 'errors.cjs', 'action.cjs', 'criteria.cjs', 'contract.cjs'] }
];

async function sourceOf(file) {
  return readFile(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');
}

function capture(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw');
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

test('every module is pure ESM: no fs, network, clock, randomness, env, cwd or require', async () => {
  const forbidden = [
    ['require', /\brequire\s*\(/],
    ['node:fs', /['"]node:fs/],
    ['node:path', /['"]node:path/],
    ['node:http', /['"]node:(http|https|net|dgram|tls)['"]/],
    ['node:crypto', /['"]node:crypto['"]/],
    ['node:child_process', /['"]node:child_process['"]/],
    ['import fs', /\bfrom\s+['"]fs['"]/],
    ['__dirname', /__dirname/],
    ['import.meta.url', /import\.meta\.url/],
    ['process.cwd', /process\.cwd/],
    ['process.env', /process\.env/],
    ['Math.random', /Math\.random/],
    ['Date.now', /Date\.now/],
    ['new Date', /new\s+Date\b/],
    ['setTimeout', /setTimeout\s*\(/],
    ['setInterval', /setInterval\s*\(/],
    ['fetch', /\bfetch\s*\(/]
  ];
  for (const { file } of MODULES) {
    const code = stripComments(await sourceOf(file));
    for (const [label, pattern] of forbidden) {
      assert.equal(pattern.test(code), false, `${file} must not use ${label}`);
    }
  }
});

test('every JSDoc header names its donor file and the frozen commit', async () => {
  for (const { file, donorFiles } of MODULES) {
    const source = await sourceOf(file);
    const header = /^\/\*\*([\s\S]*?)\*\//.exec(source);
    assert.ok(header, `${file} must open with a JSDoc header`);
    assert.ok(header[1].includes(COMMIT), `${file} header must name the frozen commit`);
    for (const donorFile of donorFiles) {
      assert.ok(header[1].includes(donorFile), `${file} header must name the donor file ${donorFile}`);
    }
  }
});

test('the barrel exposes exactly the donor-derived public surface', () => {
  const expected = [
    'ACTION_TYPES', 'ACTION_TYPE_LIST', 'ACTION_CAPABILITY', 'CAPABILITY_CONTROLLER', 'ROUTE_CHANNELS',
    'CU_STATES', 'CU_TRANSITIONS', 'TERMINAL_STATES', 'VERIFICATION_KINDS', 'VERDICTS', 'SCREENSHOT_LEVELS',
    'CAPABILITIES', 'DESTRUCTIVE_KINDS', 'DESTRUCTIVE_MODES', 'SCREENSHOT_RETENTION', 'STEP_RESULTS', 'RUN_STATUS',
    'TARGET_MOVEMENT', 'TIMING', 'STALL', 'RETRY', 'CONTRACT_DEFAULTS', 'resolveComputerUseOptions',
    'CODES', 'ComputerUseError', 'fail', 'redactDetails', 'defaultRetryable',
    'VALID_ACTION_TYPES', 'EXPECTED_EFFECT_KEYS', 'PARAM_RULES', 'normalizeAction', 'validateAction',
    'normalizeExpectedEffect', 'normalizeStabilization', 'normalizePrecondition', 'normalizeRetry',
    'normalizeDestructive', 'requiresTarget', 'describeAction', 'destructiveKinds', 'TARGET_KINDS',
    'normalizeTarget', 'describeTarget',
    'CRITERION_KINDS', 'normalizeCriterion', 'normalizeCriteria', 'evaluateCriterion', 'evaluateCriteria', 'describe',
    'createContract', 'normalizePlan', 'hasCapability', 'assertCapability', 'declaredDestructiveKinds',
    'describeContract'
  ];
  assert.deepEqual([...Object.keys(barrel)].sort(), [...expected].sort());
  assert.equal(expected.length, 56);
  assert.equal(barrel.createContract, createContractFromBarrel);
});

test('the DONOR.json record matches the manifest assignment exactly', async () => {
  const record = JSON.parse(await sourceOf('DONOR.json'));
  assert.equal(record.module, 'execution-contract');
  assert.equal(record.cityPath, 'city/10-automation/01-computer-use-runtime/execution-contract');
  assert.equal(record.district, '10-automation');
  assert.equal(record.building, '01-computer-use-runtime');
  assert.deepEqual(record.incubationRooms, ['mb-008-execution-contract-lab']);
  assert.deepEqual(record.mission, {
    missionId: 'MB-008',
    book: 'Digital-City/mission-book/MB-008-computer-use.md',
    role: 'MIGRATION',
    cluster: 'the Hns computer-use goal/success/capability/destructive-mode/limit/plan execution contract and its typed failure codes'
  });
  assert.equal(record.repository, 'zhiheng-zhang-Mera/DS-Hns');
  assert.equal(record.commit, COMMIT);
  assert.deepEqual(record.sourcePaths, [
    'app/computer-use/constants.cjs',
    'app/computer-use/errors.cjs',
    'app/computer-use/action.cjs',
    'app/computer-use/criteria.cjs',
    'app/computer-use/contract.cjs'
  ]);
  assert.deepEqual(Object.keys(record.portedFiles), [...record.sourcePaths]);
  assert.deepEqual(record.classification.UTOPIA_EXTENSION, []);
  assert.ok(record.adaptation.some((entry) => entry.includes('config/app.json') && entry.includes('PARAMETER')));
  assert.ok(record.adaptation.some((entry) => entry.includes('ROOT') && entry.includes('readComputerUseConfig')));
  assert.ok(record.knownDifferences.some((entry) => entry.includes('target.cjs')));
  assert.ok(record.parity.vectors.length >= 30);

  // Every ported target file really exists next to this test and is an ESM module.
  for (const target of Object.values(record.portedFiles)) {
    const source = await sourceOf(target);
    assert.match(source, /\bexport\b/, `${target} must be an ESM module`);
  }
});

test('a contract built through the barrel composes with criteria evaluation and typed failures', async () => {
  const contract = createContract(
    {
      id: 'run-1',
      goal: 'publish the release notes',
      allowed_capabilities: ['filesystem', 'shell'],
      safety: { destructive_actions: 'forbidden', forbidden_targets: ['#danger'] },
      limits: { max_steps: 10 },
      success_criteria: [
        { type: 'file_exists', path: 'release.md' },
        { type: 'stdout_matches', pattern: 'published' }
      ]
    },
    {},
    { limits: { maxSteps: 3 }, vision: { retention: 'audit' } }
  );
  assert.equal(contract.limits.maxSteps, 10);
  assert.equal(contract.vision.retention, 'audit');
  assert.equal(contract.safety.destructiveActions, 'forbidden');
  assert.equal(assertCapability(contract, 'filesystem'), true);
  const denied = capture(() => assertCapability(contract, 'desktop'));
  assert.equal(denied.code, CODES.CAPABILITY_NOT_ALLOWED);
  assert.equal(denied.message, 'capability "desktop" is not allowed by this contract');
  assert.deepEqual(denied.details, { capability: 'desktop', allowed: ['filesystem', 'shell'] });

  const facts = {
    fileExists: async (path) => path === 'release.md',
    lastShell: { exited: true, exitCode: 0, stdout: 'published to the feed' }
  };
  const evaluation = await evaluateCriteria(contract.successCriteria, facts);
  assert.equal(evaluation.satisfied, true);
  assert.equal(evaluation.unknown, false);
  assert.deepEqual(evaluation.results.map((result) => result.verdict), ['satisfied', 'satisfied']);

  const blocked = await evaluateCriteria(contract.successCriteria, { fileExists: facts.fileExists });
  assert.equal(blocked.satisfied, false);
  assert.equal(blocked.unknown, true);

  // A contract that names an action the schema cannot validate fails at plan time,
  // and the failure is a typed, log-safe error.
  const planFailure = capture(() => normalizePlan([{ action: 'DOM_CLICK' }]));
  assert.equal(planFailure.code, CODES.PLAN_INVALID);
  assert.equal(planFailure.message, 'plan step 0 is not a valid action: DOM_CLICK requires "target"');
  assert.deepEqual(planFailure.details, { step: '0', cause: CODES.ACTION_INVALID });
  const actionFailure = capture(() => normalizeAction({ type: 'DOM_CLICK' }));
  assert.ok(actionFailure instanceof ComputerUseError);
  assert.equal(actionFailure.code, CODES.ACTION_INVALID);
  assert.equal(actionFailure.message, 'DOM_CLICK requires "target"');

  assert.deepEqual(describeContract(contract), {
    id: 'run-1',
    goal: 'publish the release notes',
    capabilities: ['filesystem', 'shell'],
    destructiveActions: 'forbidden',
    steps: 0,
    criteria: ['file exists: release.md', 'stdout matches published'],
    limits: { maxSteps: 10, maxRetriesPerAction: 2, maxStallRecoveries: 2, stepTimeoutMs: 30000, runTimeoutMs: 1800000 },
    autonomyEnabled: false
  });
});

test('the options resolver is reachable from the barrel and honours an explicit block', () => {
  const options = barrel.resolveComputerUseOptions({}, { limits: { maxSteps: 11 }, allowedCapabilities: ['shell'] });
  assert.equal(options.maxSteps, 11);
  assert.deepEqual(options.allowedCapabilities, ['shell']);
  assert.deepEqual(resolveComputerUseOptions(), barrel.resolveComputerUseOptions());
});
