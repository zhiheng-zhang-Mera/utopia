# Capability Bridge V0.3 acceptance

PAIR_STATUS: SYNCHRONIZED
FACT: WAVE2_REPAIR=PASS
FACT: ALIEN_CAPABILITY_BRIDGE_V0_3=ACCEPTED
FACT: WINDOWS_UI_CASES=26
FACT: ANDROID_UI_CASES=25
FACT: CANONICAL_DIGEST_MATCHES=18
FACT: WIFI_RECOVERY=PASS
FACT: GATEWAY_RESTART=PASS
FACT: RUNNING_TO_INTERRUPTED=PASS
FACT: STALE_GREEN=NO
FACT: ROOT_TESTS=36_PASS
FACT: ROOM_TESTS=67_PASS
FACT: CITY_TESTS=114_PASS
FACT: PROMOTION_HISTORY=9_PASS
FACT: ANDROID_TESTS=17_PASS
FACT: APK_SHA256=5cf75592f74f62da7745dff18caf68a5fd2064b2aeeaef2e98447c60146144a3
FACT: PROMOTED_LIFECYCLE_PRESERVED=YES
FACT: D6B=DEFERRED_SCOPE_ALLOCATION
FACT: THEME_OWNERSHIP=REVIEW_PENDING
FACT: MECH_FUTURE_MIGRATION_BLOCKED_BY_ALIEN=NO

The five services are usable from headed Microsoft Edge and the connected physical Android device through one City authority. Android selected all six generated document formats through ACTION_OPEN_DOCUMENT. The final Windows series has 26 passing cases; Android has 25 distinct final passing cases, including native oversized-file refusal without an invocation. All 18 successful canonical comparisons match. Failed expected inputs retain FAILED rather than a success result.

| Capability | Windows | Android | Observed boundary |
| --- | --- | --- | --- |
| Document Intake | PASS | PASS | TXT/JSON/YAML/DOCX/XLSX/PDF; malformed JSON, truncated PDF and oversized-file refusal |
| Knowledge Query | PASS | PASS | Temporary entries and actual document-section mapping; same canonical result |
| Skill Inspect | PASS | PASS | Six reference forms/refusals, valid/malformed SKILL.md, safe/unsafe archives; Windows offline catalog |
| Evidence Review | PASS | PASS | Same integrity root, claim status, decision and digest; ARTIFACT_HASH_MISMATCH on tamper |
| Theme Lab | PASS | PASS | Same parameters and PNG result; visible preview and validation; no global apply |

Wi-Fi loss visibly disables Android invocation; reconnection produces no duplicate history. Gateway restart retains City identity and completed IDs/digests. An actual Windows UI invocation was observed RUNNING before process termination and recovered as INTERRUPTED/GATEWAY_RESTARTED, visible on both clients. This is separate from the seeded restart unit test.

Repair PR [#2](https://github.com/zhiheng-zhang-Mera/utopia/pull/2) merged to 374fad597387278f981c21f8897e772adc5922e8 after the original 4ac287b5dd6cd7214c0129b23bb1cad09aab0e97 baseline. Final Windows source: 65ae358809e997f2a644716ca2c0d601fb919492. Android source: fdb48c3; later Bridge/Web changes did not alter the installed APK. [Hosted full regression](https://github.com/zhiheng-zhang-Mera/utopia/actions/runs/36538170564) passed at 05307163ab8a43425f58b7d686d221d0db408742. Delivery-only commits and the merge are checked separately in their attached CI runs.

The future-module gate appends an unbridged module to a cloned manifest and invokes all five existing adapters; the browser regression switches to a pending descriptor during an active request. Neither test claims observation of a future real migration. All existing lifecycle values remain PROMOTED.

Earlier unsafe-archive acceptance, picker-provider lookup failures, reference-input clearing errors and viewport verification misses are preserved in raw evidence. These were repaired or rechecked; they are not relabeled as first-attempt successes. The current product gate uses each case's final observation.

Limits: one physical device and generated public fixtures; 1 MiB files, two workers, 20-second execution, 3 MiB results. Server latency is not end-to-end user performance. Temporary knowledge is not a permanent knowledge database, but invocation results are explicitly retained. Evidence verifies integrity and declared references, not external truth. Skill installation, provider automation, theme global apply and D6b remain outside scope. Theme ownership remains for review.

See [raw manifest](../raw/v0.3/manifest.json), [run ledger](../../data-records/en/BRIDGE_RUNS_V0_3.md), [activation review](../../docs/en/BRIDGE_ACTIVATION_REVIEW_V0_3.md) and [repair acceptance](WAVE2_REPAIR_ACCEPTANCE.md). Screenshots were visually reviewed; the delivery audit checks known credentials, connected-device identifier, selected private paths and both raw manifests. It is not a general security certification.
