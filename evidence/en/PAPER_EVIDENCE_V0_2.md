# V0.2 candidate paper evidence ledger

STATUS: NOT_ACCEPTED
PAIR_STATUS: SYNCHRONIZED
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
FACT: APK_SHA256=3152625605bfde912d508e47c4f555dc4f7902e25ba32c33551ead17768be6db
FACT: FINAL_ACCEPTANCE=NOT_ACCEPTED
FACT: RADIO_FIX_APK_SHA256=0f2c3091661bf8818cd0995741ce6fea1f8fe00b4a0cf5867e705294dd383b77
FACT: RADIO_FIX_SOURCE_SHA=3d7b8c9647fa13f75bc62829b5c96966dfba6dd2
FACT: RADIO_FIX_TARGETED_RADIO=2_OF_2_PASS
FACT: RADIO_FIX_TARGETED_BLE_PAIRING=NOT_RUN_SUPERSEDED_BY_LATEST_APK
FACT: RADIO_FIX_CI=36514942297_PASS
FACT: QR_CAMERA_ATTEMPTS=1_NO_CAMERA_DECODE_OBSERVED
FACT: LATEST_SOURCE_SHA=5410fa8ade8c671189cd37bff0d2c34de8b55c6f
FACT: LATEST_APK_SHA256=7acd40e0d1d39b412b4cbd0e916cb2b66c38a2c944f0914f598cb4a9fbf85451
FACT: LATEST_WRONG_CODE_UI=2_OF_2_PASS
FACT: LATEST_ANDROID_UNIT=13_PASS
FACT: LATEST_CI=36515630417_PASS
FACT: LATEST_BLE_PAIRING=1_OF_1_PASS
FACT: LATEST_TELEMETRY_AND_TASK=PASS
FACT: BUNDLE_MANIFEST=103_FILES_VALID
FACT: DELIVERY_AUDIT=219_FILES_ZERO_KNOWN_FINDINGS

This ledger is a progress checkpoint for one Alien Windows host and one Android device. The SHA and APK above identify the completed pilot matrix; the radio-fix facts identify the newer candidate. Each raw artifact's own provenance controls its applicability. Statements about ongoing integration are provisional until linked to sanitized final-build artifacts. No cross-platform generalization, completed QR trial, or full connectivity acceptance is claimed.

Three source/APK variants remain distinct: pilot baseline cb50fdd/315262… for the five-trial matrix; radio fix 3d7b8c9/0f2c30… for radio-toggle 2/2 and one no-decode camera attempt; latest pairing-error fix 5410fa8/7acd40… for wrong-code Android UI 2/2, targeted BLE pairing 1/1, Android unit 13/13 and CI 36515630417 PASS. Earlier overwritten-error attempts remain historical failures. Latest telemetry and real-task reruns now bind source 5410fa8 and APK 7acd40… explicitly: all timestamp/exact-sample/rendered-value checks passed; the real Android-submitted task completed with matching Android/Web artifact SHA-256. Historical pre-APK-provenance records retain UNKNOWN and are excluded from this latest-APK validation. Overall acceptance remains NOT_ACCEPTED.

## C-V02-01

CLAIM-ID: C-V02-01
STATUS: BLOCKED
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: manual=5_OF_5_PILOT_BASELINE_PASS; qr=0_OF_5_SUCCESS_1_NO_DECODE_ATTEMPT; mdns=5_OF_5_PILOT_BASELINE_PASS; ble=5_OF_5_PILOT_BASELINE_PASS; API_NEGATIVE=8_OF_8_PASS

CLAIM: All four bootstrap paths converge on the same authenticated City authority, API and task semantics.

ENVIRONMENT: One Alien Windows host; one Android device. Automated browser/Node evidence is distinct from physical-device evidence.

RAW-EVIDENCE: `evidence/raw/v0.2/manual-trials.json`; `evidence/raw/v0.2/mdns-trials.json`; `evidence/raw/v0.2/ble-trials.json`; corresponding `<mode>-<1..5>-events.jsonl` files; `evidence/raw/v0.2/pairing-api-failures.json`. Historical, nonfinal attempts: `evidence/raw/v0.2/historical-attempts.json`.

LIMITATIONS: One actual QR camera attempt on the radio-fix APK ended NO_CAMERA_DECODE_OBSERVED; successful scans remain 0/5, so the four-path claim remains BLOCKED. Pilot-baseline Manual, mDNS and BLE each have five successful trials bound to the pilot baseline code/APK, with authenticated, snapshot-loaded and WebSocket-online events. These were ADB-driven UI trials with real discovery, not human usability comparisons. Eight isolated HTTP negative trials passed: expiry, wrong code, replaced session and used session, twice each. Expiry used the real 300000 ms default TTL without a fake clock; recorded source hashes remained stable. Those API checks do not exercise a camera or establish physical QR success. Historical attempts are explicitly nonfinal and excluded from final counts.

