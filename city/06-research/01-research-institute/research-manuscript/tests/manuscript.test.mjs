/**
 * UTOPIA · Research Institute — manuscript assembly suite.
 *
 * Restates the Codex-Boss donor `src/shared/research-manuscript.ts` @
 * 8df428eaa437a409368401e95194e40266b83080: the six section briefs and their
 * purposes, the `@id` evidence check, the §18 sufficiency obligations (label for
 * label, in declaration order), the §19 anti-premature-closure verdicts, the
 * Markdown and LaTeX table bytes (including the two deliberate asymmetries between
 * them) and the §21.2 visual-evidence reason string.
 *
 * Asserting a pinned verdict computes the expectation from the donor's own rule,
 * never from this module's output.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MANUSCRIPT_SECTIONS,
  SECTION_OBLIGATION_LABELS,
  SECTION_STATUSES,
  antiPrematureClosure,
  buildSectionBriefs,
  evidenceCheckDraft,
  evidenceCheckInput,
  isManuscriptSection,
  isSectionStatus,
  manuscriptPlan,
  manuscriptSections,
  quantitativeVisualEvidenceVerdict,
  resultTable,
  resultTableToLatex,
  resultTableToMarkdown,
  sectionBrief,
  sectionDraft,
  sectionSufficiency,
  validateManuscriptPlan,
  validateManuscriptPlanShape,
} from '../index.mjs';

/** The donor's §18 obligation table, restated from the donor source. */
const OBLIGATIONS = {
  abstract: [
    { label: 'states the research question', met: (c) => /question|research question|investigat|studies?/i.test(c) },
    { label: 'reports the recorded result from evidence', met: (c, ctx) => ctx.evidenceIds.length === 0 || c.length > 240 },
  ],
  introduction: [
    { label: 'identifies the gap in existing work', met: (c) => /gap|limits?|outside|prior|motivat|diversity|calibration/i.test(c) },
    { label: 'states what this paper does', met: (c) => /this paper|we (investigate|study|compare|examine)|the (paper|study)/i.test(c) },
  ],
  methods: [
    { label: 'describes a frozen protocol', met: (c) => /frozen|pre-register|before any (measurement|experiment)|protocol/i.test(c) },
    { label: 'specifies metric/baseline/criterion', met: (c, ctx) => ctx.metric !== undefined && new RegExp(ctx.metric, 'i').test(c) && /baseline|decision rule|criterion/i.test(c) },
    { label: 'describes deterministic statistics', met: (c) => /deterministic|mean|standard deviation|confidence interval|no AI/i.test(c) },
  ],
  results: [
    { label: 'reports a number from recorded runs (no bare comparison)', met: (c, ctx) => c.length > 0 && (ctx.runCount === undefined || ctx.runCount === 0 || /\d+\.\d{3}|n = \d|recorded run/i.test(c)) },
    { label: 'ties the result to its statistic/confidence', met: (c) => /mean|confidence interval|\d+\.\d{3}|REPRODUCED|NOT_REPRODUCED/i.test(c) },
  ],
  discussion: [
    { label: 'interprets the result within evidence', met: (c) => /consistent|support|does not support|evidence/i.test(c) },
    { label: 'reports limitations (no hidden threats)', met: (c) => /limitation|threats to validity|limited power|not transfer|out of scope/i.test(c) },
  ],
  conclusion: [
    { label: 'ties the conclusion to the recorded evidence', met: (c) => /evidence|recorded|mean|support|reproducib/i.test(c) },
  ],
};

/** The donor's §18 rule, restated independently of the module. */
function expectedSufficiency(content, section, context) {
  const unmet = OBLIGATIONS[section].filter((obligation) => !obligation.met(content, context)).map((obligation) => obligation.label);
  return { section, passed: unmet.length === 0, unmet };
}

const PLAN = {
  id: 'ir-1',
  claimsToSections: {
    'claim:experiment-1': ['abstract', 'results', 'discussion', 'conclusion'],
    'claim:background': ['introduction', 'methods'],
  },
};

const CLAIMS = [
  { id: 'claim:experiment-1', evidenceIds: ['stat:experiment-1', 'run:1'] },
  { id: 'claim:background', evidenceIds: ['run:1', 'run:2'] },
  { id: 'claim:unmapped', evidenceIds: ['run:9'] },
];

test('the manuscript vocabulary keeps the donor order and membership', () => {
  assert.deepEqual(MANUSCRIPT_SECTIONS, ['abstract', 'introduction', 'methods', 'results', 'discussion', 'conclusion']);
  assert.deepEqual(manuscriptSections(), [...MANUSCRIPT_SECTIONS]);
  assert.deepEqual(SECTION_STATUSES, ['PENDING', 'BRIEFED', 'DRAFTED', 'REVIEWED', 'EVIDENCE_CHECKED', 'REVISED']);
  assert.equal(Object.isFrozen(MANUSCRIPT_SECTIONS), true);
  assert.equal(isManuscriptSection('results'), true);
  assert.equal(isManuscriptSection('Results'), false);
  assert.equal(isManuscriptSection('appendix'), false);
  assert.equal(isSectionStatus('EVIDENCE_CHECKED'), true);
  assert.equal(isSectionStatus('APPROVED'), false);

  assert.deepEqual(Object.keys(SECTION_OBLIGATION_LABELS), [...MANUSCRIPT_SECTIONS]);
  for (const section of MANUSCRIPT_SECTIONS) {
    assert.deepEqual(SECTION_OBLIGATION_LABELS[section], OBLIGATIONS[section].map((obligation) => obligation.label), section);
  }
});

