# Migration Phase Closeout / Freeze

> Phase: donor-migration era → product integration
> Binding control: `Digital-City/mission-book/response-9-30.md#R12` and
> `Digital-City/mission-book/ENGINEERING_BOOK-2026-09-30-PRE-ASSISTANT-UPT-CLOSEOUT.md`
> Recorded by host `Alien` on the product branch `product/upt-pre-assistant-closeout`.

## 1. Why this document exists

The donor-migration programme (Mission Book MB-001 … MB-012) is finished and no longer has a
claimable queue. This document freezes that era as an auditable baseline **before** any
product-integration work starts, so that later work cannot quietly rewrite what was accepted
or re-open a closed Mission to manufacture more migration.

## 2. Frozen baseline

```text
SHA: UTOPIA_MAIN d0dea7bcb66cf57edee73c67ddfb9526337dfb4e
SHA: CITY_CONTROL_RECORD 8dfffca0d7a9d0a4f271d9c6dfbe26ba478af4ff
RUNS: MERGED_MAIN_CI 36678805229 PASS
FACT: MB_001_012_ALL_VERIFICATION_COMPLETE true
FACT: MB_010_012_ASSESSMENT NO_VALUE
FACT: MB_010_012_MERGED_MAIN_SHA null
STATUS: MIGRATION_QUEUE_CLOSED
STATUS: REOPENED_MISSIONS 0
STATUS: UNMERGED_IMPLEMENTATION_MISSION_BRANCHES 0
STATUS: BASELINE_TRUTH_RECORDED true
PAIR_STATUS: SYNCHRONIZED
```

Required CI on that exact `main` commit: the `V0.2 checks` workflow, run `36678805229` —
`gateway-web` **success**, `android` **success**.

## 3. Mission ledger

| Mission | Completion basis | Migration branch merged at | Notes |
| --- | --- | --- | --- |
| MB-001 Core OS | implemented | `d81a567` | migrated donor core |
| MB-002 Capability Fabric | implemented | `83ea44e` | |
| MB-003 Worker Gateway | implemented (Owner-accepted completion repair) | `756c7d7` | host separation waived under `response-9-30.md#R10` |
| MB-004 Project Foreman | implemented | `0eed05b` | |
| MB-005 Host Health | implemented | `cfe34df` | |
| MB-006 Restart Recovery | implemented | `ce33792` | |
| MB-007 Research Institute | Owner accepted | `cb8e0bd` | |
| MB-008 Computer Use | Owner accepted | `168182c` | |
| MB-009 Theme Relocation | implemented | `b4bd602` | |
| MB-010 Node Fabric | `SKIPPED_NOT_REQUIRED` | *(none)* | `NO_VALUE` |
| MB-011 Customs | `SKIPPED_NOT_REQUIRED` | *(none)* | `NO_VALUE` |
| MB-012 Runtime Compliance | `SKIPPED_NOT_REQUIRED` | *(none)* | `NO_VALUE` |

All twelve have `migration_complete = true` and `verification_complete = true` in their
current Mission Book front matter.

## 4. What MB-010 / MB-011 / MB-012 actually are

These three were assessed and found to have **no migration value**: every planned capability
was already equalled or exceeded by Utopia at claim time, and the remaining donor code was
either unconstructed in production or had no consumer.

They are therefore recorded as **negative-result provenance**, not as transferred capability:

- `assessment_result = NO_VALUE`;
- `migration_completion_basis = SKIPPED_NOT_REQUIRED`;
- `merged_main_sha = null` — **no implementation from these three ever landed on `main`**;
- no verified implementation episode was created for them.

Their assessment branches **are** ancestors of `main`, but only because Owner ruling
`response-9-30.md#R11` archived them as provenance. Each of those merges added exactly five
files (an event log plus four assessment-evidence files) and **zero lines of implementation
code**. Their original remote branches were retained.

Reading those three merges as implementation merges, or reading `NO_VALUE` as "not done",
are both wrong. They are done, and nothing was migrated.

## 5. Branch audit

At the frozen baseline, every remote branch in the repository is reachable from `main`:

```text
refs checked          : 34
unmerged (ahead > 0)  : 0
mission branches      : MB-001..MB-012 all 0 ahead of main
```

So there is no accepted-but-unmerged implementation work outstanding. The three
`mission/MB-010|011|012-*` branches remain on the remote as provenance and are **not**
deleted.

## 6. Known non-blocking backlog

Carried forward from the Mission Book closeout and explicitly **not** part of this phase:

- three migrated-but-not-yet-consumed City modules — `fleetNodeStateFor`,
  `createProtectedSurfaceGuard`, `evaluateGuardian` — currently consumed only by tests;
  wiring them is integration work, not migration, and is not authorised here;
- deferred MB-003 donor surfaces (`scheduler.js`, `gate.js`, `system.js`) stay deferred and
  recorded in that module's `DONOR.json`;
- the Room Pack is attached to `main` but **not yet to Utopia's main navigation or host
  lifecycle** — closing that gap is exactly T1 of the product workbook.

None of these block the product phase; none of them authorise new donor migration.

## 7. Transition

Migration is closed. From here the only authorised work is the product-integration sequence
of the Pre-Assistant Closeout Workbook:

```text
T0  migration closeout / freeze            <- this document
T1  attach the accepted Room Pack to the normal Utopia shell
T2  one canonical Action facade, shared by Web and Android
T3  one deterministic Ask / Do entry
T4  independent product acceptance, merge, merged-main CI
```

No new Mission, no re-opened Mission, no new Room, no assistant/persona layer, no LLM router,
no Boss/Hns connector, no new domain integration, no arbitrary shell in this phase. The
next phase after T4 requires a **new Owner instruction**.

STATUS: MIGRATION_PHASE_CLOSED
PAIR_STATUS: SYNCHRONIZED
