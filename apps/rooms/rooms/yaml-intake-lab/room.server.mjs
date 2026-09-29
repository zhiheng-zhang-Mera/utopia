/**
 * UTOPIA · Rooms · Room D7a — YAML Intake Lab (server).
 *
 * Incubator for the YAML branch the D4 document intake deliberately left out: paste
 * a YAML document, get plain data and deterministic sections back, or get a
 * fail-closed refusal with the parser's own reason. Nested maps and sequences are
 * first-class, and the JSON -> JSON Lines -> YAML order is visible rather than
 * implied.
 *
 * Donor: zhiheng-zhang-Mera/Codex-Boss @ 8df428eaa437a409368401e95194e40266b83080
 *        electron/ingestion/text-parsers.ts (the YAML branch of parseStructuredText)
 *
 * The third-party parser itself belongs to the city tree: this room never imports
 * the `yaml` package, it injects the city seam. Nothing is persisted and no file is
 * written.
 */

import { createRouter, sendJson } from '../../shared/http.mjs';
import { RoomValidationError } from '../../shared/room-kit.mjs';
import {
  DEFAULT_TEXT_LIMITS,
  SECTION_KINDS,
  STRUCTURED_FORMATS,
  YAML_EXTENSIONS,
  ingestStructured,
  validateStructured,
} from './yaml-core.mjs';
import {
  MAX_ALIAS_COUNT,
  MAX_YAML_BYTES,
  tryParseYaml,
  yamlParserProvenance,
} from './intake-bridge.mjs';

const DONOR = Object.freeze({
  repository: 'zhiheng-zhang-Mera/Codex-Boss',
  commit: '8df428eaa437a409368401e95194e40266b83080',
  sourcePaths: ['electron/ingestion/text-parsers.ts'],
  branch: 'parseStructuredText: the YAML branch of the structured-data parser',
});

/** The injected seam. The room's only link to the third-party parser. */
const parseYaml = (text, options = {}) => tryParseYaml(text, options);

function requireObject(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new RoomValidationError('payload must be a JSON object');
  }
  return payload;
}

function requireText(payload) {
  if (typeof payload.text !== 'string') throw new RoomValidationError('text must be a string');
  if (payload.limits !== undefined && (payload.limits === null || typeof payload.limits !== 'object' || Array.isArray(payload.limits))) {
    throw new RoomValidationError('limits must be a JSON object');
  }
  const limits = {};
  for (const [key, value] of Object.entries(payload.limits ?? {})) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_TEXT_LIMITS, key) && key !== 'maxYamlBytes') {
      throw new RoomValidationError(`limits.${key} is not a known limit`);
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) throw new RoomValidationError(`limits.${key} must be a positive number`);
    limits[key] = numeric;
  }
  return { text: payload.text, fileName: String(payload.fileName ?? ''), limits };
}

/** Create the YAML Intake Lab route handler (no durable store). */
export function createYamlIntakeRoom() {
  const route = createRouter([
    {
      method: 'GET',
      pattern: '/capabilities',
      handle: async ({ res }) => {
        sendJson(res, 200, {
          room: 'yaml-intake-lab',
          installs: false,
          writes_files: false,
          donor: DONOR,
          formats: STRUCTURED_FORMATS,
          yaml_extensions: YAML_EXTENSIONS,
          detection_order: ['json', 'jsonl', 'yaml (with a warning)'],
          extension_rule: 'a .yaml or .yml document is parsed as YAML first and only',
          limits: DEFAULT_TEXT_LIMITS,
          parser: {
            ...yamlParserProvenance(),
            maxAliasCount: MAX_ALIAS_COUNT,
            maxBytes: MAX_YAML_BYTES,
          },
          reuse: {
            core: 'city/09-planning-knowledge/02-document-intake/ingestion-core/ingestion-core.mjs',
            seam: 'city/09-planning-knowledge/02-document-intake/ingestion-core/yaml-parser.mjs',
            note: 'the renderer, section splitter, limits and typed error come from the promoted city core; this room never copies them',
          },
          section_kinds: SECTION_KINDS,
        });
      },
    },
    {
      method: 'POST',
      pattern: '/yaml/parse',
      handle: async ({ res, readJson }) => {
        const { text, fileName, limits } = requireText(requireObject(await readJson()));
        const result = await ingestStructured(text, fileName, { parseYaml, limits });
        sendJson(res, 200, result);
      },
    },
    {
      method: 'POST',
      pattern: '/yaml/validate',
      handle: async ({ res, readJson }) => {
        const { text, fileName, limits } = requireText(requireObject(await readJson()));
        sendJson(res, 200, await validateStructured(text, fileName, { parseYaml, limits }));
      },
    },
  ]);

  return { id: 'yaml-intake-lab', handle: route };
}
