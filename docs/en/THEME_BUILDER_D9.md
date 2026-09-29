# Theme Builder D9

D9 strengthens the existing `city/11-entertainment/01-entertainment-centre/theme-engine` after local Room acceptance at `3ff7d805f0432d39499bee10741f54d3ec98f3de`. It is the third incubation Room, following D2 and D6. The module remains PROMOTED with ownership review pending; D9 does not make it ACTIVE or apply themes globally.

```js
import fs from 'node:fs';
import path from 'node:path';
import {prepareDraft} from './city/11-entertainment/01-entertainment-centre/theme-engine/design/designer.mjs';
import {buildThemePackage, summarizeBuild} from './city/11-entertainment/01-entertainment-centre/theme-engine/build/builder.mjs';
const sandboxRoot = path.resolve('.runtime/theme-preview');
fs.mkdirSync(sandboxRoot, {recursive:true});
const draft = prepareDraft({prompt:'blue research compact no persona', observation:null});
const result = await buildThemePackage({draft, sandboxRoot, outDir:path.join(sandboxRoot,'new-package')});
console.log(summarizeBuild(result,draft));
```

The output destination must be new, absolute, below an existing real sandbox root, with an existing real parent. Existing outputs, escapes, linked roots/parents and invalid packages are refused. A private staging directory is validated before rename; failures clean only that staging directory. The caller controls retention of successful artifacts. No install, registry or global directory is selected by the builder.

`intent(prompt)` is deterministic and offline. `prepareDraft` derives tokens and plans, validates observation geometry and excludes critical rectangles from placed assets. With `observation:null`, plans explicitly report degraded conservative layout. With observation, supply finite `viewport:{width,height}`, optionally `safe_region:{x,y,width,height}` and `critical_regions:[...]`. An empty or unusable observation is refused.

The generator accepts an injected image function and bounded retry/timeout settings. It validates real bytes and final processed pixels, retries invalid output, falls back procedurally and disables only failed optional assets. No model/provider client is included. Disabled assets cannot return through supplied tokens, legacy assets or dangling persona/slot references. The caller may inject `draft.image_generator` for controlled tests; normal product generation is offline.

Assets have bounded dimensions/bytes; packages are capped at 24,000,000 materialized bytes. The final package contains declarative documents, real PNG assets and previews. `summarizeBuild` returns intent/plan/package/content/validation digests, validation verdict, fallback/degradation and a bounded PNG preview without filesystem paths. Same deterministic inputs produce the same package digest; injected nondeterministic image bytes naturally change it.

Tests: `node city/test-all.mjs theme-engine`. Incubator browser evidence is preserved in Git and [D9 Room acceptance](../../evidence/en/D9_ROOM_ACCEPTANCE.md). City `DONOR.json` records the seven-file source mapping and behavior classifications. Real model API, runtime application, registry/lifecycle/recovery and external renderer integration remain DEFERRED. GLOBAL_THEME_APPLY=NO.
