# DGX v2 development candidate

Branch: Alien-GPT-DGX. No main merge.
Baseline: cc799234e7daa3d8ccfde5673b9d07ccb2376742.

This candidate implements DGX-owned governance contracts, reference-only ownership audit, assignment policy, domain adapters, structured conflict discovery, durable two-pass adjudication, scoped final release policy, appeals/dissent, and an Owner-only Web process inspector. It does not lower Engineering opposite-physical-host Formal Review.

## Use
Start the existing Gateway; connect the Web surface as City owner; open Governance. Import a case document shaped like tests/fixtures/dgx-case.mjs (draft() returns the JSON object). Select a saved case. L0 shows scope, decomposition, participants, outcomes, conflict, validation, uncertainty and release state; expand L1 for explicit claims/defence/dissent and L2 for candidate identity and evidence references. Unobserved state is NOT_RUN, not success. Case storage is bounded, atomic and survives restart.

## Host APIs
GET /api/v0/governance lists health and cases; POST creates an immutable-identity case; GET /api/v0/governance/:id inspects it; POST /api/v0/governance/:id/actions applies an operation with expected_revision. Owner authorization and the existing API/schema version 0 headers are mandatory.
Operations: EXTEND_GRAPH, ASSIGN, RESULT, CLAIM, CONFLICT, START_ADJUDICATION, PASS_A, DEFENCE, PASS_B, FINAL_REVIEW, DISSENT, APPEAL, RESOLVE_APPEAL, EVALUATE_RELEASE. Every mutation invalidates release until revalidated. Graphs never mutate/lease/complete canonical tasks.

## Canonical external ports
createGovernanceService accepts host-supplied ports, never HTTP-supplied code. readCandidates returns bounded canonical capability/history/resource facts. readParticipantFacts resolves actual identity/session/physical-host/authorship/recusal facts; readTaskAuthorship resolves canonical authors; readConflictParties resolves accepted parties. verifyParticipantReceipt must authenticate the full submitted case/head/phase/payload, not trust participant_ref alone. PCF port owns compileExecutionCapsule and validateResultEnvelope. The latter returns {valid:true} only after PCF correlation/bounds/transport evidence validation.
Release ports verifyReview, readDomainReceipt, readIndependenceReceipt, verifyIntegration, verifyObjectionResolution and verifyOwnerAuthorization resolve trusted receipts at the exact case/head/participant/scope. Domain receipts include case_ref/candidate_sha/domain/state; independence receipts additionally identify participant_refs. A score affects assignment only. verifyAppealResolution must independently verify a case/head/attempt/evidence-bound resolution. Undefined ports fail closed.
The Gateway currently wires only canonical task observation; accepted PCF-726, live participant facts, authenticated contribution receipts and formal-release receipt readers are unavailable at the frozen baseline. The production default therefore supports planning/inspection/manual conflict declaration, and reports unavailable execution/review gates. Controlled test ports are fixtures, not production implementation evidence.

## Acceptance limits
The 13-scenario map is contracts/deliberative-governance-v2/acceptance-matrix.json. Run node --test tests/dgx*.test.mjs. Tests cover contract invariants, adversarial inputs, durable information order, portal discovery/XSS, canonical task isolation and truthful failure. They do not establish physical opposite-host Review, actual PCF-726 transport, clinical simulation or final DGX freeze. DGX-990 terminal marker is deliberately absent. All unknowns, dissent and unresolved major/critical objections survive projection and block release.

## Rulings
Owner authorizes a single development branch; per-task code commits are provisional development dependencies, never accepted-review anchors. PCF-migrated execution substrate stays PCF-owned and is not copied into DGX. Health professional capability is unavailable. Main and existing worktrees are preserved. No deferred minor findings were reported in diagnostic review.
