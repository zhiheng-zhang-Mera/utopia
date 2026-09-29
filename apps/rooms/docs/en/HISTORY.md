# Room Pack Promotion History

This file records how each donor room moved from incubation into `city/`. The
machine-readable record lives in `../promotions/<room-id>.json`; the full code
stays in Git history.

---

## D3 · knowledge-core-lab → city/09-planning-knowledge/01-knowledge-service/knowledge-core

| Item | Value |
| --- | --- |
| Donor repository | `zhiheng-zhang-Mera/Codex-Boss` |
| Donor SHA | `8df428eaa437a409368401e95194e40266b83080` |
| Donor source files | `src/shared/knowledge.ts` |
| Deliberately not copied | `electron/knowledge/knowledge-store.ts` (depends on the Boss commander durable-json layer) |
| Incubator room | `apps/rooms/rooms/knowledge-core-lab/` (removed from the live tree) |
| Accepted incubator commit | `01f932bd2aad2403bec61961410ca19ca0cf28ad` |
| Promotion record | `../promotions/knowledge-core-lab.json` (holds the full promotion commit) |
| Final city path | `city/09-planning-knowledge/01-knowledge-service/knowledge-core` |
| Lifecycle | `PROMOTED` (during wave 1) |

### City module layout

```text
knowledge-core/
├── index.mjs              public surface
├── contracts/             value shapes, required/optional fields, query fields
├── retrieval/knowledge-core.mjs   matching, budgeted retrieval, goal rerank, planRetrieval
├── taxonomy/              taxonomy derivation and the deterministic domain router
├── trust/                 trust order and trust floor
├── conflict/              supersession / conflict metadata
├── tests/                 city module focused suite (including parity)
└── DONOR.json             provenance and adaptation record
```

### Adaptation

- TypeScript → ESM JavaScript with the algorithms unchanged (trust ordering, all-tag matching, validity windows, character budget, tokeniser weights);
- `conflictReport()` and `planRetrieval()` were added;
- `entryMatches()` accepts an explicit `now` for deterministic tests;
- `knowledge-store.ts` was not copied at all, so the module has no storage, no durable-json dependency and no Boss runtime requirement;
- the module is split into contracts / retrieval / taxonomy / trust / conflict facades over one core implementation, so no algorithm is duplicated.

### Known differences

- No persistence: the module is pure and the incubator room kept catalogs in the page only;
- no embeddings, no vector store, no LLM summarisation;
- domain routing and reranking use only the deterministic tokeniser (the donor has no embeddings either).

### Parity tests

Coverage: trust ordering with unknown trust = 0, domain/shelf/all-tag filtering, the trust floor, expired and not-yet-valid exclusion, budget truncation and larger-budget behaviour, trust ordering with a recency tie-break, taxonomy derivation, the deterministic domain router (domain match then up to three shared tags; no match routes nowhere), relevance weights (title 3x / tags 2x / domain 2x / content 1x) and rerank order, supersession/conflict metadata including dangling pointers.

---

## D2 · theme-engine-lab → city/11-entertainment/01-entertainment-centre/theme-engine

| Item | Value |
| --- | --- |
| Donor repository | `zhiheng-zhang-Mera/DS-Hns` |
| Donor SHA | `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b` |
| Donor source files | `app/extensions/mega/theme/color.js`, `app/extensions/mega/theme/png.js` |
| Incubator room | `apps/rooms/rooms/theme-engine-lab/` (removed from the live tree) |
| Accepted incubator commit | `9819ed7a4a212b8c8480d91c3812ce7f7a760ab9` |
| Promotion commit | `d71b9946f249ed49eae6185791cdd9be4fd76e07` |
| Final city path | `city/11-entertainment/01-entertainment-centre/theme-engine` |
| Lifecycle | `PROMOTED` (during wave 1) |
| Promotion record | `../promotions/theme-engine-lab.json` |

### What was ported

| Donor file | City module file |
| --- | --- |
| `app/extensions/mega/theme/color.js` | `color/color.mjs` |
| `app/extensions/mega/theme/png.js` | `raster/png.mjs` |

### Adaptation

