/**
 * Room 07 — Data Lab focused tests (budget: <= 6).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { startTestHub } from './harness.mjs';
import { parseCsv, summarizeCsv } from '../shared/csv.mjs';
import { describeJson, parseJson } from '../rooms/data-lab/room.server.mjs';

test('csv parser handles quotes, escaped quotes and embedded newlines', () => {
  const rows = parseCsv('a,b\n1,"x,y"\n2,"line\nbreak"\n3,"say ""hi"""');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['1', 'x,y'],
    ['2', 'line\nbreak'],
    ['3', 'say "hi"'],
  ]);
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']], 'CRLF records');
  assert.throws(() => parseCsv('a,"unterminated'));
});

test('csv summary reports columns, rows and truncation', () => {
  const summary = summarizeCsv('name,role\nAda,engineer\nGrace,admiral', { previewRows: 1 });
  assert.deepEqual(summary.columns, ['name', 'role']);
  assert.equal(summary.rowCount, 2);
  assert.equal(summary.columnCount, 2);
  assert.equal(summary.truncated, true);
  assert.deepEqual(summary.rows, [['Ada', 'engineer']]);
  assert.deepEqual(summarizeCsv('a,,c\n1,2,3').columns, ['a', 'column_2', 'c'], 'blank headers get a name');
});

test('json parse reports a position for invalid input', () => {
  assert.deepEqual(parseJson('{"a":1}'), { ok: true, value: { a: 1 } });
  const bad = parseJson('{\n  "a": ,\n}');
  assert.equal(bad.ok, false);
  assert.ok(bad.line >= 1, `expected a line number, got ${JSON.stringify(bad)}`);
  assert.equal(describeJson([1, 2, 3]), 'array(3)');
  assert.equal(describeJson({ a: 1 }), 'object(1 keys)');
  assert.equal(describeJson(null), 'null');
  assert.equal(describeJson('x'), 'string');
});

test('data lab pretty prints and minifies over HTTP', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const pretty = await hub.api('POST', '/local-rooms/v1/data-lab/json/transform', { text: '{"b":[1,2],"a":true}', mode: 'pretty' });
  assert.equal(pretty.payload.ok, true);
  assert.equal(pretty.payload.value, '{\n  "b": [\n    1,\n    2\n  ],\n  "a": true\n}\n');
  assert.equal(pretty.payload.type, 'object(2 keys)');

  const minified = await hub.api('POST', '/local-rooms/v1/data-lab/json/transform', { text: '{\n "a": 1\n}', mode: 'minify' });
  assert.equal(minified.payload.value, '{"a":1}');

  const validated = await hub.api('POST', '/local-rooms/v1/data-lab/json/transform', { text: '[1,2]', mode: 'validate' });
  assert.equal(validated.payload.type, 'array(2)');

  assert.equal((await hub.api('POST', '/local-rooms/v1/data-lab/json/transform', { text: '{}', mode: 'shout' })).status, 400);
});

test('data lab returns a structured error for invalid json and parses valid json', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const invalid = await hub.api('POST', '/local-rooms/v1/data-lab/json/parse', { text: '{oops}' });
  assert.equal(invalid.payload.ok, false);
  assert.ok(invalid.payload.error.message.length > 0);

  const valid = await hub.api('POST', '/local-rooms/v1/data-lab/json/parse', { text: '{"a": 1}' });
  assert.equal(valid.payload.ok, true);
  assert.equal(valid.payload.minified, '{"a":1}');
  assert.equal(valid.payload.type, 'object(1 keys)');
});

test('data lab csv preview endpoint works and rejects broken csv', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const preview = await hub.api('POST', '/local-rooms/v1/data-lab/csv/preview', { text: 'a,b\n1,2\n3,4' });
  assert.deepEqual(preview.payload.columns, ['a', 'b']);
  assert.equal(preview.payload.rowCount, 2);
  assert.equal(preview.payload.rows.length, 2);

  assert.equal((await hub.api('POST', '/local-rooms/v1/data-lab/csv/preview', { text: '   ' })).status, 400);
  assert.equal((await hub.api('POST', '/local-rooms/v1/data-lab/csv/preview', { text: 'a,"open' })).status, 400);
  assert.deepEqual(await readdir(hub.runtimeDir), [], 'data lab stores nothing');
});
