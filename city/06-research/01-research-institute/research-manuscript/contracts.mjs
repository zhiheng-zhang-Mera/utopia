/**
 * UTOPIA · Research Institute — research manuscript contracts.
 *
 * The frozen vocabularies and value shapes a manuscript is assembled from, as data
 * plus copy-on-construct factories and strict validators. Nothing here is a runtime:
 * there is no writer model, no reviewer process, no LaTeX engine and no file system,
 * because a manuscript record must stay readable on its own years later.
 *
 * Donor: Codex-Boss `src/shared/research-figures.ts` and
 * `src/shared/research-manuscript.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 *
 * Two kinds of things live here, and they are deliberately different:
 *
 *   1. VOCABULARY — the donor's literal constants, copied verbatim:
 *      MANUSCRIPT_SECTIONS, SECTION_STATUSES, the figure defaults
 *      (`480 x 260`, title `"Metric"`, 40 bounded rows, 24/80/40-character
 *      label bounds) and the §18 obligation labels.
 *   2. FACTORIES — `manuscriptPlan`, `sectionBrief`, `sectionDraft`,
 *      `figureOptions`, `resultTable` and friends. Each one validates its input
 *      and returns a NEW deeply frozen copy. A factory never repairs, coerces,
 *      defaults or trims: an input it will not accept throws a TypeError, and an
 *      input it accepts comes back unchanged in value. Validation is the single
 *      gate, so the same shapes can be checked without being constructed by
 *      calling the matching `validate*` function.
 *
 * The factories are a UTOPIA extension: the donor validated three shapes inline
 * (`validateManuscriptPlan`) or not at all. They add no rule to the renderers —
 * `figures.mjs` and `manuscript.mjs` keep the donor's own permissiveness, so a
 * value the donor renders (for example a non-finite bar value, which the donor
 * prints as `n/a`) still renders here. The factories are for callers that want the
 * shape guaranteed before it reaches the renderer.
 */

/** The six sections of a manuscript, in the donor's assembly order. */
export const MANUSCRIPT_SECTIONS = Object.freeze([
  'abstract',
  'introduction',
  'methods',
  'results',
  'discussion',
  'conclusion',
]);

/**
 * A section's pipeline status, in the order the donor's pipeline reaches them:
 * PENDING → BRIEFED → DRAFTED → REVIEWED → EVIDENCE_CHECKED → REVISED.
 */
export const SECTION_STATUSES = Object.freeze([
  'PENDING',
  'BRIEFED',
  'DRAFTED',
  'REVIEWED',
  'EVIDENCE_CHECKED',
  'REVISED',
]);

/** Figure defaults from the donor `metricFigureSvg` (`options.width ?? 480`). */
export const FIGURE_DEFAULT_WIDTH = 480;

/** Figure defaults from the donor `metricFigureSvg` (`options.height ?? 260`). */
export const FIGURE_DEFAULT_HEIGHT = 260;

/** Figure defaults from the donor `metricFigureSvg` (`options.title ?? "Metric"`). */
export const FIGURE_DEFAULT_TITLE = 'Metric';

/** The donor's figure text bounds: bars are sliced to 40, labels sliced to 24. */
export const FIGURE_MAX_BARS = 40;

/** The donor's figure text bounds: a bar label is sliced to 24 characters. */
export const FIGURE_MAX_LABEL = 24;

/** The donor's figure text bounds: a title is sliced to 80 characters. */
export const FIGURE_MAX_TITLE = 80;

/** The donor's figure text bounds: a y-axis label is sliced to 40 characters. */
export const FIGURE_MAX_YLABEL = 40;

/**
 * The §18 section sufficiency obligation labels, in the donor's declaration order.
 * These are the exact strings `sectionSufficiency` reports in `unmet`.
 */
