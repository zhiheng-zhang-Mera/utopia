# V0.3 paper evidence boundaries

PAIR_STATUS: SYNCHRONIZED
CODE-SHA: 65ae358809e997f2a644716ca2c0d601fb919492
FACT: GENERALIZED_PERFORMANCE_CLAIM=UNSUPPORTED
FACT: EXTERNAL_TRUTH_VERIFICATION=UNSUPPORTED

| Claim | Status | Raw evidence | Scope / limitations |
| --- | --- | --- | --- |
| C-REPAIR-01 | SUPPORTED | [regression summary](../raw/v0.3/regression-summary.json), [promotion history](../raw/v0.3/promotion-history.txt) | Forward repair commits preserve nine verifiable promotion records. |
| C-BRIDGE-01 | PILOT | [windows-runs.json](../raw/v0.3/windows-runs.json) | Five thin adapters call owning modules. |
| C-BRIDGE-02 | PILOT | [android-documents.json](../raw/v0.3/android-documents.json) | Shared authority and canonical results; bounded to these samples and one physical device. |
| C-BRIDGE-03 | PILOT | [regression-summary.json](../raw/v0.3/regression-summary.json) | Unit/browser pending-module gates pass; no actual future migration observed. |
| C-BRIDGE-04 | PILOT | [android-document-errors.json](../raw/v0.3/android-document-errors.json) | Malformed inputs and oversize preflight preserve refusal; not exhaustive format adversaries. |
| C-BRIDGE-05 | PILOT | [android-evidence-theme.json](../raw/v0.3/android-evidence-theme.json) | Tamper fails without rehashing; not truth verification or a mandatory broker. |
| C-BRIDGE-06 | SUPPORTED | [manifest.json](../raw/v0.3/manifest.json) | Domain boundaries remain explicit in descriptors, adapters and activation review; theme ownership pending. |

Run IDs, actual source versions and APK identities are in the corresponding JSON and run ledger. Failed attempts remain visible; before/after evidence is not rewritten as first-attempt success. Recovery observations are in connectivity-recovery.json and interruption-recovery.json. Digest equality establishes canonical output equality for these inputs, not arbitrary inputs, devices or global distributed correctness. Unit tests do not replace real UI acceptance; the future-module gate is explicitly a controlled regression.
