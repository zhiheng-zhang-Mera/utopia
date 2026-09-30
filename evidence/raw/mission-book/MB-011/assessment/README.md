# MB-011 Customs — assessment (published bounded evidence)

```text
MISSION      = MB-011
PHASE        = assessment (MIGRATION_ONLY; no implementation written)
HOST         = Mech
DONORS       = zhiheng-zhang-Mera/Codex-Boss@8df428eaa437a409368401e95194e40266b83080
               zhiheng-zhang-Mera/DS-Hns@eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b
UTOPIA BASE  = zhiheng-zhang-Mera/utopia@756c7d760c605e33ba386e87605e078fe24b82ca
RESULT       = NO_VALUE  (判断无价值，任务保留，未迁移)
```

This directory is the **selected, bounded, non-sensitive** evidence for the MB-011
value assessment. The full raw run stays git-ignored under
`.runtime/evidence/mission-book/MB-011/2026-09-30-mb011-assessment-01/assessment/`.

## Files

| File | What it is |
|---|---|
| `capability-matrix.json` | Machine-readable CU-01..CU-05 comparison: donor anchors, Utopia anchors, coverage, decision, reason codes, and the donor-lifecycle finding. |
| `bounded-admission.json` | Receipt of a **real** bounded run (13/13 PASS) exercising Utopia's existing admission refusals. |
| `environment.json` | Host facts and the exact donor/Utopia/City SHAs the assessment was taken against. |

## Why this is NO_VALUE

MB-002's `capability-fabric/DONOR.json` had named **MB-011 Customs** as the future
owner of the deferred Hns plugin/adapter platform, so this Mission was assessed on its
merits rather than dismissed as "already covered". The deferral turns out not to be a
migration opportunity:

1. **The donor's coherent admission design is production-dead.** `app/core/plugin-install/`
   (`plan.cjs` + `pipeline.cjs` + `records.cjs`, 960 lines) has **zero app consumers** —
   the only non-test importer is an acceptance script. Because `records.cjs` is the only
   implementation of pin / quarantine / rollback, those CU-05 features are dead with it.
   The donor's *live* `setEnabled` / `removeOne` refuse only `PLUGIN_NOT_FOUND`.
2. **The donor does not verify provenance at all** (CU-02). It records a provenance
   object built from a regex over user input. A repo-wide search finds `createVerify` 0,
   `verifySignature` 0, `publicKey` 0, `x509` 0, `contentHash` 0, `pluginHash` 0, and no
   `node:crypto` import in any of the 17 surveyed admission modules. Utopia *does*
   verify, against local Git history, for all 10 promotion records.
3. **Isolation/crash-boundary preflight does not exist as a refusal in the donor**
   (CU-04). `RUNTIME_KINDS` carries enforcement/isolation metadata, but nothing refuses
   admission; the only consumer of that metadata is advisory risk scoring inside the
   dead `plan.cjs`, and the real boundary is a child process spawned *after* the decision
   to admit.
4. **Permissions are not an admission gate in the donor** — and permission/authorization
   resolution is explicitly deferred to **MB-012**, so it is out of this Mission's scope
   either way. `ADAPTER_UNKNOWN_PERMISSION` / `ADAPTER_PERMISSION_DENIED` are declared
   but produced nowhere; an unenforceable permission is logged and the plugin is admitted.
5. **What is live is equivalent-or-weaker than what Utopia already has.** `city/manifest.mjs`,
   `apps/rooms/hub/promotions.mjs`, `scripts/verify-promotion-history.mjs`,
   `capability-fabric/registry.mjs`, `capability-fabric/providers.mjs` and the MB-006
   restart-recovery station already perform manifest/schema admission, provenance
   verification, capability-ownership and duplicate refusal, and enable/disable readiness.
   A Customs layer repeating them would duplicate existing checks — the exact thing this
   Mission's Verification gate forbids.
6. **Utopia has no plugin/extension ecosystem.** Its admission units are City modules and
   incubator Rooms. A Customs building that admits `dshns.plugin/v1` / `dshns.process/v1`
   artifacts would have nothing to admit, and building the consumer would be
   `NEW_FEATURE_DEVELOPMENT`, which `MODE = MIGRATION_ONLY` forbids.

> This negative result is retained as architecture-selection / duplication-avoidance
> evidence. The task stays, nothing was migrated, and no verified implementation episode
> is produced for a NO_VALUE outcome.

## Measured evidence (all real, no mocks)

```text
bounded admission chain                     13/13 PASS, 0 FAIL
city/test-all.mjs                           1807 pass, 0 fail, 1 skipped (of 1808)
root node --test tests/*.test.mjs           84 pass, 0 fail
scripts/verify-promotion-history.mjs        10/10 records verified at 756c7d7
TOTAL                                       1904 pass, 0 fail
```
