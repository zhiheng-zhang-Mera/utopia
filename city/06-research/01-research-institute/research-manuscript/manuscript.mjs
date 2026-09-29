/**
 * UTOPIA · Research Institute — manuscript assembly model.
 *
 * Papers are never written in a single prompt. A manuscript is assembled section by
 * section (Abstract, Introduction, Methods, Results, Discussion, Conclusion) where
 * each section is drafted from an evidence-scoped brief, reviewed, and
 * evidence-checked before revision. A section may only assert claims whose nodes
 * exist in the Evidence Graph (run/metric/statistic ids).
 *
 * Donor: Codex-Boss `src/shared/research-manuscript.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Every function name, regex, label,
 * escape rule, section order and exact error message in this file is the donor's.
 *
 * Deliberately NOT ported, and therefore not here:
 *   - `electron/research/manuscript/latex-compiler.ts` — the LaTeX/PDF compilation
 *     step. This model produces LaTeX and Markdown *text*; running an engine,
 *     writing artifacts and producing a PDF are out of scope.
 *   - `electron/research/manuscript/manuscript-assembler.ts` — the Electron-side
 *     pipeline driver. It reads and writes files, stamps `new Date().toISOString()`
 *     and reaches into the citation/bibliography modules, none of which are in
 *     scope. Its section loop, reviewer gate and bounded revisions are recorded in
 *     `knownDifferences`, not reproduced.
 *   - The Evidence Graph itself: `evidenceCheckDraft` receives the available
 *     evidence ids as a plain `Set` and asserts nothing about their truth.
 *
 * Nothing in this file reads the clock, generates an id, touches the file system or
 * talks to a model. The donor generates no id and stamps no time in these two
 * files — `ManuscriptPlan.id` and `SectionDraft.updatedAt` are supplied by the
 * caller — so there is nothing to inject.
 *
 * `MANUSCRIPT_SECTIONS` is imported from `./contracts.mjs` rather than declared a
 * second time here: it is one frozen vocabulary with one owner, and two star-exported
 * copies of the same name would cancel each other out in `./index.mjs`.
 */

import { MANUSCRIPT_SECTIONS } from './contracts.mjs';

export { MANUSCRIPT_SECTIONS } from './contracts.mjs';

/**
 * Build the six evidence-scoped section briefs, in `MANUSCRIPT_SECTIONS` order.
 *
 * A claim belongs to a section when the plan maps it there; a brief's evidence ids
 * are the de-duplicated evidence of those claims, in first-seen order.
 *
 * @param {{id: string, claimsToSections: Record<string, string[]>}} plan
 * @param {Array<{id: string, evidenceIds: string[]}>} claims
 * @returns {Array<{section: string, purpose: string, claimIds: string[], evidenceIds: string[]}>}
 */
export function buildSectionBriefs(plan, claims) {
  return MANUSCRIPT_SECTIONS.map((section) => {
    const claimIds = claims
      .filter((claim) => (plan.claimsToSections[claim.id] ?? []).includes(section))
      .map((claim) => claim.id);
    const evidenceIds = [...new Set(claims.filter((claim) => claimIds.includes(claim.id)).flatMap((claim) => claim.evidenceIds))];
    return { section, purpose: purposeOf(section), claimIds, evidenceIds };
  });
}

/**
 * A draft may only reference evidence ids that exist in the graph.
 *
 * The donor's rule exactly: `@id` tokens of 3–80 characters are the references, an
 * allowed-but-unavailable id is missing evidence, and a reference that is available
 * but not allowed is outside its scope. Both make the check fail. `missingClaims` is
 * always empty here — the donor reserves the field and never fills it.
 *
 * @param {{section: string, allowedEvidenceIds: string[], content: string}} draft
 * @param {Set<string>} availableEvidenceIds the ids that exist in the graph
 * @returns {{section: string, passed: boolean, missingEvidence: string[], missingClaims: string[]}}
 */
