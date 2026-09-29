# D9 Room acceptance

Status: ROOM_PRODUCT_ACCEPTED / PROMOTION_CANDIDATE. This is local incubation acceptance, not City promotion or Alien build acceptance.

Implementation: `28673e158594a1cc2df07f6ea8225cbae2e150c4`. Donor: DS-Hns `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b`, seven files, reusing the six existing City dependencies. The accepted Room commit is recorded subsequently in its promotion record; it is not a fabricated self-reference.

| Gate | Observed result |
| --- | --- |
| Core behavioral tests | 12 PASS: deterministic intent, bounded/critical geometry, no-observation degradation, pixels, retry/timeout/fallback/disable, output confinement, atomic cleanup and stable package digest |
| Frozen donor oracle | 3 PASS: four intent/token/slot vectors, four asset/surface vectors, three exact PNG SHA-256/alpha/bounds comparisons |
| Actual browser regression | PASS: prompt → intent → observed plan → build → visible preview; no-observation + injected failure → truthful fallback report |
| Durable browser pilot | 3 PASS at implementation SHA: intent, observed offline package, unobserved injected-failure package |
| Complete Room regression | 83 PASS |
| Existing product / City baseline | root 52 PASS; unchanged City 114 PASS |
| Independent review | Three P2 findings reproduced and fixed; focused recheck found no remaining material issue in fixes |

The review regressions cover disabled avatar references, supplied-token resurrection, malformed/outside observation, and final-downscale rejection inside retry/fallback. A failed optional asset stays disabled while other assets can compile. The builder validates materialized files inside its own staging directory, removes failed staging output and never overwrites an existing destination.

Raw pilot and public-fixture screenshots are in `evidence/raw/wave3/room-*`; `manifest.json` binds bytes. Both observed and unobserved screens were visually inspected. All prompts are generated/public, no live Gateway or phone data is included. No real image provider was called. The preview is a built package preview, not an installed theme.

Classification: donor semantic decisions/rendering are PARITY; ESM/names/deterministic metadata/caller sandbox are PORT_ADAPTATION; critical-region exclusion, hard budgets and strengthened fallback/disable are UTOPIA_EXTENSION. Model API, runtime installation and external renderer integration remain DEFERRED. GLOBAL_THEME_APPLY=NO. Research claim strength remains PILOT.

Reproduce at the accepted Room commit: `node --test apps/rooms/tests/theme-builder-lab.test.mjs` and `node scripts/d9-room-pilot.mjs`. After promotion, the active Room is intentionally removed and focused tests live with the City module.