test('the six section briefs carry the donor purposes, claim ids and evidence ids', () => {
  const briefs = buildSectionBriefs(PLAN, CLAIMS);
  assert.deepEqual(
    briefs,
    [
      {
        section: 'abstract',
        purpose: 'state the question, method, and primary finding',
        claimIds: ['claim:experiment-1'],
        evidenceIds: ['stat:experiment-1', 'run:1'],
      },
      {
        section: 'introduction',
        purpose: 'motivate the question with verified background',
        claimIds: ['claim:background'],
        evidenceIds: ['run:1', 'run:2'],
      },
      {
        section: 'methods',
        purpose: 'describe the deterministic protocol and experiment',
        claimIds: ['claim:background'],
        evidenceIds: ['run:1', 'run:2'],
      },
      {
        section: 'results',
        purpose: 'report statistics computed from raw data',
        claimIds: ['claim:experiment-1'],
        evidenceIds: ['stat:experiment-1', 'run:1'],
      },
      {
        section: 'discussion',
        purpose: 'interpret results strictly within evidence',
        claimIds: ['claim:experiment-1'],
        evidenceIds: ['stat:experiment-1', 'run:1'],
      },
      {
        section: 'conclusion',
        purpose: 'summarize supported claims and limitations',
        claimIds: ['claim:experiment-1'],
        evidenceIds: ['stat:experiment-1', 'run:1'],
      },
    ],
    'always six briefs, in MANUSCRIPT_SECTIONS order',
  );
  assert.deepEqual(briefs.map((brief) => brief.section), [...MANUSCRIPT_SECTIONS]);

  // a claim the plan never maps appears in no brief, and its evidence is not leaked
  assert.ok(!briefs.some((brief) => brief.claimIds.includes('claim:unmapped')));
  assert.ok(!briefs.some((brief) => brief.evidenceIds.includes('run:9')));

  // no claim → no claims and no evidence, but the briefs still exist
  assert.deepEqual(
    buildSectionBriefs({ id: 'ir-2', claimsToSections: {} }, []),
    MANUSCRIPT_SECTIONS.map((section) => ({ section, purpose: briefs.find((brief) => brief.section === section).purpose, claimIds: [], evidenceIds: [] })),
  );
  // the `?? []` guard on a claim the plan does not mention
  const orphan = buildSectionBriefs({ id: 'ir-3', claimsToSections: {} }, [{ id: 'a', evidenceIds: ['e'] }]);
  assert.deepEqual(orphan.map((brief) => brief.claimIds), [[], [], [], [], [], []]);
});

test('the evidence check fails on a missing id and on an out-of-scope reference', () => {
  const available = new Set(['stat:experiment-1', 'stat:experiment-2', 'run:1']);

  const clean = evidenceCheckDraft(
    { section: 'results', allowedEvidenceIds: ['stat:experiment-1', 'run:1'], content: 'Recorded @stat:experiment-1 and @run:1.' },
    available,
  );
  assert.deepEqual(clean, { section: 'results', passed: true, missingEvidence: [], missingClaims: [] });

  // A briefed id that is absent from the graph is only reported when the draft also
  // references it. The donor's `asserted` list is filtered by
  // `!allowedEvidenceIds.includes(id)`, which removes exactly the ids that filter was
  // meant to keep, so a briefed-but-unused id is never missing evidence — whether the
  // draft is silent about it or cites it as an `@id`. That is the donor's rule.
  const silentAboutGhost = evidenceCheckDraft(
    { section: 'results', allowedEvidenceIds: ['stat:experiment-1', 'stat:ghost'], content: 'Claim @stat:experiment-1.' },
    available,
  );
  assert.deepEqual(silentAboutGhost, { section: 'results', passed: true, missingEvidence: [], missingClaims: [] });
  const citesGhost = evidenceCheckDraft(
    { section: 'results', allowedEvidenceIds: ['stat:experiment-1', 'stat:ghost'], content: 'Claim @stat:ghost.' },
    available,
  );
  assert.deepEqual(citesGhost, { section: 'results', passed: true, missingEvidence: [], missingClaims: [] });
  // a briefed id that is absent AND not briefed anywhere is reported, since the
  // reference itself is what fails
  const citedGhost = evidenceCheckDraft(
    { section: 'results', allowedEvidenceIds: ['stat:experiment-1'], content: 'Claim @stat:ghost.' },
    available,
  );
  assert.deepEqual(citedGhost, {
    section: 'results',
    passed: false,
    missingEvidence: ['stat:ghost'],
    missingClaims: [],
  });

  // a reference that exists in the graph but was not briefed for this section is
  // outside scope: it fails the check and is named
  const outside = evidenceCheckDraft(
    { section: 'results', allowedEvidenceIds: ['stat:experiment-1'], content: 'Also @stat:experiment-2.' },
    available,
  );
  assert.deepEqual(outside, {
    section: 'results',
    passed: false,
    missingEvidence: ['stat:experiment-2'],
    missingClaims: [],
  });

  // a reference that is neither briefed nor in the graph is missing evidence too
  const unknown = evidenceCheckDraft(
    { section: 'discussion', allowedEvidenceIds: [], content: 'See @run:ghost.' },
    available,
  );
  assert.deepEqual(unknown, { section: 'discussion', passed: false, missingEvidence: ['run:ghost'], missingClaims: [] });
  assert.deepEqual(unknown.missingClaims, [], 'missingClaims is reserved and always empty');

  const twoProblems = evidenceCheckDraft(
    { section: 'results', allowedEvidenceIds: ['stat:ghost'], content: 'Both @stat:experiment-2 and @run:ghost.' },
    available,
  );
  assert.deepEqual(twoProblems.missingEvidence, ['run:ghost', 'stat:experiment-2'], 'always a de-duplicated list, never one id');
  assert.equal(twoProblems.passed, false);
  // `stat:ghost` was briefed and is absent, but the filter above discards it, so only
  // the references that actually fail are named
  assert.deepEqual(twoProblems.missingClaims, []);
});

