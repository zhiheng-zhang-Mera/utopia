# MB-010 Node Fabric — assessment (published bounded evidence)

```text
MISSION      = MB-010
PHASE        = assessment (MIGRATION_ONLY; no implementation written)
HOST         = Mech
DONOR        = zhiheng-zhang-Mera/Codex-Boss@8df428eaa437a409368401e95194e40266b83080
UTOPIA BASE  = zhiheng-zhang-Mera/utopia@756c7d760c605e33ba386e87605e078fe24b82ca
RESULT       = NO_VALUE  (判断无价值，任务保留，未迁移)
```

This directory is the **selected, bounded, non-sensitive** evidence for the MB-010
value assessment. The full raw run stays git-ignored under
`.runtime/evidence/mission-book/MB-010/2026-09-30-mb010-assessment-01/assessment/`.

## Files

| File | What it is |
|---|---|
| `capability-matrix.json` | Machine-readable NF-01..NF-05 comparison: donor anchors, Utopia anchors, coverage, decision, reason codes, and the donor-lifecycle finding. |
| `bounded-node-truth.json` | Receipt of a **real** bounded runtime chain (8/8 PASS) against a live `dev-gateway` + live `agents/reference-node` agent. |
| `environment.json` | Host facts and the exact donor/Utopia/City SHAs the assessment was taken against. |

## Why this is NO_VALUE

All five planned capabilities are already present in current Utopia, either because
MB-001 migrated the donor's own live node logic
(`src/shared/fleet.ts`, `src/shared/capability-router.ts`,
`src/shared/node-capabilities.ts`, `src/shared/adaptive-routing.ts` — the **same**
frozen donor baseline) into `city/00-foundation/01-city-core/fleet-routing`, or
because Utopia's own running product already owns the behaviour end to end
(`services/dev-gateway` register/heartbeat/sweeper, `agents/reference-node`
telemetry, `apps/web` device cards, `capability-fabric` + `capability-bridge`).

What remains un-migrated in the donor — `TenxNodeRegistry`, `TenxNetworkRegistry`,
`TenxProviderMatrixStore`, `TenxObservability` — is **production-dead at the frozen
baseline**: the only non-test reference is a type-only field inside
`TenxObservability`, which is itself referenced only by tests; no `electron/main.ts`
or `electron/bootstrap/` file imports `tenx/`; and `config/capabilities/node.yaml`
declares the node capability with `modules: []`, `bootModules: []`, `surface: []`.

Copying that remainder would add duplicate node-identity/route state with no
consumer, and building the consumer would be new product capability — forbidden by
`MODE = MIGRATION_ONLY`.

> This negative result is retained as architecture-selection /
> duplication-avoidance evidence. The task stays, nothing was migrated, and no
> verified implementation episode is produced for a NO_VALUE outcome.
