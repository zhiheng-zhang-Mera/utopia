/**
 * UTOPIA · Research Institute — research generalization battery suite.
 *
 * Every verdict branch, every `missing` ordering, every score and every reason
 * string asserted here restates the Codex-Boss donor `src/shared/research-battery.ts`
 * @ 8df428eaa437a409368401e95194e40266b83080. §33 is the rule under test: an
 * honest rejection, a null result, an inconclusive run and an insufficient-evidence
 * call are all PASSes, while a READY claim without the full §34 artifact chain is a
 * FAIL.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  READY_GATES,
  REPLICATION_STATUSES,
  RESEARCH_DOMAINS,
  RESEARCH_TERMINAL_STATUSES,
  REVIEW_STATUSES,
  adjudicateResearchOutcome,
  buildResearchBattery,
  isResearchDomain,
  isResearchTerminalStatus,
  researchEvidence,
  researchOutcomeInput,
  runResearchBattery,
} from '../battery.mjs';

/** The donor's own complete §34 evidence chain. */
const FULL = {
  protocol: true,
  executionEvidence: true,
  replication: 'REPRODUCED',
  statistics: true,
  claimGraph: true,
  citations: true,
  review: 'APPROVED',
  manuscript: true,
  finalAudit: true,
};
const full = (over = {}) => ({ ...FULL, ...over });
const outcome = (over = {}) => ({
  domain: 'software-engineering',
  declaredStatus: 'READY',
  hypothesisSupported: true,
  evidence: full(),
  ...over,
});

test('the frozen vocabularies are exactly the donor five domains, five statuses and seven gates', () => {
  assert.deepEqual(RESEARCH_DOMAINS, [
    'software-engineering',
    'multi-agent',
    'reliability',
    'writing-evaluation',
    'negative-null-result',
  ]);
  assert.deepEqual(RESEARCH_TERMINAL_STATUSES, [
    'READY',
    'REJECTED',
    'INCONCLUSIVE',
    'INSUFFICIENT_EVIDENCE',
    'REPLICATION_FAILED',
  ]);
  assert.deepEqual(REPLICATION_STATUSES, ['REPRODUCED', 'FAILED', 'NOT_ATTEMPTED']);
  assert.deepEqual(REVIEW_STATUSES, ['APPROVED', 'VETOED', 'NOT_RUN']);
  assert.deepEqual(READY_GATES, [
    'protocol',
    'executionEvidence',
    'statistics',
    'claimGraph',
    'citations',
    'manuscript',
    'finalAudit',
  ]);
  assert.equal(RESEARCH_DOMAINS.length, 5);
  assert.equal(RESEARCH_TERMINAL_STATUSES.length, 5);
  assert.equal(READY_GATES.length, 7);

  for (const vocabulary of [RESEARCH_DOMAINS, RESEARCH_TERMINAL_STATUSES, REPLICATION_STATUSES, REVIEW_STATUSES, READY_GATES]) {
    assert.ok(Object.isFrozen(vocabulary), 'a frozen vocabulary cannot be edited at runtime');
    assert.throws(() => vocabulary.push('extra'), TypeError);
  }

  assert.equal(isResearchDomain('multi-agent'), true);
  assert.equal(isResearchDomain('physics'), false);
  assert.equal(isResearchTerminalStatus('REPLICATION_FAILED'), true);
  assert.equal(isResearchTerminalStatus('PUBLISHED'), false);
});

