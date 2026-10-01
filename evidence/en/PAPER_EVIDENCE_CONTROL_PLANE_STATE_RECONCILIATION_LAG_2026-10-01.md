# Paper evidence — control-plane state reconciliation lag after external recovery

PAIR_STATUS: SYNCHRONIZED
FACT: INCIDENT_ID=CONTROL-PLANE-STATE-RECONCILIATION-LAG-2026-10-01
FACT: TRIGGER=GITHUB_ACTIONS_BILLING_RECOVERY
FACT: FAILURE_CLASS=CONTROL_PLANE_STATE_RECONCILIATION_LAG
FACT: REPAIR_CLASS=AUTHORITATIVE_EXTERNAL_STATE_RECONCILIATION
FACT: DEVELOPMENT_GREEN_AFTER_RECOVERY=41/41
FACT: CORRECTION_COMPLETE_AT_RECONCILIATION=36/41
FACT: STALE_DEVELOPMENT_TASKS=5
FACT: STALE_TASK_IDS=BA-007,BA-009,GAI-009,EM-012,EM-013
FACT: EVIDENCE_POINTER_MISMATCHES=1
FACT: REQUIRED_EVIDENCE_BINDING=BRANCH+HEAD_SHA+CONCLUSION
FACT: DIGITAL_CITY_RECONCILIATION_COMMIT=da309a6ef6a45ed747a270bc6576204b0455c363

## Evidence summary

After the GitHub Actions billing/account blocker was removed, the previously blocked runs were successfully re-run on their exact implementation heads. The execution layer had therefore recovered, but the Digital-City control layer still described five Development stages as billing-blocked.

The stale tasks were BA-007, BA-009, GAI-009, EM-012 and EM-013. Their referenced runs had already completed successfully. In parallel, the Mission Book dashboard still showed the original all-unclaimed snapshot, and GAI-005's Correction evidence pointer referenced RF-009 run `36746849199` instead of GAI-005's own green run `36746845955`.

This created a second incident distinct from the billing outage itself:

```text
external execution truth = recovered
canonical scheduling metadata = stale
one green evidence pointer = wrong task/branch
```

A scheduler consuming only the stale control plane could suppress eligible Corrections or fail to wake a programme-integration stage even though the real external gate was already open.

## Reconciliation repair

Digital-City commit `da309a6ef6a45ed747a270bc6576204b0455c363` reconciles current control truth:

- the five recovered Development stages are COMPLETE on their exact green heads;
- historical billing failures remain preserved in reports/evidence rather than being erased;
- GAI-005 Correction CI is bound to its own run `36746845955`;
- the dashboard is recomputed as 41/41 Development green and 36/41 Correction complete;
- Remote Fabric is recorded as 10/10 + 10/10 and its programme-integration stage is unlocked;
- the cross-programme contract now requires authoritative reconciliation after external recovery and before pool-drain/merge/terminal decisions.

The required evidence binding is:

```text
task branch == run head_branch
task head   == run head_sha
required stage terminal state == run conclusion/status
```

The machine-readable incident summary is stored at `evidence/raw/control-plane-reconciliation-2026-10-01/incident-summary.json`.

## Learned rule

External recovery is not complete when the provider/CI system merely turns green. It is complete only after canonical control metadata has been reconciled against the authoritative source.

This is preserved as Utopia dogfood for future scheduler/control-plane evolution, not rewritten into a clean success-only narrative.
