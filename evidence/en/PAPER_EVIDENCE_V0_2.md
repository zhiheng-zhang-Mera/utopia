# V0.2 candidate paper evidence ledger

STATUS: NOT_ACCEPTED
PAIR_STATUS: SYNCHRONIZED
CODE-SHA: 2607912f85c22f6075367dc0eff1c45a58d75419
FACT: UTOPIA_V0_2=NOT_ACCEPTED
FACT: PRODUCT_APK_SHA256=ec30b0829a242aac05e604d3ade1aa5e91da2bbe45d22d4d9b5bcef222a5c9a7
FACT: COLLECTION_SHA=ee3f3134efeabc3ff58d3c4fcbac6b57a5adec5c
FACT: QR_AUTOZOOM=5_PASS_1_INITIAL_NO_DECODE
FACT: QR_NEGATIVE=EXPIRED_2_PASS_SHARED_SESSION_REPLACED_2_PASS_INDEPENDENT_SESSIONS
FACT: PRODUCT_CI=36521350387_PASS
FACT: ANDROID_UNIT=16_PASS
FACT: LATEST_TASK_AND_TELEMETRY=PASS
FACT: MANUAL_RESTORATION=PASS
FACT: BUNDLE_MANIFEST=158_FILES_VALID
FACT: DELIVERY_AUDIT=381_FILES_ZERO_KNOWN_FINDINGS
FACT: MAIN_INTEGRATION=LOCAL_MERGED_937e1dc_VERIFIED
FACT: RELEASE=NOT_PUBLISHED

All six claims remain PILOT. Artifact provenance controls applicability; integration/release is not complete. Preserve failed, interrupted and unknown-provenance attempts.

## C-V02-01

CLAIM-ID: C-V02-01
STATUS: PILOT
CODE-SHA: 2607912f85c22f6075367dc0eff1c45a58d75419
RUNS: QR_CURRENT=5_PASS_1_NO_DECODE; QR_NEGATIVE=4_PASS_SHARED_EXPIRY_SESSION; OTHER_MODES=HISTORICAL_PILOTS

CLAIM: All four bootstrap paths converge on City control authority.

ENVIRONMENT: One Alien Windows host and one Android device.

RAW-EVIDENCE: `evidence/raw/v0.2/qr-autozoom-trials.json`; `evidence/raw/v0.2/qr-negative-2026-09-29T04-39-14.835Z-runs.json`; `evidence/raw/v0.2/manual-trials.json`; `evidence/raw/v0.2/mdns-trials.json`; `evidence/raw/v0.2/ble-trials.json`.

LIMITATIONS: Current camera positives/negatives are verified; other modes retain older source/APK provenance. Two expiry scans share one expired session. Display geometry changed during one success; do not attribute results solely to autozoom or claim all modes were rerun five times on this APK.

NOTES: Each raw record retains its own source/APK binding; the header does not relabel historical runs.

## C-V02-02

CLAIM-ID: C-V02-02
STATUS: PILOT
CODE-SHA: 2607912f85c22f6075367dc0eff1c45a58d75419
RUNS: SOURCE_INSPECTION

CLAIM: Discovery changes bootstrap without duplicating the data plane.

ENVIRONMENT: One Alien Windows host and one Android device.

RAW-EVIDENCE: `services/dev-gateway/pairing.mjs`; `platform/windows/ble.mjs`.

LIMITATIONS: Source inspection supports one HTTP/WebSocket control plane. Windows manufacturer data holds UUID16+locator7 because service UUID AD sections are reserved. This is not a universal security claim.

NOTES: Each raw record retains its own source/APK binding; the header does not relabel historical runs.

## C-V02-03

CLAIM-ID: C-V02-03
STATUS: PILOT
CODE-SHA: 2607912f85c22f6075367dc0eff1c45a58d75419
RUNS: CURRENT_APK_TELEMETRY=PASS; CURRENT_APK_TASK=PASS

