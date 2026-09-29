/**
 * Room 05 — Text Workshop focused tests (budget: <= 6).
 * The room is stateless: every operation is verified against fixed inputs.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { startTestHub } from './harness.mjs';
import {
  applyOperation,
  characterCount,
  dedupeLines,
  diffLines,
  lineCount,
  normalizeWhitespace,
  removeBlankLines,
  sortLines,
  summarize,
  wordCount,
} from '../shared/text-tools.mjs';

test('text stats count characters, words and lines', () => {
  const text = 'hello world\nsecond line';
  assert.equal(characterCount(text), 23);
  assert.equal(characterCount('a b', { ignoreWhitespace: true }), 2);
  assert.equal(wordCount(text), 4);
  assert.equal(lineCount(text), 2);
  assert.equal(lineCount(''), 0);
  assert.deepEqual(summarize('a b\nc'), { characters: 5, charactersNoWhitespace: 3, words: 3, lines: 2 });
});

test('whitespace and blank-line operations are deterministic', () => {
  assert.equal(normalizeWhitespace('  a   b \n\n  c  '), 'a b\n\nc');
  assert.equal(removeBlankLines('a\n\n  \nb'), 'a\nb');
  assert.equal(applyOperation('  padded  ', 'trim'), 'padded');
});

test('sort and dedupe behave predictably', () => {
  assert.equal(sortLines('b\nA\nc'), 'A\nb\nc');
  assert.equal(sortLines('b\nA\nc', { descending: true }), 'c\nb\nA');
  assert.equal(dedupeLines('a\nb\na'), 'a\nb');
  assert.equal(dedupeLines('A\na', { caseInsensitive: true }), 'A');
  assert.equal(applyOperation('b\na', 'sort-lines'), 'a\nb');
  assert.throws(() => applyOperation('x', 'not-an-operation'));
});

test('case operations cover upper, lower and title', () => {
  assert.equal(applyOperation('Mixed Case here', 'upper'), 'MIXED CASE HERE');
  assert.equal(applyOperation('Mixed Case here', 'lower'), 'mixed case here');
  assert.equal(applyOperation('mixed case here', 'title'), 'Mixed Case Here');
});

test('line diff reports added, removed and identical lines', () => {
  const rows = diffLines('a\nb\nc', 'a\nx\nc');
  assert.deepEqual(rows, [
    { type: 'same', text: 'a' },
    { type: 'removed', text: 'b' },
    { type: 'added', text: 'x' },
    { type: 'same', text: 'c' },
  ]);
  assert.deepEqual(diffLines('same', 'same'), [{ type: 'same', text: 'same' }]);
});

test('text workshop serves transforms over HTTP and persists nothing', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const operations = await hub.api('GET', '/local-rooms/v1/text-workshop/operations');
  assert.ok(operations.payload.operations.includes('sort-lines'));

  const analyzed = await hub.api('POST', '/local-rooms/v1/text-workshop/analyze', { text: 'one two\nthree' });
  assert.equal(analyzed.payload.words, 3);
  assert.equal(analyzed.payload.lines, 2);

  const transformed = await hub.api('POST', '/local-rooms/v1/text-workshop/transform', { text: 'b\na', operation: 'upper' });
  assert.equal(transformed.payload.result, 'B\nA');
  assert.equal((await hub.api('POST', '/local-rooms/v1/text-workshop/transform', { text: 'x', operation: 'merge' })).status, 400);

  const diff = await hub.api('POST', '/local-rooms/v1/text-workshop/diff', { left: 'a\nb', right: 'a\nc' });
  assert.equal(diff.payload.added, 1);
  assert.equal(diff.payload.removed, 1);
  assert.equal(diff.payload.same, 1);

  const files = await readdir(hub.runtimeDir);
  assert.deepEqual(files, [], 'the text workshop writes no runtime file');
});
