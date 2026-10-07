import { createHash } from 'node:crypto';
import { minimize } from './sanitize.mjs';

export const AUTHORITY = Object.freeze({ execute: false, repair: false, promote: false, schedule: false });
export const SAFETY_LADDER = Object.freeze(['candidate', 'sandbox', 'historical_replay', 'controlled_evaluation', 'shadow', 'independent_verification', 'explicit_promotion_authority', 'limited_rollout', 'monitor_jev_observation', 'full_promotion_or_rollback']);
const destinations = { research: 'REX', rule: 'RIV', governance: 'DGX', architecture: 'URA', capability: 'CAPABILITY_LINKED_MISSION', provider: 'GAI_ENGINEERING', boss: 'BOSS_LEGACY_DIFF' };
const hash = x => createHash('sha256').update(JSON.stringify(x)).digest('hex');
// Reports accept structured evidence references, never source content, tokens or reasoning traces.
export function evidenceRefs(refs = []) {
  return refs.filter(x => x && typeof x.path === 'string' && !/[?\n\r]|(?:token|password|secret|credential)=/i.test(x.path)).map(x => ({ path: x.path.slice(0, 512), ...(Number.isInteger(x.line) && x.line > 0 ? { line: x.line } : {}), ...(/^[a-f0-9]{64}$/.test(x.sha256) ? { sha256: x.sha256 } : {}), ...(/^[a-f0-9]{40}$/.test(x.source_sha) ? { source_sha: x.source_sha } : {}) }));
}
export function diagnose(finding) {
  const alternatives = {
    REGISTRY_RUNTIME_MISMATCH: ['Runtime snapshot belongs to another deployment or time', 'Registry claim is stale', 'Runtime capability is degraded'],
    DEAD_CAPABILITY_RECORD: ['Implementation moved without registry reconciliation', 'Capability was retired', 'Collection scope did not include the implementation'],
    EVIDENCE_POINTER_MISMATCH: ['Evidence moved or expired', 'Pointer was never valid', 'Repository checkout lacks referenced evidence'],
    BASELINE_ANCESTRY_MISMATCH: ['Wrong development branch', 'Dependency identity was recorded incorrectly', 'Checkout lacks dependency history'],
  };
  return { symptom: finding.code, observations: evidenceRefs(finding.evidence), hypotheses: (alternatives[finding.code] ?? ['Record projection is stale', 'Observed source changed', 'Observation coverage is insufficient']).map((statement, i) => ({ id: `H${i + 1}`, statement, status: 'UNVERIFIED' })), missing_evidence: ['Independent reproduction at exact implementation SHA', 'Canonical owner confirmation and historical comparison'], root_cause: 'UNVERIFIED', contributing_factors: 'UNKNOWN', downstream_symptoms: 'UNKNOWN', treatment_candidates: [{ destination: finding.recommended_destination ?? 'MISSION_BOOK', authority: 'PROPOSAL_ONLY' }], authority: AUTHORITY };
}
export function validateCaseHistory(history) {
  const previous = new Map();
  for (const revision of history) {
    const { hash: digest, ...body } = revision;
    if (JSON.stringify(minimize(body)) !== JSON.stringify(body)) throw new Error('Case record contains sensitive or unsupported content');
    const prior = previous.get(body.case_id);
    if (hash(body) !== digest || body.previous_hash !== (prior?.hash ?? null) || body.revision !== (prior?.revision ?? 0) + 1) throw new Error('Case record integrity violation');
    previous.set(body.case_id, revision);
  }
  return true;
}
export function appendCaseRevision(history, entry) {
  validateCaseHistory(history);
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(entry.case_id)) throw new Error('Invalid case identity');
  const prior = history.filter(x => x.case_id === entry.case_id).at(-1);
  const body = { case_id: entry.case_id, revision: (prior?.revision ?? 0) + 1, previous_hash: prior?.hash ?? null, recorded_at: entry.recorded_at ?? new Date().toISOString(), symptom: String(entry.symptom ?? 'UNKNOWN').slice(0, 500), hypotheses: (entry.hypotheses ?? []).map(x => String(x).slice(0, 500)), evidence: evidenceRefs(entry.evidence), repairs: entry.repairs ?? 'NOT_RUN', rejected_repairs: entry.rejected_repairs ?? 'NOT_OBSERVED', verification: entry.verification ?? 'NOT_RUN', root_cause: entry.root_cause ?? 'UNVERIFIED', recurrence_links: (entry.recurrence_links ?? []).filter(x => /^[A-Za-z0-9_-]+$/.test(x)), lessons: entry.lessons ?? 'NOT_ESTABLISHED' };
  const safe = minimize(body);
  return [...structuredClone(history), { ...safe, hash: hash(safe) }];
}
export function reconcileBoss(observations = {}) {
  const labels = ['Self Cognition', 'Self Diagnosis', 'Self Case Record', 'Runtime Intelligence Plane', 'Adaptive Provider Intelligence', 'Self Evolution Pipeline'];
  const allowed = new Set(['SUPERSEDED', 'KEEP_AS_REFERENCE', 'LEGACY_HARVEST_CANDIDATE', 'PARTIALLY_RECOVERED', 'STILL_MISSING']);
  return labels.map((name, index) => {
    const id = `BLG-00${index + 1}`, input = observations[id], evidence = evidenceRefs(input?.evidence);
    const proven = input && allowed.has(input.disposition) && evidence.length && input.rationale;
    return { id, name, disposition: proven ? input.disposition : 'KEEP_AS_REFERENCE', rationale: proven ? String(input.rationale).slice(0, 500) : 'No independently observed donor equivalence; retain reference without migrating code', evidence, migration_authority: false };
  });
}
export function routeCandidate(candidate) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(candidate.candidate_id)) throw new Error('Invalid candidate identity');
  const evidence = evidenceRefs(candidate.evidence), destination = Object.hasOwn(destinations, candidate.kind) ? destinations[candidate.kind] : null;
  const deferred = !destination || !evidence.length;
  return { candidate_id: candidate.candidate_id, kind: candidate.kind in destinations ? candidate.kind : 'UNKNOWN', destination, receipt_state: deferred ? 'DEFERRED' : 'ROUTED', defer_reason: !destination ? 'DESTINATION_OWNER_UNKNOWN' : !evidence.length ? 'EVIDENCE_REQUIRED' : null, owner_state: 'NOT_OBSERVED', recommended_owner_state: evidence.length ? 'PROPOSED' : 'NEEDS_EVIDENCE', evidence, execution_authority: false, promotion_authority: 'EXPLICIT_EXTERNAL_OWNER_REQUIRED', rollback_authority: 'DESTINATION_OWNER_REQUIRED', safety_ladder: [...SAFETY_LADDER], donor_policy: candidate.kind === 'boss' ? 'LEGACY_DIFF_BEFORE_KEEP_EXTRACT_OR_SUPERSEDE' : null };
}
export function querySelfModel(report, capabilityId) {
  return report.self_model.find(x => x.capability_id === capabilityId) ?? { capability_id: capabilityId, state: 'UNKNOWN', reason: 'NOT_IN_OBSERVED_CENSUS' };
}
export function quarterlyReview(report, { caseHistory = [], candidates = [], bossObservations = {} } = {}) {
  validateCaseHistory(caseHistory);
  const cases = new Set(caseHistory.map(x => x.case_id));
  const receipts = candidates.map(x => {
    if (!x.source_cases?.length || x.source_cases.some(id => !cases.has(id))) return { ...routeCandidate({ ...x, evidence: [] }), defer_reason: 'TRACEABLE_CASE_EVIDENCE_REQUIRED' };
    return routeCandidate(x);
  });
  return minimize({ diagnoses: report.findings.map(diagnose), case_history: structuredClone(caseHistory), boss_reconciliation: reconcileBoss(bossObservations), runtime_intelligence: { provider_task_fit: 'NOT_MEASURED', routing_outcomes: 'NOT_MEASURED', split_review_model_switch: 'NOT_MEASURED', resource_budget: 'NOT_MEASURED', stale_skills: 'UNKNOWN', continuation_stop_quality: 'NOT_MEASURED', evidence_needed: 'Verified runtime episodes and outcome measurements' }, candidate_receipts: receipts, outcome: candidates.length ? (receipts.some(x => x.receipt_state === 'ROUTED') ? 'EVOLUTION_CANDIDATE' : 'OBSERVE_MORE') : 'NO_CHANGE', authority: AUTHORITY });
}
