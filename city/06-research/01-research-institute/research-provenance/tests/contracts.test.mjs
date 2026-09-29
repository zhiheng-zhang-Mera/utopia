/**
 * UTOPIA · Research Institute — research provenance contracts suite.
 *
 * The frozen vocabularies, the copy-on-construct factories and the validators that
 * gate them restate the Codex-Boss donor `src/shared/research-citation.ts` and
 * `src/shared/research-input.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. The suite also proves the module set
 * stays self-contained: no fs, no network, no clock, no Math.random, no env, no
 * TypeScript and no cross-module import.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BIBLIOGRAPHY_STATUSES,
  CITATION_LADDER,
  PROVIDER_POLICIES,
  VERIFIED_CITATION_STATUSES,
  citationRecord,
  humanResearchInput,
  validateCitationRecord,
  validateHumanResearchInput,
} from '../index.mjs';

const citation = (overrides = {}) => ({
  id: 'citation-1',
  proposedTitle: 'A Study',
  status: 'UNSUPPORTED',
  reasons: [],
  updatedAt: '2026-09-29T00:00:00.000Z',
  ...overrides,
});

const researchInput = (overrides = {}) => ({
  researchQuestion: 'Does X cause Y?',
  workspace: 'workspace/path',
  budget: { maxSteps: 10, maxExperiments: 2, maxProviderCalls: 25 },
  ...overrides,
});

test('the frozen vocabularies are the donor ladder and status sets, frozen', () => {
  assert.deepEqual(CITATION_LADDER, [
    'UNSUPPORTED',
    'METADATA_ONLY',
    'SOURCE_RETRIEVED',
    'PASSAGE_VERIFIED',
    'CLAIM_SUPPORTED',
    'PARTIAL',
    'CONTRADICTED',
  ]);
  assert.deepEqual(VERIFIED_CITATION_STATUSES, ['SOURCE_RETRIEVED', 'PASSAGE_VERIFIED', 'CLAIM_SUPPORTED', 'PARTIAL']);
  assert.deepEqual(BIBLIOGRAPHY_STATUSES, ['SOURCE_RETRIEVED', 'PASSAGE_VERIFIED', 'CLAIM_SUPPORTED', 'PARTIAL']);
  assert.deepEqual(PROVIDER_POLICIES, ['AUTO', 'FIXED']);

  for (const vocabulary of [CITATION_LADDER, VERIFIED_CITATION_STATUSES, BIBLIOGRAPHY_STATUSES, PROVIDER_POLICIES]) {
    assert.equal(Object.isFrozen(vocabulary), true, 'a vocabulary cannot be mutated through its export');
  }

  // the ladder has no duplicate and PARTIAL sits between CLAIM_SUPPORTED and CONTRADICTED
  assert.equal(new Set(CITATION_LADDER).size, CITATION_LADDER.length);
  assert.equal(CITATION_LADDER.indexOf('PARTIAL'), CITATION_LADDER.indexOf('CLAIM_SUPPORTED') + 1);
  assert.equal(CITATION_LADDER.indexOf('CONTRADICTED'), CITATION_LADDER.length - 1);
  assert.equal(VERIFIED_CITATION_STATUSES.length, 4);
});

test('citationRecord validates first and copies, so a validated record cannot be mutated through the caller', () => {
  const authors = ['Ada Byron', 'Alan Turing'];
  const passages = [{ quote: 'the passage', page: '12' }, { quote: 'a second passage' }];
  const reasons = ['metadata verified'];
  const built = citationRecord(citation({ proposedAuthors: authors, passages, reasons, status: 'PASSAGE_VERIFIED', proposedVenue: 'A Venue', sourceRef: 'https://example.test/x' }));

  assert.deepEqual(built, {
    id: 'citation-1',
    proposedTitle: 'A Study',
    proposedAuthors: ['Ada Byron', 'Alan Turing'],
    proposedVenue: 'A Venue',
    sourceRef: 'https://example.test/x',
    status: 'PASSAGE_VERIFIED',
    passages: [{ quote: 'the passage', page: '12' }, { quote: 'a second passage' }],
    reasons: ['metadata verified'],
    updatedAt: '2026-09-29T00:00:00.000Z',
  });
  assert.notEqual(built.proposedAuthors, authors);
  assert.notEqual(built.passages, passages);
  assert.notEqual(built.passages[0], passages[0]);
  assert.notEqual(built.reasons, reasons);

  authors.push('Someone Else');
  passages[0].quote = 'mutated';
  passages.push({ quote: 'late' });
  reasons.push('mutated');
  assert.deepEqual(built.proposedAuthors, ['Ada Byron', 'Alan Turing']);
  assert.deepEqual(built.reasons, ['metadata verified']);
  assert.deepEqual(built.passages.map((passage) => passage.quote), ['the passage', 'a second passage']);

  // the optional fields are not invented: an absent optional stays absent
  const minimal = citationRecord(citation());
  assert.deepEqual(Object.keys(minimal), ['id', 'proposedTitle', 'status', 'reasons', 'updatedAt']);
  assert.equal('proposedAuthors' in minimal, false);
  assert.equal('passages' in minimal, false);
  // a passage without a page does not grow one
  assert.deepEqual(Object.keys(citationRecord(citation({ passages: [{ quote: 'q' }] })).passages[0]), ['quote']);
});

test('citationRecord never repairs the input it refuses, and never rewrites what it accepts', () => {
  // the donor's validator is the gate: each refusal message is the donor's, verbatim
  assert.throws(() => validateCitationRecord(null), { name: 'Error', message: 'Citation requires an id' });
  assert.throws(() => validateCitationRecord({}), { name: 'Error', message: 'Citation requires an id' });
  assert.throws(() => validateCitationRecord(citation({ id: 7 })), { name: 'Error', message: 'Citation requires an id' });
  assert.throws(() => validateCitationRecord(citation({ id: '' })), { name: 'Error', message: 'Citation requires an id' });
  assert.throws(() => citationRecord(citation({ proposedTitle: '   ' })), { name: 'Error', message: 'Citation title invalid' });
  assert.throws(() => citationRecord(citation({ proposedTitle: 5 })), { name: 'Error', message: 'Citation title invalid' });
  assert.throws(() => citationRecord(citation({ proposedTitle: 'x'.repeat(501) })), { name: 'Error', message: 'Citation title invalid' });
  assert.throws(() => citationRecord(citation({ status: 'VERIFIED' })), { name: 'Error', message: 'Invalid citation status' });
  assert.throws(() => citationRecord(citation({ status: undefined })), { name: 'Error', message: 'Invalid citation status' });
  assert.throws(() => citationRecord(citation({ reasons: 'none' })), { name: 'Error', message: 'Citation reasons must be an array' });
  assert.throws(() => citationRecord(citation({ passages: [{ quote: '' }] })), { name: 'Error', message: 'Invalid citation passages' });
  assert.throws(() => citationRecord(citation({ passages: [{ quote: 7 }] })), { name: 'Error', message: 'Invalid citation passages' });
  assert.throws(() => citationRecord(citation({ passages: [{ quote: 'q'.repeat(4001) }] })), { name: 'Error', message: 'Invalid citation passages' });
  assert.throws(() => citationRecord(citation({ passages: Array.from({ length: 51 }, () => ({ quote: 'q' })) })), { name: 'Error', message: 'Invalid citation passages' });

  // the first failing rule wins, in the donor's order (title before status before reasons)
  assert.throws(
    () => citationRecord({ id: '', proposedTitle: '', status: 'NOPE', reasons: 'none' }),
    { name: 'Error', message: 'Citation requires an id' },
  );
  assert.throws(
    () => citationRecord({ id: 'x', proposedTitle: '', status: 'NOPE', reasons: 'none' }),
    { name: 'Error', message: 'Citation title invalid' },
  );
  assert.throws(
    () => citationRecord({ id: 'x', proposedTitle: 'ok', status: 'NOPE', reasons: 'none' }),
    { name: 'Error', message: 'Invalid citation status' },
  );

  // boundaries the donor accepts, accepted here untouched
  assert.equal(citationRecord(citation({ proposedTitle: 'x'.repeat(500) })).proposedTitle.length, 500);
  assert.equal(citationRecord(citation({ proposedTitle: '  padded  ' })).proposedTitle, '  padded  ');
  assert.deepEqual(citationRecord(citation({ reasons: [] })).reasons, []);
  assert.equal(citationRecord(citation({ passages: Array.from({ length: 50 }, () => ({ quote: 'q' })) })).passages.length, 50);
  assert.equal(citationRecord(citation({ passages: [{ quote: 'q'.repeat(4000) }] })).passages[0].quote.length, 4000);
  // the donor only inspects `passages` when it is truthy, and only checks `quote`
  assert.equal(citationRecord(citation({ passages: null })).passages, null);
  assert.equal(citationRecord(citation({ passages: [] })).passages.length, 0);
  assert.deepEqual(citationRecord(citation({ passages: [{ quote: 'q', page: 42 }] })).passages[0], { quote: 'q', page: 42 });
  // fields the donor's validator does not check are carried, not checked
  assert.equal(citationRecord(citation({ proposedAuthors: 'Ada' })).proposedAuthors, 'Ada');
  assert.equal(citationRecord(citation({ updatedAt: undefined })).updatedAt, undefined);

  // the donor's refusals are plain errors carrying a message, not a code: no error
  // code is invented here, so the refusal paths are pinned by their exact messages
  const refusal = (() => {
    try {
      citationRecord(citation({ status: 'NOPE' }));
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(refusal instanceof Error);
  assert.equal(refusal.name, 'Error');
  assert.equal(refusal.code, undefined);
  assert.equal(refusal.message, 'Invalid citation status');
  assert.deepEqual(Object.keys(refusal), []);
  const inputRefusal = (() => {
    try {
      validateHumanResearchInput({ researchQuestion: 'q', workspace: 'w', budget: null });
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.equal(inputRefusal.code, undefined);
  assert.deepEqual(Object.keys(inputRefusal), []);
});

test('humanResearchInput validates with the donor rules and copies the arrays it is given', () => {
  const constraints = ['no external calls'];
  const reviewers = ['research:auto', 'review:human'];
  const built = humanResearchInput(researchInput({ id: 'run-1', hypothesis: 'X does cause Y', constraints, reviewers, providerPolicy: 'FIXED', budget: { maxSteps: 5, maxExperiments: 1, maxProviderCalls: 2, maxRuntimeMinutes: 30 } }));

  assert.deepEqual(built, {
    id: 'run-1',
    researchQuestion: 'Does X cause Y?',
    workspace: 'workspace/path',
    hypothesis: 'X does cause Y',
    constraints: ['no external calls'],
    providerPolicy: 'FIXED',
    reviewers: ['research:auto', 'review:human'],
    budget: { maxSteps: 5, maxExperiments: 1, maxProviderCalls: 2, maxRuntimeMinutes: 30 },
  });
  assert.notEqual(built.constraints, constraints);
  assert.notEqual(built.reviewers, reviewers);
  assert.notEqual(built.budget, researchInput().budget);

  constraints.push('late');
  reviewers.push('late');
  assert.deepEqual(built.constraints, ['no external calls']);
  assert.deepEqual(built.reviewers, ['research:auto', 'review:human']);

  // untouched, not trimmed: the validator only proves the value is usable
  const padded = humanResearchInput(researchInput({ researchQuestion: '  Q  ', workspace: '  W  ', hypothesis: '  H  ' }));
  assert.equal(padded.researchQuestion, '  Q  ');
  assert.equal(padded.workspace, '  W  ');
  assert.equal(padded.hypothesis, '  H  ');

  // optional fields stay absent when they were absent, and the budget keeps only what it had
  const minimal = humanResearchInput(researchInput());
  assert.deepEqual(Object.keys(minimal), ['researchQuestion', 'workspace', 'budget']);
  assert.deepEqual(Object.keys(minimal.budget), ['maxSteps', 'maxExperiments', 'maxProviderCalls']);
});

test('validateHumanResearchInput refuses with the donor messages, in the donor order', () => {
  const cases = [
    [undefined, 'researchQuestion is required (1–20000 chars) and immutable'],
    [{}, 'researchQuestion is required (1–20000 chars) and immutable'],
    [{ researchQuestion: 7, workspace: 'w' }, 'researchQuestion is required (1–20000 chars) and immutable'],
    [{ researchQuestion: '   ', workspace: 'w' }, 'researchQuestion is required (1–20000 chars) and immutable'],
    [{ researchQuestion: 'x'.repeat(20001), workspace: 'w' }, 'researchQuestion is required (1–20000 chars) and immutable'],
    [{ researchQuestion: 'q' }, 'An authorized workspace is required'],
    [{ researchQuestion: 'q', workspace: '' }, 'An authorized workspace is required'],
    [{ researchQuestion: 'q', workspace: 7 }, 'An authorized workspace is required'],
    [{ researchQuestion: 'q', workspace: 'w', hypothesis: '   ' }, 'hypothesis invalid'],
    [{ researchQuestion: 'q', workspace: 'w', hypothesis: 'x'.repeat(20001) }, 'hypothesis invalid'],
    [{ researchQuestion: 'q', workspace: 'w', hypothesis: 7 }, 'hypothesis invalid'],
    [{ researchQuestion: 'q', workspace: 'w', constraints: 'none' }, 'constraints invalid (max 50 strings)'],
    [{ researchQuestion: 'q', workspace: 'w', constraints: Array.from({ length: 51 }, () => 'c') }, 'constraints invalid (max 50 strings)'],
    [{ researchQuestion: 'q', workspace: 'w', constraints: ['x'.repeat(2001)] }, 'constraints invalid (max 50 strings)'],
    [{ researchQuestion: 'q', workspace: 'w', constraints: [7] }, 'constraints invalid (max 50 strings)'],
    [{ researchQuestion: 'q', workspace: 'w', providerPolicy: 'MANUAL' }, 'providerPolicy must be AUTO or FIXED'],
    [{ researchQuestion: 'q', workspace: 'w', providerPolicy: 'auto' }, 'providerPolicy must be AUTO or FIXED'],
    [{ researchQuestion: 'q', workspace: 'w', providerPolicy: null }, 'providerPolicy must be AUTO or FIXED'],
    [{ researchQuestion: 'q', workspace: 'w', reviewers: [] }, 'reviewers must be 1–5 runtime ids'],
    [{ researchQuestion: 'q', workspace: 'w', reviewers: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'reviewers must be 1–5 runtime ids'],
    [{ researchQuestion: 'q', workspace: 'w', reviewers: 'a' }, 'reviewers must be 1–5 runtime ids'],
    [{ researchQuestion: 'q', workspace: 'w' }, 'budget requires positive integer maxSteps / maxExperiments / maxProviderCalls'],
    [{ researchQuestion: 'q', workspace: 'w', budget: null }, 'budget requires positive integer maxSteps / maxExperiments / maxProviderCalls'],
    [{ researchQuestion: 'q', workspace: 'w', budget: { maxSteps: 0, maxExperiments: 1, maxProviderCalls: 1 } }, 'budget requires positive integer maxSteps / maxExperiments / maxProviderCalls'],
    [{ researchQuestion: 'q', workspace: 'w', budget: { maxSteps: 1.5, maxExperiments: 1, maxProviderCalls: 1 } }, 'budget requires positive integer maxSteps / maxExperiments / maxProviderCalls'],
    [{ researchQuestion: 'q', workspace: 'w', budget: { maxSteps: '1', maxExperiments: 1, maxProviderCalls: 1 } }, 'budget requires positive integer maxSteps / maxExperiments / maxProviderCalls'],
    [{ researchQuestion: 'q', workspace: 'w', budget: { maxSteps: 1, maxExperiments: 0, maxProviderCalls: 1 } }, 'budget requires positive integer maxSteps / maxExperiments / maxProviderCalls'],
    [{ researchQuestion: 'q', workspace: 'w', budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 0 } }, 'budget requires positive integer maxSteps / maxExperiments / maxProviderCalls'],
    [{ researchQuestion: 'q', workspace: 'w', budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1, maxRuntimeMinutes: 0 } }, 'maxRuntimeMinutes invalid'],
    [{ researchQuestion: 'q', workspace: 'w', budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1, maxRuntimeMinutes: 1.5 } }, 'maxRuntimeMinutes invalid'],
  ];
  for (const [input, message] of cases) {
    assert.throws(() => validateHumanResearchInput(input), { name: 'Error', message }, JSON.stringify(input));
    assert.throws(() => humanResearchInput(input), { name: 'Error', message }, `factory: ${JSON.stringify(input)}`);
  }

  // the first failing rule wins: a broken workspace never reaches the budget
  assert.throws(
    () => validateHumanResearchInput({ researchQuestion: '', workspace: '', budget: null }),
    { name: 'Error', message: 'researchQuestion is required (1–20000 chars) and immutable' },
  );
  assert.throws(
    () => validateHumanResearchInput({ researchQuestion: 'q', workspace: 'w', providerPolicy: 'NOPE', budget: null }),
    { name: 'Error', message: 'providerPolicy must be AUTO or FIXED' },
  );

  // every boundary the donor accepts is still accepted
  for (const accepted of [
    { researchQuestion: 'x'.repeat(20000), workspace: 'w', budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1 } },
    { researchQuestion: 'q', workspace: 'w', hypothesis: 'x'.repeat(20000), budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1 } },
    { researchQuestion: 'q', workspace: 'w', constraints: [], budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1 } },
    { researchQuestion: 'q', workspace: 'w', constraints: Array.from({ length: 50 }, () => 'x'.repeat(2000)), budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1 } },
    // the donor checks an entry's type and length, nothing else: an empty string is allowed
    { researchQuestion: 'q', workspace: 'w', constraints: [''], budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1 } },
    { researchQuestion: 'q', workspace: 'w', providerPolicy: 'AUTO', budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1 } },
    { researchQuestion: 'q', workspace: 'w', providerPolicy: 'FIXED', budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1 } },
    // reviewer ids are not inspected beyond the 1–5 count
    { researchQuestion: 'q', workspace: 'w', reviewers: [7, null], budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1 } },
    { researchQuestion: 'q', workspace: 'w', reviewers: ['a', 'b', 'c', 'd', 'e'], budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1 } },
    { researchQuestion: 'q', workspace: 'w', budget: { maxSteps: 1, maxExperiments: 1, maxProviderCalls: 1, maxRuntimeMinutes: 1 } },
  ]) {
    assert.doesNotThrow(() => validateHumanResearchInput(accepted), JSON.stringify(accepted));
  }
});

test('the module set is self-contained: no runtime, no clock, no randomness, no sibling import', async () => {
  const moduleDir = join(import.meta.dirname, '..');
  const files = ['contracts.mjs', 'citation.mjs', 'bibliography.mjs', 'input.mjs', 'index.mjs'];
  const code = {};
  for (const file of files) {
    code[file] = (await readFile(join(moduleDir, file), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
  }

  for (const file of files) {
    for (const forbidden of [
      'Math.random',
      'Date.now',
      'new Date(',
      'process.env',
      'process.',
      "require('",
      'fetch(',
      'node:fs',
      'node:path',
      'node:os',
      'node:net',
      'node:http',
      'node:child_process',
      'setTimeout',
      'writeFileSync',
      'evidence-engine',
      'research-protocol',
      'research-ir',
    ]) {
      assert.ok(!code[file].includes(forbidden), `${file} must not contain ${forbidden}`);
    }
    for (const specifier of [...code[file].matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('.'),
        `${file} imports ${specifier}, which is not a node: builtin or a relative module`,
      );
    }
  }

  // the only node builtin used anywhere is the entropy source
  const builtins = files.flatMap((file) => [...code[file].matchAll(/from\s+'(node:[^']+)'/g)].map((match) => `${file}:${match[1]}`));
  assert.deepEqual(builtins, ['input.mjs:node:crypto']);
  assert.deepEqual(Object.keys(code).filter((file) => code[file].includes("from '")), ['citation.mjs', 'bibliography.mjs', 'input.mjs', 'index.mjs']);
});
