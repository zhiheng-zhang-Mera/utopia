# V0.2 acceptance checkpoint

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
FACT: BUNDLE_MANIFEST=150_FILES_VALID
FACT: DELIVERY_AUDIT=273_FILES_ZERO_KNOWN_FINDINGS
FACT: MAIN_INTEGRATION=IN_PROGRESS_NOT_VERIFIED
FACT: RELEASE=NOT_PUBLISHED

The QR product gap is closed by observed positive and negative camera trials. Overall **NOT_ACCEPTED** remains while Gate I integration/release is pending; no completed merge or release is claimed. Semantic integration from independently changed main is in progress in an isolated checkout and has not been verified.

Product source 2607912/ec30… and collection source ee3f313 are distinct. The current APK has five successful camera pairings (runs 2–6) plus one initial no-decode attempt. Display geometry changed during run 2; four subsequent successful rows record scale 2. These observations do not establish that autozoom alone caused success. The older 5410/7acd five-success series remains historical, not counted as current-APK trials.

Scaled negative camera trials in the 04:39:14.835 UTC series completed successfully: two expired scans reuse **one** session after its real five-minute TTL, while two replaced scans use independently replaced, unexpired sessions. This satisfies two observed expiry rejections, not two independent expiry-session experiments. The failed unscaled 04:22 series records real camera zoom readbacks 1×/1.45×/2× and continuous-picture focus but no successful rejection. The interrupted 04:18 focus-bug attempt ended before camera trials and retains zero rows. All failures remain evidence.

| Gate | Evidence and boundary |
|---|---|
| A — V0 regression | Current-APK Android-submitted task completed on the real Node; both UIs agree on result. Historical recovery preserves history. Product CI passed; merged-candidate regression is not yet verified. |
| B — Device Center | Current APK Android/host timestamp and Web exact-sample matches pass; latest screenshots were visually reviewed. Observations are sampled, not simultaneous continuous equality. |
| C — QR | Current APK five positive successes and four negative rejections pass with the shared-expiry-session limitation above. |
| D — mDNS | Separately bound pilot baseline pairing 5/5 and disappearance/reappearance 2/2; later wrong-code UI 2/2. No five-trial current-APK mDNS claim. |
| E — BLE | Baseline pairing 5/5, radio-fix toggles 2/2 and later targeted pairing 1/1 retain their own versions. No hardware-block exception or five-trial current-APK claim. |
| F — Manual | Baseline 5/5 and earlier restoration passed. Current ec30 manual restoration passed, bound to collection ee3f313. |
| G — Recovery/failures | Historical Wi-Fi/Node/Gateway 3/3 each and nine outage audits; API negatives 8/8 remain distinct from the new actual camera negatives. No continuous zero-staleness claim. |
| H — Evidence | Source/APK variants and unsuccessful attempts retained; 150-file manifest verified; bounded audit of 273 delivery files found no known matches. Candidate claims remain PILOT, not universal claims. |
| I — Integration/release | Semantic integration and candidate verification in progress; release NOT_PUBLISHED. Parallel main work is preserved; no completed merge is claimed. |

Current-APK task `Q-688f30f7-11b5-451a-a7d8-52a4fa69bfb0` completed with result SHA-256 `b2cd04407ccb978ee9c04ae504e1c1d724372540e3abc49b56cf193f106b91de` matching Android/Web. Timestamp consistency and current task evidence are in [telemetry](../raw/v0.2/telemetry-consistency.json) and [task](../raw/v0.2/task-regression.json).

Evidence destinations: [autozoom trials](../raw/v0.2/qr-autozoom-trials.json), [scaled negatives](../raw/v0.2/qr-negative-2026-09-29T04-39-14.835Z-runs.json), [negative index](../raw/v0.2/qr-negative-index.json), [autozoom units](../raw/v0.2/android-autozoom-unit-tests.json), [product CI](../raw/v0.2/ci-autozoom-product.json), [manifest](../raw/v0.2/manifest.json), [claim ledger](PAPER_EVIDENCE_V0_2.md). New evidence is included in the verified bundle; no secret or camera preview is needed in published evidence.
