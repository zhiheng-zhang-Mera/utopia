/**
 * UTOPIA · Research Institute — bibliography suite.
 *
 * The entry rendering, the exclusion rule and the document header restate the
 * Codex-Boss donor `src/shared/research-bibliography.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. The type-only import of
 * `CitationRecord` / `CitationStatus` is replaced by the frozen vocabulary, and the
 * rendering is pinned byte-for-byte: record order is preserved, keys are sanitised,
 * braces are escaped in the title/journal/url fields only, and there is no
 * deduplication.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  BIBLIOGRAPHY_STATUSES,
  CITATION_LADDER,
  bibliographyEntries,
  referencesBib,
} from '../index.mjs';

const record = (overrides = {}) => ({
  id: 'citation-1',
  proposedTitle: 'A Study',
  proposedAuthors: ['Ada Byron'],
  status: 'CLAIM_SUPPORTED',
  reasons: [],
  updatedAt: '2026-09-29T00:00:00.000Z',
  ...overrides,
});

// the exact document a fixed record set renders to; the digest of this literal is
// pinned below, so a truncated or edited rendering cannot pass
const EXPECTED_ENTRY_SMITH = '@misc{smith-2024,\n  title = {A \\{Study\\} of Things},\n  author = {Ada Byron and Alan Turing},\n  journal = {Journal of \\{Tests\\}},\n  url = {https://x.test/\\{a\\}}\n}';
const EXPECTED_ENTRY_BARE = '@misc{no-metadata-here-,\n  title = {Untitled},\n  author = {Unknown}\n}';
const EXPECTED_BIB = '% References generated deterministically from verified citations (2 verified).\n@misc{smith-2024,\n  title = {A \\{Study\\} of Things},\n  author = {Ada Byron and Alan Turing},\n  journal = {Journal of \\{Tests\\}},\n  url = {https://x.test/\\{a\\}}\n}\n\n@misc{no-metadata-here-,\n  title = {Untitled},\n  author = {Unknown}\n}\n';
const EXPECTED_EMPTY_BIB = '% References generated deterministically from verified citations (0 verified).\n% no verified citations yet\n';
const EXPECTED_BIB_SHA256 = 'c77c9800f5312541af75d7bf4c741f2f35568ce968d45594cafcfed70fdf2ca2';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

const PINNED = [
  record({
    id: 'smith-2024',
    proposedTitle: 'A {Study} of Things',
    proposedAuthors: ['Ada Byron', 'Alan Turing'],
    proposedVenue: 'Journal of {Tests}',
    sourceRef: 'https://x.test/{a}',
  }),
  record({ id: 'no metadata here!', proposedTitle: undefined, proposedAuthors: undefined, proposedVenue: undefined, sourceRef: undefined, status: 'SOURCE_RETRIEVED' }),
  record({ id: 'unsupported', proposedTitle: 'suggested but never acquired', status: 'UNSUPPORTED' }),
];

test('a verified record renders as the donor renders it, field for field', () => {
  assert.deepEqual(bibliographyEntries(PINNED), [EXPECTED_ENTRY_SMITH, EXPECTED_ENTRY_BARE]);
  assert.equal(EXPECTED_ENTRY_SMITH.length, 161);
  assert.equal(EXPECTED_ENTRY_BARE.length, 69);

  // the escaping applies to the title, the journal and the url — and not to the author
  const braces = bibliographyEntries([record({ proposedAuthors: ['A{B}'], proposedTitle: 'T{U}', proposedVenue: 'V{W}', sourceRef: 'u{x}' })]);
  assert.equal(braces[0], '@misc{citation-1,\n  title = {T\\{U\\}},\n  author = {A{B}},\n  journal = {V\\{W\\}},\n  url = {u\\{x\\}}\n}');
  // and the key is sanitised, not escaped
  assert.equal(bibliographyEntries([record({ id: 'a b.c/d:e_f-g{h}' })])[0].startsWith('@misc{a-b-c-d:e_f-g-h-,'), true);
});

test('the entry key is the sanitised id, with the donor fallbacks', () => {
  const keyOf = (id) => bibliographyEntries([record(id === undefined ? { id: undefined } : { id })])[0].split(',')[0];
  assert.equal(keyOf('plain-id'), '@misc{plain-id');
  assert.equal(keyOf('has spaces'), '@misc{has-spaces');
  assert.equal(keyOf('a.b/c d'), '@misc{a-b-c-d');
  assert.equal(keyOf('keep:colon_underscore-dash'), '@misc{keep:colon_underscore-dash');
  assert.equal(keyOf(''), '@misc{citation', 'an empty id falls back to "citation"');
  assert.equal(keyOf(undefined), '@misc{citation', 'a missing id falls back to "citation"');
  assert.equal(keyOf('Ünïcode?'), '@misc{-n-code-', 'non-ASCII is replaced, one dash per character');
});

test('author and title fall back exactly where the donor falls back, and nowhere else', () => {
  const entry = (overrides) => bibliographyEntries([record(overrides)])[0];
  assert.equal(entry({ proposedAuthors: [] }).includes('author = {Unknown}'), true);
  assert.equal(entry({ proposedAuthors: undefined }).includes('author = {Unknown}'), true);
  assert.equal(entry({ proposedAuthors: ['Ada', 'Alan', 'Grace'] }).includes('author = {Ada and Alan and Grace}'), true);
  assert.equal(entry({ proposedTitle: undefined }).includes('title = {Untitled}'), true);
  // only a present, non-empty venue / sourceRef adds a field
  assert.equal(entry({ proposedVenue: undefined }).includes('journal'), false);
  assert.equal(entry({ proposedVenue: '' }).includes('journal'), false);
  assert.equal(entry({ sourceRef: undefined }).includes('url'), false);
  assert.equal(entry({ sourceRef: '' }).includes('url'), false);
  assert.equal(entry({ proposedVenue: 'V' }).includes('journal = {V}'), true);
  assert.equal(entry({ sourceRef: 'U' }).includes('url = {U}'), true);
  // title and author are always emitted, in that order, with no venue and no url
  assert.equal(entry({}), '@misc{citation-1,\n  title = {A Study},\n  author = {Ada Byron}\n}');
});

test('only the four verified statuses are included, and nothing is deduplicated', () => {
  for (const status of CITATION_LADDER) {
    const included = bibliographyEntries([record({ status })]);
    assert.equal(included.length, BIBLIOGRAPHY_STATUSES.includes(status) ? 1 : 0, `${status} inclusion`);
  }
  assert.deepEqual([...BIBLIOGRAPHY_STATUSES], ['SOURCE_RETRIEVED', 'PASSAGE_VERIFIED', 'CLAIM_SUPPORTED', 'PARTIAL']);
  assert.deepEqual(bibliographyEntries([record({ id: 'a', status: 'UNSUPPORTED' }), record({ id: 'b', status: 'METADATA_ONLY' }), record({ id: 'c', status: 'CONTRADICTED' })]), []);
  // a record with no status at all, or an unknown one, is simply not verified
  assert.deepEqual(bibliographyEntries([{ id: 'a', proposedTitle: 'T', reasons: [] }]), []);
  assert.deepEqual(bibliographyEntries([{ id: 'a', proposedTitle: 'T', status: 'VERIFIED', reasons: [] }]), []);

  // order is record order, not id order
  const ordered = bibliographyEntries([
    record({ id: 'zulu' }),
    record({ id: 'alpha' }),
    record({ id: 'mike' }),
  ]);
  assert.deepEqual(ordered.map((entry) => entry.split(',')[0]), ['@misc{zulu', '@misc{alpha', '@misc{mike']);

  // the donor does not deduplicate: the same record twice renders twice
  const twice = bibliographyEntries([record({ id: 'same' }), record({ id: 'same' })]);
  assert.equal(twice.length, 2);
  assert.equal(twice[0], twice[1]);
  assert.equal(referencesBib([record({ id: 'same' }), record({ id: 'same' })]).includes('(2 verified)'), true);
});

test('referencesBib writes the count header, the blank-line separation and the placeholder', () => {
  assert.equal(referencesBib(PINNED), EXPECTED_BIB);
  assert.equal(referencesBib([]), EXPECTED_EMPTY_BIB);
  assert.equal(referencesBib([record({ status: 'METADATA_ONLY' })]), EXPECTED_EMPTY_BIB, 'nothing verified yields the placeholder, not an empty document');

  // pinned lengths and the pinned digest of the rendered document
  assert.equal(EXPECTED_BIB.length, 312);
  assert.equal(EXPECTED_EMPTY_BIB.length, 107);
  assert.equal(sha256(EXPECTED_BIB).length, 64);
  assert.equal(sha256(EXPECTED_BIB), EXPECTED_BIB_SHA256);
  assert.equal(sha256(referencesBib(PINNED)), EXPECTED_BIB_SHA256);
  assert.equal(sha256(referencesBib([])), sha256(EXPECTED_EMPTY_BIB));
  assert.equal(EXPECTED_BIB_SHA256.length, 64);

  // the header counts the entries, and the entries are separated by exactly one blank line
  const header = EXPECTED_BIB.split('\n')[0];
  assert.equal(header, '% References generated deterministically from verified citations (2 verified).');
  assert.equal(referencesBib([record({ id: 'one' })]).split('\n')[0].includes('(1 verified)'), true);
  assert.equal(EXPECTED_BIB.endsWith('}\n'), true);
  assert.equal(EXPECTED_BIB.split('\n\n').length, 2, 'two entries, one blank line between them');
  assert.equal(header + '\n' + bibliographyEntries(PINNED).join('\n\n') + '\n', EXPECTED_BIB, 'header, entries, blank line, trailing newline');

  // an empty record list and a list with nothing verified render identically
  assert.equal(referencesBib([]), referencesBib([record({ status: 'CONTRADICTED' })]));
});

test('the bibliography renders records and validates nothing, exactly as the donor does', () => {
  // the donor never calls validateCitationRecord here, so a malformed verified record
  // reaches the renderer; a non-array author list fails on `.join`, not on a rule
  assert.throws(() => bibliographyEntries([record({ proposedAuthors: 'Ada Byron' })]), TypeError);
  // a missing title is defaulted, a missing id is defaulted: those are the only repairs
  assert.match(bibliographyEntries([{ id: '', status: 'PARTIAL', reasons: [] }])[0], /^@misc\{citation,/);
});
