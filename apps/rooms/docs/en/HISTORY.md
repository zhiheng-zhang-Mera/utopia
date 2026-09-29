# Room Pack Promotion History

This file records how each donor room moved from incubation into `city/`. The
machine-readable record lives in `../promotions/<room-id>.json`; the full code
stays in Git history.

**The two SHAs have fixed definitions and must never be confused:**

```text
acceptedRoomCommit = the last accepted commit of the incubator room
promotedAtCommit   = the first commit where the formal city module landed
                     (reachable, and checkable as <sha>:<path>)
```

Both must really exist in Git history, and `acceptedRoomCommit` must be an
ancestor of `promotedAtCommit`. Verifier: `node scripts/verify-promotion-history.mjs`.

## Overview

| Room | acceptedRoomCommit | promotedAtCommit | Target city path |
| --- | --- | --- | --- |
| `skill-intake-lab` (D1) | `1ba5b4809f05a155ed76fecdbb9479f900686fa1` | `140287250ef1440441df4eaf0dfefc14528eeee4` | `city/02-engineering/02-worker-gateway/skill-intake` |
| `theme-engine-lab` (D2) | `9819ed7a4a212b8c8480d91c3812ce7f7a760ab9` | `a18b1e80b7405137ac3c56ef1bc1805677b6a93f` | `city/11-entertainment/01-entertainment-centre/theme-engine` |
| `knowledge-core-lab` (D3) | `01f932bd2aad2403bec61961410ca19ca0cf28ad` | `b82fcfd0f153a63b8424051affd86bf7df0a41d0` | `city/09-planning-knowledge/01-knowledge-service/knowledge-core` |
| `document-intake-lab` (D4) | `165e2664ad4e2d777889d8dec47893144e8c81dd` | `e3d6bbd9dd9196ce0991e095fb91993df3ec3dd1` | `city/09-planning-knowledge/02-document-intake/ingestion-core` |
| `skill-discovery-lab` (D5) | `b4dff81503128ae0d2ad163732171eb6dd887f4b` | `48494263d75532eaaba3490bc6c4223d5ff44ead` | `city/02-engineering/02-worker-gateway/skill-intake` |
| `theme-package-lab` (D6) | `95d958ddacc6071fc6c2b0ee4c2be8b132c9dd4d` | `5d1abecdc38ace5f5cf02aafbf097026d3427eec` | `city/11-entertainment/01-entertainment-centre/theme-engine` |
| `yaml-intake-lab` (D7a) | `b6d7733c927288c8c1246d097d509cc9caeb5fa4` | `e068d58ee890f17e1b87efb9f5d5af461d2a784b` | `city/09-planning-knowledge/02-document-intake/ingestion-core` |
| `document-readers-lab` (D7b) | `e9a4c2370544028749c5cd0c2d492389ee53d7b5` | `6a95bf4502f1e07a8036e319146e608f2a8db943` | `city/09-planning-knowledge/02-document-intake/document-readers` |
| `evidence-engine-lab` (D8) | `ec4202f774a996a1c1a7f867fac9f529abd43b00` | `e1dcfd73e9b35b44ad15112c2fc66aad41b1e099` | `city/06-research/01-research-institute/evidence-engine` |

> **D1 note:** the commit that first wrote
> `city/02-engineering/02-worker-gateway/skill-intake` was rewritten during a
> Wave 1 history cleanup and is no longer reachable, so this record points at
> `1402872`, the first *reachable* commit that contains the module. The value
> pre-filled during Wave 1 (shaped like `6b29e84…`) was the pre-amend SHA and is
> void.
>
> **Never pre-guess a commit's own SHA.** A record is only filled in after the
> target commit exists, and it is checked against local Git history by
> `scripts/verify-promotion-history.mjs`.

---

## D8 · evidence-engine-lab → city/06-research/01-research-institute/evidence-engine