NOTES: Candidate claim; root integration must update final run counts, hashes and artifact links before acceptance.

## C-V02-02

CLAIM-ID: C-V02-02
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: CODE_INSPECTION_ONLY

CLAIM: QR, mDNS and BLE change bootstrap without duplicating the control data plane.

ENVIRONMENT: One Alien Windows host; one Android device. Automated browser/Node evidence is distinct from physical-device evidence.

RAW-EVIDENCE: `services/dev-gateway/pairing.mjs`; `services/dev-gateway/discovery.mjs`; `platform/windows/ble.mjs`; `contracts/pairing-v1/descriptor.mjs`.

LIMITATIONS: This is a source-inspection finding, not four-path physical acceptance. Windows reserves service UUID advertisement sections; the implemented manufacturer payload carries a 16-byte UUID marker plus a 7-byte locator. Credentials and ephemeral secrets are excluded from advertising.

NOTES: Candidate claim; root integration must update final run counts, hashes and artifact links before acceptance.

## C-V02-03

CLAIM-ID: C-V02-03
STATUS: PILOT
CODE-SHA: 5410fa8ade8c671189cd37bff0d2c34de8b55c6f
RUNS: LATEST_TELEMETRY_MATCH=PASS; LATEST_REAL_TASK=PASS; HISTORICAL_APK=UNKNOWN

CLAIM: Android and Web share one authoritative snapshot for Node telemetry and state.

ENVIRONMENT: One Alien Windows host; one Android device. Automated browser/Node evidence is distinct from physical-device evidence.

RAW-EVIDENCE: `evidence/raw/v0.2/telemetry-consistency.json`; `evidence/raw/v0.2/android-telemetry.xml`; `evidence/raw/v0.2/android-devices.png`; `evidence/raw/v0.2/web-devices.png`; `evidence/raw/v0.2/task-regression.json`.

LIMITATIONS: Latest source 5410fa8ade8c671189cd37bff0d2c34de8b55c6f and installed APK 7acd40e0d1d39b412b4cbd0e916cb2b66c38a2c944f0914f598cb4a9fbf85451 are recorded explicitly. Android host timestamp, Web exact sample, and both rendered-value checks passed. Task Q-8c990031-136b-4de9-8c56-adf67d4e13aa completed on the real reference Node with checkpoint/result available; both UIs matched artifact SHA-256 ae149a46984f46a35f4e64f3e745084b66973b38aebe85b67af704a748cc827c. Historical records without installed APK hashes remain UNKNOWN in separate preserved files. Sequential snapshots and formatted UI observations are not simultaneous atomic captures; intermediate host/Web samples may differ during propagation. This is a one-host PILOT, not continuous synchronization or cross-platform precision.

NOTES: Candidate claim; root integration must update final run counts, hashes and artifact links before acceptance.

## C-V02-04

CLAIM-ID: C-V02-04
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: WIFI=3_OF_3_PASS; NODE=3_OF_3_PASS; GATEWAY=3_OF_3_PASS; MDNS_DISAPPEAR_REAPPEAR=2_OF_2_PASS; BLE_TOGGLE=2_OF_2_RADIOFIX_PASS

CLAIM: Client or Node disconnection does not leave stale telemetry rendered as live green state.

ENVIRONMENT: One Alien Windows host; one Android device. Automated browser/Node evidence is distinct from physical-device evidence.

RAW-EVIDENCE: `evidence/raw/v0.2/wifi-recovery.json`; `evidence/raw/v0.2/node-recovery.json`; `evidence/raw/v0.2/gateway-recovery.json`; corresponding connection-event JSONL and offline XML files. Native mDNS recovery: `evidence/raw/v0.2/mdns-discovery-recovery.json`. The separately bound radio-fix result is `evidence/raw/v0.2/ble-discovery-recovery.json`; CI evidence as `evidence/raw/v0.2/ci-radiofix-product.json`.

