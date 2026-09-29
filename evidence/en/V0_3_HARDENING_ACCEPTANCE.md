# V0.3 hardening acceptance

PAIR_STATUS: SYNCHRONIZED
STATUS: V0_3_HARDENING=PASS
FACT: BASE_MAIN=a6745686b4a85da9c6327546b8a20a55d023a2fd
FACT: BASE_CI=36539843220
CODE-SHA: 8c1106e3b6685a123dd5e75ef98ee52e8c9bba43
FACT: IMPLEMENTATION_CI=36548239748_SUCCESS
FACT: SUMMARY_DETAIL_SNAPSHOT_LIST_LIMITS=500_50_50_200
FACT: OLD_DB_MIGRATION=PASS_98_ROWS
FACT: ROOT_ROOM_CITY_ANDROID_TESTS=46_67_114_21
FACT: PROMOTION_HISTORY=PASS_9
FACT: WINDOWS_PHYSICAL_ANDROID_CASES=26_7
FACT: CROSS_CLIENT_DIGEST_MATCHES=5
FACT: APK_SHA256=521610d1f44add13a2cdbd1832b38ccc4e692d122d0d4197d2e9c8a602f52c0f
FACT: GLOBAL_THEME_APPLY=NO
FACT: PAPER_CLAIMS=PILOT

Hardening preserves the existing five services while separating bounded summaries from retained results. Qualified identities, lifecycle-aware availability, genuine Theme operations and Android typed errors are implemented. All City modules retain their previous lifecycle; Road, activation and D9 are later phases.

| Gate | Evidence |
| --- | --- |
| Legacy migration, idempotency, corrupt-row rollback | `tests/capability-history.test.mjs`; [real runtime migration](../raw/v0.3-hardening/runtime-migration.json) |
| 560 large generated records → 500 summaries / 50 details | history test, including bounded HTTP list and summary-only snapshot |
| Running work survives retention; late completion becomes recent | history test with 505 intervening jobs |
| Qualified collisions and mixed/deprecated/planned lifecycles | `tests/capability-registry.test.mjs` |
| Theme false validate refused; existing adapters preserved | registry, adapter and Bridge tests |
| On-demand detail, expired COMPLETED state, stale response fencing | `tests/web-services.test.mjs`; physical history selections below |
| Android error code/status/message; stale RUNNING protection | `CapabilityRequestExceptionTest.kt`, 21 total Android unit tests and build PASS |
| Windows and physical Android consumption | [Windows 26 cases](../raw/v0.3-hardening/windows-runs.json), [Android 7 checks](../raw/v0.3-hardening/android-attempt-1.json) |
| Room, City, promotion history and regression totals | [regression summary](../raw/v0.3-hardening/regression-summary.json) |
| Hosted clean runners | [implementation CI](https://github.com/zhiheng-zhang-Mera/utopia/actions/runs/36548239748), both jobs succeeded |

The real pre-hardening database contained 98 inline-result records. A private local backup preceded migration. All 98 summaries preserved their identity/status/timestamps/digests; all 50 retained results matched their digest. Two consecutive Gateway restarts passed. The invocation segment of the observed City snapshot was 18,519 bytes with no result payload. This does not bound unrelated task/event history or claim secure erasure of SQLite pages.

The physical Android 0.3.1 APK matched the local build hash. Document Intake, Document→Knowledge, Skill Inspect, Evidence Review and Theme Generate ran through native controls and matched Windows digests. Android separately selected Windows-created theme and evidence records and loaded preview/details. Four public-input screenshots were visually reviewed; no camera or active pairing material was captured. The original V0.3 acceptance remains historical evidence, not overwritten by this series.

Independent review found stale RUNNING snapshots could erase fresh terminal results; both clients were fixed and regression tests were observed failing before repair. Android operation/sample/picker changes also invalidate pending detail callbacks. No unresolved critical/important finding remains from that review.

The [manifest](../raw/v0.3-hardening/manifest.json) covers eight sanitized artifacts. Exact known-credential/device-value and selected private-path checks passed; this is not a general secret-scanning claim. The private database backup and raw local build logs are not published.

Hardening branch: `alien/v0.3-hardening-repair`. Integration must verify the final branch CI, merge to main, and verify main CI before creating annotated tag `utopia-v0.3-hardening`. The tag annotation records the actual post-merge main SHA and main CI run, avoiding a self-referential commit SHA in this document. Only that frozen baseline opens Wave3.

Paper claims C-HARDEN-01 (bounded invocation visibility), C-HARDEN-02 (qualified identity under collisions), C-HARDEN-03 (lifecycle-aware availability) remain PILOT, supported by the focused tests and this bounded run series; no general performance or long-term field claim is made.
