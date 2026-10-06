# CEX-790 — backend → Web/Android entry inventory (development side)

```text
BASELINE            dependency SHA union 5c7d46dcbf1b01259b5edaf574b620714beb40b7
                    (CEX-701 a24c0440, CEX-702 3d233ff3, CEX-703 478d4860, CEX-704 d05f5a45, CEX-705 de9185a4)
SOURCES READ        10, as the workbook names them
ITEMS                145
CLASSES              {"INTERNAL_PROTOCOL":24,"EXPOSED":109,"CURRENT_ENTRY_GAP":8,"PARITY_GAP":3,"EXPOSED_ADVANCED":1}
REGISTRY RECORDS     11
MACHINE-READABLE     utopia:evidence/raw/mission-book/CEX-790/capability-inventory.json
```

## 1. Sources actually read

| # | Source the workbook names | How it was read | Items |
|---|---|---|---|
| 1 | Gateway user-facing routes | parsed the request dispatcher in `services/dev-gateway/server.mjs`: 48 routes, static and pattern, with their methods | 48 |
| 2 | Action routes / operations | the operation catalog in `services/dev-gateway/actions.mjs` | 9 |
| 3 | Ask targets | the same catalog the `GET /api/v0/ask/targets` route serves (no second copy) | included above |
| 4 | Room catalog | read from the same catalog module as the Room operations | included above |
| 5 | capability registry | every record under the Digital-City `capability-registry/records/` | 11 |
| 6 | Web clickable entry | `data-page`, `data-terminal`, `data-scheduler-action`, `data-goto` and button ids across `apps/web` | 41 |
| 7 | Android clickable entry | nav lists, `page == "…"` branches and `@Composable …Panel` definitions under `…/control` | 32 |
| 8 | Settings / recovery lifecycle | the device/pairing/join routes plus the Android Settings, recovery and onboarding panels | included in 1 and 7 |
| 9 | scheduler user actions | `ACTION_WIRING` in `apps/web/scheduler.js` | 4 |
| 10 | existing registry records / legacy backfill | the same 11 records, plus `CAPABILITY_INDEX.yaml` / `SURFACE_INDEX.yaml` which are reconciled in §4 | 11 |

## 2. The gate

The workbook does not require every endpoint to have a button. It requires that every **user-semantically mature**
capability has at least one ordinary entry, first-class surface parity, an explanation when unavailable, correct
confirmation/authority when destructive, and that future/infrastructure surfaces create no false affordance.

After curation the inventory therefore contains **no unclassified user-facing backend capability**, and the residual
gaps are exactly the three kinds below — each named, each explained, none silently dropped.

## 3. Curated exceptions — the audit's real output

### GET /api/v0/capabilities

* automated class: `CURRENT_ENTRY_GAP`
* audited class: `CURRENT_ENTRY_GAP` (REGISTRY_GAP)
* reason: The Web Services page and the Android Services panel both list and invoke capabilities, so the surface is user-reachable, but NO capability record names this route or the bridge behind it. Recorded as a registry gap: the capability-bridge invocation surface needs a CAP record, not a new UI.

### GET /api/v0/capabilities/:id

* automated class: `CURRENT_ENTRY_GAP`
* audited class: `CURRENT_ENTRY_GAP` (REGISTRY_GAP)
* reason: Same surface as GET /api/v0/capabilities: reachable from the Services page detail, unnamed by any record.

### POST /api/v0/capabilities/:id/invoke

* automated class: `CURRENT_ENTRY_GAP`
* audited class: `CURRENT_ENTRY_GAP` (REGISTRY_GAP)
* reason: The invoke path is the destructive/mutating half of the same unnamed surface. It keeps its confirmation and authority on the existing routes; what is missing is the registry entry that would let an auditor find it.

### GET /api/v0/capability-invocations

* automated class: `CURRENT_ENTRY_GAP`
* audited class: `CURRENT_ENTRY_GAP` (REGISTRY_GAP)
* reason: The invocation history the Services surface reads. Same unnamed capability bridge.

### GET /api/v0/capability-invocations/:id

* automated class: `CURRENT_ENTRY_GAP`
* audited class: `CURRENT_ENTRY_GAP` (REGISTRY_GAP)
* reason: Invocation detail. Same unnamed capability bridge.

### POST /api/v0/host/join

* automated class: `CURRENT_ENTRY_GAP`
* audited class: `PARITY_GAP` (PARITY_GAP)
* reason: A browser may switch this host between PRIMARY and MEMBER; the Android surface has no equivalent, and the route is deliberately restricted to a local host-owner request. Recorded as a real first-class-surface parity gap, not as a missing entry.

### GET /api/v0/host/join/status

* automated class: `CURRENT_ENTRY_GAP`
* audited class: `PARITY_GAP` (PARITY_GAP)
* reason: The status half of the same host-role flow; Web only by design (the request is refused for a non-local caller).

### POST /api/v0/tasks/:id/cancel

* automated class: `PARITY_GAP`
* audited class: `EXPOSED` (FALSE_POSITIVE)
* reason: The automated rule could not see it: the Web reaches cancel through the scheduler ACTION_WIRING table (CANCEL -> route cancel) rather than through a path-shaped string. Both surfaces have it.

### POST /api/v0/tasks/:id/provider-choice

* automated class: `PARITY_GAP`
* audited class: `EXPOSED` (FALSE_POSITIVE)
* reason: Same as cancel: the Web reaches it through ACTION_WIRING (CHOOSE_PROVIDER -> providerChoice) and the Android panel has a choose control.

### page:Actions