export const SECTION_OBLIGATION_LABELS = Object.freeze({
  abstract: Object.freeze(['states the research question', 'reports the recorded result from evidence']),
  introduction: Object.freeze(['identifies the gap in existing work', 'states what this paper does']),
  methods: Object.freeze([
    'describes a frozen protocol',
    'specifies metric/baseline/criterion',
    'describes deterministic statistics',
  ]),
  results: Object.freeze([
    'reports a number from recorded runs (no bare comparison)',
    'ties the result to its statistic/confidence',
  ]),
  discussion: Object.freeze(['interprets the result within evidence', 'reports limitations (no hidden threats)']),
  conclusion: Object.freeze(['ties the conclusion to the recorded evidence']),
});

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, field) {
  if (!isPlainObject(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function requireText(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} must be a non-empty string`);
  return value;
}

function requireArray(value, field) {
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`);
  return value;
}

function requireCount(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative finite number`);
  }
  return value;
}

function requireVocabulary(value, field, vocabulary) {
  if (!vocabulary.includes(value)) throw new TypeError(`${field} must be one of ${vocabulary.join(', ')}`);
  return value;
}

function requireTextList(value, field) {
  return Object.freeze(
    requireArray(value, field).map((entry, index) => requireText(entry, `${field}[${index}]`)),
  );
}

/** Copy a string-keyed record of arrays of sections, one level deep, frozen. */
function freezeSectionMap(value, field) {
  const out = {};
  for (const [claim, sections] of Object.entries(value)) {
    if (!Array.isArray(sections) || sections.length < 1) {
      throw new TypeError(`${field}.${claim} must be a non-empty array of sections`);
    }
    out[claim] = Object.freeze(
      sections.map((section, index) =>
        requireVocabulary(section, `${field}.${claim}[${index}]`, MANUSCRIPT_SECTIONS),
      ),
    );
  }
  return Object.freeze(out);
}

/** Is this one of the donor's six manuscript sections? */
export function isManuscriptSection(value) {
  return MANUSCRIPT_SECTIONS.includes(value);
}

/** The six sections, in assembly order, as a fresh list. */
export function manuscriptSections() {
  return [...MANUSCRIPT_SECTIONS];
}

/** Is this one of the donor's six pipeline statuses? */
export function isSectionStatus(value) {
  return SECTION_STATUSES.includes(value);
}

/**
 * Validate a manuscript plan without constructing it.
 *
 * @param {object} plan `{ id, claimsToSections }` — the donor's ManuscriptPlan
 * @returns {object} the same plan value, unchanged
 */
export function validateManuscriptPlanShape(plan) {
  requireObject(plan, 'plan');
  requireText(plan.id, 'plan.id');
  const claimsToSections = plan.claimsToSections ?? {};
  requireObject(claimsToSections, 'plan.claimsToSections');
  for (const [claim, sections] of Object.entries(claimsToSections)) {
    requireText(claim, 'plan.claimsToSections key');
    requireArray(sections, `plan.claimsToSections.${claim}`);
    if (sections.length < 1) throw new TypeError(`plan.claimsToSections.${claim} must not be empty`);
    sections.forEach((section, index) =>
      requireVocabulary(section, `plan.claimsToSections.${claim}[${index}]`, MANUSCRIPT_SECTIONS),
    );
  }
  return plan;
}

/**
 * Validate a manuscript plan and return a frozen copy.
 *
 * @param {object} plan `{ id, claimsToSections }`
 */
export function manuscriptPlan(plan) {
  validateManuscriptPlanShape(plan);
  return Object.freeze({
    id: plan.id,
    claimsToSections: freezeSectionMap(plan.claimsToSections ?? {}, 'plan.claimsToSections'),
  });
}

/**
 * Validate a section brief (`{ section, purpose, claimIds, evidenceIds }`) and
 * return a frozen copy.
 */
export function sectionBrief(brief) {
  requireObject(brief, 'brief');
  return Object.freeze({
    section: requireVocabulary(brief.section, 'brief.section', MANUSCRIPT_SECTIONS),
    purpose: requireText(brief.purpose, 'brief.purpose'),
    claimIds: requireTextList(brief.claimIds ?? [], 'brief.claimIds'),
    evidenceIds: requireTextList(brief.evidenceIds ?? [], 'brief.evidenceIds'),
  });
}

/**
 * Validate a section draft (`SectionDraft`) and return a frozen copy.
 *
 * `reviewerNotes` is optional in the donor and stays absent when it was absent: the
 * factory adds no field the caller did not supply.
 */
export function sectionDraft(draft) {
  requireObject(draft, 'draft');
  const out = {
    section: requireVocabulary(draft.section, 'draft.section', MANUSCRIPT_SECTIONS),
    status: requireVocabulary(draft.status, 'draft.status', SECTION_STATUSES),
    allowedEvidenceIds: requireTextList(draft.allowedEvidenceIds ?? [], 'draft.allowedEvidenceIds'),
    content: typeof draft.content === 'string' ? draft.content : null,
    revisions: requireCount(draft.revisions, 'draft.revisions'),
    updatedAt: requireText(draft.updatedAt, 'draft.updatedAt'),
  };
  if (out.content === null) throw new TypeError('draft.content must be a string');
  if (draft.reviewerNotes !== undefined) out.reviewerNotes = requireTextList(draft.reviewerNotes, 'draft.reviewerNotes');
  return Object.freeze(out);
}

/**
 * Validate the input `evidenceCheckDraft` reads: the donor's
 * `Pick<SectionDraft, "section" | "allowedEvidenceIds" | "content">`.
 */
export function evidenceCheckInput(draft) {
  requireObject(draft, 'draft');
  const out = {
    section: requireVocabulary(draft.section, 'draft.section', MANUSCRIPT_SECTIONS),
    allowedEvidenceIds: requireTextList(draft.allowedEvidenceIds ?? [], 'draft.allowedEvidenceIds'),
    content: typeof draft.content === 'string' ? draft.content : null,
  };
  if (out.content === null) throw new TypeError('draft.content must be a string');
  return Object.freeze(out);
}

/** Validate one figure bar (`{ label, value }`) and return a frozen copy. */
export function figureBar(bar) {
  requireObject(bar, 'bar');
  if (typeof bar.value !== 'number' || !Number.isFinite(bar.value)) {
    throw new TypeError('bar.value must be a finite number');
  }
  return Object.freeze({
    label: typeof bar.label === 'string' ? bar.label : null,
    value: bar.value,
  });
}

/** Validate the figure options (`{ title, width, height, yLabel }`) and return a frozen copy. */
export function figureOptions(options = {}) {
  requireObject(options, 'options');
  const out = {};
  if (options.title !== undefined) out.title = requireText(options.title, 'options.title');
  for (const field of ['width', 'height']) {
    if (options[field] === undefined) continue;
    if (typeof options[field] !== 'number' || !Number.isFinite(options[field])) {
      throw new TypeError(`options.${field} must be a finite number`);
    }
    out[field] = options[field];
  }
  if (options.yLabel !== undefined) out.yLabel = requireText(options.yLabel, 'options.yLabel');
  return Object.freeze(out);
}

/** Validate one result-table column (`{ name, unit? }`) and return a frozen copy. */
export function resultTableColumn(column) {
  requireObject(column, 'column');
  const out = { name: requireText(column.name, 'column.name') };
  if (column.unit !== undefined) out.unit = requireText(column.unit, 'column.unit');
  return Object.freeze(out);
}

/** Validate one result-table cell (`{ value, raw? }`) and return a frozen copy. */
export function resultTableCell(cell) {
  requireObject(cell, 'cell');
  if (typeof cell.value !== 'number' || !Number.isFinite(cell.value)) {
    throw new TypeError('cell.value must be a finite number');
  }
  const out = { value: cell.value };
  if (cell.raw !== undefined) out.raw = requireText(cell.raw, 'cell.raw');
  return Object.freeze(out);
}

/** Validate one result-table row (`{ label, cells }`) and return a frozen copy. */
export function resultTableRow(row) {
  requireObject(row, 'row');
  return Object.freeze({
    label: requireText(row.label, 'row.label'),
    cells: Object.freeze(requireArray(row.cells ?? [], 'row.cells').map((cell, index) => {
      try {
        return resultTableCell(cell);
      } catch (error) {
        throw new TypeError(`row.cells[${index}]: ${error.message}`);
      }
    })),
  });
}

/**
 * Validate a result table (`{ title, columns, rows, footnote? }`) and return a
 * frozen copy. A row with fewer cells than there are columns is accepted exactly as
 * the donor accepts it: the renderers emit a short row rather than inventing cells.
 */
export function resultTable(table) {
  requireObject(table, 'table');
  const out = {
    title: requireText(table.title, 'table.title'),
    columns: Object.freeze(requireArray(table.columns ?? [], 'table.columns').map((column, index) => {
      try {
        return resultTableColumn(column);
      } catch (error) {
        throw new TypeError(`table.columns[${index}]: ${error.message}`);
      }
    })),
    rows: Object.freeze(requireArray(table.rows ?? [], 'table.rows').map((row, index) => {
      try {
        return resultTableRow(row);
      } catch (error) {
        throw new TypeError(`table.rows[${index}]: ${error.message}`);
      }
    })),
  };
  if (table.footnote !== undefined) out.footnote = requireText(table.footnote, 'table.footnote');
  return Object.freeze(out);
}

/** Validate a `{ name, svg }` figure artifact and return a frozen copy. */
export function figure(figure) {
  requireObject(figure, 'figure');
  const svg = typeof figure.svg === 'string' ? figure.svg : null;
  if (svg === null) throw new TypeError('figure.svg must be a string');
  return Object.freeze({ name: requireText(figure.name, 'figure.name'), svg });
}
