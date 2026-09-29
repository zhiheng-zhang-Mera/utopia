/**
 * UTOPIA · Rooms · YAML Intake Lab — bridge to the promoted document intake core.
 *
 * The structured-data renderer, the section splitter, the input limits and the typed
 * parse error already live in the promoted city module
 * `city/09-planning-knowledge/02-document-intake/ingestion-core`. This lab must never
 * carry a second copy of them, so it imports them through this one bridge. The YAML
 * parser seam is reached the same way, because the `yaml` package is installed for
 * the city tree and nowhere else.
 *
 * At promotion the bridge disappears and these imports become the ingestion core's
 * own relative imports.
 */

export {
  DEFAULT_TEXT_LIMITS,
  SECTION_KINDS,
  TextParseError,
  detectFormat,
  renderStructured,
  sectionsFromStructured,
} from '../../../../city/09-planning-knowledge/02-document-intake/ingestion-core/ingestion-core.mjs';

export {
  MAX_ALIAS_COUNT,
  MAX_YAML_BYTES,
  YAML_PACKAGE,
  YamlParserError,
  parseYamlDocument,
  tryParseYaml,
  yamlParserProvenance,
} from '../../../../city/09-planning-knowledge/02-document-intake/ingestion-core/yaml-parser.mjs';