* automated class: `PARITY_GAP`
* audited class: `EXPOSED` (FALSE_POSITIVE)
* reason: The Android advanced nav names the same page "Action" (singular), which the nav map did not cover. Both surfaces have the page.

### CONFIRM

* automated class: `CURRENT_ENTRY_GAP`
* audited class: `CURRENT_ENTRY_GAP` (BY_DESIGN)
* reason: ACTION_WIRING declares CONFIRM kind=unwired with no route. This is the honest-unwired control the CEX-702 review accepted: it must NOT be wired until a canonical route with proven-identical semantics exists.


Summary of the curated exceptions:

```text
REGISTRY_GAP      5   the whole capability-bridge invocation surface is user-reachable and unnamed by any record
PARITY_GAP        2   the host PRIMARY/MEMBER role switch is a browser-only first-class surface, by design
FALSE_POSITIVE    3   routes or pages the automated rule could not see (ACTION_WIRING, and Android's "Action" page)
BY_DESIGN         1   generic CONFIRM stays honest-unwired until a canonically identical route exists
```

## 4. Capability Registry reconciliation state, read from the control plane

| capability | exposure class | backend wiring | reachability | reconciliation |
|---|---|---|---|---|
| `CAP-ASK-001` | DIRECT_CONTROL | VERIFIED | PARTIAL | FORMAL_REVIEW_RECONCILED |
| `CAP-CITY-MEMBERS-NATIVE-001` | DIRECT_CONTROL | VERIFIED | PARTIAL | FORMAL_REVIEW_RECONCILED |
| `CAP-EXECUTION-001` | INTERNAL_ONLY | VERIFIED | NOT_APPLICABLE | FORMAL_REVIEW_RECONCILED |
| `CAP-EXPERIMENT-MANIFEST-001` | DIRECT_CONTROL | VERIFIED | VERIFIED | VERIFIED_BOUNDED_WEB_MANIFEST_WORKFLOW |
| `CAP-IDENTITY-001` | DIRECT_CONTROL | VERIFIED | PARTIAL | FORMAL_REVIEW_RECONCILED |
| `CAP-MON-001` | BACKGROUND_DISCLOSED | VERIFIED | PARTIAL | FORMAL_REVIEW_RECONCILED |
| `CAP-NODE-DESCRIPTOR-001` | INTERNAL_ONLY | VERIFIED | NOT_APPLICABLE | FORMAL_REVIEW_RECONCILED |
| `CAP-ONBOARDING-OWNER-001` | DIRECT_CONTROL | VERIFIED | PARTIAL | FORMAL_REVIEW_RECONCILED |
| `CAP-RESEARCH-TRACE-001` | OBSERVABLE_ADVANCED | VERIFIED | PARTIAL | FORMAL_REVIEW_RECONCILED |
| `CAP-SCHEDULER-CHOICE-001` | DIRECT_CONTROL | VERIFIED | PARTIAL | FORMAL_REVIEW_RECONCILED |
| `CAP-WORKER-POOL-AGENT-001` | INTERNAL_ONLY | VERIFIED | NOT_APPLICABLE | CANDIDATE_RECONCILED_PENDING_FORMAL_REVIEW |

**One reality mismatch found and recorded, not repaired here:** `CAP-WORKER-POOL-AGENT-001` still declares
`CANDIDATE_RECONCILED_PENDING_FORMAL_REVIEW`, but WBC-603 — the workbook that owns the worker pool seam — is
`COMPLETE` with `review_complete: true` and the terminal marker `WORKER_POOL_AGENT_SEAM_ACCEPTED` was released by the
opposite-host review on this host. The record also declares no API surface at all, which is consistent with its
`INTERNAL_ONLY` class. This is the `CAPABILITY_REGISTRY_REALITY_MISMATCH` the workbook's gate forbids, and it is
resolved in §5.

## 5. Registry backfill and reconciliation performed by this task

```text
CAP-WORKER-POOL-AGENT-001   reconciliation -> FORMAL_REVIEW_RECONCILED, review evidence bound, known gaps updated
                            (the pending-Formal-Review gap is closed by the WBC-603 review that released the marker)
CAP-CAPABILITY-BRIDGE-001   NEW record for the capability-bridge invocation surface that the audit found unnamed:
                            GET /api/v0/capabilities, GET /api/v0/capabilities/:id, POST /api/v0/capabilities/:id/invoke,
                            GET /api/v0/capability-invocations, GET /api/v0/capability-invocations/:id
                            exposure class DIRECT_CONTROL on both first-class surfaces, user reachability PARTIAL
                            (the Web and Android Services surfaces exist; no E2E intent validation was performed)
CAPABILITY_INDEX.yaml       updated with the new record and the reconciled one
SURFACE_INDEX.yaml          updated with the new record's two surfaces
CAPABILITY_EXPOSURE_MATRIX  refreshed in both languages
```

## 6. What this development-side inventory does NOT claim

* It does not claim the automated rules are complete. They produced 11 candidates of which 4 were
  false positives or by-design; the curation that resolved them is recorded above line by line so the reviewer can
  attack the reasoning rather than the classifier.
* It does not claim surface parity where the workbook does not require it: the host role switch is browser-only on
  purpose, and that is recorded as a parity gap rather than as a missing entry.
* It does not claim intent validation. Every backfilled record keeps `intent_validation_status: NOT_TESTED` unless an
  independent review said otherwise.
* The reviewer must rebuild this inventory independently from the code and diff the two, which is exactly what the
  workbook's Formal Review section requires and what this file is meant to be diffed against.
