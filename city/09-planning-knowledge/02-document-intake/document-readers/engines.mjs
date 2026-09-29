/**
 * UTOPIA · City · Document Intake — document reader engine seam.
 *
 * The three office/PDF readers need three third-party engines, and this is the only
 * module in the city tree that names them:
 *
 *   fflate        XLSX container decompression (pinned 0.8.3)
 *   mammoth       DOCX -> HTML/text conversion (pinned 1.12.2)
 *   pdfjs-dist    PDF text extraction (pinned 6.3.289, legacy build)
 *
 * Every engine is loaded lazily and reported honestly. A missing install is
 * `ENGINE_UNAVAILABLE`, which is a different answer from "this document is broken":
 * the first is an installation problem, the second is a document problem, and a
 * caller that conflates them tells the operator to fix the wrong thing.
 *
 * The readers themselves are pure: they take bytes and return sections, so this
 * seam is also the only place that ever touches the engine's module namespace.
 */

import { createRequire } from 'node:module';

/** Engine package names, kept in one place so the quarantine is greppable. */
export const ENGINE_PACKAGES = Object.freeze({
  fflate: 'fflate',
  mammoth: 'mammoth',
  pdfjs: 'pdfjs-dist',
});

/** Typed failure raised by this seam. */
export class EngineUnavailableError extends Error {
  constructor(engine, detail = null) {
    super(`the ${engine} engine is not available for the city tree (run: pnpm --dir city install --frozen-lockfile)`);
    this.name = 'EngineUnavailableError';
    this.code = 'ENGINE_UNAVAILABLE';
    this.engine = engine;
    this.detail = detail;
  }
}

const require = createRequire(import.meta.url);
const cache = new Map();

/** Where a package really resolves from, for provenance and diagnostics. */
export function engineProvenance(engine) {
  const name = ENGINE_PACKAGES[engine];
  if (!name) throw new Error(`unknown engine "${engine}"`);
  let resolved = null;
  try {
    resolved = require.resolve(`${name}/package.json`);
  } catch {
    resolved = null;
  }
  return {
    engine,
    package: name,
    available: resolved !== null,
    resolvedFrom: resolved,
    quarantinedIn: 'city/09-planning-knowledge/02-document-intake/document-readers/engines.mjs',
  };
}

/** Every engine this building depends on, with its resolution state. */
export function enginesProvenance() {
  return Object.keys(ENGINE_PACKAGES).map((engine) => engineProvenance(engine));
}

async function load(engine, importer) {
  if (cache.has(engine)) return cache.get(engine);
  const name = ENGINE_PACKAGES[engine];
  if (!name) throw new Error(`unknown engine "${engine}"`);
  let namespace;
  try {
    namespace = await importer();
  } catch (error) {
    throw new EngineUnavailableError(engine, String(error?.message || error));
  }
  cache.set(engine, namespace);
  return namespace;
}

/** fflate, for the XLSX/DOCX container reader and for building a sample package. */
export async function loadFflate() {
  const namespace = await load('fflate', () => import(ENGINE_PACKAGES.fflate));
  if (typeof namespace.unzipSync !== 'function') throw new EngineUnavailableError('fflate', 'the package does not expose unzipSync()');
  return {
    unzipSync: namespace.unzipSync,
    zipSync: namespace.zipSync,
    strToU8: namespace.strToU8,
    strFromU8: namespace.strFromU8,
    version: namespace.version ?? null,
  };
}

/** mammoth, for the DOCX reader. */
export async function loadMammoth() {
  const namespace = await load('mammoth', () => import(ENGINE_PACKAGES.mammoth));
  const api = namespace.default ?? namespace;
  if (typeof api.convertToHtml !== 'function' && typeof api.convertToMarkdown !== 'function') {
    throw new EngineUnavailableError('mammoth', 'the package exposes neither convertToHtml() nor convertToMarkdown()');
  }
  return api;
}

/**
 * pdfjs-dist legacy build, for the PDF reader.
 *
 * The legacy build is the one that runs without a browser worker, which is what a
 * local city module needs: no worker file to serve, no DOM, no bundler.
 */
export async function loadPdfjs() {
  const namespace = await load('pdfjs', () => import(`${ENGINE_PACKAGES.pdfjs}/legacy/build/pdf.mjs`));
  if (typeof namespace.getDocument !== 'function') throw new EngineUnavailableError('pdfjs', 'the legacy build does not expose getDocument()');
  return namespace;
}

/** Test seam: drop every cached engine namespace. */
export function resetEngineCache() {
  cache.clear();
}