test('the evidence check keeps the donor token grammar and the 20-id cap', () => {
  const available = new Set(['abc', 'a:b-c_d', 'ab', 'abcd-efgh']);
  const draft = {
    section: 'results',
    allowedEvidenceIds: [],
    content: 'See @abc and @a:b-c_d, not @ab or @abcd-efg.',
  };
  const verdict = evidenceCheckDraft(draft, available);
  assert.deepEqual(verdict.missingEvidence, ['abcd-efg', 'abc', 'a:b-c_d'], 'the asserted list first, then the references in first-seen order');
  assert.equal(verdict.passed, false, 'the 8-character token @abcd-efg is a reference, and it is out of scope');
  assert.ok(!verdict.missingEvidence.includes('ab'), '@ab is too short to be a reference');

  const inScope = evidenceCheckDraft({ section: 'results', allowedEvidenceIds: ['abc'], content: 'See @abc.' }, available);
  assert.deepEqual(inScope, { section: 'results', passed: true, missingEvidence: [], missingClaims: [] }, 'a 3-character token resolves');

  const twoChar = evidenceCheckDraft({ section: 'results', allowedEvidenceIds: [], content: 'See @ab.' }, available);
  assert.deepEqual(twoChar, { section: 'results', passed: true, missingEvidence: [], missingClaims: [] }, '@ab is too short to be a reference');

  // the quantifier is capped at 80, so a longer run of characters yields one token of
  // exactly 80 characters, with the remainder outside the reference
  const run = 'x'.repeat(81);
  const captured = [...`See @${run}.`.matchAll(/@([A-Za-z0-9:_-]{3,80})/g)].map((match) => match[1]);
  assert.equal(captured.length, 1);
  assert.equal(captured[0].length, 80, 'the reference grammar is 3 to 80 characters');
  assert.equal(captured[0], run.slice(0, 80));
  const long = evidenceCheckDraft({ section: 'results', allowedEvidenceIds: [], content: `See @${run}.` }, new Set());
  assert.deepEqual(long.missingEvidence, [run.slice(0, 80)]);

  // The donor's `.slice(0, 20)` is applied to the `asserted` list before the
  // references are merged in, so it caps nothing here: 25 out-of-scope references all
  // come back. The defect is the donor's and is kept as-is.
  const ids = Array.from({ length: 25 }, (_, index) => `stat:${String(index).padStart(2, '0')}`);
  const many = evidenceCheckDraft(
    { section: 'results', allowedEvidenceIds: [], content: ids.map((id) => `@${id}`).join(' ') },
    new Set(ids),
  );
  assert.equal(many.missingEvidence.length, 25, 'the cap does not bound the out-of-scope references');
  assert.deepEqual(many.missingEvidence, ids);
  assert.equal(many.passed, false);

  // A briefed id that is also absent from the graph is filtered out of `asserted`,
  // so a section that asserts nothing while every briefed id is unavailable still
  // passes. The donor's filter discards exactly what the assertion intended to catch.
  const briefedButGone = evidenceCheckDraft(
    { section: 'results', allowedEvidenceIds: ids, content: 'no references here' },
    new Set(),
  );
  assert.deepEqual(briefedButGone, { section: 'results', passed: true, missingEvidence: [], missingClaims: [] });
});

