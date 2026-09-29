# V0.3 Hardening and Wave3 Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement task by task. Track gates and exact commits; review the branch before merging.

**Goal:** Keep the five accepted services usable while bounding result history, then complete the Road, eligible activation, and D9 theme builder delivery.
**Architecture:** Summary metadata stays in SQLite invocations; retained results move to a detail table with transactional migration and pruning. Qualified City identities and lifecycle decide availability. Wave3 reuses accepted City implementations and preserves promotion provenance.
**Tech Stack:** Node 24, SQLite, vanilla Web UI, Kotlin/Compose, existing City modules.
**Spec:** UTOPIA_V0.3_HARDENING_AND_WAVE3_ENGINEERING_BOOK.md supplied by the user; sections 1–49.

## Global Constraints

- Product usability first; minimal Computer Use; generated/public fixtures only.
- Base main a6745686b4a85da9c6327546b8a20a55d023a2fd; hosted CI 36539843220 succeeded.
- Hardening branch alien/v0.3-hardening-repair must pass and merge before Wave3 implementation.
- Preserve accepted promotion history, invocation IDs/digests/status/timestamps, and published evidence.
- Retain 500 summaries, 50 details; snapshots 50 summaries; list maximum 200.
- Never reset the live database; migration failure must roll back and refuse startup.
- D9 fixed donor eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b; seven named files only, reuse promoted dependencies.
- No global theme apply, registry/runtime migration, provider API, V0.4 or unrelated donors.

## Review Focus

- Corrupt legacy rows: entire migration rolls back; history remains recoverable (Task 1).
- Running jobs amidst retention: do not prune active summaries; no result resurrection on snapshot refresh (Tasks 1, 3).
- Same module name elsewhere cannot substitute for a missing qualified dependency (Task 2).
- Late detail response after navigation cannot replace the selected invocation; expired detail retains COMPLETED (Task 3).
- Failed optional assets degrade locally; unsafe packages and path escapes fail closed (Task 7).

### Task 1: Bounded invocation persistence and API
Files: services/capability-bridge/invocation-store.mjs (new), bridge.mjs, services/dev-gateway/server.mjs; tests/capability-history.test.mjs (new).
Interfaces: createInvocationStore(store) returns save(row), list(limit=50), get(id). list yields ascending recent summaries only; get returns summary plus retained result or null. resultAvailable is authoritative. limit is a positive integer capped at 200.
- [ ] Write tests for legacy migration/restart/idempotency/rollback, 560 large invocations, 500/50 retention, bounded snapshot/list and detail digest preservation; observe failures.
- [ ] Implement transactional migration, saves and pruning. Preserve metadata; retire oldest terminal summaries before running jobs.
- [ ] Run node --test tests/capability-history.test.mjs tests/capability-bridge.test.mjs; require PASS and commit.

### Task 2: Qualified lifecycle registry and real theme operations
Files: services/capability-bridge/registry.mjs, contracts/capability-bridge-v1/schema.json; tests/capability-registry.test.mjs.
Interfaces: ModuleRef={districtId,buildingId,moduleId}; moduleKey(ref) is slash-qualified; descriptor moduleRefs/moduleLifecycles expose every dependency. Mixed lifecycle uses restrictive state, never the first module's state.
- [ ] Test duplicate names, missing qualified dependency, PLANNED/INCUBATING/DEPRECATED/mixed lifecycles, unknown promoted module, and false theme validate rejection; observe failures.
- [ ] Implement qualified matching; pending for planned/incubating, unavailable for deprecated, degraded for missing/unknown lifecycle, available only all promoted/active.
- [ ] Run registry/adapters/bridge tests; require PASS and commit.

### Task 3: Explicit detail consumers and Android typed errors
Files: apps/web/services.js; apps/android/app/src/main/java/city/utopia/control/{CityClient,ServicesPanel,CapabilityRequestException}.kt; tests/web-services.test.mjs and Android unit tests.
Interfaces: clients fetch capability-invocations/:id on selection; preserve summary status when unavailable/offline; resultAvailable=false shows expiry and retained digest. CapabilityRequestException(code,status,message) preserves HTTP business refusals.
- [ ] Add real browser tests for summary-only refresh, explicit detail fetch, pruned completed detail, and stale response navigation. Add Android tests for typed code/status/message and offline classification; observe failures.
- [ ] Implement detail selection and UI lifetime fencing; avoid repeated payload fetches on snapshots.
- [ ] Run root tests and Android unit/build; require PASS and commit.

### Task 4: Hardening acceptance and frozen baseline
- [ ] Run promotion-history, Room, City, bilingual, root and Android gates. Restart real Gateway without deleting data; install updated APK and verify selected history/details on physical device where available.
- [ ] Write paired hardening acceptance and sanitized generated-fixture evidence, review branch, fix material findings with tests.
- [ ] Push feature branch, verify terminal hosted CI, merge PR, verify exact main SHA and terminal CI, then annotate utopia-v0.3-hardening. Record all SHAs; only then start Wave3.