CLAIM: Android and Web share authoritative telemetry and task state.

ENVIRONMENT: One Alien Windows host and one Android device.

RAW-EVIDENCE: `evidence/raw/v0.2/telemetry-consistency.json`; `evidence/raw/v0.2/task-regression.json`.

LIMITATIONS: Current ec30 observations match Android/host timestamp and Web exact sample. Both UIs agree on the completed task and artifact stated in acceptance. Sequential samples and formatted UI values are not simultaneous atomic captures; preserved earlier unknown-APK records are excluded.

NOTES: Each raw record retains its own source/APK binding; the header does not relabel historical runs.

## C-V02-04

CLAIM-ID: C-V02-04
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: WIFI=3; NODE=3; GATEWAY=3; OUTAGE_AUDIT=9; RADIO_TOGGLE=2

CLAIM: Confirmed outages are rendered as non-live state.

ENVIRONMENT: One Alien Windows host and one Android device.

RAW-EVIDENCE: `evidence/raw/v0.2/wifi-recovery.json`; `evidence/raw/v0.2/node-recovery.json`; `evidence/raw/v0.2/gateway-recovery.json`; `evidence/raw/v0.2/recovery-outage-audit.json`; `evidence/raw/v0.2/ble-discovery-recovery.json`.

LIMITATIONS: These are historical, version-bound sampled observations. Earlier Node-stop samples still displayed Android ONLINE before confirmed OFFLINE; no continuous zero-stale duration or immediate detection is established. Post-QR cached-to-online observation is likewise sampled.

NOTES: Each raw record retains its own source/APK binding; the header does not relabel historical runs.

## C-V02-05

CLAIM-ID: C-V02-05
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: BASELINE_MANUAL=5; BASELINE_MDNS=5; BASELINE_BLE=5; CURRENT_QR=5_SUCCESS

CLAIM: Pairing and recovery latency are product-acceptable.

ENVIRONMENT: One Alien Windows host and one Android device.

RAW-EVIDENCE: `evidence/raw/v0.2/manual-trials.json`; `evidence/raw/v0.2/mdns-trials.json`; `evidence/raw/v0.2/ble-trials.json`; `evidence/raw/v0.2/qr-autozoom-trials.json`.

LIMITATIONS: Baseline authenticated medians 103/24/32 ms and overall ADB medians 24987/37301/30358 ms describe Manual/mDNS/BLE only. Driver waits are not human speed; newer QR runs are not pooled. No threshold or general performance acceptance is inferred.

NOTES: Each raw record retains its own source/APK binding; the header does not relabel historical runs.

## C-V02-06

CLAIM-ID: C-V02-06
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: STACK_BASELINE=1x30s; STACK_NORMAL=1x30s

CLAIM: Telemetry/discovery resource overhead is low.

ENVIRONMENT: One Alien Windows host and one Android device.

RAW-EVIDENCE: `evidence/raw/v0.2/stack-resource-pilot.json`; `evidence/raw/v0.2/resource-pilot.json`.

LIMITATIONS: Historical stack pair: CPU 0.817%/0.966% of one core; mean combined working set 125.73/223.60 MB. Normal includes PowerShell BLE. Shared pages, shared-host noise, order and instrumentation effects remain. This is PILOT measurement, not support for universal low overhead or the newer APK alone.

NOTES: Each raw record retains its own source/APK binding; the header does not relabel historical runs.


Final integration update: local merge 937e1dc preserves main f28422b and the unchanged Android tree from 2607912. Root tests 26/26, Rooms 67/67, City 44/44, promotion history 4/4, bilingual checks and read-only review passed. Post-integration physical task/result and telemetry checks passed; City identity and all six previous tasks survived Gateway restart. One additional camera restoration passed after one preserved pre-camera driver timeout. The 158-file manifest passed the bounded 381-file audit with zero known findings. Earlier pending-integration prose above is superseded by this update. Cloud PR merge and release remain pending at this checkpoint.