test('§18 sufficiency reports the exact unmet obligations in declaration order', () => {
  const none = { claimIds: [], evidenceIds: [] };
  const cases = [
    ['abstract', '', none],
    ['abstract', 'This studies the question.', none],
    ['abstract', 'This studies the question and reports.', none],
    ['abstract', 'We investigate the question.', { claimIds: ['c'], evidenceIds: ['e1'] }],
    ['abstract', `We investigate the question. ${'x'.repeat(241)}`, { claimIds: ['c'], evidenceIds: ['e1'] }],
    ['introduction', 'There is a gap here.', none],
    ['introduction', 'This paper compares two systems.', none],
    ['introduction', 'Prior work limits us; this paper compares two systems.', none],
    ['methods', 'We follow the protocol.', none],
    ['methods', 'The frozen protocol measures accuracy.', { metric: 'accuracy' }],
    ['methods', 'The frozen protocol measures accuracy against the baseline.', { metric: 'accuracy' }],
    ['methods', 'The frozen protocol measures accuracy against the baseline; statistics are deterministic.', { metric: 'accuracy' }],
    ['results', '', none],
    ['results', 'We measured something.', none],
    ['results', 'We measured something.', { runCount: 3 }],
    ['results', 'The mean was 0.750.', { runCount: 3 }],
    ['discussion', 'The result supports the claim.', none],
    ['discussion', 'The result supports the claim, but a limitation is power.', none],
    ['conclusion', 'The evidence supports this.', none],
    ['conclusion', 'Acknowledgements only.', none],
  ];

  for (const [section, content, context] of cases) {
    const expected = expectedSufficiency(content, section, context);
    const actual = sectionSufficiency(content, section, context);
    assert.deepEqual(actual, expected, `${section}: ${JSON.stringify(content)}`);
    assert.equal(actual.passed, actual.unmet.length === 0, `${section}: passed means nothing unmet`);
    for (const label of actual.unmet) {
      assert.ok(OBLIGATIONS[section].some((obligation) => obligation.label === label), `${label} is a declared obligation`);
    }
  }

  // the exact strings, for the interesting verdicts
  assert.deepEqual(sectionSufficiency('', 'abstract', none), {
    section: 'abstract',
    passed: false,
    unmet: ['states the research question'],
  });
  assert.deepEqual(sectionSufficiency('We investigate the question.', 'abstract', { claimIds: [], evidenceIds: ['e'] }), {
    section: 'abstract',
    passed: false,
    unmet: ['reports the recorded result from evidence'],
  });
  assert.deepEqual(sectionSufficiency('', 'results', { claimIds: [], evidenceIds: [], runCount: 3, metric: 'accuracy' }), {
    section: 'results',
    passed: false,
    unmet: ['reports a number from recorded runs (no bare comparison)', 'ties the result to its statistic/confidence'],
  });
  assert.deepEqual(sectionSufficiency('The frozen protocol measures accuracy against the baseline, statistics are deterministic.', 'methods', { metric: 'accuracy' }), {
    section: 'methods',
    passed: true,
    unmet: [],
  });

  // a section with no obligations passes trivially, and an unknown section has none
  assert.deepEqual(sectionSufficiency('anything at all', 'appendix', none), { section: 'appendix', passed: true, unmet: [] });

  // metrics are regexes in the donor: a literal or a pattern both work
  const pattern = sectionSufficiency('mean accuracy_score is above the decision rule', 'methods', { metric: 'accuracy_score' });
  assert.deepEqual(pattern.unmet, ['describes a frozen protocol'], 'a metric pattern matches literally');

  // the donor's own edge behaviour, kept: a non-zero runCount demands a number, and
  // the statistic obligation is judged independently of it
  assert.deepEqual(sectionSufficiency('We compared two conditions.', 'results', { runCount: 5, evidenceIds: [], claimIds: [] }), {
    section: 'results',
    passed: false,
    unmet: ['reports a number from recorded runs (no bare comparison)', 'ties the result to its statistic/confidence'],
  });
  assert.deepEqual(sectionSufficiency('n = 5 runs were recorded.', 'results', { runCount: 5, evidenceIds: [], claimIds: [] }), {
    section: 'results',
    passed: false,
    unmet: ['ties the result to its statistic/confidence'],
    // "recorded run" satisfies the number obligation; naming a run is not a statistic
  });
  // runCount 0 releases the "no bare comparison" obligation even with no number present
  assert.deepEqual(sectionSufficiency('We compared two conditions.', 'results', { runCount: 0, evidenceIds: [], claimIds: [] }), {
    section: 'results',
    passed: false,
    unmet: ['ties the result to its statistic/confidence'],
  });

  // with no metric supplied the metric obligation short-circuits to unmet, and no
  // regex is built at all; the statistics obligation is still judged on its own
  assert.deepEqual(sectionSufficiency('The frozen protocol measures accuracy against the baseline.', 'methods', {}), {
    section: 'methods',
    passed: false,
    unmet: ['specifies metric/baseline/criterion', 'describes deterministic statistics'],
  });

  // the abstract evidence obligation reads ctx.evidenceIds directly, as the donor does
  assert.throws(() => sectionSufficiency('question', 'abstract', { claimIds: [] }), TypeError);
});

