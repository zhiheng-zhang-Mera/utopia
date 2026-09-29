/**
 * UTOPIA · Research Institute — protocol freeze + amendment suite.
 *
 * The canonical JSON form, the injected freeze hash, the scientific core, the silent
 * mutation verdict, the amendment gate and the baseline provenance decision, restated
 * from the Codex-Boss donor `src/shared/research-protocol.ts` @
 * 8df428eaa437a409368401e95194e40266b83080.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalStableProtocol,
  diffProtocol,
  hashProtocol,
  inferBaselineProvenance,
  scientificCore,
  validateAmendment,
} from '../index.mjs';

/** Deterministic stand-in for the injected digest: the canonical text itself. */
const identityHash = (text) => `hash(${text})`;

const protocol = () => ({
  schemaVersion: 1,
  hypothesis: 'X beats Y',
  primaryMetric: 'accuracy',
  baseline: '0.5',
  sampleDefinition: 'all items',
  evaluationCriterion: 'accuracy > 0.5',
  createdAt: '2026-09-29T00:00:00.000Z',
});

test('the canonical form sorts keys recursively and hashes through the injected digest', () => {
  assert.equal(canonicalStableProtocol(null), 'null');
  assert.equal(canonicalStableProtocol(1), '1');
  assert.equal(canonicalStableProtocol('a'), '"a"');
  assert.equal(canonicalStableProtocol(true), 'true');
  assert.ok(canonicalStableProtocol(undefined) === undefined, 'the donor calls JSON.stringify(undefined), which has no string form');
  assert.equal(canonicalStableProtocol({ b: 1, a: 2 }), '{"a":2,"b":1}');
  assert.equal(canonicalStableProtocol({ b: { d: 4, c: [3, { f: 6, e: 5 }] }, a: 1 }), '{"a":1,"b":{"c":[3,{"e":5,"f":6}],"d":4}}');
  assert.equal(canonicalStableProtocol([1, 'a', null]), '[1,"a",null]');

  const first = { ...protocol(), extra: { z: 1, a: 2 } };
  const second = { extra: { a: 2, z: 1 }, ...protocol() };
  assert.equal(canonicalStableProtocol(first), canonicalStableProtocol(second), 'property order does not matter');
  assert.equal(hashProtocol(first, identityHash), hashProtocol(second, identityHash));
  assert.equal(hashProtocol(protocol(), identityHash), `hash(${canonicalStableProtocol(protocol())})`);
});

test('the scientific core is the donor field set, exclusion rule optional', () => {
  assert.deepEqual(scientificCore(protocol()), {
    hypothesis: 'X beats Y',
    'primary-metric': 'accuracy',
    baseline: '0.5',
    'sample-definition': 'all items',
    'evaluation-criterion': 'accuracy > 0.5',
  });
  assert.deepEqual(scientificCore({ ...protocol(), exclusionRule: 'drop outliers' }), {
    hypothesis: 'X beats Y',
    'primary-metric': 'accuracy',
    baseline: '0.5',
    'sample-definition': 'all items',
    'evaluation-criterion': 'accuracy > 0.5',
    'exclusion-rule': 'drop outliers',
  });
  assert.deepEqual(
    Object.keys(scientificCore({ ...protocol(), exclusionRule: '' })),
    ['hypothesis', 'primary-metric', 'baseline', 'sample-definition', 'evaluation-criterion'],
    'an empty exclusion rule is not part of the core',
  );
  assert.equal(scientificCore(protocol())['exclusion-rule'], undefined);
});

test('diffProtocol reports a silent change only for a differing frozen field', () => {
  const original = scientificCore(protocol());
  assert.deepEqual(diffProtocol(original, protocol()), { silentChange: false, changedFrozen: [], changedMechanical: [] });

  const changed = diffProtocol(original, { ...protocol(), baseline: '0.6' });
  assert.deepEqual(changed, { silentChange: true, changedFrozen: ['baseline'], changedMechanical: [] });

  const many = diffProtocol(original, { ...protocol(), hypothesis: 'Z beats W', evaluationCriterion: 'accuracy > 0.9' });
  assert.deepEqual(many.changedFrozen, ['hypothesis', 'evaluation-criterion'], 'reported in the frozen core order');
  assert.equal(many.silentChange, true);

  // a field the candidate no longer carries is not a silent change: the donor only
  // compares fields the candidate core actually defines.
  assert.deepEqual(diffProtocol(original, { ...protocol(), exclusionRule: undefined }), { silentChange: false, changedFrozen: [], changedMechanical: [] });
  const withRule = diffProtocol(scientificCore({ ...protocol(), exclusionRule: 'drop outliers' }), { ...protocol(), exclusionRule: 'keep all' });
  assert.deepEqual(withRule, { silentChange: true, changedFrozen: ['exclusion-rule'], changedMechanical: [] });
  assert.deepEqual(withRule.changedMechanical, [], 'mechanical changes are never reported here');
});

