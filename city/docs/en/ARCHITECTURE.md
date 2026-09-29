# UTOPIA · City — Implementation Layer Architecture

**Status:** in force
**Manifest:** [`city/CITY_IMPLEMENTATION_MANIFEST.json`](../CITY_IMPLEMENTATION_MANIFEST.json)
**Incubation entry point:** [`apps/rooms/docs/en/INCUBATION_POLICY.md`](../../apps/rooms/docs/en/INCUBATION_POLICY.md)

---

## 1. Two different things

```text
Digital-City repository = the map / planning / sync reference
Utopia/city/            = the actual city module implementation layer
```

`city/` registers only implementations that really exist. The manifest is not a
wish list: a module is only written as `ACTIVE` / `PROMOTED` once it was incubated
inside the Room Pack, accepted locally and formally promoted. `DEFERRED` work is
never written as `ACTIVE`.

---

## 2. Hierarchy and ownership

```text
City
  ↓
District
  ↓
Building
  ↓
Module / Capability
```

Each concept has a hard boundary:

| Concept | Meaning |
| --- | --- |
| Room (`apps/rooms/**`) | incubator / local product / user-facing experiment |
| Building (`city/<district>/<building>/`) | ownership + lifecycle + service boundary |
| Module (`city/<district>/<building>/<module>/`) | implementation unit inside a Building |

**A Room is not a Building.** A Module must never be promoted into its own
Building for cosmetic reasons.

---

## 3. Districts that actually exist

Only the districts currently needed are created; no empty 00–11 skeleton.

```text
city/
├── CITY_IMPLEMENTATION_MANIFEST.json
├── manifest.mjs
├── test-all.mjs
├── docs/{zh-CN,en}/ARCHITECTURE.md
├── 00-foundation/
│   └── 03-capability-fabric/
│       └── capability-fabric/
├── 02-engineering/
│   └── 02-worker-gateway/
│       └── skill-intake/
├── 06-research/
│   └── 01-research-institute/
│       └── evidence-engine/
├── 09-planning-knowledge/
│   ├── 01-knowledge-service/
│   │   └── knowledge-core/
│   └── 02-document-intake/
│       ├── ingestion-core/
│       └── document-readers/
└── 11-entertainment/
    └── 01-entertainment-centre/
        └── theme-engine/
```

### Wave 1 ownership table

| District | Building | Module | Donor source |
| --- | --- | --- | --- |
| `00-foundation` City Foundation | `03-capability-fabric` Capability Fabric | `capability-fabric` | DS-Hns `app/core/{capability-registry,plugin-manager,health-supervisor,lockfile,contracts/capability}.cjs` + Codex-Boss `src/shared/{provider-contracts,provider-outcome,provider-state,capability-router}.ts` |
| `02-engineering` Engineering Works | `02-worker-gateway` Worker Gateway | `skill-intake` | DS-Hns `app/extensions/mega/skills/*` |
| `06-research` Research | `01-research-institute` Research Institute | `evidence-engine` | Codex-Boss `electron/evidence-engine.ts` |
| `09-planning-knowledge` Planning & Knowledge | `01-knowledge-service` Knowledge Service | `knowledge-core` | Codex-Boss `src/shared/knowledge.ts` |
| `09-planning-knowledge` Planning & Knowledge | `02-document-intake` Document Intake | `ingestion-core` | Codex-Boss `electron/ingestion/*` |
| `09-planning-knowledge` Planning & Knowledge | `02-document-intake` Document Intake | `document-readers` | Codex-Boss `electron/ingestion/{docx,xlsx,pdf}-reader.ts` |
| `11-entertainment` Entertainment | `01-entertainment-centre` Entertainment Centre | `theme-engine` | DS-Hns `app/extensions/mega/theme/*` |

---

## 4. Module lifecycle

```text
PLANNED      ownership registered, code not migrated yet
INCUBATING   being proved inside the Room Pack
PROMOTED     promoted from its incubator room, code lives in this tree
ACTIVE       formally in service
DEPRECATED   kept but no longer developed
```

Manifest validation (`city/manifest.mjs`) enforces (schema v2):

- `schemaVersion` must be `2`;
- `district.id` looks like `02-engineering` and `module.path` equals `city/<district>/<building>/<module>`;
- every module declares one of the lifecycles above;
- an implemented module (`PROMOTED` / `ACTIVE` / `DEPRECATED`) must declare `incubationRooms` with at least one non-empty, unique entry;
- **the same incubation room may not be claimed by two modules**;
- an implemented module's directory must exist, while a `PLANNED` / `INCUBATING` module's directory must **not** exist yet;
- a `donor`, when present, must carry a `repository` and a valid git SHA.

### Why a list and not a single value

From wave 2 on, one city module can be strengthened by several incubations, for example:

```json
"incubationRooms": ["skill-intake-lab", "skill-discovery-lab"]
```

Each incubator still keeps its own `apps/rooms/promotions/<room>.json` record, and wave 1 records are never overwritten. The single `roomId` field is retired (the validator can still read it for compatibility, but new writes must use the list).

`city/tests/manifest.test.mjs` runs these checks for real.

---

## 5. Required target structure

- **Do not** modify `apps/web/**`, `apps/android/**`, `services/dev-gateway/**`, `agents/reference-node/**`, `contracts/**`, `platform/**`;
- **Do not** change City Control Protocol, Gateway API v0, runtime node task semantics or the Android protocol contract;
- every module carries its own focused tests;
- one shared test entry point: `node city/test-all.mjs` (plain Node discovery, avoiding Windows glob differences, with no new test framework);
- no premature City Language Service, permission framework, event bus or plugin system.

---

## 6. How the Room Pack relates to city

```text
IDEA / DONOR
    ↓
Room Pack incubator room      (apps/rooms/rooms/<lab>/)
    ↓
local product acceptance      (focused tests + browser core action + single host)
    ↓
promotion decision
    ↓
city/<district>/<building>/<module>
```

After promotion:

```text
apps/rooms/rooms/<lab>/        removed from the final tree
apps/rooms/promotions/<id>.json kept as the record
Git history + bilingual docs   kept for traceability
```

**Room and City must never drift apart as two live implementations.**