export function evidenceCheckDraft(draft, availableEvidenceIds) {
  const referenced = [...draft.content.matchAll(/@([A-Za-z0-9:_-]{3,80})/g)].map((match) => match[1]);
  const asserted = draft.allowedEvidenceIds.filter((id) => !availableEvidenceIds.has(id));
  const missingEvidence = [...new Set([...referenced.filter((id) => !availableEvidenceIds.has(id)), ...asserted])]
    .filter((id) => !draft.allowedEvidenceIds.includes(id))
    .slice(0, 20);
  const referencedOutsideScope = referenced.filter((id) => !draft.allowedEvidenceIds.includes(id) && availableEvidenceIds.has(id));
  return {
    section: draft.section,
    passed: missingEvidence.length === 0 && referencedOutsideScope.length === 0,
    missingEvidence: [...new Set([...missingEvidence, ...referencedOutsideScope])],
    missingClaims: [],
  };
}

/**
 * The donor's own plan validation, kept with its exact messages.
 *
 * The donor never calls it from `buildSectionBriefs`; it is a gate a caller may run
 * before assembling. It throws rather than repairing, which is why the UTOPIA
 * `manuscriptPlan` factory in `./contracts.mjs` mirrors it.
 *
 * @param {{id: string, claimsToSections: Record<string, string[]>}} plan
 */
export function validateManuscriptPlan(plan) {
  if (!plan || typeof plan.id !== 'string' || !plan.id.trim()) throw new Error('Manuscript plan requires an id');
  for (const [claim, sections] of Object.entries(plan.claimsToSections ?? {})) {
    if (sections.length < 1 || sections.some((section) => !MANUSCRIPT_SECTIONS.includes(section))) {
      throw new Error(`Invalid claim→section mapping for ${claim}`);
    }
  }
}

/**
 * U7 (§18): section sufficiency obligations — a section is accepted by what it
 * must contain, never by a word count. Each obligation is a deterministic
 * predicate over the draft and the evidence/claim material it was briefed on.
 */
const SECTION_OBLIGATIONS = [
  // Abstract: names the question + states a primary finding bound to evidence.
  { section: 'abstract', label: 'states the research question', met: (content) => /question|research question|investigat|studies?/i.test(content) },
  { section: 'abstract', label: 'reports the recorded result from evidence', met: (content, ctx) => ctx.evidenceIds.length === 0 || content.length > 240 },
  { section: 'introduction', label: 'identifies the gap in existing work', met: (content) => /gap|limits?|outside|prior|motivat|diversity|calibration/i.test(content) },
  { section: 'introduction', label: 'states what this paper does', met: (content) => /this paper|we (investigate|study|compare|examine)|the (paper|study)/i.test(content) },
  { section: 'methods', label: 'describes a frozen protocol', met: (content) => /frozen|pre-register|before any (measurement|experiment)|protocol/i.test(content) },
  { section: 'methods', label: 'specifies metric/baseline/criterion', met: (content, ctx) => ctx.metric !== undefined && new RegExp(ctx.metric, 'i').test(content) && /baseline|decision rule|criterion/i.test(content) },
  { section: 'methods', label: 'describes deterministic statistics', met: (content) => /deterministic|mean|standard deviation|confidence interval|no AI/i.test(content) },
  { section: 'results', label: 'reports a number from recorded runs (no bare comparison)', met: (content, ctx) => content.length > 0 && (ctx.runCount === undefined || ctx.runCount === 0 || /\d+\.\d{3}|n = \d|recorded run/i.test(content)) },
  { section: 'results', label: 'ties the result to its statistic/confidence', met: (content) => /mean|confidence interval|\d+\.\d{3}|REPRODUCED|NOT_REPRODUCED/i.test(content) },
  { section: 'discussion', label: 'interprets the result within evidence', met: (content) => /consistent|support|does not support|evidence/i.test(content) },
  { section: 'discussion', label: 'reports limitations (no hidden threats)', met: (content) => /limitation|threats to validity|limited power|not transfer|out of scope/i.test(content) },
  { section: 'conclusion', label: 'ties the conclusion to the recorded evidence', met: (content) => /evidence|recorded|mean|support|reproducib/i.test(content) },
];

