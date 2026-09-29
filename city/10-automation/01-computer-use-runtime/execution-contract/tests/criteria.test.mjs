/**
 * UTOPIA · Automation District — success criteria parity.
 *
 * Pins the donor `app/computer-use/criteria.cjs` @
 * eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b: the closed criterion vocabulary and
 * its order, the kind aliases, every description string, the whole evaluation
 * switch (with injected facts — no filesystem, no clock), the
 * unknown-never-true rule and the "no criteria ⇒ satisfied + skipped" rule.
 * Donor defects kept by the port are pinned explicitly.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CRITERION_KINDS,
  normalizeCriterion,
  normalizeCriteria,
  evaluateCriterion,
  evaluateCriteria,
  describe
} from '../criteria.mjs';
import { CODES } from '../errors.mjs';

function capture(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected the call to throw');
}

const FACTS = {
  fileExists: async (path) => path === 'exists.txt',
  fileContains: async (path, text) => path === 'exists.txt' && text === 'hello',
  fileModifiedSince: async (path, since) => path === 'exists.txt' && since === 5,
  startedAt: 5,
  processExited: async (pid) => pid === 7,
  processRunning: async (name) => name === 'node',
  lastShell: { exited: true, exitCode: 0, stdout: 'Hello World', stderr: 'oops' },
  world: { url: 'https://Example.com/x' },
  initialUrl: 'https://other.example',
  domQuery: async (selector) => (selector === '.a' ? [1, 2] : []),
  domText: async (selector) => (selector === 'body' ? '  Hello Big World  ' : 'nope'),
  domValue: async (selector) => (selector === '#v' ? 42 : null),
  axFind: async (criterion) => (criterion.name === 'Save' ? [{ id: 1 }] : []),
  windowExists: async (criterion) => criterion.title === 'W',
  foregroundWindow: async () => ({ title: 'Notepad', processName: 'notepad.exe' }),
  visualChange: async (criterion) => criterion.selector === '#r',
  events: [{ type: 'ready' }],
  custom: async (criterion) => criterion.name === 'ok',
  exitCode: async () => 3
};

test('the criterion vocabulary is the donor closed list, in donor order', () => {
  assert.deepEqual(CRITERION_KINDS, [
    'file_exists', 'file_missing', 'file_contains', 'file_modified', 'process_exited', 'process_running',
    'stdout_matches', 'stderr_matches', 'exit_code', 'url_matches', 'url_changed', 'dom_exists', 'dom_text',
    'dom_value', 'ax_element', 'window_exists', 'foreground_window', 'visual_change', 'event', 'all', 'any', 'custom'
  ]);
  assert.equal(CRITERION_KINDS.length, 22);
});

test('a bare string is a custom criterion, normalized criteria carry kindAlias and a description', () => {
  assert.deepEqual(normalizeCriterion('the dashboard shows today'), {
    kind: 'custom',
    name: 'the dashboard shows today',
    description: 'the dashboard shows today'
  });
  const file = normalizeCriterion({ type: 'file_exists', path: 'out.txt' }, 3);
  assert.equal(file.kind, 'file_exists');
  assert.equal(file.kindAlias, 'file_exists');
  assert.equal(file.description, 'file exists: out.txt');
  assert.equal(file.path, 'out.txt');

  const aliased = normalizeCriterion({ type: 'file', path: 'out.txt' });
  assert.equal(aliased.kind, 'file_exists');
  assert.equal(aliased.kindAlias, 'file');
  assert.equal(aliased.description, 'file exists: out.txt');

  const described = normalizeCriterion({ type: 'file_exists', path: 'p', description: 'custom wording' });
  assert.equal(described.description, 'custom wording');
});

test('the donor alias only applies to `type`, so `kind: "file"` survives unexpanded (preserved donor defect)', async () => {
  // `{ kind, ...input, kindAlias }` lets the caller's raw `kind` overwrite the
  // alias-expanded one; only the `type` spelling gets expanded.
  const byKind = normalizeCriterion({ kind: 'file', path: 'p' });
  assert.equal(byKind.kind, 'file');
  assert.equal(byKind.kindAlias, 'file');
  assert.equal(byKind.description, 'custom check: (unnamed)');
  const byType = normalizeCriterion({ type: 'file', path: 'p' });
  assert.equal(byType.kind, 'file_exists');
  assert.equal(byType.kindAlias, 'file');
  // An unexpanded alias then falls through the evaluator's default branch.
  const evaluated = await evaluateCriterion(normalizeCriterion({ kind: 'file', path: 'p' }), FACTS);
  assert.equal(evaluated.verdict, 'unknown');
  assert.equal(evaluated.detail, 'no evidence available');
});

test('an object criterion must be plain and must name a supported kind', () => {
  const shape = capture(() => normalizeCriterion(5, 2));
  assert.equal(shape.code, CODES.CONTRACT_INVALID);
  assert.equal(shape.message, 'success criterion #2 must be an object or string');
  assert.deepEqual(shape.details, { criterion: 5 });
  assert.equal(shape.retryable, false);

  const unsupported = capture(() => normalizeCriterion({ kind: 'nope' }));
  assert.equal(unsupported.code, CODES.CONTRACT_INVALID);
  assert.equal(unsupported.message, 'unsupported success criterion kind: nope');
  assert.deepEqual(unsupported.details, { kind: 'nope', supported: [...CRITERION_KINDS] });

  const missing = capture(() => normalizeCriterion({}));
  assert.equal(missing.message, 'unsupported success criterion kind: (missing)');
  assert.deepEqual(missing.details, { kind: null, supported: [...CRITERION_KINDS] });

  // The raw kind is lower-cased before lookup.
  assert.equal(normalizeCriterion({ type: 'FILE_EXISTS', path: 'p' }).kind, 'file_exists');
});

test('negation is coerced to a boolean and only stored when the author wrote it', () => {
  assert.equal(normalizeCriterion({ type: 'file_exists', path: 'p', negate: 0 }).negate, false);
  assert.equal(normalizeCriterion({ type: 'file_exists', path: 'p', negate: 'yes' }).negate, true);
  assert.equal('negate' in normalizeCriterion({ type: 'file_exists', path: 'p' }), false);
});

test('all/any nest their criteria and refuse an empty list', () => {
  const all = normalizeCriterion({ type: 'all', criteria: ['a', { type: 'file_exists', path: 'p' }] });
  assert.equal(all.kind, 'all');
  assert.equal(all.description, 'all of 2 criteria');
  assert.deepEqual(all.criteria.map((entry) => entry.kind), ['custom', 'file_exists']);

  // `of` is readable only when the author also supplies a description (see the
  // donor defect pinned below), which skips the crashing `describe()` call.
  const viaOf = normalizeCriterion({ type: 'any', of: [{ type: 'event', name: 'ready' }], description: 'ready event seen' });
  assert.equal(viaOf.kind, 'any');
  assert.equal(viaOf.description, 'ready event seen');
  assert.deepEqual(viaOf.criteria.map((entry) => entry.kind), ['event']);

  const empty = capture(() => normalizeCriterion({ type: 'all', criteria: [] }));
  assert.equal(empty.message, 'success criterion "all" needs a non-empty criteria array');
  const emptyAny = capture(() => normalizeCriterion({ type: 'any', criteria: [] }));
  assert.equal(emptyAny.message, 'success criterion "any" needs a non-empty criteria array');
  // An empty `criteria` array short-circuits the `of` fallback, exactly as in the donor.
  const shadowed = capture(() => normalizeCriterion({ type: 'any', criteria: [], of: ['x'] }));
  assert.equal(shadowed.message, 'success criterion "any" needs a non-empty criteria array');
});

test('the donor describes an `of`-shaped all/any before it expands it, so it crashes (preserved donor defect)', () => {
  // `describe()` runs before `criterion.criteria` is assigned, and the `of`
  // spelling is not in the spread, so `criterion.criteria.length` reads
  // `undefined.length` and a raw TypeError escapes the normalizer.
  assert.throws(() => normalizeCriterion({ type: 'any', of: [{ type: 'event', name: 'ready' }] }), TypeError);
  assert.throws(() => normalizeCriterion({ type: 'all', of: ['x'] }), TypeError);
  // Writing `criteria` (even with an explicit description) avoids the crash.
  const explicit = normalizeCriterion({ type: 'all', criteria: ['x'], description: 'both things hold' });
  assert.equal(explicit.description, 'both things hold');
});

test('normalizeCriteria accepts a list, a single entry, or nothing', () => {
  assert.deepEqual(normalizeCriteria(undefined), []);
  assert.deepEqual(normalizeCriteria(null), []);
  assert.deepEqual(normalizeCriteria([]), []);
  assert.equal(normalizeCriteria('one').length, 1);
  assert.deepEqual(normalizeCriteria([{ type: 'file', path: 'p' }, 'x']).map((entry) => entry.kind), ['file_exists', 'custom']);
});

test('every criterion kind has the donor description string', () => {
  assert.equal(describe(normalizeCriterion({ type: 'file_exists', path: 'p' })), 'file exists: p');
  assert.equal(describe(normalizeCriterion({ type: 'file_missing', file: 'p' })), 'file is gone: p');
  assert.equal(describe(normalizeCriterion({ type: 'file_contains', path: 'p', text: 'hi' })), 'file contains "hi": p');
  assert.equal(describe(normalizeCriterion({ type: 'file_contains', path: 'p' })), 'file contains "": p');
  assert.equal(describe(normalizeCriterion({ type: 'file_modified', path: 'p' })), 'file modified after the run started: p');
  assert.equal(describe(normalizeCriterion({ type: 'file_modified', path: 'p', since: 5 })), 'file modified after 5: p');
  assert.equal(describe(normalizeCriterion({ type: 'process_exited' })), 'process exited: (any)');
  assert.equal(describe(normalizeCriterion({ type: 'process_exited', process: 'node' })), 'process exited: node');
  assert.equal(describe(normalizeCriterion({ type: 'process_running', name: 'node' })), 'process running: node');
  assert.equal(describe(normalizeCriterion({ type: 'stdout_matches', pattern: 'hi' })), 'stdout matches hi');
  assert.equal(describe(normalizeCriterion({ type: 'stderr_matches', text: 'oops' })), 'stderr matches oops');
  assert.equal(describe(normalizeCriterion({ type: 'exit_code', value: 0 })), 'last exit code is 0');
  assert.equal(describe(normalizeCriterion({ type: 'exit_code', code: 3 })), 'last exit code is 3');
  assert.equal(describe(normalizeCriterion({ type: 'url_matches', pattern: 'x' })), 'url matches x');
  assert.equal(describe(normalizeCriterion({ type: 'url_changed', from: 'a' })), 'url changed from a');
  assert.equal(describe(normalizeCriterion({ type: 'url_changed' })), 'url changed from (previous)');
  assert.equal(describe(normalizeCriterion({ type: 'dom_exists', selector: '.a' })), 'DOM has .a');
  assert.equal(describe(normalizeCriterion({ type: 'dom_text', selector: 'body', text: 'hi' })), 'DOM text "hi" in body');
  assert.equal(describe(normalizeCriterion({ type: 'dom_text' })), 'DOM text "" in body');
  assert.equal(describe(normalizeCriterion({ type: 'dom_value', selector: '#v', value: 42 })), '#v has value 42');
  assert.equal(describe(normalizeCriterion({ type: 'dom_value', selector: '#v' })), '#v has value ""');
  assert.equal(describe(normalizeCriterion({ type: 'ax_element', name: 'Save' })), 'accessibility element Save');
  assert.equal(describe(normalizeCriterion({ type: 'ax_element' })), 'accessibility element ');
  assert.equal(describe(normalizeCriterion({ type: 'window_exists', title: 'W' })), 'window exists: W');
  assert.equal(describe(normalizeCriterion({ type: 'foreground_window', title: 'N' })), 'foreground window is N');
  assert.equal(describe(normalizeCriterion({ type: 'foreground_window', process: 'p' })), 'foreground window is p');
  assert.equal(describe(normalizeCriterion({ type: 'visual_change' })), 'the screen region changed');
  assert.equal(describe(normalizeCriterion({ type: 'event', name: 'ready' })), 'event observed: ready');
  assert.equal(describe(normalizeCriterion({ type: 'custom', name: 'ok' })), 'custom check: ok');
  assert.equal(describe(normalizeCriterion({ type: 'custom' })), 'custom check: (unnamed)');
});

test('evaluation is per-kind and reads only the injected facts', async () => {
  const cases = [
    [{ type: 'file_exists', path: 'exists.txt' }, 'satisfied'],
    [{ type: 'file_exists', path: 'missing.txt' }, 'unsatisfied'],
    [{ type: 'file_missing', path: 'missing.txt' }, 'satisfied'],
    [{ type: 'file_contains', path: 'exists.txt', text: 'hello' }, 'satisfied'],
    [{ type: 'file_modified', path: 'exists.txt' }, 'satisfied'],
    [{ type: 'file_modified', path: 'exists.txt', since: 9 }, 'unsatisfied'],
    [{ type: 'process_exited', pid: 7 }, 'satisfied'],
    [{ type: 'process_exited', code: 0 }, 'satisfied'],
    [{ type: 'process_exited', code: 1 }, 'unsatisfied'],
    [{ type: 'process_running', process: 'node' }, 'satisfied'],
    [{ type: 'process_running', process: 'other' }, 'unsatisfied'],
    [{ type: 'stdout_matches', pattern: 'hello' }, 'satisfied'],
    [{ type: 'stdout_matches', text: 'Hello', regex: false }, 'satisfied'],
    [{ type: 'stderr_matches', text: 'oops', regex: false }, 'satisfied'],
    [{ type: 'exit_code', value: 0 }, 'satisfied'],
    [{ type: 'exit_code', code: 3 }, 'unsatisfied'],
    [{ type: 'url_matches', pattern: 'example\\.com' }, 'satisfied'],
    [{ type: 'url_matches', url: 'Example', regex: false }, 'satisfied'],
    // `regex: false` is a case-sensitive substring test, unlike the regex path.
    [{ type: 'url_matches', url: 'example', regex: false }, 'unsatisfied'],
    [{ type: 'url_changed' }, 'satisfied'],
    [{ type: 'url_changed', from: 'https://Example.com/x' }, 'unsatisfied'],
    [{ type: 'dom_exists', selector: '.a' }, 'satisfied'],
    [{ type: 'dom_exists', selector: '.b' }, 'unsatisfied'],
    [{ type: 'dom_text', selector: 'body', text: 'big world' }, 'satisfied'],
    [{ type: 'dom_text', selector: 'body', text: 'Hello Big World', exact: true }, 'satisfied'],
    [{ type: 'dom_value', selector: '#v', value: 42 }, 'satisfied'],
    [{ type: 'dom_value', selector: '#v', value: 41 }, 'unsatisfied'],
    [{ type: 'ax_element', name: 'Save' }, 'satisfied'],
    [{ type: 'ax_element', name: 'Cancel' }, 'unsatisfied'],
    [{ type: 'window_exists', title: 'W' }, 'satisfied'],
    [{ type: 'window_exists', title: 'X' }, 'unsatisfied'],
    [{ type: 'foreground_window', title: 'note' }, 'satisfied'],
    [{ type: 'foreground_window', process: 'NOTEPAD' }, 'satisfied'],
    [{ type: 'foreground_window', title: 'chrome' }, 'unsatisfied'],
    [{ type: 'visual_change', selector: '#r' }, 'satisfied'],
    [{ type: 'visual_change', selector: '#other' }, 'unsatisfied'],
    [{ type: 'event', name: 'ready' }, 'satisfied'],
    [{ type: 'event', name: 'nope' }, 'unsatisfied']
  ];
  for (const [input, verdict] of cases) {
    const result = await evaluateCriterion(normalizeCriterion(input), FACTS);
    assert.equal(result.verdict, verdict, JSON.stringify(input));
    assert.equal(result.ok, verdict === 'satisfied', JSON.stringify(input));
    assert.equal(result.detail, result.criterion.description);
  }
  // A `foreground_window` with neither title nor process has no answer to give.
  const noSelector = await evaluateCriterion(normalizeCriterion({ type: 'foreground_window' }), FACTS);
  assert.equal(noSelector.verdict, 'unknown');
});

test('missing evidence is unknown, never true, and the result shape is the donor shape', async () => {
  const noFacts = await evaluateCriterion(normalizeCriterion({ type: 'file_exists', path: 'p' }));
  assert.deepEqual(Object.keys(noFacts).sort(), ['criterion', 'detail', 'ok', 'verdict']);
  assert.equal(noFacts.verdict, 'unknown');
  assert.equal(noFacts.ok, false);
  assert.equal(noFacts.detail, 'no evidence available');

  // A fact that throws is captured, not propagated, and keeps its code.
  const throwing = await evaluateCriterion(normalizeCriterion({ type: 'dom_exists', selector: '.a' }), {
    domQuery: () => {
      throw new Error('boom');
    }
  });
  assert.equal(throwing.verdict, 'unknown');
  assert.equal(throwing.ok, false);
  assert.equal(throwing.detail, 'boom');
  assert.equal(throwing.code, CODES.CONTRACT_INVALID);
});

test('negate flips a known verdict and leaves an unknown verdict unknown', async () => {
  const flipped = await evaluateCriterion(normalizeCriterion({ type: 'file_exists', path: 'missing.txt', negate: true }), FACTS);
  assert.equal(flipped.verdict, 'satisfied');
  assert.equal(flipped.ok, true);

  const unknown = await evaluateCriterion(normalizeCriterion({ type: 'file_exists', path: 'p', negate: true }), {});
  assert.equal(unknown.verdict, 'unknown');
  assert.equal(unknown.ok, false);
});

test('all/any combine child verdicts with the donor three-valued rules', async () => {
  // A missing run-start makes `file_modified` genuinely unknown rather than false.
  const factsWithGap = { ...FACTS, startedAt: undefined };

  const allTrue = await evaluateCriterion(normalizeCriterion({ type: 'all', criteria: [{ type: 'file_exists', path: 'exists.txt' }, { type: 'event', name: 'ready' }] }), FACTS);
  assert.equal(allTrue.verdict, 'satisfied');

  const allFalse = await evaluateCriterion(normalizeCriterion({ type: 'all', criteria: [{ type: 'file_exists', path: 'exists.txt' }, { type: 'window_exists', title: 'nope' }] }), FACTS);
  assert.equal(allFalse.verdict, 'unsatisfied');

  const allUnknown = await evaluateCriterion(normalizeCriterion({ type: 'all', criteria: [{ type: 'file_exists', path: 'exists.txt' }, { type: 'file_modified', path: 'x' }] }), factsWithGap);
  assert.equal(allUnknown.verdict, 'unknown');

  const anyTrue = await evaluateCriterion(normalizeCriterion({ type: 'any', criteria: [{ type: 'file_exists', path: 'missing.txt' }, { type: 'event', name: 'ready' }] }), FACTS);
  assert.equal(anyTrue.verdict, 'satisfied');

  const anyFalse = await evaluateCriterion(normalizeCriterion({ type: 'any', criteria: [{ type: 'file_exists', path: 'missing.txt' }, { type: 'event', name: 'nope' }] }), FACTS);
  assert.equal(anyFalse.verdict, 'unsatisfied');

  const anyUnknown = await evaluateCriterion(normalizeCriterion({ type: 'any', criteria: [{ type: 'file_exists', path: 'missing.txt' }, { type: 'file_modified', path: 'x' }] }), factsWithGap);
  assert.equal(anyUnknown.verdict, 'unknown');
});

test('a custom criterion consults the custom fact or the named check function', async () => {
  assert.equal((await evaluateCriterion(normalizeCriterion({ type: 'custom', name: 'ok' }), FACTS)).verdict, 'satisfied');
  const named = await evaluateCriterion(normalizeCriterion({ type: 'custom', name: 'x', check: { fn: 'isDone' } }), { isDone: async () => true });
  assert.equal(named.verdict, 'satisfied');
  const unnamed = await evaluateCriterion(normalizeCriterion({ type: 'custom', name: 'x' }), {});
  assert.equal(unnamed.verdict, 'unknown');
});

test('no criteria means satisfied and skipped — the donor completion rule', async () => {
  assert.deepEqual(await evaluateCriteria([]), { satisfied: true, unknown: false, results: [], skipped: true });
  assert.deepEqual(await evaluateCriteria(undefined), { satisfied: true, unknown: false, results: [], skipped: true });
  assert.deepEqual(await evaluateCriteria(null), { satisfied: true, unknown: false, results: [], skipped: true });
});

test('evaluateCriteria reports per-criterion results and treats unknown as not satisfied', async () => {
  const factsWithGap = { ...FACTS, startedAt: undefined };
  const result = await evaluateCriteria(
    normalizeCriteria([
      { type: 'file_exists', path: 'exists.txt' },
      { type: 'event', name: 'nope' },
      { type: 'file_modified', path: 'unknown.txt' }
    ]),
    factsWithGap
  );
  assert.equal(result.satisfied, false);
  assert.equal(result.unknown, true);
  assert.equal(result.skipped, undefined);
  assert.deepEqual(result.results, [
    { kind: 'file_exists', description: 'file exists: exists.txt', verdict: 'satisfied', detail: 'file exists: exists.txt' },
    { kind: 'event', description: 'event observed: nope', verdict: 'unsatisfied', detail: 'event observed: nope' },
    { kind: 'file_modified', description: 'file modified after the run started: unknown.txt', verdict: 'unknown', detail: 'no evidence available' }
  ]);

  const satisfied = await evaluateCriteria(normalizeCriteria([{ type: 'file_exists', path: 'exists.txt', negate: false }]), FACTS);
  assert.deepEqual(satisfied, {
    satisfied: true,
    unknown: false,
    results: [{ kind: 'file_exists', description: 'file exists: exists.txt', verdict: 'satisfied', detail: 'file exists: exists.txt' }]
  });

  // A single non-array criterion is normalized before evaluation.
  const single = await evaluateCriteria({ type: 'file_exists', path: 'exists.txt' }, FACTS);
  assert.equal(single.satisfied, true);
  assert.equal(single.results[0].kind, 'file_exists');
});

test('an already-normalized array is used as-is, so a raw object keeps its raw kind (preserved donor defect)', async () => {
  // `evaluateCriteria` only normalizes when the input is not an array, so an
  // array of raw objects skips alias expansion and description derivation.
  const raw = await evaluateCriteria([{ kind: 'file', path: 'exists.txt' }], FACTS);
  assert.deepEqual(raw.results, [
    { kind: 'file', description: undefined, verdict: 'unknown', detail: 'no evidence available' }
  ]);
  assert.equal(raw.satisfied, false);
  assert.equal(raw.unknown, true);

  const normalized = normalizeCriteria([{ kind: 'file', path: 'exists.txt' }]);
  assert.equal(normalized[0].kind, 'file');
  assert.equal((await evaluateCriterion(normalized[0], FACTS)).verdict, 'unknown');
});