test('§19 anti-premature-closure names every undiscussed claim and evidence id', () => {
  const undiscussed = antiPrematureClosure({
    claims: [{ id: 'claim:experiment-1', text: 'a' }, { id: 'claim:background', text: 'b' }],
    evidenceIds: ['run:1', 'run:2'],
    sections: {
      results: { content: 'The mean was 0.750.', allowedEvidenceIds: [] },
      discussion: { content: 'The result is consistent with the evidence.', allowedEvidenceIds: [] },
    },
    plan: PLAN,
  });
  assert.deepEqual(undiscussed, {
    premature: true,
    undiscussedClaims: ['claim:background'],
    undiscussedEvidence: ['run:1', 'run:2'],
    resultWithoutInterpretation: false,
  });

  // a complete manuscript closes cleanly: every mapped claim has a draft and every
  // evidence id is named by an `@id` citation
  const closed = antiPrematureClosure({
    claims: [{ id: 'claim:experiment-1', text: 'a' }, { id: 'claim:background', text: 'b' }],
    evidenceIds: ['run:1', 'run:2'],
    sections: {
      abstract: { content: 'We investigate the question (@stat:experiment-1).', allowedEvidenceIds: [] },
      results: { content: 'The mean was 0.750 (@run:1).', allowedEvidenceIds: [] },
      discussion: { content: 'The result is consistent with the evidence (@run:2).', allowedEvidenceIds: [] },
      conclusion: { content: 'The evidence supports this.', allowedEvidenceIds: [] },
      introduction: { content: 'Prior work leaves a gap.', allowedEvidenceIds: [] },
      methods: { content: 'The frozen protocol.', allowedEvidenceIds: [] },
    },
    plan: PLAN,
  });
  assert.deepEqual(closed, {
    premature: false,
    undiscussedClaims: [],
    undiscussedEvidence: [],
    resultWithoutInterpretation: false,
  });

  // a claim with no draft in any of its mapped sections stays undiscussed
  const missingSection = antiPrematureClosure({
    claims: [{ id: 'claim:experiment-1', text: 'a' }, { id: 'claim:background', text: 'b' }],
    evidenceIds: [],
    sections: { results: { content: 'The mean was 0.750.', allowedEvidenceIds: [] }, discussion: { content: 'Consistent with evidence.', allowedEvidenceIds: [] } },
    plan: PLAN,
  });
  assert.deepEqual(missingSection.undiscussedClaims, ['claim:background']);
  assert.equal(missingSection.premature, true);

  // evidence counts as discussed when a draft lists it as allowed, even uncited
  const byAllowed = antiPrematureClosure({
    claims: [{ id: 'claim:experiment-1', text: 'a' }, { id: 'claim:background', text: 'b' }],
    evidenceIds: ['run:2'],
    sections: {
      abstract: { content: 'We investigate.', allowedEvidenceIds: ['run:2'] },
      introduction: { content: 'A gap.', allowedEvidenceIds: [] },
      methods: { content: 'Protocol.', allowedEvidenceIds: [] },
      results: { content: 'The mean was 0.750.', allowedEvidenceIds: [] },
      discussion: { content: 'Consistent with evidence.', allowedEvidenceIds: [] },
      conclusion: { content: 'The evidence supports it.', allowedEvidenceIds: [] },
    },
    plan: PLAN,
  });
  assert.deepEqual(byAllowed.undiscussedEvidence, [], 'allowedEvidenceIds counts as discussed');
  assert.equal(byAllowed.premature, false);

  // the `@id` citation form, with the id's regex metacharacters escaped
  const cited = antiPrematureClosure({
    claims: [{ id: 'claim:experiment-1', text: 'a' }, { id: 'claim:background', text: 'b' }],
    evidenceIds: ['stat:experiment-1'],
    sections: {
      abstract: { content: 'We investigate.', allowedEvidenceIds: [] },
      introduction: { content: 'A gap.', allowedEvidenceIds: [] },
      methods: { content: 'Protocol.', allowedEvidenceIds: [] },
      results: { content: 'The mean was 0.750; see @stat:experiment-1.', allowedEvidenceIds: [] },
      discussion: { content: 'Consistent with evidence.', allowedEvidenceIds: [] },
      conclusion: { content: 'The evidence supports it.', allowedEvidenceIds: [] },
    },
    plan: PLAN,
  });
  assert.deepEqual(cited.undiscussedEvidence, []);
  assert.equal(cited.resultWithoutInterpretation, false);
});

test('§19 reports a results section that no discussion interprets', () => {
  const base = {
    claims: [],
    evidenceIds: [],
    plan: { id: 'ir-9', claimsToSections: {} },
  };
  const resultsOnly = antiPrematureClosure({ ...base, sections: { results: { content: 'The mean was 0.750.', allowedEvidenceIds: [] } } });
  assert.deepEqual(resultsOnly, {
    premature: true,
    undiscussedClaims: [],
    undiscussedEvidence: [],
    resultWithoutInterpretation: true,
  });

  const uninterpreting = antiPrematureClosure({
    ...base,
    sections: {
      results: { content: 'The mean was 0.750.', allowedEvidenceIds: [] },
      discussion: { content: 'We enjoyed this project.', allowedEvidenceIds: [] },
    },
  });
  assert.equal(uninterpreting.resultWithoutInterpretation, true, 'a discussion with no interpreting word still fails');
  assert.equal(uninterpreting.premature, true);

  for (const word of ['consistent', 'support', 'limitation', 'uncertain', 'suggest']) {
    const verdict = antiPrematureClosure({
      ...base,
      sections: {
        results: { content: 'The mean was 0.750.', allowedEvidenceIds: [] },
        discussion: { content: `This ${word}s the reading.`, allowedEvidenceIds: [] },
      },
    });
    assert.equal(verdict.resultWithoutInterpretation, false, word);
  }

  // no results text at all is not an anomaly
  const noResults = antiPrematureClosure({ ...base, sections: { discussion: { content: 'Nothing to say.', allowedEvidenceIds: [] } } });
  assert.deepEqual(noResults, {
    premature: false,
    undiscussedClaims: [],
    undiscussedEvidence: [],
    resultWithoutInterpretation: false,
  });

  // the donor's `?? {}` fallback on a plan without claimsToSections
  const noMap = antiPrematureClosure({
    claims: [{ id: 'claim:x', text: 'x' }],
    evidenceIds: [],
    sections: {},
    plan: { id: 'ir-10' },
  });
  assert.deepEqual(noMap.undiscussedClaims, ['claim:x']);
  assert.equal(noMap.premature, true);
});