- CommonJS → ESM with named exports;
- `readability()` and the WCAG threshold constants were added so the contrast verdict lives in one place;
- `ramp()` was added: the deterministic lightness ramp moved from the room handler into the city core;
- `buildSwatch()` was added on top of the donor canvas helpers so a palette becomes an image deterministically;
- only `color.js` and `png.js` were copied: the donor theme directory's contract / builder / asset-factory / designer / orchestrator modules belong to later waves.

### Known differences

- No theme contract, validator, builder, asset factory or preview (wave 2);
- nothing is applied to the Alien Web UI; the module produces colours and images only;
- no theme registry, lifecycle or recovery orchestration.

### Parity tests

Coverage: hex / rgb() / rgba() / percentage grammar and rejection cases, channel clamping, hex round-trip, alpha compositing, HSL round-trip, WCAG contrast (21:1 extremes) and readability levels, shade / mix / distance / isLight / bestOn, PNG encode → independent decode round-trip for RGB and RGBA, PNG header reading and non-PNG rejection, swatch determinism, column layout and alpha preservation.

### After promotion

```text
apps/rooms/rooms/theme-engine-lab/     removed (Git history keeps it)
apps/rooms/tests/theme-engine.test.mjs removed (the parity suite travelled with the core)
apps/rooms/promotions/theme-engine-lab.json  kept
city/.../theme-engine/tests/           the module carries its own focused tests
```

---

## D1 · skill-intake-lab → city/02-engineering/02-worker-gateway/skill-intake

| Item | Value |
| --- | --- |
| Donor repository | `zhiheng-zhang-Mera/DS-Hns` |
| Donor SHA | `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b` |
| Donor source files | `app/extensions/mega/skills/skill-format.js`, `app/extensions/mega/skills/tar.js` |
| Incubator room | `apps/rooms/rooms/skill-intake-lab/` (removed from the live tree) |
| Accepted incubator commit | `1ba5b4809f05a155ed76fecdbb9479f900686fa1` |
| Promotion commit | `6b29e84430ba888b6bc1d5bcde344e16f23b64c2` |
| Final city path | `city/02-engineering/02-worker-gateway/skill-intake` |
| Lifecycle | `ACTIVE` |
| Promotion record | `../promotions/skill-intake-lab.json` |

### What was ported

| Donor file | City module file |
| --- | --- |
| `app/extensions/mega/skills/skill-format.js` | `format.mjs` |
| `app/extensions/mega/skills/tar.js` | `archive.mjs` |

### Adaptation

- CommonJS → ESM with named exports;
- `readSkillFile` / `scanSkillRoot` / `resolveInstalled` were dropped: the city core
  touches no disk and has no dependency on the HNS installation directory;
- `extractTar` was not carried over: this module only inspects archives in memory
  and never writes files, so there is no extraction path to get wrong;
- `readSkillFile`'s size guard moved into `parseSkillText`, so a pasted document is
  bounded by the same `MAX_SKILL_BYTES` rule;
- archive inspection reports accepted / refused entries instead of a written-files list.

### Known differences

- No skill installation in this wave: validation and inspection only;
- `readEntries` filters unsafe paths out of the entry list (donor behaviour) rather
  than surfacing them as refused entries;
- No GitHub download or source resolution (`skill-source.js`, `skill-service.js`
  belong to a later wave).

### Parity tests

The vectors come from the donor suite `tests/unit/skills-service.test.js` and cover:
name grammar, the frontmatter subset (whenToUse / metadata / every invocation
boolean spelling), malformed-frontmatter reasons, `renderSkillDocument` round-trip,
tar listing with `stripComponents`, traversal and absolute-path refusal,
symlink/hardlink/device refusal, byte and entry caps, transparent gzip and corrupt
checksum refusal.

### After promotion

```text
apps/rooms/rooms/skill-intake-lab/     removed (Git history keeps it)
apps/rooms/tests/skill-intake.test.mjs removed (the parity suite travelled with the core)
apps/rooms/promotions/skill-intake-lab.json  kept
city/.../skill-intake/tests/           the module carries its own focused tests
```
