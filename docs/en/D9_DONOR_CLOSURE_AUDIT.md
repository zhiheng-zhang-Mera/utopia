# D9 Theme Builder closure audit

Historical audit status: DONOR_COPIED / closure verified. Later Room acceptance and City promotion are recorded in [Theme Builder D9](THEME_BUILDER_D9.md); observations below describe the pinned donor before adaptation.

Source: `zhiheng-zhang-Mera/DS-Hns` at `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b`. The commit was verified through GitHub and the exact contents downloaded read-only. Local donor repositories were not changed. Original bytes remain in ignored runtime storage; no donor runtime was launched.

| New source, under app/extensions/mega/theme/ | Git blob |
| --- | --- |
| builder.js | b1e9a5fad7fc5f73a282486d8fc0deb12db5ca71 |
| designer.js | 15f87f97845d9dea8a549d0135fa21aa5461a33f |
| assets/planner.js | 1d57be88d4db84cd79c54e7fc10a93da0086d210 |
| assets/generator.js | 00a41484ec760d51484f6bce99d6ff123d02975d |
| assets/processor.js | dd3bc6dadf7792b96e9455f52df9b31749c2d588 |
| assets/validator.js | 33d7b4519be9fd91021d7aadf028eeb3c994fb1b |
| assets/fallback.js | 43be1339f49be91dacd5eaa6381d1b9cc6c4b8b6 |

The seven files require only each other, Node fs/path, and the already promoted contract, surface, package validator, asset factory, PNG and colour modules. The latter six originals were also read for oracle comparison; they must be reused from City, not promoted twice. Their closure adds only Node zlib. No resolver, runtime, registry, lifecycle, recovery, model adapter, official integration or built-in theme is needed.

## Observed gaps requiring explicit adaptation

- Designer calls its local entry point `interpret`, not `intent`; the pinned export has no `interpretWithModel`. Its semantic decisions are deterministic, but `interpreted_at` uses wall time. The Utopia API needs deterministic metadata and an `intent` entry point. Real model integration remains DEFERRED.
- Planner records observation and safe regions, but character sizing can exceed small viewports and does not subtract critical regions. Utopia must test and enforce actual placement bounds; mere observation presence is not enough.
- Generator retries header-invalid or undecodable model images, but a decoded image that fails final pixel validation is disabled directly. The required chain must also retry/fall back after pixel rejection. Retry/time limits and decoded-image dimensions need bounds.
- Pixel validator measures alpha, colours and dimensions, but per-asset byte excess is only a soft warning and bundle validation has no total package ceiling. Utopia must explicitly enforce the requested ceilings.
- Builder deletes the supplied output tree and writes there directly. It does not perform the atomic promotion described in its introductory comment. Preserve compilation semantics while replacing this write boundary with a new, confined staging directory, validate before rename, refuse existing destination/path escape and clean only its own staging tree on failure.
- Builder embeds wall-clock metadata and can fill a disabled planned asset from its legacy bundle. Stable package digests and single-asset disable require explicit fixes, not a parity claim.
- Donor overlay defaults and limits must pass the already promoted Utopia validator; a package cannot raise its own safety ceilings to bypass validation.

## Behavior classification for implementation

| Behavior | Classification |
| --- | --- |
| Intent palette/style/density/persona decisions; pixel processing; procedural rendering | PARITY, pending port comparison |
| CommonJS to ESM; existing Utopia surface/slot/token names; dependency imports | PORT_ADAPTATION |
| Fixed metadata; caller sandbox and atomic output; no production install | PORT_ADAPTATION |
| Critical-region exclusion; retry after pixel rejection; hard budgets; honest single-asset disable | UTOPIA_EXTENSION with dedicated regression gates |
| Provider API, runtime apply, registry/lifecycle/recovery and external renderer integration | DEFERRED |

Four prompt/design/plan oracle vectors and three procedural pixel vectors were computed from the pinned source after closure inspection. These are audit preparation, **not port parity evidence**. No Room product, package acceptance, physical consumer or D9 promotion result is claimed. GLOBAL_THEME_APPLY=NO.

The merged fast-path scheduling document separately defers D9. The continued standing workbook authorization was followed on an isolated feature branch; the fast-path document was preserved. This audit is not an instruction to change scheduling.
