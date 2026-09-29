/**
 * UTOPIA · City · Document Intake — isolated YAML parser seam.
 *
 * This is the first third-party parser the city tree owns, so it is quarantined
 * here on purpose: it is the only module in the document-intake building that names
 * the `yaml` package, and it is the only place an external dependency is imported
 * from. Everything that *uses* YAML (the ingestion core, the incubator room, the
 * readers) works through this seam, so replacing or removing the package is a
 * one-file change.
 *
 * Rules this seam enforces:
 *   - the dependency is imported lazily, so a caller that never ingests YAML never
 *     loads it;
 *   - aliases are bounded (`maxAliasCount`): a YAML bomb is refused, not resolved;
 *   - every parse outcome is a plain result object, and a parse failure is a typed
 *     `YAML_INVALID` error carrying the parser's own message and line - never a raw
 *     exception from the third-party library;
 *   - an unavailable package is reported as `YAML_PARSER_UNAVAILABLE`, which is a
 *     different answer from "this document is not valid YAML".
 *
 * Donor: zhiheng-zhang-Mera/Codex-Boss `electron/ingestion/text-parsers.ts`
 * @ 8df428eaa437a409368401e95194e40266b83080, which imports
 * `{ parse as parseYamlDocument, YAMLParseError } from "yaml"` and calls it with
 * `{ maxAliasCount: 100 }`.
 */

import { createRequire } from 'node:module';

/** Package name, kept in one place so the quarantine is greppable. */
export const YAML_PACKAGE = 'yaml';

/** Alias ceiling for one document. The donor's number, kept exactly. */
export const MAX_ALIAS_COUNT = 100;

/** Largest YAML document this seam will hand to the parser (bytes of UTF-8). */
export const MAX_YAML_BYTES = 4 * 1024 * 1024;

/** Typed failure raised by the seam. Code is always one of the two below. */
export class YamlParserError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = 'YamlParserError';
    this.code = code;
    this.detail = detail;
  }
}

const require = createRequire(import.meta.url);

let cached = null;

/**
 * Load the parser once. Resolution happens through this file's own directory, so
 * the package is looked up in `city/node_modules` and never in the app's.
 */
export async function loadYamlParser() {
  if (cached) return cached;
  try {
    const namespace = await import(YAML_PACKAGE);
    const parse = namespace.parse;
    if (typeof parse !== 'function') {
      throw new YamlParserError('YAML_PARSER_UNAVAILABLE', `the ${YAML_PACKAGE} package does not expose parse()`);
    }
    cached = { parse, YAMLParseError: namespace.YAMLParseError ?? null, name: namespace.default?.name ?? YAML_PACKAGE };
    return cached;
  } catch (error) {
    if (error instanceof YamlParserError) throw error;
    throw new YamlParserError(
      'YAML_PARSER_UNAVAILABLE',
      `the ${YAML_PACKAGE} package is not installed for the city tree (run: pnpm --dir city install --frozen-lockfile)`,
      String(error?.message || error),
    );
  }
}

/** Where the package really resolves from, for provenance and diagnostics. */
export function yamlParserProvenance() {
  let resolved = null;
  try {
    resolved = require.resolve(`${YAML_PACKAGE}/package.json`);
  } catch {
    resolved = null;
  }
  return {
    package: YAML_PACKAGE,
    resolvedFrom: resolved,
    quarantinedIn: 'city/09-planning-knowledge/02-document-intake/ingestion-core/yaml-parser.mjs',
    maxAliasCount: MAX_ALIAS_COUNT,
    maxBytes: MAX_YAML_BYTES,
  };
}

/**
 * Parse one YAML document.
 *
 * @param {string} text
 * @param {{maxBytes?: number, maxAliasCount?: number, tolerateEmpty?: boolean}} [options]
 * @returns {Promise<{ok: true, value: unknown, warnings: string[]}>}
 * @throws {YamlParserError} YAML_INVALID or YAML_PARSER_UNAVAILABLE
 */
export async function parseYamlDocument(text, { maxBytes = MAX_YAML_BYTES, maxAliasCount = MAX_ALIAS_COUNT, tolerateEmpty = false } = {}) {
  const source = String(text ?? '');
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes > maxBytes) {
    throw new YamlParserError('YAML_INVALID', `YAML document is ${bytes} bytes, above the ${maxBytes} byte limit`, { bytes, maxBytes });
  }
  if (!source.trim()) {
    if (tolerateEmpty) return { ok: true, value: null, warnings: ['the YAML document is empty'] };
    throw new YamlParserError('YAML_INVALID', 'YAML document is empty');
  }
  const { parse, YAMLParseError } = await loadYamlParser();
  try {
    const value = parse(source, { maxAliasCount });
    return { ok: true, value: value === undefined ? null : value, warnings: [] };
  } catch (error) {
    const detail = YAMLParseError && error instanceof YAMLParseError ? error.message : String(error?.message || error);
    const line = Array.isArray(error?.linePos) && error.linePos.length ? error.linePos[0] : null;
    throw new YamlParserError('YAML_INVALID', `not valid YAML: ${detail}`, {
      reason: detail,
      line: line?.line ?? null,
      column: line?.col ?? null,
    });
  }
}

/**
 * Parse a YAML document and fail closed with a single reason string, for callers
 * that report one message rather than a code. A missing package stays a distinct
 * outcome: it is an installation problem, not a document problem.
 */
export async function tryParseYaml(text, options) {
  try {
    const parsed = await parseYamlDocument(text, options);
    return { ok: true, ...parsed };
  } catch (error) {
    if (error instanceof YamlParserError) {
      return { ok: false, code: error.code, reason: error.message, detail: error.detail };
    }
    return { ok: false, code: 'YAML_INVALID', reason: String(error?.message || error), detail: null };
  }
}

/** Test seam: drop the cached parser (used by the focused suite only). */
export function resetYamlParserCache() {
  cached = null;
}