### Task 5: Document-to-Knowledge Road
Files: contracts/city-roads/document-knowledge-v1/{schema.json,index.mjs,tests/conformance.test.mjs}; services/capability-bridge/adapters.mjs.
- [ ] Extract the existing deterministic section mapping into a versioned SDK plus validator; pin current output in conformance tests before replacement.
- [ ] Preserve trust UNVERIFIED, temporary shelf, document domain, ordering/IDs; no persistence/daemon. Remove duplicate adapter mapping. Run conformance/bridge suites, commit.

### Task 6: Independent activation review
- [ ] Inspect provenance, focused/parity gates, both-client accepted consumption and recovery evidence for ingestion-core, document-readers, knowledge-core, skill-intake, evidence-engine.
- [ ] Record each criterion; only qualifying modules become ACTIVE in an independent chore(city): activate accepted consumed modules commit. Theme stays PROMOTED while ownership pending.

### Task 7: D9 Room incubation and promotion
- [ ] Audit exact pinned donor seven-file closure and promoted dependencies; record PARITY/PORT_ADAPTATION/UTOPIA_EXTENSION/DEFERRED per behavior.
- [ ] Build theme-builder-lab with deterministic intent, truthful observation plans, injectable image seam/fallback chain, pixel validation and caller-confined atomic package output. Add the workbook's section 28 tests before implementation.
- [ ] Prove real browser prompt/plan/build/preview/validation/fallback product operations. Commit accepted Room and record its exact SHA.
- [ ] Promote into existing theme-engine design/planning/assets/pipeline/build paths, reuse existing dependencies, add third incubation room and provenance. Commit promotion, retire active Room in a separate commit, verify promotion history and City tests.

### Task 8: D9 product consumption and final freeze
- [ ] Add real build operation with bounded sandbox package artifacts and result summary. Preserve generate semantics; no fake validate operation.
- [ ] Implement Windows and Android prompt/build/preview/validation/fallback consumption. Compare intent/plan/package/content digests and verdict for identical inputs; verify degraded/no observation and refused protected surfaces.
- [ ] Full regression and physical acceptance; paired Wave3 acceptance, paper evidence (PILOT), run records, topology delta, sanitized raw manifests. Push/CI/merge/freeze with exact SHAs. Keep each unresolved gate explicit without undoing accepted Mech promotion.

## Execution ledger

- H0: clean checkout, fresh origin/main a6745686; CI 36539843220 terminal success. No AGENTS.md found.
- Ruling: reuse the current dedicated checkout and a short feature branch, preserving the live runtime and all prior evidence; no additional worktree needed.
- Ruling: execute inline under standing workbook authorization; supplied spec decides scope, no redundant design approval.
- Pre-flight: Task 1 summary/detail API must be consumed by Task 3 before deployment. Task 2 keeps capability IDs but qualifies dependencies and future IDs. Wave3 starts only after Task 4 merge.
- Baseline command correction: npm is absent from PATH; use pnpm or node commands already available.
- Tasks 1–3: implementation and local verification complete. Root 46, Android 21 unit tests plus assembleDebug PASS; Room 67, City 114 and nine promotion records PASS. New tests were observed failing before the corresponding fixes.
- Independent review: fixed Android and Web stale RUNNING-summary races; added terminal-state merge regression checks. Android operation/sample/picker navigation now invalidates pending detail callbacks.
- Ruling: summary recency follows latest state transition rather than original insertion, preserving a slow job's freshly completed result. Generated 505-intervening-job regression PASS.
- Task 4: real runtime migration/physical smoke, delivery review, hosted CI and merge pending. No Wave3 implementation has started.
- Task 4 update: implementation 8c1106e, hosted CI 36548239748 PASS; real 98-row migration and two restarts PASS; Windows 26 and physical Android 7 checks PASS, five canonical digest matches. APK 0.3.1 SHA-256 521610d1f44add13a2cdbd1832b38ccc4e692d122d0d4197d2e9c8a602f52c0f. Four screenshots visually reviewed. Delivery documentation/manifest commit, exact final-head CI, merge and tag remain pending.
- Task 4 complete: delivery head 87cd870; push/PR CI 36548851514 and 36548895519 SUCCESS; PR #5 merged to 393f3b89a9c4fae61be1e431c4bcd47fee945e88; main CI 36549170404 SUCCESS. Annotated utopia-v0.3-hardening published and remote peeled SHA verified. Eight committed raw blob hashes match the manifest. No outstanding physical/hosted wait for hardening.
- Task 5: extracted pure Road SDK/schema/validators, removed adapter mapping; conformance plus six-format frozen-digest parity PASS. Root regression pending before commit. Strict malformed-section validation is additive; valid document outputs and the 200-section Bridge limit are preserved.
- Tasks 5–6 complete locally: Road 762d677 and independent activation bddf448; root 51, City 114, promotion 9 and bilingual checks PASS. Hosted bddf448 runs 36550553732 / 36550552720 SUCCESS. Independent review found sparse SDK arrays bypassing validation; new regression reproduced the defect, both validators now visit every position, root 52 PASS. D9 exact donor SHA verified remotely; seven source blobs downloaded read-only into ignored runtime for closure audit.