test('the LaTeX table is emitted byte for byte, with the donor escapes', () => {
  const table = {
    title: 'accuracy by recorded run',
    columns: [{ name: 'accuracy', unit: '%' }, { name: 'n' }],
    rows: [
      { label: 'run 1', cells: [{ value: 0.5 }, { value: 32, raw: 'n = 32' }] },
      { label: 'run 2', cells: [{ value: 1 }, { value: 3 }] },
    ],
    footnote: 'mean 0.750; 95% CI [0.100, 1.000]',
  };
  const latex = resultTableToLatex(table);
  assert.equal(
    latex,
    [
      '\\begin{table}[h]',
      '\\centering',
      '\\caption{accuracy by recorded run}',
      '\\begin{tabular}{lrr}',
      '\\hline',
      '\\textbf{} & \\textbf{accuracy (\\%)} & \\textbf{n} \\\\',
      '\\hline',
      'run 1 & 0.500 & n = 32 \\\\',
      'run 2 & 1.000 & 3.000 \\\\',
      '\\hline',
      '\\end{tabular}',
      '\\footnotesize mean 0.750; 95\\% CI [0.100, 1.000]',
      '\\end{table}',
    ].join('\n'),
  );
  assert.equal(latex.length, 281, 'the tabular block has the pinned length');
  assert.ok(!latex.endsWith('\n'), 'no trailing newline, exactly as the donor emits it');

  // every column after the label column is right-aligned
  assert.match(latex, /\\begin\{tabular\}\{lrr\}/);
  // a raw cell replaces the number and is not escaped
  assert.ok(latex.includes('n = 32'));
  assert.ok(latex.includes('3.000'), 'a value without raw is formatted to three decimals');

  const escaped = resultTableToLatex({
    title: 'gap_analysis & 50% #1 ~ 2^3',
    columns: [{ name: 'a_b', unit: 'ms' }],
    rows: [{ label: 'r_1', cells: [{ value: 0.5, raw: 'x_y' }] }],
    footnote: 'p < 0.05, 100% & "quoted"',
  });
  assert.equal(
    escaped,
    [
      '\\begin{table}[h]',
      '\\centering',
      '\\caption{gap\\_analysis \\& 50\\% \\#1 \\textasciitilde{} 2\\textasciicircum{}3}',
      '\\begin{tabular}{lr}',
      '\\hline',
      '\\textbf{} & \\textbf{a\\_b (ms)} \\\\',
      '\\hline',
      'r\\_1 & x_y \\\\',
      '\\hline',
      '\\end{tabular}',
      '\\footnotesize p < 0.05, 100\\% \\& "quoted"',
      '\\end{table}',
    ].join('\n'),
    'the title, headers, row label and footnote are escaped; the raw cell is not',
  );

  // no footnote: the footnote line collapses to an empty line, as the donor emits it
  assert.equal(
    resultTableToLatex({ title: 't', columns: [{ name: 'c' }], rows: [] }),
    [
      '\\begin{table}[h]',
      '\\centering',
      '\\caption{t}',
      '\\begin{tabular}{lr}',
      '\\hline',
      '\\textbf{} & \\textbf{c} \\\\',
      '\\hline',
      ' \\\\',
      '\\hline',
      '\\end{tabular}',
      '',
      '\\end{table}',
    ].join('\n'),
  );
});

test('the Markdown table mirrors the same rows, with its own escaping rules', () => {
  const table = {
    title: 'accuracy by recorded run',
    columns: [{ name: 'accuracy', unit: '%' }, { name: 'n' }],
    rows: [
      { label: 'run 1', cells: [{ value: 0.5 }, { value: 32, raw: 'n = 32' }] },
      { label: 'run 2', cells: [{ value: 1 }, { value: 3 }] },
    ],
    footnote: 'mean 0.750; 95% CI [0.100, 1.000]',
  };
  const markdown = resultTableToMarkdown(table);
  assert.equal(
    markdown,
    [
      '### accuracy by recorded run',
      '',
      'Run | accuracy | n',
      '--- | --- | ---',
      'run 1 | 0.500 | n = 32',
      'run 2 | 1.000 | 3.000',
      '',
      '_mean 0.750; 95% CI [0.100, 1.000]_',
    ].join('\n'),
  );
  assert.equal(markdown.length, 146, 'the table has the pinned length');
  // the mirror is NOT the LaTeX header: `Run` labels the first column, the unit is
  // dropped from the header and `%` is not escaped
  assert.ok(markdown.startsWith('### accuracy by recorded run\n\nRun | accuracy | n\n--- | --- | ---'));
  assert.ok(markdown.includes('Run | accuracy | n'), 'the first column is labelled Run');
  assert.ok(!markdown.includes('accuracy (%)'), 'the unit never reaches the Markdown header');
  assert.ok(!markdown.includes('\\%'), 'a percent sign is not escaped in Markdown');

  // only the row label and the footnote are escaped; cells and column names are not
  const probe = resultTableToMarkdown({
    title: 'gap_analysis & 50% #1 ~ 2^3',
    columns: [{ name: 'a_b', unit: 'ms' }],
    rows: [{ label: 'a|b\nc', cells: [{ value: 0.5 }] }],
    footnote: 'p < 0.05, 100% & "quoted"',
  });
  assert.equal(
    probe,
    [
      '### gap_analysis & 50% #1 ~ 2^3',
      '',
      'Run | a_b',
      '--- | ---',
      'a\\|b c | 0.500',
      '',
      '_p < 0.05, 100% & "quoted"_',
    ].join('\n'),
  );

  // a raw cell in a cell that is not the label is trusted verbatim, pipe and all
  const rawPipe = resultTableToMarkdown({
    title: 't',
    columns: [{ name: 'c' }],
    rows: [{ label: 'r', cells: [{ value: 0.5, raw: 'a|b' }] }],
  });
  assert.ok(rawPipe.includes('r | a|b'), 'the donor does not escape cells');
  assert.ok(!rawPipe.includes('a\\|b'));

  // no footnote and no rows
  assert.equal(
    resultTableToMarkdown({ title: 't', columns: [{ name: 'c' }], rows: [] }),
    '### t\n\nRun | c\n--- | ---\n',
  );
  assert.equal(
    resultTableToMarkdown({ title: 't', columns: [{ name: 'c' }], rows: [] }).includes('_'),
    false,
    'an absent footnote adds no italic line',
  );
});