test('the contracts validate the declared shapes and never repair an invalid value', () => {
  const evidence = researchEvidence(full());
  assert.deepEqual(evidence, FULL);

  // copy-on-construct: editing the result cannot reach back into the caller
  const source = full();
  const copy = researchEvidence(source);
  assert.notEqual(copy, source, 'the factory returns a new object, not the argument');
  copy.protocol = false;
  assert.equal(source.protocol, true, 'the factory copies rather than aliases');
  assert.deepEqual(Object.keys(copy), Object.keys(FULL), 'the field order follows the donor interface');

  // every required field is required, and no invalid value is coerced
  assert.throws(() => researchEvidence({}), TypeError, 'a missing boolean is refused');
  assert.throws(() => researchEvidence(full({ protocol: 'yes' })), TypeError);
  assert.throws(() => researchEvidence(full({ finalAudit: 1 })), TypeError);
  assert.throws(() => researchEvidence(full({ replication: 'MAYBE' })), TypeError);
  assert.throws(() => researchEvidence(full({ replication: undefined })), TypeError);
  assert.throws(() => researchEvidence(full({ review: 'MAYBE' })), TypeError);
  assert.throws(() => researchEvidence(full({ review: null })), TypeError);
  assert.throws(() => researchEvidence(null), TypeError);
  assert.throws(() => researchEvidence([]), TypeError);

  assert.deepEqual(
    researchOutcomeInput({ domain: 'reliability', declaredStatus: 'INCONCLUSIVE', hypothesisSupported: null, evidence: full() }),
    { domain: 'reliability', declaredStatus: 'INCONCLUSIVE', hypothesisSupported: null, evidence: FULL },
  );
  assert.throws(() => researchOutcomeInput(outcome({ domain: 'physics' })), TypeError);
  assert.throws(() => researchOutcomeInput(outcome({ declaredStatus: 'PUBLISHED' })), TypeError);
  assert.throws(() => researchOutcomeInput(outcome({ hypothesisSupported: 'true' })), TypeError);
  assert.throws(() => researchOutcomeInput(outcome({ evidence: full({ citations: undefined }) })), TypeError);
});

