# Construction-record consolidation, 2026-10-07

```text
purpose   The cloud carried 84 branches of construction history. Each of them recorded evidence, data
          records or paper material that exists nowhere else. This directory is the union of those
          records, placed on top of the VERIFIED program code so the construction branches can be
          retired without losing a single recorded artefact.
code      This branch is 185d043e11ae8516a1e7a492d09d031610be576b (4-in-1-REX+PCF+CHK+DGX) with ONLY
          record files added. Not one line under services/ apps/ contracts/ city/ agents/ scripts/
          tests/ was touched, which is what "the program body stays the verified 4-in-1 head" means.
```

## What was taken

129 paths existed on at least one origin branch and were absent from the verified head:

```text
evidence/        115
docs/             13
data-records/      1
```

They come from the City Work Monitor line (`MON-902/903/990`), the JOIN-590 line, HOST-START-MODES and
the REX-803 preflight. Every one was taken from the branch that carries it; nothing was renamed and
nothing was rewritten, so each file keeps the bytes it was recorded with.

## Divergence, kept rather than resolved

Four paths existed on more than one branch with DIFFERENT bytes. Picking one and discarding the other
would have made this a lossy "union", so the newest recording is at its original path and every other
version is preserved verbatim under
`evidence/raw/mission-book/_consolidation-divergence-2026-10-07/repair-MON-903-mech-honest-metrics-on-review-head/`:

| path | kept at its path (from) | also preserved (from) |
|---|---|---|
| `docs/en/CITY_WORK_MONITOR_DECISION_REVIEW.md` | `a22e8611…` (integration/MON-accepted-head-mech-preflight) | `eb8eb65b…` |
| `docs/zh-CN/CITY_WORK_MONITOR_DECISION_REVIEW.md` | `cc9e8b85…` (same) | `153eab8d…` |
| `evidence/raw/mission-book/MON-903/alien-review/decision-provenance.png` | `84559cce…` (same) | `ad612cf2…` |
| `evidence/raw/mission-book/MON-903/alien-review/runtime-capture.json` | `d10d8e71…` (same) | `b11869dc…` |

The full per-path provenance (which branch each file came from, and every divergent blob SHA) is in the
consolidation report that accompanied this work.

## What this is NOT

```text
· Not a review, an acceptance, or a merge. It changes no verdict and releases no marker.
· Not a claim that the retired branches were wrong: their records are preserved here, which is the
  opposite of discarding them.
· Not a second source of truth for the program. The code is exactly the verified head.
```