test('the §21.2 visual-evidence verdict keeps the donor reason string', () => {
  assert.deepEqual(quantitativeVisualEvidenceVerdict({ hasQuantitativeResults: true, resultTableCount: 1, embeddableFigureCount: 0 }), { ok: true });
  assert.deepEqual(quantitativeVisualEvidenceVerdict({ hasQuantitativeResults: true, resultTableCount: 0, embeddableFigureCount: 3 }), { ok: true });
  assert.deepEqual(quantitativeVisualEvidenceVerdict({ hasQuantitativeResults: false, resultTableCount: 0, embeddableFigureCount: 0 }), { ok: true });
  assert.deepEqual(quantitativeVisualEvidenceVerdict({ hasQuantitativeResults: true, resultTableCount: 0, embeddableFigureCount: 0 }), {
    ok: false,
    reason: 'MANUSCRIPT_VISUAL_EVIDENCE_INSUFFICIENT: quantitative results with 0 result tables and 0 PDF-embeddable figures',
  });
  assert.equal(Object.keys(quantitativeVisualEvidenceVerdict({ hasQuantitativeResults: true, resultTableCount: 1, embeddableFigureCount: 0 })).length, 1);
});

test('the donor plan validator keeps its exact refusal messages', () => {
  assert.equal(validateManuscriptPlan(PLAN), undefined, 'a valid plan validates silently');
  assert.equal(validateManuscriptPlan({ id: 'x' }), undefined, 'no claimsToSections means nothing to check');
  assert.throws(() => validateManuscriptPlan({ id: '   ', claimsToSections: {} }), {
    name: 'Error',
    message: 'Manuscript plan requires an id',
  });
  assert.throws(() => validateManuscriptPlan({ claimsToSections: {} }), { message: 'Manuscript plan requires an id' });
  assert.throws(() => validateManuscriptPlan(null), { message: 'Manuscript plan requires an id' });
  assert.throws(() => validateManuscriptPlan({ id: 'x', claimsToSections: { 'claim:a': [] } }), {
    message: 'Invalid claim→section mapping for claim:a',
  });
  assert.throws(() => validateManuscriptPlan({ id: 'x', claimsToSections: { 'claim:a': ['appendix'] } }), {
    message: 'Invalid claim→section mapping for claim:a',
  });
  assert.throws(() => validateManuscriptPlan({ id: 'x', claimsToSections: { 'claim:a': ['results', 'appendix'] } }), {
    message: 'Invalid claim→section mapping for claim:a',
  });
});

