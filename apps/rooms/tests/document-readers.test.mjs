/**
 * D7b — Document Readers Lab focused tests (room surface and sample builders).
 *
 * The three readers have their own focused suites; this one covers what the room
 * adds: the real engines are reached from the city tree, a synthetic sample is a real
 * document, the reader report is honest about counts and warnings, a refused document
 * is a product answer with a typed code, and nothing is persisted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestHub } from './harness.mjs';
import { SAMPLE_KINDS, buildDocx, buildPdf, buildSample, buildXlsx } from '../rooms/document-readers-lab/samples.mjs';

const API = '/local-rooms/v1/document-readers-lab';
const DONOR_COMMIT = '8df428eaa437a409368401e95194e40266b83080';

async function readSample(hub, kind, extra = {}) {
  const sample = await hub.api('POST', `${API}/sample`, { kind });
  assert.equal(sample.status, 200, JSON.stringify(sample.payload).slice(0, 200));
  const read = await hub.api('POST', `${API}/read`, { kind, base64: sample.payload.base64, fileName: sample.payload.fileName, ...extra });
  return { sample: sample.payload, read };
}

test('a built sample is a real document of its kind', async () => {
  assert.deepEqual(SAMPLE_KINDS, ['xlsx', 'docx', 'pdf']);

  const xlsx = Buffer.from(await buildXlsx());
  assert.equal(xlsx.subarray(0, 2).toString('latin1'), 'PK', 'xlsx is a real ZIP container');
  const docx = Buffer.from(await buildDocx());
  assert.equal(docx.subarray(0, 2).toString('latin1'), 'PK', 'docx is a real ZIP container');
  const pdf = buildPdf();
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-', 'pdf starts with the PDF header');
  assert.match(pdf.toString('latin1'), /startxref/);

  for (const kind of SAMPLE_KINDS) {
    const sample = await buildSample(kind);
    assert.equal(sample.kind, kind);
    assert.ok(sample.bytesLength > 100, `${kind} has real content`);
    assert.match(sample.fileName, new RegExp(`\\.${kind}$`));
  }
  await assert.rejects(() => buildSample('zip'), /unknown sample kind/);
});

test('the room reads all three kinds with the real engines', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  const capabilities = await hub.api('GET', `${API}/capabilities`);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.payload.writes_files, false);
  assert.equal(capabilities.payload.persists_input, false);
  assert.equal(capabilities.payload.donor.commit, DONOR_COMMIT);
  assert.deepEqual(capabilities.payload.donor.sourcePaths, [
    'electron/ingestion/docx-reader.ts',
    'electron/ingestion/xlsx-reader.ts',
    'electron/ingestion/pdf-reader.ts',
  ]);
  assert.equal(capabilities.payload.engines.length, 3);
  assert.ok(capabilities.payload.engines.every((engine) => engine.available), 'all three engines resolve');
  assert.ok(capabilities.payload.engines.every((engine) => /\/city\/node_modules\//.test(engine.resolvedFrom.replace(/\\/g, '/'))), 'all three come from the city tree');
  assert.match(capabilities.payload.reuse.note, /never copies/);
  assert.deepEqual(capabilities.payload.readers.map((reader) => reader.kind), ['docx', 'xlsx', 'pdf']);
  assert.deepEqual(capabilities.payload.samples, [...SAMPLE_KINDS]);

  // xlsx: the sheet becomes a markdown table and the formula-without-cache warns
  const xlsx = await readSample(hub, 'xlsx');
  assert.equal(xlsx.read.payload.ok, true, JSON.stringify(xlsx.read.payload).slice(0, 200));
  assert.equal(xlsx.read.payload.kind, 'xlsx');
  assert.ok(xlsx.read.payload.counts.sheets >= 1, 'at least one sheet');
  assert.ok(xlsx.read.payload.counts.rows >= 3, 'the rows were read');
  assert.match(xlsx.read.payload.preview, /\|/, 'the preview is a markdown table');
  assert.match(xlsx.read.payload.preview, /trust anchor/);
  assert.ok(xlsx.read.payload.warnings.some((warning) => /formula/i.test(warning)), 'a formula without a cached value is reported');

  // docx: paragraphs come back, with the heading and list preserved
  const docx = await readSample(hub, 'docx');
  assert.equal(docx.read.payload.ok, true, JSON.stringify(docx.read.payload).slice(0, 200));
  assert.ok(docx.read.payload.counts.paragraphs >= 4, 'the paragraphs were read');
  assert.match(docx.read.payload.preview, /Intake Note/);
  assert.match(docx.read.payload.preview, /first bullet/);

  // pdf: the page count and its text come back through the real decoder
  const pdf = await readSample(hub, 'pdf');
  assert.equal(pdf.read.payload.ok, true, JSON.stringify(pdf.read.payload).slice(0, 300));
  assert.equal(pdf.read.payload.counts.pages, 1);
  assert.match(JSON.stringify(pdf.read.payload.extraction), /Intake note/);
});

test('a refused document is a product answer with a typed code', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());

  // a ZIP that is not a DOCX
  const notDocx = await hub.api('POST', `${API}/read`, { kind: 'docx', base64: Buffer.from('not a zip').toString('base64') });
  assert.equal(notDocx.status, 200, 'a refusal is a product answer, not a transport error');
  assert.equal(notDocx.payload.ok, false);
  assert.ok(['NOT_DOCX', 'CORRUPT_DOCX', 'ENGINE_UNAVAILABLE'].includes(notDocx.payload.code), notDocx.payload.code);

  const notPdf = await hub.api('POST', `${API}/read`, { kind: 'pdf', base64: Buffer.from('plain text').toString('base64') });
  assert.equal(notPdf.payload.ok, false);
  assert.ok(['NOT_PDF', 'CORRUPT_PDF'].includes(notPdf.payload.code), notPdf.payload.code);

  const notXlsx = await hub.api('POST', `${API}/read`, { kind: 'xlsx', base64: Buffer.from('plain text').toString('base64') });
  assert.equal(notXlsx.payload.ok, false);
  assert.ok(['NOT_XLSX', 'CORRUPT_XLSX'].includes(notXlsx.payload.code), notXlsx.payload.code);

  // a reader limit is honoured, and it is the room that explains it
  const sample = await hub.api('POST', `${API}/sample`, { kind: 'pdf' });
  const limited = await hub.api('POST', `${API}/read`, { kind: 'pdf', base64: sample.payload.base64, limits: { maxBytes: 16 } });
  assert.equal(limited.payload.ok, false);
  assert.equal(limited.payload.code, 'TOO_LARGE');

  // the room refuses a payload it cannot serve at all
  const badKind = await hub.api('POST', `${API}/read`, { kind: 'zip', base64: sample.payload.base64 });
  assert.equal(badKind.status, 400);
  const badBase64 = await hub.api('POST', `${API}/read`, { kind: 'pdf' });
  assert.equal(badBase64.status, 400);
  const unknownLimit = await hub.api('POST', `${API}/read`, { kind: 'pdf', base64: sample.payload.base64, limits: { maxNope: 1 } });
  assert.equal(unknownLimit.status, 400);
  const badSample = await hub.api('POST', `${API}/sample`, { kind: 'zip' });
  assert.equal(badSample.status, 400);
});

test('the lab writes no runtime file and carries no engine of its own', async (t) => {
  const hub = await startTestHub();
  t.after(() => hub.stop());
  const { readdir, readFile } = await import('node:fs/promises');
  const { join } = await import('node:path');

  await readSample(hub, 'xlsx');
  assert.deepEqual(await readdir(hub.runtimeDir), [], 'the lab has no durable file: the input is never persisted');

  const roomDir = join(import.meta.dirname, '..', 'rooms', 'document-readers-lab');
  const files = (await readdir(roomDir)).filter((name) => name.endsWith('.mjs')).sort();
  assert.deepEqual(files, ['client.mjs', 'docx.mjs', 'engine-bridge.mjs', 'pdf.mjs', 'room.server.mjs', 'samples.mjs', 'xlsx.mjs']);
  for (const file of files) {
    const code = (await readFile(join(roomDir, file), 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    for (const forbidden of ["require('", 'from "app/', "from 'app/", 'writeFileSync', "from 'fflate'", "from 'mammoth'", "from 'pdfjs-dist'"]) {
      assert.ok(!code.includes(forbidden), `${file} must not ${forbidden}`);
    }
    for (const specifier of [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1])) {
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
  }
  // the engines and the XML helpers come from the promoted city modules
  const bridge = await readFile(join(roomDir, 'engine-bridge.mjs'), 'utf8');
  assert.match(bridge, /document-readers\/engines\.mjs/, 'the engine seam is reached through the bridge');
  assert.match(bridge, /ingestion-core\/ingestion-core\.mjs/, 'the XML helpers are reused, not copied');
});
