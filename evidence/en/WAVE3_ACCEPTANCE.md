# Wave3 acceptance

PAIR_STATUS: SYNCHRONIZED
STATUS: WAVE3=ACCEPTED
CODE-SHA: c31035f9fd7e40a63033dcd1d63fde1629a8f31b
FACT: HARDENING=PASS
FACT: ROAD_ACTIVATION=PASS
FACT: D9=CITY_PROMOTED
FACT: ROOT_ROOM_CITY_ANDROID_TESTS=56_67_129_21
FACT: PROMOTION_HISTORY=PASS_10
FACT: GLOBAL_THEME_APPLY=NO
FACT: THEME_LIFECYCLE=PROMOTED
FACT: PAPER_CLAIMS=PILOT
FACT: WINDOWS_ANDROID_BUILD_CASES=3_3
FACT: CANONICAL_DIGEST_MATCHES=3
FACT: RUNTIME_RESTART_REFUSALS=PASS

Hardening was frozen at main `393f3b89a9c4fae61be1e431c4bcd47fee945e88` under annotated tag `utopia-v0.3-hardening`, with main CI 36549170404 successful. It separates 500 invocation summaries / 50 details; City snapshots contain at most 50 summaries and no full results. The real 98-row migration and two restarts passed. Qualified identity, lifecycle-aware availability and Android typed errors remain covered by regression tests.

Road implementation `762d677` extracts the existing mapping into the pure `document-knowledge-v1` SDK, schema and validator. Six-format frozen digests remain unchanged; sparse-array validation was repaired before merge. Independent activation `bddf448` makes ingestion-core, document-readers, knowledge-core, skill-intake and evidence-engine ACTIVE. Wave3-A merged at `7e97a4b6402f5828a4928e8194051a5cf2634e19`; main CI 36551626680 succeeded.

| D9 gate | Evidence |
| --- | --- |
| Pinned donor / minimal closure | DS-Hns `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b`; seven new files and six reused City dependencies; [audit](../../docs/en/D9_DONOR_CLOSURE_AUDIT.md) |
| Parity / fallback / geometry / sandbox | 12 core + 3 frozen oracle tests in the City theme-engine; actual byte/pixel checks, final resize retry, protected surfaces and atomic output validation |
| Room product | Three durable browser cases at `28673e1`; [Room acceptance](D9_ROOM_ACCEPTANCE.md) |
| Accepted Room | `3ff7d805f0432d39499bee10741f54d3ec98f3de` |
| City promotion | `74c277cbc2a44fc045b8c81e8e401df3729fbf28` |
| Retirement | `b16df6335a9ee459a5792f99fbb838cbb2a2600a`; active incubator removed; ten real-ancestry records verified |
| Main integration | PR #7 → `c7281da185b21e330cd02bbae044702ed2c3e77c`; main CI 36555381764 succeeded |

Alien implementation `3da5ed2` adds a genuine build adapter and Windows/Android controls. Gateway owns output paths, retains the latest eight successful packages independently of invocation retention, and removes unfinished jobs on restart. Full results never enter `/city`; a bounded preview and digests are loaded on demand. The storage-failure regression ensures a terminal typed error rather than orphaned RUNNING state. Review reproduced and fixed package deletion after 500 unrelated invocations, then independently rechecked survival after restart.

Windows existing-capability pilot: 26 PASS; physical Android regression: 7 PASS including five canonical digest matches and reopening Windows theme/evidence history. Windows build pilot: three cases PASS with preview/package digest visible and detail restored after reload. Physical Android build: three matching cases PASS, using native controls; canonical result plus intent/plan/package/content/validation digests and verdict match Windows. Observed offline, unobserved offline and unobserved injected-failure cases all pass; the last reports seven procedural fallbacks. APK 0.3.2 SHA-256: `f3b2bcc6115e7cc0cefe1b12ad6c5454e001005bc2065db3497a27a40306e043`.

Live runtime refusal/restart pilot: output escape, protected external surface and malformed observation fail with explicit typed codes; no successful artifact is removed. Six successful packages and their detail/digests survive a real Gateway restart, and snapshots remain summary-only. Four new public-input screenshots were visually reviewed. [Raw manifest](../raw/wave3/manifest.json) binds the sanitized run records, retained failed attempt and screenshots. No desktop Computer Use was used; native actions came from adb UI-tree controls.

[Hosted implementation CI 36556676840](https://github.com/zhiheng-zhang-Mera/utopia/actions/runs/36556676840) succeeded. Final integration/freeze must record the actual merged SHA and successful main CI in the annotated `utopia-wave3` tag; this document does not invent a self-referential SHA.

Scope limits: generated/public inputs only; one Windows host and one physical Android 12 device. Desktop observation is a generated preset, not screen sensing. No real image provider, global Apply, registry/lifecycle/recovery ownership or official renderer integration. Theme remains PROMOTED pending ownership review; future unbridged modules remain BRIDGE_PENDING without blocking Mech or existing services. V0.4 and Boss/Hns runtime work are outside this workbook.