LIMITATIONS: Wi-Fi, Node and Gateway recovery each passed three recorded trials, with history and City identity preserved. Final Node/Gateway rows include Web Node observations. The confirmed-outage observations record OFFLINE/UNKNOWN rather than live green state, followed by recovery. However, UI dumps and Web reads were sequential and sampled; earlier Node-stop observations still showed Android ONLINE before the later confirmed OFFLINE observation. Therefore staleGreenObserved=false applies only to the designated confirmed-outage sample, not continuous zero stale-green duration or immediate detection. Native mDNS disappearance/reappearance passed twice. The initial BLE toggle helper returned nonzero despite changing radio state; it is not counted as a pass. Two subsequent radio-fix source/APK trials passed explicit disabled/enabled UI checks and native rediscovery, with separate provenance. These bounded observations justify PILOT only. The published outage audit checked all nine XML files for explicit Utopia OFFLINE/UNKNOWN/RECONNECTING or Node OFFLINE state matching the records; see `evidence/raw/v0.2/recovery-outage-audit.json`.

NOTES: Candidate claim; root integration must update final run counts, hashes and artifact links before acceptance.

## C-V02-05

CLAIM-ID: C-V02-05
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: MANUAL=5; MDNS=5; BLE=5; QR=0; WIFI_RECOVERY=3; NODE_RECOVERY=3; GATEWAY_RECOVERY=3

CLAIM: Pairing and reconnection meet product-acceptable latency.

ENVIRONMENT: One Alien Windows host; one Android device. Automated browser/Node evidence is distinct from physical-device evidence.

RAW-EVIDENCE: `evidence/raw/v0.2/manual-trials.json`; `evidence/raw/v0.2/mdns-trials.json`; `evidence/raw/v0.2/ble-trials.json`, with corresponding per-trial event files. Historical, excluded attempts: `evidence/raw/v0.2/historical-attempts.json`.

LIMITATIONS: Observed submission-to-authenticated intervals (`pairingExchangeLatencyMs`) were Manual 40–280 ms, mDNS 17–922 ms and BLE 22–275 ms, with five pilot-baseline trials per mode. Manual uses the existing credential path, so this metric is not a short-code exchange there. Overall start-to-online times include ADB/UI-driver waits and input overhead; they are not estimates of human pairing speed or a fair usability comparison between modes. Three recovery records per interruption type are now available, but sequential UI sampling and differing event/capture times limit latency interpretation. No final product-acceptability threshold or QR camera timing is available. Small-sample ranges are descriptive only; this is PILOT data, not a SUPPORTED latency claim. Baseline medians were 103 / 24 / 32 ms for authenticated intervals and 24987 / 37301 / 30358 ms for ADB-driven overall time (Manual / mDNS / BLE); QR is null. The overall values are not human-speed benchmarks.

NOTES: Candidate claim; root integration must update final run counts, hashes and artifact links before acceptance.

## C-V02-06

CLAIM-ID: C-V02-06
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: STACK_BASELINE=1x30s_PILOT; STACK_NORMAL=1x30s_PILOT; ISOLATED_SAMPLER_BASELINE=1x30s; ISOLATED_SAMPLER_ENABLED=1x30s

CLAIM: Telemetry and discovery have low host resource overhead.

ENVIRONMENT: One Alien Windows host; one Android device. Automated browser/Node evidence is distinct from physical-device evidence.

RAW-EVIDENCE: `evidence/raw/v0.2/stack-resource-pilot.json`; command: set `CITY_RESOURCE_HOST` to the local LAN IPv4, then `node scripts/stack-resource-pilot.mjs`. Supplement: `evidence/raw/v0.2/resource-pilot.json` from `node scripts/resource-pilot.mjs`.

LIMITATIONS: The full-stack pilot completed one sequential baseline/normal pair, configured for 30 seconds per mode after a 5-second warmup (observed windows 30.581 and 30.726 seconds). Baseline Gateway + Node with discovery/telemetry disabled measured 0.817% CPU of one logical core and 125.73 MB mean combined WorkingSet64. Normal Gateway + Node + telemetry + mDNS + WinRT BLE publisher measured 0.966% CPU and 223.60 MB. Both runs are PILOT; normal mDNS/BLE were ACTIVE before and after measurement. The normal working set includes the PowerShell WinRT publisher; summed working sets may double-count shared pages and do not equal private memory. Shared-host noise and order effects are uncontrolled, and the separate PowerShell measurement process perturbs the host but is excluded from these counters. Shared Windows services, other kernel work, initialization, Android/Web clients, user tasks and network bytes are excluded. This single pair does not establish universal low overhead or a causal resource difference; this claim remains PILOT, not SUPPORTED. The stack JSON records the pilot baseline code SHA with `worktreeModified=true`. The earlier isolated sampler supplement (0.210% versus 0.470% CPU; 53.11 versus 53.77 MB mean RSS) retains its own historical provenance and must not be attributed to the current candidate.

NOTES: Candidate claim; root integration must update final run counts, hashes and artifact links before acceptance.
