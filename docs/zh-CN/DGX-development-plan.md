# DGX implementation plan

Goal: implement DGX-owned v2 contracts and an Owner-visible governance inspector on Alien-GPT-DGX; never merge main.
Spec: Digital-City@04a6c855240de45e43828ad44a07ecbcfbe71b5d mission-book/mission-group/deliberative-governance-expansion-migration.
Architecture: pure versioned policy modules, durable governance documents, typed external canonical readers, bounded projection. Governance documents cannot assign or mutate canonical tasks.

- [x] DGX-001: audit ownership, KEEP/REFERENCE/EXTRACT (no extraction justified), path checks.
- [ ] DGX-002: core.mjs Constitution, immutable fact snapshot, provenance DAG, PCF thin ports; cycle/intent/authority/privacy tests.
- [ ] DGX-003: assignment.mjs capability/history input, hard independence eligibility, deterministic fallback, receipts; no database.
- [ ] DGX-004: profiles.mjs domain ports, Engineering full-SHA/CI/opposite-host, Research evidence, Health unavailable.
- [ ] DGX-005: adjudication.mjs stateful A-before-defence B protocol, independent identity, evidence-bound verdict; no model decision invented.
- [ ] DGX-006: release.mjs scoped participant final review, dissent, bounded appeal, critical/major and owner gates; no voting.
- [ ] DGX-007: projection.mjs L0/L1/L2, gateway document registry and owner-only API, web inspector. No task scheduler; monitor failure independent.
- [ ] DGX-990: cross-domain conformance tests, exact evidence/report; independent formal review/freeze remain NOT_RUN until observed.

Validation: node --test tests/dgx*.test.mjs; root suite; check:docs; hosted CI at exact pushed head. Red then green per module.
Review focus: missing facts must fail closed; adversarial nested fields, cross-case receipts, stale candidate, unknown canonical task, read failure, self-review, different agent on same host, withheld defence, active risk visible, UI XSS/context reset.
Ruling: owner already supplied a complete workbook and directs full execution; use workbook design rather than request another design approval. Single-branch development edges are provisional, never accepted-review dependency anchors. PCF port unavailable fails typed; do not implement migrated substrate.
