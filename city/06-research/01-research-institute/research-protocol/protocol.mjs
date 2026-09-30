/**
 * UTOPIA · Research Institute — protocol freeze + amendment.
 *
 * protocol.json is frozen by a caller-supplied hash before experiments start, and
 * the run moves to PROTOCOL_FROZEN. After freeze only mechanical fields (syntax /
 * path / environment / package / runtime error) may be auto-fixed; scientific fields
 * (hypothesis / primary metric / baseline / sample definition / exclusion rule /
 * evaluation criterion) must not change silently — any such change requires an
 * explicit `protocol-amendment-<n>.json` referencing the original frozen hash.
 *
 * Ported from the Codex-Boss donor `src/shared/research-protocol.ts` @
 * 8df428eaa437a409368401e95194e40266b83080. Pure: the digest is injected, never
 * computed here, so the freeze hash is the caller's rule and the same protocol
 * always canonicalises to the same text.
 *
 * Rules that must not be softened:
 *   - the canonical JSON form is key-sorted and recursive, so two equal protocols
 *     hash equal regardless of property order;
 *   - `diffProtocol` reports a silent change only for a field that is present in the
 *     frozen core AND differs; a field the candidate no longer carries is not a
 *     silent change here;
 *   - a baseline is never an unexplained constant: when none is declared the host
 *     records why it chose the number it chose.
 */

import { DECLARABLE_BASELINE_SOURCES, protocolAmendment } from './contracts.mjs';

export { AUTO_FIXABLE_FIELDS, FROZEN_FIELDS, protocolAmendment } from './contracts.mjs';

/** Deterministic canonical JSON (sorted keys) used for the freeze hash. */
export function canonicalStableProtocol(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStableProtocol).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalStableProtocol(value[key])}`).join(',')}}`;
}

export function hashProtocol(protocol, hash) {
  return hash(canonicalStableProtocol(protocol));
}

/** Returns the scientific core used to detect silent mutation after freeze. */
export function scientificCore(protocol) {
  const core = {
    hypothesis: protocol.hypothesis,
    'primary-metric': protocol.primaryMetric,
    baseline: protocol.baseline,
    'sample-definition': protocol.sampleDefinition,
    'evaluation-criterion': protocol.evaluationCriterion,
  };
  if (protocol.exclusionRule) core['exclusion-rule'] = protocol.exclusionRule;
  return core;
}

/** Compares the current scientific core to a previously frozen one (silent-mutation guard). */
export function diffProtocol(original, candidate) {
  const candidateCore = scientificCore(candidate);
  const changedFrozen = Object.keys(original).filter((field) => candidateCore[field] !== undefined && candidateCore[field] !== original[field]);
  return { silentChange: changedFrozen.length > 0, changedFrozen, changedMechanical: [] };
}

/**
 * Validate a protocol amendment. The single gate: every refusal carries the donor's
 * exact message, including the offending field name.
 *
 * @throws {Error} see `protocolAmendment` (contracts.mjs)
 */
export function validateAmendment(amendment) {
  protocolAmendment(amendment);
}

/* ----------------------------------------- baseline provenance (Overcomplete §9.8) */

/** Metric names that behave like a bounded proportion (chance = 0.5). */
const PROPORTION_TOKENS = ['accuracy', 'precision', 'recall', 'f1', 'agreement', 'hit', 'pass@', 'coverage', 'accept', 'correct', 'match'];
/** Metric names that behave like an error/loss quantity where lower is better. */
const ERROR_TOKENS = ['error', 'loss', 'cost', 'latency', 'time', 'delay', 'reject'];

/**
 * Host-deterministic baseline decision (Overcomplete §9.8): a baseline is never an
 * unexplained constant. The implementation may DECLARE a baseline with provenance
 * (`METRICS_META {"baseline":…,"source":"known-benchmark"}`); when none is declared
 * the host infers a named provenance from the metric name and records the reasoning.
 */
export function inferBaselineProvenance(metric, declared) {
  const lower = metric.toLowerCase();
  if (declared && typeof declared.baseline === 'number' && Number.isFinite(declared.baseline)) {
    return {
      value: String(declared.baseline),
      kind: DECLARABLE_BASELINE_SOURCES.includes(declared.source) ? declared.source : 'implementation-declared',
      reason: `implementation declared baseline ${declared.baseline} with source '${declared.source ?? 'unspecified'}'`,
    };
  }
  if (PROPORTION_TOKENS.some((token) => lower.includes(token))) {
    return { value: '0.5', kind: 'random-chance', reason: `metric '${metric}' is proportion-like; chance level 0.5 chosen by host heuristic (no declared baseline)` };
  }
  if (ERROR_TOKENS.some((token) => lower.includes(token))) {
    return { value: '0', kind: 'host-heuristic', reason: `metric '${metric}' is an error/loss quantity; declare a real baseline via METRICS_META (ideal-zero is NOT a scientific baseline) — recorded for transparency` };
  }
  return { value: '0.5', kind: 'host-heuristic', reason: `no declared baseline and metric '${metric}' does not match a proportion heuristic; 0.5 kept with explicit provenance — declare a real baseline via METRICS_META for non-proportion studies` };
}
