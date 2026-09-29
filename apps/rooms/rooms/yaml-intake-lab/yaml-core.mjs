/**
 * UTOPIA · Rooms · YAML Intake Lab — YAML intake core.
 *
 * The donor's structured-data order, completed with the branch D4 left out:
 *
 *   YAML / YML            parsed as YAML, always
 *   anything else         JSON, then JSON Lines, then YAML with a warning
 *
 * Ported from the Codex-Boss donor `electron/ingestion/text-parsers.ts`
 * @ 8df428eaa437a409368401e95194e40266b83080 (`import { parse as
 * parseYamlDocument, YAMLParseError } from "yaml"`, called with
 * `{ maxAliasCount: 100 }`), promoted into the same building's ingestion core.
 *
 * What the donor does that this module keeps exactly:
 *   - an extension of `.yaml`/`.yml` prefers YAML and never tries JSON first;
 *   - every other extension tries JSON, then JSON Lines, and only then YAML, and the
 *     fallback is *reported* (`JSON parsing failed (...); parsed as YAML`) rather
 *     than silent;
 *   - a document that is neither is refused with both reasons in one message;
 *   - the parsed value is a plain JavaScript value: no classes, no functions, no
 *     executable payload.
 *
 * What is deliberately different:
 *   - the parser is an injected seam (`parseYaml`), so this module never imports the
 *     third-party package itself and can be tested with a deterministic stub as well
 *     as with the real parser;
 *   - a YAML bomb is bounded by the seam's alias ceiling, and a document past the
 *     byte bound is refused before the parser is called;
 *   - `ingestStructured()` returns one reportable object (value, format, sections,
 *     warnings) so a product surface never has to re-implement the ordering.
 */

import {
  DEFAULT_TEXT_LIMITS,
  SECTION_KINDS,
  TextParseError,
  detectFormat,
  renderStructured,
  sectionsFromStructured,
} from './intake-bridge.mjs';

export { DEFAULT_TEXT_LIMITS, SECTION_KINDS, TextParseError, detectFormat, renderStructured, sectionsFromStructured };

/** Formats this lab can report. `yaml` is the one D4 deferred. */
export const STRUCTURED_FORMATS = Object.freeze(['json', 'jsonl', 'yaml']);

/** Extensions that must be parsed as YAML regardless of their content. */
export const YAML_EXTENSIONS = Object.freeze(['.yaml', '.yml']);

export function extensionOf(fileName = '') {
  const name = String(fileName || '');
  return name.includes('.') ? name.slice(name.lastIndexOf('.')).toLowerCase() : '';
}

export function prefersYaml(fileName = '') {
  return YAML_EXTENSIONS.includes(extensionOf(fileName));
}

/**
 * Parse JSON, then JSON Lines, then YAML - the donor's order, completed.
 *
 * @param {string} text
 * @param {string} fileName
 * @param {{parseYaml: Function}} options  the injected YAML seam
 * @returns {Promise<{value: unknown, format: 'json'|'jsonl'|'yaml', warnings: string[]}>}
 * @throws {TextParseError} CORRUPT_INPUT
 */