| Item | Value |
| --- | --- |
| Donor repository | `zhiheng-zhang-Mera/Codex-Boss` |
| Donor SHA | `8df428eaa437a409368401e95194e40266b83080` |
| Donor source file | `electron/evidence-engine.ts` (reference types only: `src/shared/contracts.ts`, `src/shared/provider-contracts.ts`) |
| Incubator room | `apps/rooms/rooms/evidence-engine-lab/` (removed from the live tree) |
| Accepted incubator commit | `ec4202f774a996a1c1a7f867fac9f529abd43b00` |
| Promotion commit | `e1dcfd73e9b35b44ad15112c2fc66aad41b1e099` |
| Final city path | `city/06-research/01-research-institute/evidence-engine` |
| Lifecycle | `PROMOTED` (during wave 2) |
| New district | yes: `06-research` is the city's first Research ownership, opened by this promotion |

### Adaptation

- the donor's runtime types (`BossTask`, `ClaimRecord`, `CouncilSession`,
  `DisputeRecord`, `EvidenceBundle`, `RawArtifact`) are replaced by plain shapes in
  `contracts.mjs` (EvidenceTask, EvidenceArtifact, EvidenceClaim, EvidenceDispute,
  EvidenceBundle), so a decision needs no task runtime, no provider automation, no
  council process and no root trust;
- every non-deterministic input is injectable (`idFactory`, `now`, `hash`), so the
  same artifacts always produce the same manifest, the same integrityRoot and the same
  bundle;
- a resolved dispute no longer marks a claim DISPUTED. The donor had no resolution
  concept at all, and carrying a flag that changed nothing would be worse than either;
  an unresolved dispute still marks the claim and still blocks a PASS;
- a `reasons` list and `describeBundle()` make the decision explainable without
  re-deriving it from the claims;
- `buildRehydrationPrompts()` keeps the donor's prompt shape. It builds text and
  contacts nobody.

### Known differences

- no task runtime, provider automation, council runtime, research conductor or root
  trust, as the workbook requires;
- no persistence and no network: the module is pure, and the incubator surface kept
  its sample in the page;
- no claim verification against the outside world: `REFERENCED_NOT_VERIFIED` means the
  declared evidence labels resolve, not that the claim is true.

### Parity tests

Coverage: artifact SHA-256 over UTF-8 content; a stored hash that no longer matches
raising `ARTIFACT_HASH_MISMATCH` instead of re-hashing; the sorted manifest with
provider, kind, hash, bytes and capture time; the integrityRoot as the SHA-256 of the
sorted `id:hash` lines and its order-independence; artifacts of another task being
excluded; the structured `{"claims"` block being read and a missing/unparsable block
yielding no claims; `Proposal A/B/C` label mapping in artifact-id order; the four claim
statuses with DISPUTED beating a resolved reference and a missing label being
INSUFFICIENT; an unstructured synthesis becoming one INSUFFICIENT claim; unsynthesised
proposals/responses becoming UNVERIFIED claims that are never treated as evidence; the
PASS rule (no missing provider, no unresolved dispute, no blocking claim) and the fact
that task completion is never evidence; rehydration quoting only the unresolved claims;
determinism with injected ids and clock; and the module carrying no Boss runtime
dependency.

---

## D7b · document-readers-lab → city/09-planning-knowledge/02-document-intake/document-readers

| Item | Value |
| --- | --- |
| Donor repository | `zhiheng-zhang-Mera/Codex-Boss` |
| Donor SHA | `8df428eaa437a409368401e95194e40266b83080` |
| Donor source files | `electron/ingestion/docx-reader.ts`, `xlsx-reader.ts`, `pdf-reader.ts`, `tests/fixtures/workbook-fixtures.ts` |
| Incubator room | `apps/rooms/rooms/document-readers-lab/` (removed from the live tree) |
| Accepted incubator commit | `e9a4c2370544028749c5cd0c2d492389ee53d7b5` |
| Promotion commit | `6a95bf4502f1e07a8036e319146e608f2a8db943` |
| Final city path | `city/09-planning-knowledge/02-document-intake/document-readers` |
| Lifecycle | `PROMOTED` (during wave 2) |
| New module | yes: the readers are their own module in the same building, so the ingestion core keeps owning text and structured intake |
| Engines | fflate 0.8.3, mammoth 1.12.2, pdfjs-dist 6.3.289 (the pdfjs legacy build), all quarantined in the module's `engines.mjs` |