test('the amendment gate refuses with the donor messages and accepts a frozen-field change', () => {
  const amendment = {
    id: 'protocol-amendment-1',
    protocolHash: 'hash-1',
    changes: [{ field: 'hypothesis', before: 'X beats Y', after: 'X beats Y at scale', reason: 'scope narrowed' }],
    approved: true,
    createdAt: '2026-09-29T00:00:00.000Z',
  };
  assert.equal(validateAmendment(amendment), undefined);
  assert.throws(() => validateAmendment({ ...amendment, id: '' }), (error) => {
    assert.equal(error.message, 'Amendment requires an id');
    return true;
  });
  assert.throws(() => validateAmendment({ ...amendment, changes: [{ field: 'environment', reason: 'r' }] }), (error) => {
    assert.equal(error.message, 'Amendment touches non-frozen field: environment');
    return true;
  });
  assert.throws(() => validateAmendment({ ...amendment, changes: [{ field: 'baseline' }] }), (error) => {
    assert.equal(error.message, 'Amendment change requires a reason');
    return true;
  });
});

test('a declared baseline is honoured, an unknown source becomes implementation-declared', () => {
  assert.deepEqual(inferBaselineProvenance('accuracy', { baseline: 0.72, source: 'known-benchmark' }), {
    value: '0.72',
    kind: 'known-benchmark',
    reason: "implementation declared baseline 0.72 with source 'known-benchmark'",
  });
  assert.deepEqual(inferBaselineProvenance('accuracy', { baseline: 0, source: 'previous-system' }), {
    value: '0',
    kind: 'previous-system',
    reason: "implementation declared baseline 0 with source 'previous-system'",
  });
  assert.deepEqual(inferBaselineProvenance('accuracy', { baseline: 0.1, source: 'vibes' }), {
    value: '0.1',
    kind: 'implementation-declared',
    reason: "implementation declared baseline 0.1 with source 'vibes'",
  });
  assert.deepEqual(inferBaselineProvenance('accuracy', { baseline: 0.1 }), {
    value: '0.1',
    kind: 'implementation-declared',
    reason: "implementation declared baseline 0.1 with source 'unspecified'",
  });
  assert.deepEqual(inferBaselineProvenance('accuracy', { baseline: 0.1, source: 'host-heuristic' }), {
    value: '0.1',
    kind: 'implementation-declared',
    reason: "implementation declared baseline 0.1 with source 'host-heuristic'",
  });
  assert.deepEqual(inferBaselineProvenance('accuracy', { baseline: Number.NaN, source: 'known-benchmark' }), {
    value: '0.5',
    kind: 'random-chance',
    reason: "metric 'accuracy' is proportion-like; chance level 0.5 chosen by host heuristic (no declared baseline)",
  });
  assert.deepEqual(inferBaselineProvenance('accuracy', { baseline: '0.9', source: 'known-benchmark' }), {
    value: '0.5',
    kind: 'random-chance',
    reason: "metric 'accuracy' is proportion-like; chance level 0.5 chosen by host heuristic (no declared baseline)",
  });
});

test('with no declared baseline the host infers a named provenance and records why', () => {
  for (const metric of ['Accuracy', 'precision@1', 'F1', 'agreement', 'hit-rate', 'pass@k', 'coverage', 'accept-rate', 'correct', 'match-rate']) {
    const decision = inferBaselineProvenance(metric);
    assert.equal(decision.kind, 'random-chance', metric);
    assert.equal(decision.value, '0.5', metric);
    assert.equal(decision.reason, `metric '${metric}' is proportion-like; chance level 0.5 chosen by host heuristic (no declared baseline)`);
  }
  for (const metric of ['error', 'loss', 'cost', 'latency', 'time', 'delay', 'reject']) {
    const decision = inferBaselineProvenance(metric);
    assert.equal(decision.kind, 'host-heuristic', metric);
    assert.equal(decision.value, '0', metric);
    assert.equal(decision.reason, `metric '${metric}' is an error/loss quantity; declare a real baseline via METRICS_META (ideal-zero is NOT a scientific baseline) — recorded for transparency`);
  }
  const unknown = inferBaselineProvenance('throughput');
  assert.deepEqual(unknown, {
    value: '0.5',
    kind: 'host-heuristic',
    reason: "no declared baseline and metric 'throughput' does not match a proportion heuristic; 0.5 kept with explicit provenance — declare a real baseline via METRICS_META for non-proportion studies",
  });
  // the metric is matched case-insensitively
  assert.equal(inferBaselineProvenance('LATENCY').value, '0');
  assert.equal(inferBaselineProvenance('ACCURACY').value, '0.5');
});
