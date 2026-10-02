// UXI-301: cross-language parity between the Android adapter and the frozen RS-290 contract.
//
// The workbook requires Web and Android to share SEMANTICS. A JVM test cannot import the contract, and
// the browser cannot reach it either, so both surfaces hold their own tables - which is exactly how a
// second vocabulary appears. This test is the guard: it PARSES the Kotlin adapter's source and compares
// its tables with the contract in both directions, so a term added to one side and not the other fails
// here rather than shipping as a divergence.
//
// It runs in `pnpm test`, i.e. the same CI job as the contract itself, so drift cannot hide in the
// Android module where no contract import is possible.

import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {ALLOWED_ACTIONS, PRESENTATION_STATES, TERM_CLASS, TERMS} from '../contracts/rs-presentation-contract-v1/presentation.mjs';
import {SEVERITY_OF_CLASS, STATE_SEVERITIES} from '../apps/web/scheduler-adapter.js';

const KOTLIN = new URL('../apps/android/app/src/main/java/city/utopia/control/SchedulerPresentation.kt', import.meta.url);
const source = readFileSync(KOTLIN, 'utf8');

/** Slice out one table declaration so the three tables cannot be confused for each other. */
const slice = (from, to) => {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `Kotlin adapter is missing ${from}; the parity guard cannot run`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `Kotlin adapter is missing ${to} after ${from}`);
  return source.slice(start, end);
};

const termTable = slice('val TERM_COPY', 'val STATE_COPY');
const stateTable = slice('val STATE_COPY', 'val ACTION_COPY');
const actionTable = slice('val ACTION_COPY', 'fun viewModel');

const parseTermLike = (text) => {
  const rows = [...text.matchAll(/^\s*"([A-Z_]+)" to SchedulerTermCopy\("([A-Z_]+)", "(.*?)", SchedulerSeverity\.([A-Z]+)\),\s*$/gm)];
  return rows.map((m) => ({key: m[1], term: m[2], copy: m[3], severity: m[4]}));
};

const KOTLIN_SEVERITY = {
  OK: 'ok', WAITING: 'waiting', BLOCKED: 'blocked', UNKNOWN: 'unknown', NEUTRAL: 'neutral', ATTENTION: 'attention',
};

test('UXI-301 android: the Kotlin term table equals the contract EXACTLY, in both directions', () => {
  const rows = parseTermLike(termTable);
  assert.equal(rows.length, TERMS.length, `parsed ${rows.length} Kotlin terms but the contract declares ${TERMS.length}`);
  assert.deepEqual(rows.map((r) => r.key).sort(), [...TERMS].sort(), 'the Android term set has drifted from the contract');
  // Every row names itself, has real copy, and does not print its own token.
  for (const row of rows) {
    assert.equal(row.key, row.term, `row keyed ${row.key} names ${row.term}`);
    assert.ok(row.copy.trim().length > 0, `${row.key} has blank copy`);
    assert.notEqual(row.copy, row.key, `${row.key} renders its token as copy`);
  }
});

test('UXI-301 android: the Kotlin state and action tables equal the contract', () => {
  const states = parseTermLike(stateTable);
  assert.deepEqual(states.map((r) => r.key).sort(), [...PRESENTATION_STATES].sort(), 'state set drift');
  const actions = [...actionTable.matchAll(/^\s*"([A-Z_]+)" to \("(.*?)" to (true|false)\),\s*$/gm)]
    .map((m) => ({token: m[1], label: m[2], primary: m[3] === 'true'}));
  assert.deepEqual(actions.map((a) => a.token).sort(), [...ALLOWED_ACTIONS].sort(), 'action set drift');
  for (const action of actions) {
    assert.ok(action.label.trim().length > 0, `${action.token} has a blank label`);
    assert.notEqual(action.label, action.token, `${action.token} renders its token as a label`);
  }
});

test('UXI-301 android: Kotlin severity agrees with the contract class wherever the class carries meaning', () => {
  const rows = parseTermLike(termTable);
  const stateTerms = new Set(TERMS.filter((t) => TERM_CLASS[t] === 'STATE'));
  const mismatched = [];
  const unbounded = [];
  for (const row of rows) {
    const kotlin = KOTLIN_SEVERITY[row.severity];
    assert.ok(kotlin, `unknown Kotlin severity ${row.severity}`);
    if (stateTerms.has(row.key)) {
      // STATE-class terms are bounded rather than derived, and the bounds must match the web adapter's.
      if (!STATE_SEVERITIES.includes(kotlin)) unbounded.push(`${row.key}=${kotlin}`);
      continue;
    }
    if (kotlin !== SEVERITY_OF_CLASS[TERM_CLASS[row.key]]) {
      mismatched.push(`${row.key}: contract ${TERM_CLASS[row.key]} -> ${SEVERITY_OF_CLASS[TERM_CLASS[row.key]]}, Kotlin ${kotlin}`);
    }
  }
  assert.deepEqual(mismatched, [], 'Android emphasis contradicts the contract class');
  assert.deepEqual(unbounded, [], 'a STATE-class term carries a severity outside the bounded set');
});

test('UXI-301 android: the parity guard would actually fail on drift', () => {
  // A guard that cannot fail is not a guard. Removing one term from the parsed slice must produce an
  // inequality against the contract, proving the comparison is live rather than vacuous.
  const rows = parseTermLike(termTable);
  const missing = rows.slice(1).map((r) => r.key).sort();
  assert.notDeepEqual(missing, [...TERMS].sort(), 'the comparison must detect a missing term');
  const extra = [...rows.map((r) => r.key), 'INVENTED_TERM'].sort();
  assert.notDeepEqual(extra, [...TERMS].sort(), 'the comparison must detect an invented term');
});
