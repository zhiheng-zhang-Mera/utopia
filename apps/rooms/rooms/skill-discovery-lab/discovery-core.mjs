/**
 * UTOPIA · Rooms · Skill Discovery Lab — discovery core surface.
 *
 * One place that wires the two ported donor modules together and fixes the
 * sandbox root the room is allowed to scan. Tests import this module, the room
 * imports this module, and neither carries its own copy of the logic.
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export {
  GITHUB_HOSTS,
  RAW_HOSTS,
  SCAFFOLD_DIRS,
  archiveUrls,
  collectFrom,
  diskAdapter,
  inspectLocalPath,
  locateSkills,
  normalizeSubpath,
  parseGithubReference,
  refCandidates,
  resolutionPlan,
  scanDirectory,
} from './source.mjs';

export {
  BUNDLED_SKILLS,
  CURATED_COLLECTIONS,
  DEFAULT_SEARCH_LIMIT,
  GITHUB_API,
  createCatalog,
  renderCatalogSkill,
} from './catalog.mjs';

/** The only directory tree the room is allowed to scan. */
export const SAFE_SCAN_ROOT = resolve(fileURLToPath(new URL('./samples', import.meta.url)));

/** A short human description of a parsed reference, for the UI. */
export function describeRef(ref) {
  if (!ref || typeof ref !== 'object') return 'unknown reference';
  if (ref.kind === 'repo') return `repository ${ref.owner}/${ref.repo}${ref.branch ? ` @ ${ref.branch}` : ''}${ref.subpath ? ` (${ref.subpath})` : ''}`;
  if (ref.kind === 'treeDir') return `directory ${ref.owner}/${ref.repo} (${ref.refCandidates?.length ?? 0} ref split(s) to probe)`;
  if (ref.kind === 'blobFile') return `file ${ref.owner}/${ref.repo} (${ref.refCandidates?.length ?? 0} ref split(s) to probe)`;
  if (ref.kind === 'rawFile') return `raw file ${ref.owner}/${ref.repo}@${ref.branch}/${ref.subpath ?? ''}`;
  if (ref.kind === 'url') return `direct URL ${ref.url}`;
  return `unknown reference kind ${ref.kind}`;
}
