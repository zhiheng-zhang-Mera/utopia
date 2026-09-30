# MB-012 Runtime Compliance — assessment (published bounded evidence)

```text
MISSION      = MB-012
PHASE        = assessment (MIGRATION_ONLY; no implementation written)
HOST         = Mech
DONOR        = zhiheng-zhang-Mera/Codex-Boss@8df428eaa437a409368401e95194e40266b83080
UTOPIA BASE  = zhiheng-zhang-Mera/utopia@756c7d760c605e33ba386e87605e078fe24b82ca
RESULT       = NO_VALUE  (判断无价值，任务保留，未迁移)
```

This directory is the **selected, bounded, non-sensitive** evidence for the MB-012
value assessment. The full raw run stays git-ignored under
`.runtime/evidence/mission-book/MB-012/2026-09-30-mb012-assessment-01/assessment/`.

## Files

| File | What it is |
|---|---|
| `capability-matrix.json` | Machine-readable RC-01..RC-05 comparison: donor anchors, Utopia anchors, coverage, decision, reason codes, and the donor-lifecycle finding. |
| `bounded-enforcement.json` | Receipt of a **real** bounded run (19/19 PASS) exercising Utopia's existing enforcement refusals, including a live gateway on an ephemeral port. |
| `environment.json` | Host facts and the exact donor/Utopia/City SHAs the assessment was taken against. |

## Why this is NO_VALUE

MB-002's `capability-fabric/DONOR.json` had named **MB-012** as the owner of the deferred
Codex-Boss permission/authorization resolution (`capability-broker.ts`,
`authorization.ts`, `permission-contract.ts`), so this Mission was assessed on its merits
rather than dismissed as already covered. Surveying all 24 donor enforcement modules at
the frozen commit shows the deferral is not a migration opportunity:

1. **The capability layer the Mission points at never runs in the donor.**
   `createCapabilityBroker`, `invokeThroughBroker`, `evaluate`, `gateAuthorizer` and
   `authorizeExecution` have **zero non-test production callers**, and
   `electron/main.ts:1003` builds `new ExecutionGate()` with **no options**, so the
   authorizer hook — the code's own "mapped" boundary — never fires.
2. **The donor's runtime-policy file has no consumer at all** (RC-04).
   `loadRuntimePolicy` is module-private with zero callers,
   `electron/commander/runtime-policy.ts` exports nothing, and no JSON-Schema validator
   exists in the repository. There is no donor behaviour to migrate.
3. **The donor's escalation rejection is CI-script-only** (RC-03):
   `authority-planes.ts` has exactly one caller, a standalone diff-guard script, and the
   named `refuse*` guards are test-only.
4. **The donor's audit ledger is written but never read** (RC-05). It is consumed only by
   `RootAuthority.history()`, whose callers are tests; its integrity mechanism is an
   **unkeyed** SHA-256 chain — `createVerify`/`verifySignature`/`publicKey`/`x509`/
   `createHmac` have **0 hits** in `electron/` and `src/`.
5. **What is live already has a Utopia counterpart**, including the computer
   side-effect permission gate, which MB-008 migrated from the *same*
   `src/shared/permission.ts` this Mission names.
6. **Utopia's live enforcement is consumed, and was measured refusing on real paths**: a
   live `capability-bridge` invoke (`CAPABILITY_NOT_FOUND`, `OPERATION_BLOCKED`) and a
   live gateway (`409` version mismatch, `401` wrong token, `403` wrong node, `400`
   out-of-range progress, `409` invalid transition, wildcard-bind refusal).

> This negative result is retained as architecture-selection / duplication-avoidance
> evidence. The task stays, nothing was migrated, and no verified implementation episode
> is produced for a NO_VALUE outcome.

## Measured evidence (all real, no mocks)

```text
bounded enforcement chain (incl. a live gateway + live bridge)   19/19 PASS, 0 FAIL
city/test-all.mjs                                                1807 pass, 1 skipped (of 1808)
root node --test tests/*.test.mjs                                84 pass, 0 fail
scripts/verify-promotion-history.mjs                             10/10 verified at 756c7d7
TOTAL                                                            1904 PASS, 0 FAIL
```
