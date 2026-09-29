/**
 * UTOPIA · Rooms · Document Readers Lab — bridge to the promoted building.
 *
 * The XML text helpers already live in
 * `city/09-planning-knowledge/02-document-intake/ingestion-core`, and the three
 * third-party engines are quarantined in
 * `city/09-planning-knowledge/02-document-intake/document-readers/engines.mjs`. This
 * lab must never carry a second copy of either, so its readers import them through
 * this one bridge. At promotion the bridge disappears and these imports become the
 * readers' own relative imports.
 */

export {
  DEFAULT_TEXT_LIMITS,
  TextParseError,
  decodeText,
  extractTextRuns,
  matchBlocks,
  unescapeXml,
} from '../../../../city/09-planning-knowledge/02-document-intake/ingestion-core/ingestion-core.mjs';

export {
  ENGINE_PACKAGES,
  EngineUnavailableError,
  engineProvenance,
  enginesProvenance,
  loadFflate,
  loadMammoth,
  loadPdfjs,
  resetEngineCache,
} from '../../../../city/09-planning-knowledge/02-document-intake/document-readers/engines.mjs';
