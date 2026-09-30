'use strict';

/**
 * Donor covering suite, extracted verbatim from DS-Hns
 * `tests/unit/engineering-verifier.test.js` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b.
 *
 * The donor file is the verifier suite, whose module is another agent's and outside this
 * migration's scope. Its last case is the donor's only coverage of
 * `app/engineering/process.cjs`: it builds a real process supervisor through
 * `createProcessSupervisor` and runs one real command through it. That single case was
 * lifted out unchanged — body, title, skip guard and every assertion are the donor's.
 *
 * The only edits are:
 *  * the import specifier, pointing at the ported `process.mjs`;
 *  * the `test`/`assert`/`fs`/`path`/`createRequire` imports and the `CHECKPOINT`
 *    constant the extracted body needs (the donor file declares them once at the top);
 *  * the skip guard, which now looks for the ported `checkpoint.mjs` instead of the
 *    donor's `app/engineering/checkpoint.cjs`;
 *  * the verifier import, which points at the ported `verifier.mjs` because that is what
 *    the case exercises the process supervisor through.
 *
 * The command it runs is `process.execPath -e "console.log(...)"`, with the repository
 * root as its cwd; it writes nothing, and the process is disposed in a `finally`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { createVerifier, VERIFICATION_LEVELS } from '../../verifier.mjs';

const require = createRequire(import.meta.url);

/** The checkpoint module's real truncation contract, as the donor file computes it. */
const CHECKPOINT = path.join(import.meta.dirname, '..', '..', 'checkpoint.mjs');
test('a real command runs end to end through the real supervisor registry', { skip: fs.existsSync(CHECKPOINT) ? false : 'checkpoint.mjs has not landed yet' }, async () => {
  const { createProcessSupervisor } = require('../../process.mjs')
  const supervisor = createProcessSupervisor({ now: () => Date.now() })
  const discovery = { commands: { test: { command: process.execPath, args: ['-e', "console.log('# tests 2'); console.log('# pass 2'); console.log('# fail 0')"], acceptsFocus: false, evidence: 'fixture' } } }
  const verifier = createVerifier({ supervisor, workspace: process.cwd(), discovery, required: [VERIFICATION_LEVELS.FOCUSED] })
  try {
    const result = await verifier.run(VERIFICATION_LEVELS.FOCUSED, { timeoutMs: 30_000 })
    assert.equal(result.exitCode, 0, `the real node process must exit zero (${result.reason})`)
    assert.equal(result.ok, true)
    assert.equal(result.testSummary && result.testSummary.tests, 2)
    assert.equal(result.testSummary.failed, 0)
    assert.equal(verifier.satisfied().ok, true, 'a real green run is fresh evidence')
  } finally {
    supervisor.dispose('test teardown')
  }
})