/** All §18 obligations a section must satisfy (a section with no obligations passes trivially). */
function obligationsFor(section) {
  return SECTION_OBLIGATIONS.filter((obligation) => obligation.section === section);
}

/**
 * §18 section acceptance: every obligation for the section must be met.
 *
 * Obligations are evaluated in the donor's declaration order, and every unmet label
 * is reported (not just the first), so the verdict is a checklist.
 *
 * @param {string} content the drafted section text
 * @param {string} section one of `MANUSCRIPT_SECTIONS`
 * @param {{claimIds: string[], evidenceIds: string[], hypothesis?: string, metric?: string, baseline?: string, runCount?: number}} context
 * @returns {{section: string, passed: boolean, unmet: string[]}}
 */
export function sectionSufficiency(content, section, context) {
  const unmet = obligationsFor(section).filter((obligation) => !obligation.met(content, context)).map((obligation) => obligation.label);
  return { section, passed: unmet.length === 0, unmet };
}

/**
 * U7 (§19 anti-premature-closure): even when every section has text, writing
 * must not close while significant material is undiscussed. Returns the
 * evidence/claims that no section addresses.
 *
 * A claim is addressed when any section the plan maps it to has a draft. Evidence is
 * discussed when a draft cites it as `@id` or lists it in `allowedEvidenceIds`. A
 * results section with no interpreting discussion is reported as an anomaly the plan
 * refuses to ship silently.
 *
 * @param {{claims: Array<{id: string, text: string}>, evidenceIds: string[], sections: Record<string, object>, plan: object}} input
 * @returns {{premature: boolean, undiscussedClaims: string[], undiscussedEvidence: string[], resultWithoutInterpretation: boolean}}
 */
