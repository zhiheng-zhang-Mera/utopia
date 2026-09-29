# V0.2 acceptance checkpoint

STATUS: NOT_ACCEPTED
PAIR_STATUS: SYNCHRONIZED
CODE-SHA: 5410fa8ade8c671189cd37bff0d2c34de8b55c6f
FACT: UTOPIA_V0_2=NOT_ACCEPTED
FACT: PILOT_BASELINE_SOURCE_SHA=cb50fdd6ba5f23c16167672f32853485701772fb
FACT: PILOT_BASELINE_APK_SHA256=3152625605bfde912d508e47c4f555dc4f7902e25ba32c33551ead17768be6db
FACT: RADIO_FIX_SOURCE_SHA=3d7b8c9647fa13f75bc62829b5c96966dfba6dd2
FACT: RADIO_FIX_APK_SHA256=0f2c3091661bf8818cd0995741ce6fea1f8fe00b4a0cf5867e705294dd383b77
FACT: RADIO_FIX_TARGETED_RADIO=2_OF_2_PASS
FACT: RADIO_FIX_CI=36514942297_PASS
FACT: QR_CAMERA=0_OF_5_SUCCESS_1_NO_DECODE_ATTEMPT
FACT: LATEST_SOURCE_SHA=5410fa8ade8c671189cd37bff0d2c34de8b55c6f
FACT: LATEST_APK_SHA256=7acd40e0d1d39b412b4cbd0e916cb2b66c38a2c944f0914f598cb4a9fbf85451
FACT: LATEST_WRONG_CODE_UI=2_OF_2_PASS
FACT: LATEST_ANDROID_UNIT=13_PASS
FACT: LATEST_CI=36515630417_PASS
FACT: LATEST_BLE_PAIRING=1_OF_1_PASS
FACT: LATEST_TELEMETRY_AND_TASK=PASS
FACT: BUNDLE_MANIFEST=103_FILES_VALID
FACT: DELIVERY_AUDIT=219_FILES_ZERO_KNOWN_FINDINGS
FACT: RELEASE=NOT_PUBLISHED
FACT: MERGE=NOT_DONE

**NOT_ACCEPTED:** QR has zero successful camera trials out of five required; one genuine attempt ended NO_CAMERA_DECODE_OBSERVED after OS camera permission was allowed. API expiry/old-session rejection is not camera or Android negative-QR UI acceptance. [Draft PR #1](https://github.com/zhiheng-zhang-Mera/utopia/pull/1) remains unmerged; no release is claimed.

Provenance is split deliberately. The pilot baseline has Manual/mDNS/BLE 5/5 each and the recovery/resource matrix. The radio-fix variant passed Bluetooth toggle 2/2 and CI. The latest pairing-error fix retains the error independently of discovery status: Android wrong-code UI rejection now passes 2/2 and unit tests 13/13. Latest BLE pairing passed 1/1, telemetry/task reruns passed with explicit installed APK provenance, and CI 36515630417 passed both jobs. Previous attempts where discovery overwrote the rejection text are historical failures, not these new UI passes. Historical telemetry/task observations omitted the installed APK hash; their preserved pre-APK-provenance records remain UNKNOWN and are not reassigned to any APK.

| Gate | Evidence and outstanding boundary |
|---|---|
| A — V0 regression | Baseline recovery preserves history. Latest real task completed with both UIs matching artifact SHA-256 and explicit source/installed APK provenance. Historical unknown-APK records remain separate. Latest CI 36515630417 passed both jobs; radio-fix CI passed. |
| B — Device Center | Latest exact-APK host timestamp, Web exact-sample and Android/Web rendered-value checks all passed. Historical unknown-APK records remain separate. |
| C — QR | 0/5 successes, one actual no-decode attempt. Camera exchange and Android expired/old-QR UI paths remain unverified. |
| D — mDNS | Pilot baseline discovery/pairing 5/5; native disappearance/reappearance 2/2. Latest wrong-code UI rejection 2/2 is separately bound. |
| E — BLE | Pilot baseline discovery/pairing 5/5; radio-fix toggles 2/2 with disabled text, enabled/retry hint and native rediscovery. Latest targeted pairing passed 1/1. Hardware is capable; hardware-block acceptance is inapplicable. |
| F — Manual | Pilot baseline clean manual trials 5/5. Do not claim five trials on the latest APK. |
| G — Recovery/failures | Wi-Fi/Node/Gateway 3/3 each; nine published outage XML files audited for explicit Utopia outage state matching their records. This is sampled confirmed-outage evidence, not continuous zero staleness. API negatives 8/8; latest wrong-code UI 2/2. QR negative-UI coverage remains missing. |
| H — Evidence | Bilingual ledgers, sanitized trials, resource data and manifest exist. The 103-file bundle manifest is valid; a 219-file audit found no known secrets, private paths or connected-device serial, and two published images were visually reviewed. This is a bounded audit, not proof of absence of every possible secret. Historical failed/unknown records remain visible. |
| I — Release | Draft PR only. No accepted release, merge or final clean-state/asset verification. Latest CI passed; final clean-state/asset verification remains pending. |

Evidence: [baseline trials](../raw/v0.2/manual-trials.json), [mDNS trials](../raw/v0.2/mdns-trials.json), [BLE trials](../raw/v0.2/ble-trials.json), [mDNS recovery](../raw/v0.2/mdns-discovery-recovery.json), [outage audit](../raw/v0.2/recovery-outage-audit.json), [latest Android units](../raw/v0.2/android-errorfix-unit-tests.json), [API negatives](../raw/v0.2/pairing-api-failures.json), [resource pilot](../raw/v0.2/stack-resource-pilot.json), [claim ledger](PAPER_EVIDENCE_V0_2.md). Latest targeted records: [wrong-code UI](../raw/v0.2/mdns-wrong-code-runs.json), [BLE pairing](../raw/v0.2/ble-radiofix-trials.json), [telemetry](../raw/v0.2/telemetry-consistency.json), [task](../raw/v0.2/task-regression.json), [product CI](../raw/v0.2/ci-errorfix-product.json), [delivery audit](../raw/v0.2/delivery-audit.json). Autonomous work is complete at this checkpoint; physical QR successes and negative-QR UI coverage, accepted release, and post-commit branch CI/clean-state verification remain outstanding.

Baseline authenticated-interval medians: Manual 103 ms, mDNS 24 ms, BLE 32 ms; QR null. ADB-driven overall medians: 24987 / 37301 / 30358 ms. These include driver/input waits and are not human-speed comparisons. The single 30-second stack pair measured 0.817% / 0.966% of one CPU core and 125.73 / 223.60 MB combined working set; normal includes PowerShell BLE. Noise, shared pages and instrumentation prevent a universal low-overhead claim.
