# Paper evidence — asynchronous dispatch transient quiescence

PAIR_STATUS: SYNCHRONIZED
FACT: INCIDENT_ID=ASYNC-DISPATCH-TRANSIENT-QUIESCENCE-2026-10-01
FACT: GLOBAL_COMPONENT_TASKS=41
FACT: DEVELOPMENT_IMPLEMENTED=41
FACT: FULLY_TWO_STAGE_COMPLETE_AT_FINAL_SNAPSHOT=20
FACT: CORRECTION_CODE_COMPLETE_CI_BLOCKED=2
FACT: DEVELOPMENT_CODE_COMPLETE_CI_BLOCKED=5
FACT: DEVELOPMENT_GREEN_WAITING_CORRECTION=14
FACT: UTOPIA_MAIN_STAYED_AT=82ed36933fb4c5b00e44768d9e1aedec1d525d9c
FACT: FAILURE_CLASS=TRANSIENT_ZERO_ELIGIBILITY_MISREAD_AS_TERMINAL_OR_PARKABLE
FACT: REPAIR_CLASS=ELIGIBILITY_AWARE_BOUNDED_RESCAN
FACT: DEFAULT_RESCAN_INTERVAL_MINUTES=20
FACT: STRUCTURAL_INELIGIBILITY_BYPASSES_PERIODIC_RESCAN=true
FACT: GLOBAL_EXTERNAL_BLOCK_BYPASSES_PERIODIC_RESCAN=true
FACT: SINGLE_EMPTY_SCAN_PROVES_POOL_DRAINED=false

## Evidence summary

The four-programme run exposed a scheduler-level failure mode: task eligibility was dynamic, but host retirement was based on a point-in-time scan. A worker could therefore leave while the global pool was unfinished, even though another worker was about to transition work into an eligible state.

Observed sequence on the control repository:

| Time (+10) | Control commit | Observation |
| --- | --- | --- |
| 03:32:29 | `b2672fa` | Alien records RF-006 Correction code-complete but hosted CI cannot start; run stops |
| 03:36:42 | `d9201af` | Mech claims/completes BA-007 Development locally, CI externally blocked |
| 03:42:35 | `802d4c9` | Mech claims/completes EM-013 Development locally, CI externally blocked |
| 03:48:00 | `d4e2847` | Mech claims/completes GAI-009 Development locally, CI externally blocked |

The final observed pool was 41/41 implemented, but only 20/41 fully two-stage complete; two Corrections and five Developments were code-complete but hosted-CI blocked, while 14 green Developments still awaited the other-host Correction.

The raw machine-readable incident summary is stored at `evidence/raw/async-dispatch-2026-10-01/incident-summary.json`.

## Learned scheduling rule

A point-in-time empty eligible set must not be interpreted as terminal unless the global pool is itself terminal. Future orchestration should distinguish `TEMPORARILY_UNCLAIMABLE`, `STRUCTURALLY_INELIGIBLE`, `GLOBAL_EXTERNAL_BLOCK`, and `POOL_TERMINAL`.

Default recovery for `TEMPORARILY_UNCLAIMABLE`: park and re-enter the global scan after approximately 20 minutes. Structural ineligibility and a typed global external blocker do not require periodic retry.

This record is intentionally preserved as failure evidence rather than rewritten into a clean success narrative.