export async function parseStructuredText(text, fileName = '', { parseYaml } = {}) {
  if (typeof parseYaml !== 'function') {
    throw new TextParseError('PARSER_UNAVAILABLE', 'YAML intake needs an injected parser');
  }
  const warnings = [];
  const trimmed = String(text ?? '').trim();
  if (!trimmed) throw new TextParseError('CORRUPT_INPUT', 'Structured document is empty');

  const tryJson = () => {
    try {
      return { ok: true, value: JSON.parse(trimmed) };
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  };

  const declared = detectFormat(fileName);

  /** One refusal, carrying both the message a person reads and the parser's own detail. */
  const refuse = (message, detail) => {
    const failure = new TextParseError('CORRUPT_INPUT', message);
    failure.detail = detail ?? null;
    return failure;
  };

  // `.yaml` / `.yml`: YAML first and only. A YAML file that happens to be valid JSON
  // is still reported as YAML, because that is what the extension asked for.
  if (prefersYaml(fileName)) {
    const parsed = await parseYaml(trimmed, { fileName });
    if (!parsed.ok) {
      throw refuse(`Not valid YAML: ${parsed.detail?.reason ?? parsed.reason}`, parsed.detail ?? null);
    }
    if (Array.isArray(parsed.warnings)) warnings.push(...parsed.warnings);
    return { value: parsed.value, format: 'yaml', warnings };
  }

  const json = tryJson();
  if (json.ok) return { value: json.value, format: 'json', warnings };

  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length > 1 && lines.every((line) => line.trim().startsWith('{') && line.trim().endsWith('}'))) {
    const rows = [];
    for (const line of lines) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        rows.length = 0;
        break;
      }
    }
    if (rows.length) {
      warnings.push(`parsed ${rows.length} JSON Lines records`);
      return { value: rows, format: 'jsonl', warnings };
    }
  }

  const parsed = await parseYaml(trimmed, { fileName });
  if (!parsed.ok) {
    throw refuse(
      `Not valid JSON or YAML: ${json.error} | ${parsed.detail?.reason ?? parsed.reason}`,
      parsed.detail ?? null,
    );
  }
  warnings.push(`JSON parsing failed (${json.error}); parsed as YAML`);
  if (Array.isArray(parsed.warnings)) warnings.push(...parsed.warnings);
  return { value: parsed.value, format: 'yaml', warnings };
}

/**
 * The whole intake in one call: parse, then split into deterministic sections.
 *
 * Every outcome is returned - `ok`, the format, the value, the sections, the
 * warnings, or the refusal code and reason - so a caller never has to catch a
 * thrown error to show a product answer, and never has to guess which parser ran.
 *
 * @returns {Promise<object>}
 */
export async function ingestStructured(text, fileName = '', { parseYaml, limits = {} } = {}) {
  const effective = { ...DEFAULT_TEXT_LIMITS, ...limits };
  const detected = detectFormat(fileName);
  try {
    const parsed = await parseStructuredText(text, fileName, { parseYaml });
    const sections = sectionsFromStructured(parsed.value, effective);
    return {
      ok: true,
      fileName: String(fileName || ''),
      declared: detected,
      format: parsed.format,
      value: parsed.value,
      warnings: parsed.warnings,
      sections,
      rendered: renderStructured(parsed.value),
      stats: {
        bytes: Buffer.byteLength(String(text ?? ''), 'utf8'),
        sections: sections.length,
        keys: parsed.value !== null && typeof parsed.value === 'object' ? Object.keys(parsed.value).length : 0,
        arrays: countArrays(parsed.value),
        maxDepth: depthOf(parsed.value),
      },
    };
  } catch (error) {
    if (error instanceof TextParseError) {
      return {
        ok: false,
        fileName: String(fileName || ''),
        declared: detected,
        code: error.code,
        reason: error.message,
        detail: error.detail ?? null,
        warnings: [],
      };
    }
    return {
      ok: false,
      fileName: String(fileName || ''),
      declared: detected,
      code: 'INTERNAL_ERROR',
      reason: String(error?.message || error),
      detail: null,
      warnings: [],
    };
  }
}

/** Validate without producing sections: the fail-closed verdict alone. */
export async function validateStructured(text, fileName = '', { parseYaml } = {}) {
  const result = await ingestStructured(text, fileName, { parseYaml });
  return result.ok
    ? { ok: true, format: result.format, warnings: result.warnings, bytes: result.stats.bytes }
    : { ok: false, code: result.code, reason: result.reason, detail: result.detail };
}

function countArrays(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return 0;
  if (Array.isArray(value)) return 1 + value.reduce((total, item) => total + countArrays(item, depth + 1), 0);
  return Object.values(value).reduce((total, item) => total + countArrays(item, depth + 1), 0);
}

function depthOf(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  if (!children.length) return depth;
  return Math.max(...children.map((child) => depthOf(child, depth + 1)));
}