test('READY passes only with the full §34 artifact chain and an approving review', () => {
  assert.deepEqual(adjudicateResearchOutcome(outcome()), {
    domain: 'software-engineering',
    declaredStatus: 'READY',
    status: 'READY',
    pass: true,
    reason: 'full §34 artifact chain + review approved',
    missing: [],
  });

  // a fake READY is downgraded and the missing chain is named in donor order
  assert.deepEqual(adjudicateResearchOutcome(outcome({ evidence: full({ manuscript: false, finalAudit: false }) })), {
    domain: 'software-engineering',
    declaredStatus: 'READY',
    status: 'INSUFFICIENT_EVIDENCE',
    pass: false,
    reason: 'fake READY caught — missing: manuscript, final-audit',
    missing: ['manuscript', 'final-audit'],
  });
  assert.deepEqual(adjudicateResearchOutcome(outcome({ evidence: full({ protocol: false }) })).missing, ['protocol']);

  const bare = adjudicateResearchOutcome(
    outcome({
      evidence: full({
        protocol: false,
        executionEvidence: false,
        replication: 'NOT_ATTEMPTED',
        statistics: false,
        claimGraph: false,
        citations: false,
        review: 'NOT_RUN',
        manuscript: false,
        finalAudit: false,
      }),
    }),
  );
  assert.deepEqual(bare.missing, [
    'protocol',
    'execution-evidence',
    'statistics',
    'claim-graph',
    'citation',
    'manuscript',
    'final-audit',
    'review',
  ]);
  assert.equal(bare.missing.length, 8);
  assert.equal(bare.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(bare.pass, false);
  assert.equal(
    bare.reason,
    'fake READY caught — missing: protocol, execution-evidence, statistics, claim-graph, citation, manuscript, final-audit, review',
  );

  // a vetoed review is reported as the review gate, not as a missing review
  const vetoed = adjudicateResearchOutcome(outcome({ evidence: full({ review: 'VETOED' }) }));
  assert.deepEqual(vetoed.missing, ['review-pass']);
  assert.equal(vetoed.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(vetoed.reason, 'fake READY caught — missing: review-pass');
  const notRun = adjudicateResearchOutcome(outcome({ evidence: full({ review: 'NOT_RUN' }) }));
  assert.deepEqual(notRun.missing, ['review']);
  assert.equal(notRun.reason, 'fake READY caught — missing: review');

  // `replication` is not one of the seven gates, and no evidence-chain label can
  // contain the word "replication": the donor's REPLICATION_FAILED downgrade inside
  // the READY branch is unreachable, so a READY declared over a failed or never
  // attempted replication still passes. Carried over deliberately.
  for (const replication of ['REPRODUCED', 'FAILED', 'NOT_ATTEMPTED']) {
    const verdict = adjudicateResearchOutcome(outcome({ evidence: full({ replication }) }));
    assert.equal(verdict.status, 'READY', `a READY with replication ${replication} is still READY`);
    assert.equal(verdict.pass, true);
  }
  const everyLabel = [...bare.missing, 'review-pass'];
  assert.ok(everyLabel.every((item) => !item.includes('replication')));
});

test('REJECTED is a PASS only when the evidence is complete and the hypothesis unsupported', () => {
  assert.deepEqual(adjudicateResearchOutcome(outcome({ declaredStatus: 'REJECTED', hypothesisSupported: false })), {
    domain: 'software-engineering',
    declaredStatus: 'REJECTED',
    status: 'REJECTED',
    pass: true,
    reason: 'correct rejection with full evidence — PASS',
    missing: [],
  });

  // the negative/null-result domain counts as honest even when nothing is stated
  const nullResult = adjudicateResearchOutcome(
    outcome({ domain: 'negative-null-result', declaredStatus: 'REJECTED', hypothesisSupported: null }),
  );
  assert.equal(nullResult.pass, true);
  assert.equal(nullResult.reason, 'correct rejection with full evidence — PASS');

  // a stated-but-null hypothesis in another domain is not honest
  const unstated = adjudicateResearchOutcome(outcome({ domain: 'multi-agent', declaredStatus: 'REJECTED', hypothesisSupported: null }));
  assert.equal(unstated.pass, false);
  assert.equal(unstated.reason, 'rejection recorded but hypothesis evidence says supported — verify');
  const supported = adjudicateResearchOutcome(outcome({ declaredStatus: 'REJECTED', hypothesisSupported: true }));
  assert.equal(supported.pass, false);
  assert.equal(supported.reason, 'rejection recorded but hypothesis evidence says supported — verify');

  // an incomplete chain fails, and the reason lists what is missing
  const incomplete = adjudicateResearchOutcome(
    outcome({ declaredStatus: 'REJECTED', hypothesisSupported: false, evidence: full({ protocol: false }) }),
  );
  assert.equal(incomplete.pass, false);
  assert.deepEqual(incomplete.missing, ['protocol']);
  assert.equal(incomplete.reason, 'insufficient evidence for a rejection — missing: protocol');

  // replication is required here but is not part of `missing`, so the donor emits its
  // reason with an empty list and a trailing space
  const unrecorded = adjudicateResearchOutcome(
    outcome({ declaredStatus: 'REJECTED', hypothesisSupported: false, evidence: full({ replication: 'NOT_ATTEMPTED' }) }),
  );
  assert.deepEqual(unrecorded.missing, []);
  assert.equal(unrecorded.pass, false);
  assert.equal(unrecorded.reason, 'insufficient evidence for a rejection — missing: ');

  const vetoed = adjudicateResearchOutcome(
    outcome({ declaredStatus: 'REJECTED', hypothesisSupported: false, evidence: full({ review: 'VETOED' }) }),
  );
  assert.equal(vetoed.pass, false);
  assert.deepEqual(vetoed.missing, ['review-pass']);
  assert.equal(vetoed.reason, 'insufficient evidence for a rejection — missing: review-pass');
});

test('REPLICATION_FAILED is a PASS only when the failure is actually recorded', () => {
  assert.deepEqual(
    adjudicateResearchOutcome(
      outcome({ domain: 'reliability', declaredStatus: 'REPLICATION_FAILED', hypothesisSupported: null, evidence: full({ replication: 'FAILED' }) }),
    ),
    {
      domain: 'reliability',
      declaredStatus: 'REPLICATION_FAILED',
      status: 'REPLICATION_FAILED',
      pass: true,
      reason: 'replication failed and honestly recorded — PASS (no fake READY)',
      missing: [],
    },
  );

  // claiming a replication failure over a reproduced result fails with the donor's
  // empty missing list and trailing space
  const reproduced = adjudicateResearchOutcome(
    outcome({ declaredStatus: 'REPLICATION_FAILED', hypothesisSupported: null, evidence: full() }),
  );
  assert.equal(reproduced.pass, false);
  assert.deepEqual(reproduced.missing, []);
  assert.equal(reproduced.reason, 'replication-failure claim incomplete — missing: ');

  const notAttempted = adjudicateResearchOutcome(
    outcome({ declaredStatus: 'REPLICATION_FAILED', hypothesisSupported: null, evidence: full({ replication: 'NOT_ATTEMPTED' }) }),
  );
  assert.equal(notAttempted.pass, false);
  assert.equal(notAttempted.reason, 'replication-failure claim incomplete — missing: ');

  const missingGate = adjudicateResearchOutcome(
    outcome({ declaredStatus: 'REPLICATION_FAILED', hypothesisSupported: null, evidence: full({ replication: 'FAILED', claimGraph: false }) }),
  );
  assert.deepEqual(missingGate.missing, ['claim-graph']);
  assert.equal(missingGate.pass, false);
  assert.equal(missingGate.reason, 'replication-failure claim incomplete — missing: claim-graph');

  const vetoed = adjudicateResearchOutcome(
    outcome({ declaredStatus: 'REPLICATION_FAILED', hypothesisSupported: null, evidence: full({ replication: 'FAILED', review: 'VETOED' }) }),
  );
  assert.equal(vetoed.pass, false);
  assert.deepEqual(vetoed.missing, ['review-pass']);
});

test('INCONCLUSIVE needs only execution evidence and statistics', () => {
  assert.deepEqual(
    adjudicateResearchOutcome(
      outcome({
        domain: 'writing-evaluation',
        declaredStatus: 'INCONCLUSIVE',
        hypothesisSupported: null,
        evidence: full({ claimGraph: false, manuscript: false, finalAudit: false, citations: false }),
      }),
    ),
    {
      domain: 'writing-evaluation',
      declaredStatus: 'INCONCLUSIVE',
      status: 'INCONCLUSIVE',
      pass: true,
      reason: 'inconclusive result honestly reported — PASS',
      missing: ['claim-graph', 'citation', 'manuscript', 'final-audit'],
    },
  );

  const noStatistics = adjudicateResearchOutcome(
    outcome({ declaredStatus: 'INCONCLUSIVE', hypothesisSupported: null, evidence: full({ statistics: false }) }),
  );
  assert.equal(noStatistics.pass, false);
  assert.equal(noStatistics.reason, 'inconclusive claim without statistics/execution evidence');

  const noExecution = adjudicateResearchOutcome(
    outcome({ declaredStatus: 'INCONCLUSIVE', hypothesisSupported: null, evidence: full({ executionEvidence: false }) }),
  );
  assert.equal(noExecution.pass, false);
  assert.equal(noExecution.reason, 'inconclusive claim without statistics/execution evidence');

  // this branch reads only those two gates: a protocol gap, a vetoed review or an
  // unrecorded replication does not change the verdict. Carried over deliberately.
  const indifferent = adjudicateResearchOutcome(
    outcome({
      declaredStatus: 'INCONCLUSIVE',
      hypothesisSupported: null,
      evidence: full({ protocol: false, review: 'VETOED', replication: 'NOT_ATTEMPTED' }),
    }),
  );
  assert.equal(indifferent.pass, true);
  assert.equal(indifferent.reason, 'inconclusive result honestly reported — PASS');
});

test('INSUFFICIENT_EVIDENCE needs only a protocol and an execution trail', () => {
  assert.deepEqual(
    adjudicateResearchOutcome(
      outcome({
        domain: 'negative-null-result',
        declaredStatus: 'INSUFFICIENT_EVIDENCE',
        hypothesisSupported: null,
        evidence: full({ statistics: false, replication: 'NOT_ATTEMPTED', manuscript: false }),
      }),
    ),
    {
      domain: 'negative-null-result',
      declaredStatus: 'INSUFFICIENT_EVIDENCE',
      status: 'INSUFFICIENT_EVIDENCE',
      pass: true,
      reason: 'insufficient-evidence call honestly recorded — PASS',
      missing: ['statistics', 'manuscript'],
    },
  );

  const noProtocol = adjudicateResearchOutcome(
    outcome({ declaredStatus: 'INSUFFICIENT_EVIDENCE', hypothesisSupported: null, evidence: full({ protocol: false }) }),
  );
  assert.equal(noProtocol.pass, false);
  assert.equal(noProtocol.reason, 'insufficient-evidence claim without a protocol/execution trail');

  const noTrail = adjudicateResearchOutcome(
    outcome({ declaredStatus: 'INSUFFICIENT_EVIDENCE', hypothesisSupported: null, evidence: full({ executionEvidence: false }) }),
  );
  assert.equal(noTrail.pass, false);
  assert.equal(noTrail.reason, 'insufficient-evidence claim without a protocol/execution trail');

  // like the inconclusive branch, this one reads only its two gates
  const indifferent = adjudicateResearchOutcome(
    outcome({
      declaredStatus: 'INSUFFICIENT_EVIDENCE',
      hypothesisSupported: null,
      evidence: full({ statistics: false, manuscript: false, finalAudit: false, review: 'VETOED' }),
    }),
  );
  assert.equal(indifferent.pass, true);
  assert.equal(indifferent.reason, 'insufficient-evidence call honestly recorded — PASS');
});

test('an undeclared terminal status reaches the donor last branch rather than being gated', () => {
  // the contract refuses to construct it …
  assert.throws(() => researchOutcomeInput({ ...outcome(), declaredStatus: 'PUBLISHED' }), TypeError);
  // … and adjudication still reports it the way the donor wrote it
  assert.deepEqual(adjudicateResearchOutcome(outcome({ declaredStatus: 'PUBLISHED' })), {
    domain: 'software-engineering',
    declaredStatus: 'PUBLISHED',
    status: 'INSUFFICIENT_EVIDENCE',
    pass: false,
    reason: 'unknown declared status PUBLISHED',
    missing: [],
  });
  const withGaps = adjudicateResearchOutcome(
    outcome({ declaredStatus: 'PUBLISHED', evidence: full({ protocol: false, statistics: false }) }),
  );
  assert.deepEqual(withGaps.missing, ['protocol', 'statistics']);
  assert.equal(withGaps.reason, 'unknown declared status PUBLISHED');
});

test('the battery declares one honest scenario per domain and scores every path', () => {
  const battery = buildResearchBattery();
  assert.equal(battery.length, 6);
  assert.deepEqual(battery.map((scenario) => scenario.label), [
    'SE READY',
    'SE fake READY',
    'Multi-Agent null result (correct rejection)',
    'Reliability replication failed (honest)',
    'Writing-evaluation inconclusive (honest)',
    'Negative/Null insufficient evidence (honest)',
  ]);
  assert.deepEqual(battery.map((scenario) => scenario.expectPass), [true, false, true, true, true, true]);
  assert.deepEqual(battery.map((scenario) => scenario.input.domain), [
    'software-engineering',
    'software-engineering',
    'multi-agent',
    'reliability',
    'writing-evaluation',
    'negative-null-result',
  ]);
  assert.deepEqual(battery.map((scenario) => scenario.input.declaredStatus), [
    'READY',
    'READY',
    'REJECTED',
    'REPLICATION_FAILED',
    'INCONCLUSIVE',
    'INSUFFICIENT_EVIDENCE',
  ]);
  assert.deepEqual(battery.map((scenario) => scenario.input.hypothesisSupported), [true, true, false, null, null, null]);

  // the evidence each scenario declares is the donor's
  assert.deepEqual(battery[0].input.evidence, full());
  assert.deepEqual(battery[1].input.evidence, full({ manuscript: false, finalAudit: false }));
  assert.deepEqual(battery[2].input.evidence, full());
  assert.deepEqual(battery[3].input.evidence, full({ replication: 'FAILED' }));
  assert.deepEqual(battery[4].input.evidence, full({ claimGraph: false, manuscript: false, finalAudit: false, citations: false }));
  assert.deepEqual(battery[5].input.evidence, full({ statistics: false, replication: 'NOT_ATTEMPTED', manuscript: false }));

  // all five domains are covered; software-engineering carries both the honest READY
  // and the fake-READY scenario, so it is the one domain that appears twice
  assert.deepEqual(
    [...new Set(battery.map((scenario) => scenario.input.domain))].sort(),
    [...RESEARCH_DOMAINS].sort(),
  );
  assert.equal(battery.filter((scenario) => scenario.input.domain === 'software-engineering').length, 2);
});

test('runResearchBattery reports the donor verdicts and reason strings in scenario order', () => {
  const run = runResearchBattery();
  assert.equal(run.total, 6);
  assert.equal(run.passed, 6);
  assert.equal(run.scenarios.length, 6);
  assert.deepEqual(run.scenarios.map((scenario) => scenario.status), [
    'READY',
    'INSUFFICIENT_EVIDENCE',
    'REJECTED',
    'REPLICATION_FAILED',
    'INCONCLUSIVE',
    'INSUFFICIENT_EVIDENCE',
  ]);
  assert.deepEqual(run.scenarios.map((scenario) => scenario.pass), [true, false, true, true, true, true]);
  assert.deepEqual(run.scenarios.map((scenario) => scenario.reason), [
    'full §34 artifact chain + review approved',
    'fake READY caught — missing: manuscript, final-audit',
    'correct rejection with full evidence — PASS',
    'replication failed and honestly recorded — PASS (no fake READY)',
    'inconclusive result honestly reported — PASS',
    'insufficient-evidence call honestly recorded — PASS',
  ]);
  assert.deepEqual(run.scenarios.map((scenario) => scenario.missing), [
    [],
    ['manuscript', 'final-audit'],
    [],
    [],
    ['claim-graph', 'citation', 'manuscript', 'final-audit'],
    ['statistics', 'manuscript'],
  ]);
  assert.deepEqual(run.scenarios.map((scenario) => scenario.expected), [true, false, true, true, true, true]);
  assert.deepEqual(run.scenarios.map((scenario) => scenario.label), buildResearchBattery().map((scenario) => scenario.label));

  // the scored fields are the verdict fields plus label and expected, in that order
  assert.deepEqual(run.scenarios[0], {
    domain: 'software-engineering',
    declaredStatus: 'READY',
    status: 'READY',
    pass: true,
    reason: 'full §34 artifact chain + review approved',
    missing: [],
    label: 'SE READY',
    expected: true,
  });

  // the score is the real comparison, not a declared constant
  assert.equal(run.scenarios.filter((scenario) => scenario.pass === scenario.expected).length, run.passed);
  assert.equal(run.passed, run.total, 'every §33 scenario terminates honestly');
});

test('the battery module imports only its siblings and stays free of the donor runtime', async () => {
  const code = (await readFile(join(import.meta.dirname, '..', 'battery.mjs'), 'utf8'))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
  for (const forbidden of ['Math.random', 'Date.now', 'new Date', 'process.env', 'require(', 'fetch(', 'node:', 'Boss']) {
    assert.ok(!code.includes(forbidden), `battery.mjs must not use ${forbidden}`);
  }
  const specifiers = [...code.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(specifiers, ['./contracts.mjs', './contracts.mjs'], 'battery.mjs imports only its sibling contracts');
});