### Adaptation

- the three engines are named only in `engines.mjs`, are loaded lazily, and are
  reached by every consumer through that one seam; a missing install is
  `ENGINE_UNAVAILABLE` (an installation problem), which is a different answer from a
  broken document;
- XLSX: the donor's static fflate import became `await loadFflate()`, so
  `readArchiveEntries` is async; the byte-level guards run before the engine load, so
  wrong input fails closed without depending on engine availability; the donor's
  `decodeUtf8` maps to the ingestion core's `decodeText`, whose encoding warnings are
  forwarded rather than dropped;
- DOCX: the donor's converter seams are kept exactly, so the heading/list mapping and
  the paragraph budgets are provable with the engine and without it;
- PDF: the seam loads the legacy build (no worker, no DOM), and nothing had to be
  dropped from the donor's `getDocument` options;
- the donor's test-only fixture logic became product code in `samples.mjs`: a real
  OOXML package and a real PDF are assembled in memory, so neither the tests nor a
  product surface need a committed binary fixture;
- error codes are namespaced per reader, so a caller branches on a code instead of
  parsing a message.

### Known differences

- nothing is persisted: the readers take bytes and return sections, and the module
  never writes a file;
- `ENCRYPTED_*` codes are preserved from the donor but no engine path raises them
  here (fflate 0.8.x ignores the ZIP encryption flag, and there is no password
  handling to exercise);
- no OCR and no page rendering: PDF extraction is text only;
- the DOCX adapter emits paragraphs, not a full OOXML document model.

### Parity tests

Coverage: XLSX shared strings, sheet name/part, used range and markdown-table output;
a formula with no cached value warning and never being computed; archive byte, entry,
per-entry, total-size, sheet, row and column limits failing closed; DOCX paragraph
splitting, heading levels (including Chinese headings) and list mapping, its paragraph
and character budgets, both injectable converter seams and the real engine; PDF %PDF
preflight, per-page text and document info, its byte/page/character limits, and a
truncated document failing closed; determinism for identical bytes in all three; and
the quarantine (each reader imports only the engine seam, the ingestion core and
`node:` builtins).

---

## D7a · yaml-intake-lab → city/09-planning-knowledge/02-document-intake/ingestion-core

| Item | Value |
| --- | --- |
| Donor repository | `zhiheng-zhang-Mera/Codex-Boss` |
| Donor SHA | `8df428eaa437a409368401e95194e40266b83080` |
| Donor source file | `electron/ingestion/text-parsers.ts` (the YAML branch of `parseStructuredText`) |
| Incubator room | `apps/rooms/rooms/yaml-intake-lab/` (removed from the live tree) |
| Accepted incubator commit | `b6d7733c927288c8c1246d097d509cc9caeb5fa4` |
| Promotion commit | `e068d58ee890f17e1b87efb9f5d5af461d2a784b` |
| Final city path | `city/09-planning-knowledge/02-document-intake/ingestion-core` |
| Lifecycle | `PROMOTED` (during wave 2) |
| Shared module | yes: D4 already promoted the encoding, section-splitting, structured and XML cores into the same module, so it now records `incubationRooms: ["document-intake-lab", "yaml-intake-lab"]` |
| City dependency layer | `city/package.json` + `city/pnpm-lock.yaml` (yaml 2.9.0, fflate 0.8.3, mammoth 1.12.2, pdfjs-dist 6.3.289), installed by the hosted job before the city tests |

### Adaptation

- the donor's order is completed, not reinterpreted: a `.yaml`/`.yml` document is
  parsed as YAML first and only; any other extension tries JSON, then JSON Lines,
  then YAML, and the fallback is reported as
  `JSON parsing failed (...); parsed as YAML`;
- the external `yaml` package is quarantined in one file inside this building
  (`yaml-parser.mjs`): it imports the package lazily, applies the donor's
  `maxAliasCount: 100` and a 4 MiB document bound, and separates `YAML_INVALID`
  (the document is bad) from `YAML_PARSER_UNAVAILABLE` (the install is incomplete);
