// UXI-390: the ACTION WIRING must be bound at the call site, not merely declared.
//
// Mech's finding, and it named the class precisely: `supportedActions`, `CityClient.providerChoice` and the
// per-provider Choose control were all added with NO test binding. The suites verified the TABLES, and the
// tables can agree while the surface is not connected - which is the gap three earlier rounds closed one
// level up, reappearing here. The capability set could be declared while nothing bound it to a handler or to
// a client method.
//
// And the gap was already occupied: MainActivity carried a `"CHOOSE_PROVIDER" ->` branch that no supported
// action could reach. Harmless dead code, but a TRAP, because it looks like a handler - a future host adding
// one word to a one-element set would make the action-row button live again and it would still do nothing,
// which is the original honesty defect exactly. That branch is now deleted; this test is what stops it, and
// its cousins, coming back.
//
// The assertions parse the Kotlin as TEXT, the same technique the parity guard already uses, because the
// Android module cannot import the contract and no test can instantiate the composable.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const DIR = new URL('../apps/android/app/src/main/java/city/utopia/control/', import.meta.url);
const main = readFileSync(new URL('MainActivity.kt', DIR), 'utf8');
const client = readFileSync(new URL('CityClient.kt', DIR), 'utf8');
const panel = readFileSync(new URL('SchedulerPanel.kt', DIR), 'utf8');

/** Token -> the CityClient method that must exist for it to be performable at all. */
const CLIENT_METHOD = {
  CANCEL: 'fun cancel(',
  CHOOSE_PROVIDER: 'fun providerChoice(',
};

test('UXI-390: every supported action is bound to a handler branch AND a client method', () => {
  const declared = main.match(/supportedActions\s*=\s*setOf\(([^)]*)\)/);
  assert.ok(declared, 'MainActivity must declare supportedActions; the parse is part of the test');
  const supported = [...declared[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);

  // A set that parsed as empty, or as one element after a bad edit, must not let this pass vacuously -
  // the same minimum-count discipline the parity guard applies to the two tables.
  assert.ok(supported.length >= 1, `parsed ${supported.length} supported actions; an empty parse cannot pass`);
  assert.ok(supported.includes('CANCEL'), 'CANCEL is wired and must remain declared, or this test is vacuous');

  for (const token of supported) {
    assert.ok(
      new RegExp(`"${token}"\\s*->`).test(main),
      `${token} is declared supported but MainActivity.onAction has no branch for it`,
    );
    const method = CLIENT_METHOD[token];
    assert.ok(method, `${token} is supported but this test has no client-method mapping for it; add one`);
    assert.ok(
      client.includes(method),
      `${token} is supported but CityClient has no ${method} - this is the assertion that would have caught the original defect, because providerChoice did not exist then`,
    );
  }
});

test('UXI-390: no handler branch is unreachable dead code that looks like a handler', () => {
  const declared = main.match(/supportedActions\s*=\s*setOf\(([^)]*)\)/);
  const supported = [...declared[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  const branches = [...main.matchAll(/^\s*"([A-Z_]+)"\s*->/gm)].map((m) => m[1]);
  assert.ok(branches.length >= 1, `parsed ${branches.length} when branches; an empty parse cannot pass`);
  const dead = branches.filter((token) => !supported.includes(token));
  assert.deepEqual(
    dead,
    [],
    `handler branches nothing can reach (dead code that reads as a live handler): ${dead.join(', ')}`,
  );
});

test('UXI-390: the per-provider Choose control sends THAT row ref, and cannot send a blank one', () => {
  // The choice belongs on the row that NAMES the service - a task-level control sending "the first
  // available" ref would be the UI making the user's choice, which the workbook forbids.
  assert.match(panel, /choose\.invoke\(taskId, provider\.ref\)/, 'the Choose control must send the row ref');
  assert.match(panel, /provider\.ref\.isNotBlank\(\)/, 'a blank ref must suppress the control, not send it');
  assert.match(panel, /provider\.selectable &&/, 'only a selectable row may offer the choice');
  assert.match(client, /if \(providerRef\.isBlank\(\)\)/, 'CityClient must refuse a blank ref client-side');
  assert.match(panel, /arr\.optString\(i\)/, 'feed candidates are ref STRINGS, read with optString');
});

test('UXI-390: CHOOSE_PROVIDER is NOT an action-row action - that is the trap Mech named', () => {
  // The guards above would BOTH pass if someone re-added CHOOSE_PROVIDER to supportedActions: the branch
  // exists and providerChoice exists. But the action-row path passes chosenRef = null on purpose, so the
  // control would be live and do nothing - the original honesty defect exactly. The choice belongs on the
  // provider ROW, so this asserts the action-row token is absent rather than merely that it is bound.
  const declared = main.match(/supportedActions\s*=\s*setOf\(([^)]*)\)/);
  const supported = [...declared[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  assert.ok(
    !supported.includes('CHOOSE_PROVIDER'),
    'CHOOSE_PROVIDER must not be an action-row action: that path sends a null ref by design, so supporting it would make an enabled control that does nothing',
  );
  assert.match(panel, /chosenRef: String\? = null/, 'the action-row choice path must stay null by design');
});