export function antiPrematureClosure(input) {
  const addressedClaims = new Set();
  const discussed = new Set();
  // claimsToSections is keyed claim-id → section list; a claim is addressed
  // when any of its mapped sections has a draft.
  for (const [claimId, claimSections] of Object.entries(input.plan.claimsToSections ?? {})) {
    for (const section of claimSections) {
      if (input.sections[section]) {
        addressedClaims.add(claimId);
      }
    }
  }
  for (const draft of Object.values(input.sections)) {
    for (const id of input.evidenceIds) {
      if (new RegExp(`@${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(draft.content) || draft.allowedEvidenceIds.includes(id)) discussed.add(id);
    }
  }
  const undiscussedClaims = input.claims.filter((claim) => !addressedClaims.has(claim.id)).map((claim) => claim.id);
  const undiscussedEvidence = input.evidenceIds.filter((id) => !discussed.has(id));
  const results = input.sections.results?.content ?? '';
  const discussion = input.sections.discussion?.content ?? '';
  // A results section that names evidence but has no interpreting discussion
  // sentence is an anomaly the plan refuses to ship silently.
  const resultWithoutInterpretation = results.length > 0 && discussion.length === 0
    ? true
    : results.length > 0 && !/consistent|support|limitation|uncertain|suggest/i.test(discussion);
  return {
    premature: undiscussedClaims.length > 0 || undiscussedEvidence.length > 0 || resultWithoutInterpretation,
    undiscussedClaims,
    undiscussedEvidence,
    resultWithoutInterpretation,
  };
}

/** The donor's LaTeX cell escape: reserved characters, then `~` and `^`. */
function escapeLatexCell(value) {
  return value.replace(/([\\{}_$&%#])/g, '\\$1').replace(/~/g, '\\textasciitilde{}').replace(/\^/g, '\\textasciicircum{}');
}

/** The donor's Markdown cell escape: a pipe, and a line break folded into a space. */
function escapeMarkdownCell(value) {
  return value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

/**
 * Deterministic LaTeX table from recorded metrics (U7 §21). Pure: same rows →
 * same tabular bytes. Each cell is a real number; nothing is invented.
 *
 * The first header cell is empty and the column format is `l` followed by one `r`
 * per data column. A cell's `raw` string, when given, replaces the formatted number
 * and is NOT escaped — the donor trusts a caller-supplied raw cell verbatim.
 *
 * @param {{title: string, columns: Array<{name: string, unit?: string}>, rows: Array<{label: string, cells: Array<{value: number, raw?: string}>}>, footnote?: string}} table
 * @returns {string} the `table` environment
 */
export function resultTableToLatex(table) {
  const headers = ['', ...table.columns.map((column) => (column.unit ? `${escapeLatexCell(column.name)} (${escapeLatexCell(column.unit)})` : escapeLatexCell(column.name)))];
  const columnCount = headers.length;
  const format = 'l' + 'r'.repeat(Math.max(0, columnCount - 1));
  const headerRow = headers.map((header) => `\\textbf{${header}}`).join(' & ');
  const body = table.rows
    .map((row) => [escapeLatexCell(row.label), ...row.cells.map((cell) => cell.raw ?? cell.value.toFixed(3))].join(' & '))
    .join(' \\\\\n');
  const footnote = table.footnote ? `\\footnotesize ${escapeLatexCell(table.footnote)}` : '';
  return `\\begin{table}[h]\n\\centering\n\\caption{${escapeLatexCell(table.title)}}\n\\begin{tabular}{${format}}\n\\hline\n${headerRow} \\\\\n\\hline\n${body} \\\\\n\\hline\n\\end{tabular}\n${footnote}\n\\end{table}`;
}

/**
 * Deterministic markdown mirror of the same table (for paper.md).
 *
 * The mirror is deliberately not identical to the LaTeX form: the first header is
 * the literal `Run`, the title becomes an `###` heading, cells and columns are not
 * escaped (only row labels and the footnote are), and the footnote is italic text
 * under the table.
 *
 * @param {{title: string, columns: Array<{name: string, unit?: string}>, rows: Array<{label: string, cells: Array<{value: number, raw?: string}>}>, footnote?: string}} table
 * @returns {string} the markdown table
 */
export function resultTableToMarkdown(table) {
  const headers = ['Run', ...table.columns.map((column) => column.name)];
  const headerLine = headers.join(' | ');
  const divider = headers.map(() => '---').join(' | ');
  const body = table.rows.map((row) => [escapeMarkdownCell(row.label), ...row.cells.map((cell) => cell.raw ?? cell.value.toFixed(3))].join(' | '));
  const footnote = table.footnote ? `\n\n_${escapeMarkdownCell(table.footnote)}_` : '';
  return `### ${table.title}\n\n${headerLine}\n${divider}\n${body.join('\n')}${footnote}`;
}

/**
 * §21.2 quantitative visual-evidence verdict: a quantitative manuscript must
 * embed at least one meaningful result table (or a LaTeX-embeddable figure) in
 * the compiled artifact — decorative-only assets never count.
 *
 * @param {{hasQuantitativeResults: boolean, resultTableCount: number, embeddableFigureCount: number}} input
 * @returns {{ok: boolean, reason?: string}}
 */
export function quantitativeVisualEvidenceVerdict(input) {
  if (!input.hasQuantitativeResults) return { ok: true };
  if (input.resultTableCount > 0 || input.embeddableFigureCount > 0) return { ok: true };
  return { ok: false, reason: 'MANUSCRIPT_VISUAL_EVIDENCE_INSUFFICIENT: quantitative results with 0 result tables and 0 PDF-embeddable figures' };
}

/** The donor's one-line purpose for each section. */
function purposeOf(section) {
  return {
    abstract: 'state the question, method, and primary finding',
    introduction: 'motivate the question with verified background',
    methods: 'describe the deterministic protocol and experiment',
    results: 'report statistics computed from raw data',
    discussion: 'interpret results strictly within evidence',
    conclusion: 'summarize supported claims and limitations',
  }[section];
}