- `parseStructuredText()` is asynchronous, because the YAML branch lazily loads its
  parser; the new `ingestStructured()` returns parse outcome, sections, rendering and
  stats as one reportable object so a product surface never re-implements the order;
- `detectFormat()` no longer marks yaml/yml as deferred: it is a real format now;
- a refusal carries the parser's own reason, line and column.

### Known differences

- no persistence and no knowledge write: the module is pure;
- a multi-document YAML stream is refused with the parser's reason rather than being
  silently truncated to its first document;
- no Excel/PDF/DOCX readers here: those are D7b and land in their own module in the
  same building.

### Parity tests

Coverage: the extension rule (`.yaml`/`.yml` is YAML first and only, and a YAML file
that is also valid JSON is still reported as YAML), JSON and JSON Lines keeping their
formats, the non-YAML fallback warning text, nested maps and sequences, scalars and
dates, fail-closed refusals for malformed input, an empty document, a multi-document
stream and an alias bomb, the parser's line/column detail, deterministic rendering and
sections with offsets, the section cap and the byte bound, and the quarantine itself
(the core reaches the seam and never the package).

---

## D6 · theme-package-lab → city/11-entertainment/01-entertainment-centre/theme-engine

| Item | Value |
| --- | --- |
| Donor repository | `zhiheng-zhang-Mera/DS-Hns` |
| Donor SHA | `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b` |
| Donor source files | `app/extensions/mega/theme/contract.js`, `surface.js`, `validator.js`, `asset-factory.js` |
| Incubator room | `apps/rooms/rooms/theme-package-lab/` (removed from the live tree) |
| Accepted incubator commit | `95d958ddacc6071fc6c2b0ee4c2be8b132c9dd4d` |
| Promotion commit | `5d1abecdc38ace5f5cf02aafbf097026d3427eec` |
| Final city path | `city/11-entertainment/01-entertainment-centre/theme-engine` |
| Lifecycle | `PROMOTED` (during wave 2) |
| Shared module | yes: D2 already promoted the colour and raster helpers into the same module, so it now records `incubationRooms: ["theme-engine-lab", "theme-package-lab"]` |
| D6a scope | the Theme Package API version, the slot vocabulary with per-slot permission, the token schema, the worker-state vocabulary, the four ownership surfaces with the single write gate, the package validator and the deterministic procedural asset factory |
| D6b status | `DEFERRED_SCOPE_ALLOCATION` |

### Adaptation

- CommonJS → ESM with the algorithms unchanged;
- the donor's permanent product nouns are not Utopia's public API: `hns_native` →
  `owned_surface`, `official_shell` → `external_shell`, `official_overlay` →
  `owned_overlay`, `official_renderer` → `protected_external_surface`; slot families
  `hns.*` / `official.*` → `surface.*` / `shell.*` / `overlay.*` / `external.*`; CSS
  custom properties `--hns-*` → `--utopia-*`;
- the validator gained `validateDocuments()`, so the same checks run over in-memory
  documents and over a materialized package directory from one implementation. The
  incubator room validates without writing a file, which is why it can be a real
  product surface without a durable store;
- the overlay strength ceilings moved into the validator: a package's declared
  overlay plan is checked against the engineering limits, not only against the
  builder's own downgrade ladder;
- the colour and raster helpers stay in the already-promoted `color/` and `raster/`
  directories, so no algorithm is duplicated.

### Known differences

- Nothing is applied to any UI: the module produces and validates packages;
- no registry, lifecycle or recovery: the donor's orchestration layer is out of scope;
- no builder and no designer: the D6b closure (`builder.js`, `designer.js` and the
  `assets/` planner, generator, processor, validator and fallback modules) is not
  carried in this wave;
- no image model: procedural generation is deterministic and offline.

### D6b deferral

