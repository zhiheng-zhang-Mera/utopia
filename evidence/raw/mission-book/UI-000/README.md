# UI-000 evidence — visual direction candidates

Bounded, non-sensitive evidence for the **UI-000 Owner style gate**. Owner only needs to pick
A / B / C (or say "none of them" with one sentence).

Full raw run (80 files, ~6 MB) lives in the git-ignored
`.runtime/evidence/mission-book/UI-000/` per `mission-book/PROCESS_DATA_POLICY.md` Layer 1.
This directory is the deliberately small published subset.

## What to look at

| File | What it shows |
|---|---|
| `candidate-a/1440x960-home.png` | **A · Halo / 随行** — Home (desktop) |
| `candidate-a/1440x960-ask.png` | A — Ask/Do |
| `candidate-a/1440x960-tools.png` | A — Tools |
| `candidate-a/414x896-tools.png` | A — narrow screen |
| `candidate-b/1440x960-home.png` | **B · Atlas / 工作台** — Home (desktop) |
| `candidate-b/1440x960-ask.png` | B — Ask/Do |
| `candidate-b/1440x960-tools.png` | B — Tools |
| `candidate-b/414x896-tools.png` | B — narrow screen |
| `candidate-c/1440x960-home.png` | **C · Prism / 剧场** — Home (desktop) |
| `candidate-c/1440x960-ask.png` | C — Ask/Do (addressable scene) |
| `candidate-c/1440x960-ask-spotlight.png` | C — Ask/Do as a full-bleed spotlight overlay |
| `candidate-c/1440x960-tools.png` | C — Tools |
| `candidate-c/414x896-tools.png` | C — narrow screen |
| `android-candidates/candidate-{a,b,c}-home.png` | Real Jetpack Compose Home screen per direction, captured on a booted `android-36` emulator (720×1600 @320dpi) |
| `rooms/{a,b,c}-knowledge.png` | The **real** Room Hub rendering the **real** Knowledge Room under each candidate theme |
| `rooms/none-knowledge.png` | The same Room today, for comparison (`#0c1016` + `#5ec8f2`) |
| `before/home.png`, `before/tools-rooms.png` | The shipping Web product today, for comparison |
| `parity-report.md` | Machine check that all three candidates express the same functional facts (396/396 probes) |
| `EVIDENCE_MANIFEST.json` | The commit this evidence describes, plus a sha256 per file; verified by `scripts/ui-000/evidence-check.mjs` |

## How it was produced

```powershell
node scripts/ui-000/serve.mjs 4330                     # candidate surface
node apps/rooms/hub/server.mjs                         # real Room Hub (loopback)
$env:CITY_TOKEN = (Get-Content .runtime/local-config.json | ConvertFrom-Json).token
node scripts/ui-000/screenshot.mjs                     # Web + Rooms + before/after
node scripts/ui-000/parity.mjs                         # 396 capability/action/demotion probes
node scripts/ui-000/review-probes.mjs                  # the review host's independent, stricter probe
node scripts/ui-000/android-screens.mjs                # Compose screens via emulator + adb
node scripts/ui-000/evidence-check.mjs                 # verify this evidence still describes HEAD
```

## Evidence integrity

This directory hit the same defect class three times: a pointer that stopped describing the artifact it
claimed to describe — a stale `HEAD_SHA` in the Development report, a parity report published at
285/285 while the real run was 390/390, and these screenshots plus README numbers predating the commit
that fixed the very defect the Review had flagged. Human eyeballing failed three times, so
`EVIDENCE_MANIFEST.json` records the commit this evidence describes and a sha256 per file, and
`node scripts/ui-000/evidence-check.mjs` fails with `EVIDENCE_POINTER_MISMATCH` once the branch head
moves past it. `--write` regenerates the manifest after a deliberate re-capture.

Note on the current capture: **only candidate B's rendered pixels changed** in the last re-capture.
The WCAG minimum-target fix was a no-op for A and C at these viewports (their line boxes already
exceeded 24px), so their PNGs are byte-identical rather than re-encoded. B changed visibly because it
also stopped rendering raw event types on its primary path — the exact point its Review flagged.

Two evidence captures were **not** produced the naive way, and the reason is recorded because it
is a real finding rather than a convenience:

1. **Android.** The candidate Activity is `exported="false"`, so `adb shell am start` is refused.
   Debug builds override the flag from `app/src/debug/AndroidManifest.xml`; the release manifest
   stays closed. Also, `am start` reuses an existing Activity instance, so a naive capture renders
   the splash screen three times (or the first direction three times); `android-screens.mjs` waits
   for the real `Displayed …` logcat line and forces a fresh instance per direction.
2. **Rooms.** `apps/rooms/.runtime-rooms/*.json` is untracked local state, so a fresh worktree shows
   an empty Room. The Knowledge Room seed was copied from the real local store before capture, so
   the screenshots show real content and a real empty state is still covered by the focus room.
