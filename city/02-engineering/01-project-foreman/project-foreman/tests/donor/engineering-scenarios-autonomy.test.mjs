'use strict'

/**
 * Donor suite: the autonomy half of DS-Hns `tests/unit/engineering-scenarios.test.js`
 * @ `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b`.
 *
 * The donor file mixes autonomy unit tests with four scenarios that drive the
 * engineering *supervisor* against a scratch repository (they import
 * `app/engineering/supervisor.cjs`, `failure.cjs` and two test helpers). Only the
 * two harness-free autonomy tests are copied here; the four supervisor scenarios
 * are named in the migration report as excluded. Every test body, title and
 * assertion below is byte-identical to the donor's; the only rewrite is the module
 * specifier, which points at the ported `autonomy.mjs` instead of
 * `../../app/engineering/autonomy.cjs`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * Phase 9 — autonomy authority.
 *
 * The bug this covers: an autonomy controller created once at runtime construction
 * and never re-read can leave a contract's explicit `autonomy_enabled: true`
 * silently ignored. The effective value is resolved per run from three sources,
 * and the last one *stated* wins.
 */
test('autonomy authority: runtime default < contract override < explicit run option', () => {
  const { resolveAutonomy } = require('../../autonomy.mjs')
  const cases = [
    { runtime: {}, contract: {}, runOptions: {}, expected: false, source: 'runtime' },
    { runtime: { autonomyEnabled: true }, contract: {}, runOptions: {}, expected: true, source: 'runtime' },
    { runtime: { autonomyEnabled: false }, contract: { autonomyEnabled: true }, runOptions: {}, expected: true, source: 'contract' },
    { runtime: { autonomyEnabled: true }, contract: { autonomyEnabled: false }, runOptions: {}, expected: false, source: 'contract' },
    { runtime: { autonomyEnabled: false }, contract: { autonomyEnabled: true }, runOptions: { autonomous: false }, expected: false, source: 'run-option' },
    { runtime: { autonomyEnabled: true }, contract: { autonomyEnabled: false }, runOptions: { autonomous: true }, expected: true, source: 'run-option' },
    // The snake_case spelling the execution contract uses.
    { runtime: {}, contract: { autonomy_enabled: true }, runOptions: {}, expected: true, source: 'contract' }
  ]
  for (const entry of cases) {
    const resolved = resolveAutonomy(entry)
    assert.equal(resolved.enabled, entry.expected, JSON.stringify(entry))
    assert.equal(resolved.source, entry.source, JSON.stringify(entry))
  }
})

test('autonomy continues only with new evidence, and never past its own bounds', () => {
  const { createEngineeringAutonomy } = require('../../autonomy.mjs')
  const controller = createEngineeringAutonomy({ enabled: true, limits: { maxContinuationRounds: 2, maxTotalSteps: 100 } })
  const failing = (overrides = {}) => ({
    result: 'FAILED',
    mutations: { applied: 1 },
    filesChanged: ['src/a.cjs'],
    verification: { levels: { 'full-verify': { ok: false } } },
    ...overrides
  })
  // A round that changed something may continue...
  assert.equal(controller.decide(failing(), { round: 0, totalSteps: 3 }).continue, true)
  // ...but only up to the continuation budget.
  assert.equal(controller.decide(failing(), { round: 1, totalSteps: 6 }).continue, true)
  assert.equal(controller.decide(failing(), { round: 2, totalSteps: 9 }).continue, false)
  // A round that changed nothing is a blind repetition, however much budget is left.
  const nothing = controller.decide(failing({ mutations: { applied: 0 }, filesChanged: [] }), { round: 0, totalSteps: 0 })
  assert.equal(nothing.continue, false)
  assert.match(nothing.reason, /no new evidence/)
  // Completion, cancellation and a block are all terminal for autonomy.
  for (const result of ['COMPLETED', 'CANCELLED', 'BLOCKED']) {
    assert.equal(controller.decide(failing({ result }), { round: 0, totalSteps: 0 }).continue, false, `${result} must stop continuation`)
  }
  // Disabled means disabled, whatever the evidence says.
  const off = createEngineeringAutonomy({ enabled: false })
  assert.equal(off.decide(failing(), { round: 0, totalSteps: 0 }).continue, false)
})