The D6b donor closure was inspected before deciding, and it is clean: `builder.js`,
`designer.js` and the five `assets/*` modules require only `node:fs`, `node:path` and
this module's own files, so there is no Electron, no foreign runtime, no session
dependency and no mandatory network, and every write is confined to a caller-supplied
`outDir`. It is therefore **not** deferred as `DEFERRED_RUNTIME_COUPLING`. It is
deferred as `DEFERRED_SCOPE_ALLOCATION`: the wave's non-deferrable items (D7a YAML,
D7b document readers, D8 evidence core) land first, and no partial builder is shipped,
so nothing here pretends to be complete. The closure list is recorded above so the
next wave starts from evidence rather than from a re-investigation.

### Parity tests

Coverage: the four surfaces with their permissions and input/access contracts; the
write gate refusing the protected surface and refusing an asset kind a surface does
not accept; a plan naming the protected surface honestly versus claiming to write it
(including a nested target reference); the slot whitelist (unknown slot, structural
slot, undeclared property); the token schema (unknown token, invalid colour, length
and number, empty asset values); manifest required fields, slug id, forbidden
parent/extends fields, supported apps and API-version compatibility; declarative-only
packages (an executable file anywhere is refused); asset confinement (declared assets
exist inside the package and may not leave it); readability and worker-state
separability failing closed; overlay per-layer and stacked opacity ceilings with
input passing through; procedural determinism (identical bytes for the same palette,
style and seed, different bytes for a different palette or style); and character
assets keeping real alpha instead of painting a rectangle.

---

## D5 · skill-discovery-lab → city/02-engineering/02-worker-gateway/skill-intake

| Item | Value |
| --- | --- |
| Donor repository | `zhiheng-zhang-Mera/DS-Hns` |
| Donor SHA | `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b` |
| Donor source files | `app/extensions/mega/skills/skill-source.js`, `app/extensions/mega/skills/skill-catalog.js` |
| Incubator room | `apps/rooms/rooms/skill-discovery-lab/` (removed from the live tree) |
| Accepted incubator commit | `b4dff81503128ae0d2ad163732171eb6dd887f4b` |
| Promotion commit | `48494263d75532eaaba3490bc6c4223d5ff44ead` |
| Final city path | `city/02-engineering/02-worker-gateway/skill-intake` |
| Lifecycle | `PROMOTED` (during wave 2) |
| Shared module | yes: D1 already promoted the format and archive core into the same module, so it now records `incubationRooms: ["skill-intake-lab", "skill-discovery-lab"]` |

### Adaptation

- CommonJS → ESM with the algorithms unchanged: the reference parser, the candidate
  ordering, the archive URL planner and the tiered scanner behave as the donor does;
- filesystem access goes through an injectable read adapter (`isDirectory` / `isFile` /
  `list`), so the same scan runs over the real disk and over an in-memory tree in tests;
- the SKILL.md parser is this module's own `format.mjs`, never a second copy;
- GitHub resolution stays a plan: `resolutionPlan()` returns the archive URL forms,
  ref splits and subpaths as data, and the module has no fetch, request or download
  entry point at all;
- the catalog's live GitHub code search takes an injectable `fetchJson`; with none
  configured it answers `unavailable` and the curated and bundled entries stand;
- `describeRef()` moved out of the incubator's room wiring into `source.mjs`, because
  it only describes a parsed reference.

### Known differences

- No install: the module validates, inspects and discovers, and never writes a skill
  to disk;
- no download: `resolutionPlan()` describes attempts a caller could make; performing
  one is out of scope for this module;
- the donor's `skill-service.js` is not carried, so nothing here installs, updates or
  removes a skill;
- `readEntries` still filters unsafe archive paths out of the entry list (donor
  behaviour) instead of surfacing them as refused entries.

### Parity tests

Coverage: every reference form (owner/repo, `@ref`, subpath, `/tree/`, `/blob/`, raw
and plain URLs), traversal refusal and subpath normalisation, the longest-ref-first
candidate order, archive URL order and de-duplication, the resolution plan for
repository/tree/raw references, the tiered scanner order (subpath, own bundle,
`skills/` collection, sibling bundles, then flat files), scaffolding never being
offered, the scanner over an in-memory tree as well as the fixtures, the parser
refusing an unparseable flat file, catalog ranking (a name hit outranks a summary
hit; tags filter with AND), and a failed or unconfigured live search never removing
the offline answer.

