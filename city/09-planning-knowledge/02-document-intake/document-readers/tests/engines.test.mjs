/**
 * UTOPIA · City · Document Intake — engine seam tests.
 *
 * The seam is the only module in the city tree that names fflate, mammoth or
 * pdfjs-dist, so these tests check what must be true of a quarantine: the packages
 * resolve from the city tree (not the app), they are loaded lazily, and a missing
 * install is reported as an installation problem rather than as a broken document.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ENGINE_PACKAGES,
  EngineUnavailableError,
  engineProvenance,
  enginesProvenance,
  loadFflate,
  loadMammoth,
  loadPdfjs,
  resetEngineCache,
} from '../engines.mjs';

test('every engine is named in one module and resolves from the city tree', async () => {
  assert.deepEqual(Object.keys(ENGINE_PACKAGES).sort(), ['fflate', 'mammoth', 'pdfjs']);

  const provenance = enginesProvenance();
  assert.equal(provenance.length, 3);
  for (const engine of provenance) {
    assert.equal(engine.available, true, `${engine.package} resolves`);
    assert.match(engine.resolvedFrom.replace(/\\/g, '/'), /\/city\/node_modules\//, `${engine.package} resolves from city/`);
    assert.equal(engine.quarantinedIn, 'city/09-planning-knowledge/02-document-intake/document-readers/engines.mjs');
  }
  assert.equal(engineProvenance('pdfjs').package, 'pdfjs-dist');
  assert.throws(() => engineProvenance('nope'), /unknown engine/);

  // the readers directory must not name an engine package outside this seam
  const moduleDir = join(import.meta.dirname, '..');
  const files = (await readdir(moduleDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'))
    .map((entry) => entry.name)
    .sort();
  assert.ok(files.includes('engines.mjs'));
  for (const file of files.filter((name) => name !== 'engines.mjs')) {
    const code = await readFile(join(moduleDir, file), 'utf8');
    const specifiers = [
      ...[...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]),
      ...[...code.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]),
    ];
    for (const specifier of specifiers) {
      assert.ok(!Object.values(ENGINE_PACKAGES).includes(specifier), `${file} must not import ${specifier} directly`);
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${file} imports ${specifier}`);
    }
    assert.ok(!code.includes('ENGINE_PACKAGES.'), `${file} must go through the seam, not around it`);
  }
});

test('the engines really load and expose what the readers need', async () => {
  resetEngineCache();
  const fflate = await loadFflate();
  assert.equal(typeof fflate.unzipSync, 'function');
  assert.equal(typeof fflate.zipSync, 'function');
  assert.equal(typeof fflate.strToU8, 'function');

  // a real round-trip through the engine, not a shape check
  const packed = fflate.zipSync({ 'a.txt': fflate.strToU8('hello') });
  const unpacked = fflate.unzipSync(packed);
  assert.equal(fflate.strFromU8(unpacked['a.txt']), 'hello');

  const mammoth = await loadMammoth();
  assert.ok(typeof mammoth.convertToHtml === 'function' || typeof mammoth.convertToMarkdown === 'function');

  const pdfjs = await loadPdfjs();
  assert.equal(typeof pdfjs.getDocument, 'function');
  assert.match(String(pdfjs.version), /^\d+\.\d+/);
});

test('a missing install is an installation problem, not a broken document', () => {
  const unavailable = new EngineUnavailableError('fflate', 'simulated');
  assert.equal(unavailable.code, 'ENGINE_UNAVAILABLE');
  assert.equal(unavailable.engine, 'fflate');
  assert.match(unavailable.message, /pnpm --dir city install --frozen-lockfile/);
  assert.equal(unavailable.detail, 'simulated');
});