test('the manuscript factories validate, freeze, copy and never repair', () => {
  const plan = manuscriptPlan(PLAN);
  assert.deepEqual(plan, PLAN);
  assert.ok(Object.isFrozen(plan));
  assert.ok(Object.isFrozen(plan.claimsToSections));
  assert.ok(Object.isFrozen(plan.claimsToSections['claim:experiment-1']));
  assert.throws(() => {
    plan.claimsToSections['claim:experiment-1'].push('methods');
  }, TypeError);
  assert.throws(() => manuscriptPlan({ id: '', claimsToSections: {} }), { message: 'plan.id must be a non-empty string' });
  assert.throws(() => manuscriptPlan({ claimsToSections: {} }), { message: 'plan.id must be a non-empty string' });
  assert.throws(() => manuscriptPlan('ir-1'), { message: 'plan must be an object' });
  assert.throws(() => manuscriptPlan({ id: 'x', claimsToSections: { 'claim:a': [] } }), {
    message: 'plan.claimsToSections.claim:a must not be empty',
  });
  assert.throws(() => manuscriptPlan({ id: 'x', claimsToSections: { 'claim:a': ['appendix'] } }), {
    message: 'plan.claimsToSections.claim:a[0] must be one of abstract, introduction, methods, results, discussion, conclusion',
  });
  assert.throws(() => manuscriptPlan({ id: 'x', claimsToSections: { 'claim:a': 'results' } }), {
    message: 'plan.claimsToSections.claim:a must be an array',
  });
  assert.equal(validateManuscriptPlanShape(PLAN), PLAN, 'the shape check returns the value it judged');
  assert.throws(() => validateManuscriptPlanShape({ id: 'x', claimsToSections: { 'claim:a': ['appendix'] } }), TypeError);

  const brief = sectionBrief({ section: 'results', purpose: 'report statistics', claimIds: ['c'], evidenceIds: [] });
  assert.deepEqual(brief, { section: 'results', purpose: 'report statistics', claimIds: ['c'], evidenceIds: [] });
  assert.ok(Object.isFrozen(brief) && Object.isFrozen(brief.claimIds));
  assert.throws(() => sectionBrief({ section: 'appendix', purpose: 'p', claimIds: [], evidenceIds: [] }), {
    message: 'brief.section must be one of abstract, introduction, methods, results, discussion, conclusion',
  });
  assert.throws(() => sectionBrief({ section: 'results', purpose: '   ', claimIds: [], evidenceIds: [] }), {
    message: 'brief.purpose must be a non-empty string',
  });
  assert.throws(() => sectionBrief({ section: 'results', purpose: 'p', claimIds: [''], evidenceIds: [] }), {
    message: 'brief.claimIds[0] must be a non-empty string',
  });

  const draft = sectionDraft({
    section: 'results',
    status: 'DRAFTED',
    allowedEvidenceIds: ['run:1'],
    content: 'The mean was 0.750.',
    revisions: 0,
    updatedAt: '2026-09-29T00:00:00.000Z',
  });
  assert.deepEqual(draft, {
    section: 'results',
    status: 'DRAFTED',
    allowedEvidenceIds: ['run:1'],
    content: 'The mean was 0.750.',
    revisions: 0,
    updatedAt: '2026-09-29T00:00:00.000Z',
  });
  assert.ok(Object.isFrozen(draft));
  assert.equal('reviewerNotes' in draft, false, 'an absent optional field is not invented');
  const withNotes = sectionDraft({
    section: 'results',
    status: 'REVIEWED',
    allowedEvidenceIds: [],
    content: '',
    reviewerNotes: ['tighten the claim'],
    revisions: 2,
    updatedAt: '2026-09-29T00:00:00.000Z',
  });
  assert.deepEqual(withNotes.reviewerNotes, ['tighten the claim']);
  assert.ok(Object.isFrozen(withNotes.reviewerNotes));
  assert.throws(() => sectionDraft({ section: 'results', status: 'APPROVED', allowedEvidenceIds: [], content: '', revisions: 0, updatedAt: 'x' }), {
    message: 'draft.status must be one of PENDING, BRIEFED, DRAFTED, REVIEWED, EVIDENCE_CHECKED, REVISED',
  });
  assert.throws(() => sectionDraft({ section: 'results', status: 'DRAFTED', allowedEvidenceIds: [], content: 42, revisions: 0, updatedAt: 'x' }), {
    message: 'draft.content must be a string',
  });
  assert.throws(() => sectionDraft({ section: 'results', status: 'DRAFTED', allowedEvidenceIds: [], content: '', revisions: -1, updatedAt: 'x' }), {
    message: 'draft.revisions must be a non-negative finite number',
  });
  assert.throws(() => sectionDraft({ section: 'results', status: 'DRAFTED', allowedEvidenceIds: [], content: '', revisions: 0, updatedAt: ' ' }), {
    message: 'draft.updatedAt must be a non-empty string',
  });

  const checkInput = evidenceCheckInput({ section: 'abstract', allowedEvidenceIds: ['run:1'], content: 'x' });
  assert.deepEqual(checkInput, { section: 'abstract', allowedEvidenceIds: ['run:1'], content: 'x' });
  assert.ok(Object.isFrozen(checkInput));
  // an empty draft body is a string, and the factory accepts it: a PENDING section
  // has no content yet, and refusing it would be policy the donor does not have
  assert.equal(evidenceCheckInput({ section: 'conclusion', content: '' }).content, '');
  assert.throws(() => evidenceCheckInput({ section: 'conclusion' }), { message: 'draft.content must be a string' });
  assert.throws(() => evidenceCheckInput({ section: 'appendix', content: 'x' }), {
    message: 'draft.section must be one of abstract, introduction, methods, results, discussion, conclusion',
  });
  assert.throws(() => evidenceCheckInput({ section: 'methods', content: 'x', allowedEvidenceIds: 'run:1' }), {
    message: 'draft.allowedEvidenceIds must be an array',
  });

  const table = resultTable({
    title: 'accuracy by recorded run',
    columns: [{ name: 'accuracy', unit: '%' }, { name: 'n' }],
    rows: [{ label: 'run 1', cells: [{ value: 0.5 }, { value: 32, raw: 'n = 32' }] }],
  });
  assert.deepEqual(table, {
    title: 'accuracy by recorded run',
    columns: [{ name: 'accuracy', unit: '%' }, { name: 'n' }],
    rows: [{ label: 'run 1', cells: [{ value: 0.5 }, { value: 32, raw: 'n = 32' }] }],
  });
  assert.ok(Object.isFrozen(table) && Object.isFrozen(table.rows[0].cells[1]));
  assert.equal('footnote' in table, false, 'an absent footnote is not invented');
  assert.throws(() => resultTable({ title: 't', columns: [{ name: 'c' }], rows: [{ label: 'r', cells: [{ value: Number.NaN }] }] }), {
    message: 'table.rows[0]: row.cells[0]: cell.value must be a finite number',
  });
  assert.throws(() => resultTable({ title: 't', columns: [{ name: '' }], rows: [] }), {
    message: 'table.columns[0]: column.name must be a non-empty string',
  });
  assert.throws(() => resultTable({ title: 't', columns: [{ name: 'c' }], rows: [{ label: 'r', cells: [{ value: 0.5, raw: '' }] }] }), {
    message: 'table.rows[0]: row.cells[0]: cell.raw must be a non-empty string',
  });
  assert.throws(() => resultTable({ columns: [], rows: [] }), { message: 'table.title must be a non-empty string' });

  // construction copies: mutating the source afterwards changes nothing
  const source = {
    title: 't',
    columns: [{ name: 'c' }],
    rows: [{ label: 'r', cells: [{ value: 0.5 }] }],
  };
  const copied = resultTable(source);
  source.columns.push({ name: 'extra' });
  source.rows[0].cells.push({ value: 9 });
  assert.deepEqual(copied.columns, [{ name: 'c' }]);
  assert.deepEqual(copied.rows[0].cells, [{ value: 0.5 }]);
  assert.throws(() => {
    copied.rows[0].cells[0].value = 7;
  }, TypeError);
});