---

## D4 · document-intake-lab → city/09-planning-knowledge/02-document-intake/ingestion-core

| Item | Value |
| --- | --- |
| Donor repository | `zhiheng-zhang-Mera/Codex-Boss` |
| Donor SHA | `8df428eaa437a409368401e95194e40266b83080` |
| Donor source files | `electron/ingestion/xml-text.ts`, `electron/ingestion/text-parsers.ts` |
| Incubator room | `apps/rooms/rooms/document-intake-lab/` (removed from the live tree) |
| Accepted incubator commit | `165e2664ad4e2d777889d8dec47893144e8c81dd` |
| Promotion commit | `e3d6bbd9dd9196ce0991e095fb91993df3ec3dd1` |
| Final city path | `city/09-planning-knowledge/02-document-intake/ingestion-core` |
| Lifecycle | `PROMOTED` (during wave 1) |
| D4a scope | UTF-8/UTF-16 decoding, TXT/Markdown, JSON/JSON Lines, CSV/TSV, XML text, section splitting and input limits |
| D4b deferred | YAML/yml: the donor's YAML branch needs the external `yaml` package, which must first be isolated inside this building |

### Adaptation

- TypeScript → ESM JavaScript with the algorithms unchanged;
- the donor's GBK fallback becomes an explicit warning: the runtime's `TextDecoder` does not always ship the GBK table, and a silent guess is never acceptable;
- the YAML branch is not carried; `detectFormat()` marks yaml/yml as explicitly deferred instead of letting them fall through to a wrong parser;
- the parser guards (`maxSections` / `maxBytes` / `maxContentLength` / `maxCsvRows`) match the donor defaults and can be overridden per request;
- `docx-reader.ts` / `xlsx-reader.ts` / `pdf-reader.ts` are untouched and belong to later waves in the same building.

### Known differences

- No persistence and no knowledge write: the module is pure and the incubator processed documents in the page only;
- no OCR, no PDF text extraction, no spreadsheet workbook model;
- the module emits offset-carrying sections and does not include the donor's downstream identity/hashing/redaction pipeline.

### Parity tests

Coverage: UTF-8/UTF-16 BOMs and strict UTF-8 validation with a warned lossy fallback, markdown splitting (ATX/setext headings, bullets, numbered items, fenced code, key/value lines), Chinese numbered headings in plain text, JSON parsing and JSON Lines detection, empty/corrupt input refusal, the YAML deferral message, structured flattening and deterministic rendering, CSV quoting/escaping/embedded newlines/CRLF/row cap/unterminated-quote warning, delimiter detection, grouping by the first column with a column cap, XML entities (named, decimal, hex, invalid left alone, decoded once), XML text-run extraction and block matching, and parser guards producing TOO_LARGE.

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
| Promotion commit | `b82fcfd0f153a63b8424051affd86bf7df0a41d0` |
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
| Promotion commit | `a18b1e80b7405137ac3c56ef1bc1805677b6a93f` |
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
| Promotion commit | `140287250ef1440441df4eaf0dfefc14528eeee4` |
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

## V0.3 consumption repair

Skill catalog metadata now uses resolvable/source and previewable, not installable/install. Search/parser algorithms are unchanged; no installer exists. Evidence Engine provenance now distinguishes PARITY, PORT_ADAPTATION and UTOPIA_EXTENSION. Resolved-dispute handling is an explicit adaptation; reasons/describeBundle are extensions. Historical commits remain unchanged.

## D9 — Theme Builder Lab

Accepted Room: `3ff7d805f0432d39499bee10741f54d3ec98f3de`. Promoted core: `74c277cbc2a44fc045b8c81e8e401df3729fbf28`. The seven-file pinned DS-Hns closure became the third incubation source of the existing theme-engine. Room browser and 16 focused/parity gates passed; full Rooms 83 passed before retirement, City 129 passed after extraction. The active Room and its API factory are removed; source, UI and browser tests remain recoverable at the accepted commit. Promotion record, City tests and DONOR remain. Alien build consumption is a later product gate; GLOBAL_THEME_APPLY=NO.
