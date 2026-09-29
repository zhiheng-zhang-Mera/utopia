# V0.2 acceptance checkpoint

STATUS: NOT_ACCEPTED
PAIR_STATUS: SYNCHRONIZED
CODE-SHA: 5410fa8ade8c671189cd37bff0d2c34de8b55c6f
FACT: UTOPIA_V0_2=NOT_ACCEPTED
FACT: PRODUCT_APK_SHA256=7acd40e0d1d39b412b4cbd0e916cb2b66c38a2c944f0914f598cb4a9fbf85451
FACT: QR_RUN_SOURCE_SHA=f8285134f6ac8ef58f34c9c48bc6e21f21c1317e
FACT: QR_DEVICE_OBSERVER_SOURCE_SHA=5855a927e42ae2945728f509a7b4ef07bcd372bf
FACT: QR_POSITIVE=5_PASS_2_PRE_CAMERA_DRIVER_ERRORS
FACT: QR_NEGATIVE=0_PASS_3_NO_DECODE_ATTEMPTS_1_GUARD_INVOCATION
FACT: QR_NEGATIVE_LEGACY_DRIVER_HASH=UNKNOWN
FACT: MANUAL_RESTORATION=PASS
FACT: PRODUCT_CI=36515630417_PASS
FACT: BUNDLE_MANIFEST=126_FILES_VALID
FACT: DELIVERY_AUDIT=244_FILES_ZERO_KNOWN_FINDINGS
FACT: RELEASE=NOT_PUBLISHED
FACT: MERGE=NOT_DONE

**NOT_ACCEPTED:** positive QR camera pairing now has five successes. Physical negative-QR rejection verification and release delivery remain incomplete. The phone was positioned by the user; successful run indices are 1, 2, 5, 6 and 7. Pre-camera driver failures 3 and 4 remain visible and are not camera failures.

The APK product source remains 5410fa8/7acd40…. QR runs bind repository source f828513…; Device Center observation binds collector 5855a9…. These collector revisions do not imply a new APK. Pilot-baseline cb50fdd/315262… retains Manual/mDNS/BLE 5/5 each; radio-fix 3d7b8c9/0f2c30… retains toggle 2/2. Latest-product wrong-code UI 2/2, targeted BLE pairing 1/1, exact-APK telemetry/task and CI passed. Earlier overwritten-error, no-decode, USB/onboarding and unknown-APK attempts remain historical.

| Gate | Evidence and remaining boundary |
|---|---|
| A — V0 regression | Real latest-APK task completed; Android/Web task and result artifact agree. Baseline recovery preserves history. Product CI passed; final branch CI/clean-state verification follows evidence commit. |
| B — Device Center | Latest telemetry timestamp/exact-sample/rendered-value checks passed. After successful QR, Alien was visible initially UNKNOWN · Cached, then automatically ONLINE without re-pairing. These are two sampled observations, not zero-staleness proof. |
| C — QR | Positive camera pairing 5 successes, plus 2 retained pre-camera driver errors. Negative camera rejection remains 0 passes: expiry 1 and replaced-session 2 attempts produced no observed decode/rejection. Gate incomplete. |
| D — mDNS | Pilot baseline discovery/pairing 5/5; native disappearance/reappearance 2/2. Latest wrong-code UI rejection 2/2 separately bound. |
| E — BLE | Pilot baseline pairing 5/5; radio-fix toggle 2/2; latest targeted pairing 1/1. No five-trial claim for latest APK; no hardware-block exception. |
| F — Manual | Baseline clean manual trials 5/5; latest post-QR manual restoration passed and host is usable online. |
| G — Failures/recovery | Wi-Fi/Node/Gateway 3/3 each, nine outage XML audits pass. API negatives 8/8 are distinct from camera UI. Required expired/replaced QR camera rejection repetitions remain unverified. |
| H — Evidence | Paired ledgers and bounded pilots exist. The refreshed manifest covers 126 files; the 244-file delivery audit reports zero known findings. Legacy negative-driver hash stays UNKNOWN; do not backfill it from newer source. |
| I — Release | [Draft PR #1](https://github.com/zhiheng-zhang-Mera/utopia/pull/1) remains open; release NOT_PUBLISHED. Parallel main changes are preserved and unmerged, not claimed tested. A verified feature-branch release need not overwrite or merge main. |

Negative attempts are preserved across three invocations: 03:46 UTC contains one expired and one replaced-session no-decode attempt; 03:58 failed the geometry guard before the camera and has zero rows; 03:59 contains one replaced-session no-decode attempt. The attempted expiry protocol reused one expired session for planned repeated scans; it was not two independent expired sessions. No attempt is promoted to PASS because an API test passed.

Published sources include [baseline trials](../raw/v0.2/manual-trials.json), [mDNS](../raw/v0.2/mdns-trials.json), [BLE](../raw/v0.2/ble-trials.json), [telemetry](../raw/v0.2/telemetry-consistency.json), [task](../raw/v0.2/task-regression.json), [outage audit](../raw/v0.2/recovery-outage-audit.json) and [claim ledger](PAPER_EVIDENCE_V0_2.md). Published updates: [QR trials](../raw/v0.2/qr-trials.json), [QR Device Center](../raw/v0.2/qr-device-center.json), [negative attempt index](../raw/v0.2/qr-negative-index.json), and [manual restoration](../raw/v0.2/manual-qr-restoration-trials.json). The sanitized bundle retains unsuccessful attempts and its manifest is verified.

Baseline authenticated-interval medians are Manual 103 ms, mDNS 24 ms and BLE 32 ms. Overall ADB medians 24987 / 37301 / 30358 ms include driver/input waits and are not human comparisons; newer QR timings are not pooled into that baseline. The single stack resource pair is PILOT, not universal low-overhead evidence. Work remains pending physical negative-QR verification; no autonomous-completion claim is made.

Restored host observation: [online host](../raw/v0.2/post-qr-restoration-host.json).
