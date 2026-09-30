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

Three incubation identities are recognised, and they must never blur:

| Identity | Recorded as | What it means |
| --- | --- | --- |
| Room Pack incubator | `apps/rooms/promotions/<room>.json` | a live room under `apps/rooms/rooms/<room>/` was accepted locally, then promoted |
| mission-book migration incubator | a `mission` block on the module, a `DONOR.json`, plus `Digital-City/mission-book/reports/<MISSION_ID>/` | `Digital-City/mission-book` is a separate, Owner-defined control plane: it lands code directly under `city/` on a `mission/<MISSION_ID>-<slug>` branch, and a second, different host verifies it before merge |
| mission-book programme-task incubator | a `mission` block on the module, a `PROVENANCE.json`, plus `Digital-City/mission-book/reports/<TASK_ID>/` | the same control plane's asynchronous `BA-`/`RF-`/`GAI-`/`EM-` task pool; new Owner-defined construction with no donor, landed on a `<programme>/<TASK_ID>-<slug>` branch and verified by a different host |

A mission-derived incubator id has the form `mb-<task>-<module>-lab`.
`city/tests/manifest.test.mjs` refuses a module that claims one without a matching
`mission` block, and refuses a module whose manifest entry disagrees with its own
provenance file — `DONOR.json` for a migration, `PROVENANCE.json` for a programme task.
The identities may not be mixed inside one module: a mission-book task is not a Room Pack
promotion, and saying otherwise would make the room promotion records unverifiable. See §4
for why a programme task must record `donor: null` rather than a donor.

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
│   ├── 01-city-core/
│   │   ├── root-authority/
│   │   ├── task-lifecycle/
│   │   ├── fleet-routing/
│   │   └── audit-ledger/
│   ├── 02-city-node-network/
│   │   └── device-identity/
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

### MB-001 City Core table

Migrated by `Digital-City/mission-book` MB-001 from the frozen donor
`zhiheng-zhang-Mera/Codex-Boss @ 8df428eaa437a409368401e95194e40266b83080`. Each
module records its cluster, its donor files and every deliberate difference in its
own `DONOR.json`.

| District | Building | Module | Cluster | Donor source |
| --- | --- | --- | --- | --- |
| `00-foundation` City Foundation | `01-city-core` City Core | `root-authority` | A — root authority / root trust / protected surface | `src/shared/root-authority/{contracts,protected-surface}.ts`, `electron/root-authority/protected-surface-guard.ts` |
| `00-foundation` City Foundation | `01-city-core` City Core | `task-lifecycle` | B — task identity / lifecycle / durable state | `src/shared/candidate-gate.ts` §35 |
| `00-foundation` City Foundation | `01-city-core` City Core | `fleet-routing` | C — orchestration / routing / runtime coordination | `src/shared/{fleet,capability-router,node-capabilities,adaptive-routing}.ts` |
| `00-foundation` City Foundation | `01-city-core` City Core | `audit-ledger` | D — continuation / recovery / durable audit | `src/shared/decision-ledger.ts`, `src/shared/candidate-gate.ts` §36 |

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

A mission-incubated module adds three more enforced rules:

- every `incubationRooms` entry must use the mission form `mb-<task>-<module>-lab`,
  and a mission incubator may not be mixed with a Room Pack room inside one module;
- the module must carry a `mission` block naming the task and the cluster it covers;
- the manifest entry must agree with an on-disk provenance file on the module id, the
  city path, the incubator list, the task id and the cluster.

That third rule resolves differently for the two mission-book task forms, because they are
not the same kind of work:

| Mission-book task form | Example id | Provenance file | Donor |
| --- | --- | --- | --- |
| Migration mission | `MB-001` | `DONOR.json` | pinned repository + commit, and the manifest must agree on both |
| Programme task (`BA` / `RF` / `GAI` / `EM`) | `RF-001` | `PROVENANCE.json` | **none** — new Owner-defined construction, recorded as `donor: null` |

A programme task carries no donor because there is nothing to port. Writing a `DONOR.json`
for it would have to invent a commit, which is exactly the fabrication the migration rule
exists to prevent, so the manifest requires `donor: null` and a `PROVENANCE.json` that
states what the module is, which published City map building it occupies and which seams it
deliberately does not cross.

### Why a mission incubation is not a faked promotion

The Room Pack route proves a capability by running it as a live local product room
before it is promoted. A mission-book migration proves it differently: the donor code
is ported onto a `mission/<MISSION_ID>-<slug>` branch, and a second, different host
independently reviews it against the donor before the branch may reach `main`. The
mission reports live in `Digital-City/mission-book/reports/<MISSION_ID>/` and the
process record lives in Utopia's own evolution feed.

Recording a mission migration as a Room Pack promotion would have been simpler and
would have been a lie: no room ever ran. So the manifest names the mission identity
instead, and the test above refuses to let the two be confused.

---

## 5. Required target structure

- **Do not** modify `apps/web/**`, `apps/android/**`, `services/dev-gateway/**`, `agents/reference-node/**`, `contracts/**`, `platform/**`;
- **Do not** change City Control Protocol, Gateway API v0, runtime node task semantics or the Android protocol contract;
- every module carries its own focused tests;
- one shared test entry point: `node city/test-all.mjs` (plain Node discovery, avoiding Windows glob differences, with no new test framework);
- no premature City Language Service, permission framework, event bus or plugin system.

### The freeze, and mission-book consumption

The list above freezes the product surfaces for the *city construction waves* that
produced wave 1 and wave 2. It exists so a city module cannot quietly rewrite the
protocol Android and Web already depend on.

A mission-book migration has a different and later requirement. MB-001's Verification
gate demands that at least one existing Utopia task/control flow really consumes the
migrated Core boundary while Web and Android state truth stays consistent. A Core that
nothing consumes is not a migration, it is a library.

The two rules are reconciled as follows, and only as follows:

- **consumption may reach `services/**`** when the mission-book requires it, because
  the mission-book explicitly names the existing Utopia Services/Tasks consumption
  surfaces as legitimate consumers;
- **the protocol and semantics freeze stays absolute.** Consumption must be an
  equivalence-preserving rewiring: the City Control Protocol, Gateway API v0 request
  and response shapes, runtime node task state names, event names and payload shapes,
  and the Android protocol contract stay unchanged, and data persisted before the
  rewiring stays readable after it;
- **a behaviour change needs its own mission**, never a quiet edit folded into this
  one.

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

---

## 7. MB-006 Restart Recovery Station migration

`Digital-City/mission-book` is a second, Owner-defined control plane. It lands code
directly under `city/` on a `mission/<MISSION_ID>-<slug>` branch, and a **different** host
verifies it against the donor before the branch may reach `main`. That is a second
incubation identity beside the Room Pack, and the two must never be blurred: no Room ever
ran for these modules, so recording them as Room Pack promotions would be false provenance.

A mission-derived incubator id has the form `mb-<MISSION_ID>-<module>-lab` and must be
accompanied by a `mission` block on the module. `city/tests/manifest.test.mjs` refuses a
module that claims one without the other, and refuses a manifest entry that disagrees with
the module's own `DONOR.json`.

MB-006 (donor `dsh-restart @ e20fb6cc`) added a new building, `04-restart-recovery-station`:

| Module | Donor source | What it provides |
| --- | --- | --- |
| `restart-protocol` | `src/shared/{protocol,types}.ts`, `src/plugin/request-validator.ts` | the shared restart wire protocol and request admission: shape and policy validation order, refusal codes, request normalisation and fingerprinting |
| `restart-lock` | `src/plugin/restart-lock.ts` | the exclusive restart lock: declared transition edges, holder rules, bounded history, forced release |
| `checkpoint-gate` | `src/plugin/checkpoint-gate.ts` | the checkpoint seam and its bounded fail-closed gate |
| `restart-ticket` | `src/plugin/ticket-store.ts`, `src/plugin/atomic.ts` | the versioned checksummed ticket and its verification ladder |

The donor's structure is preserved: `restart-protocol` is the port of the donor's shared
contract layer, and the other three import from it exactly as `src/plugin/*.ts` imports
`src/shared/*.ts` there. A checksum-defining function or a state vocabulary must have one
home, not one per module.

### `capabilityProvider`

These four modules are restart infrastructure. They really exist in the city, but they
expose no user-facing capability, so they declare `"capabilityProvider": false` and the
capability registry skips them. Without that flag the Web and Android capability lists
would advertise them as "unavailable" capabilities awaiting a bridge — an assertion about a
product surface that does not exist.

### The freeze, and mission-book consumption

§5 freezes the product surfaces so a city module cannot quietly rewrite the protocol
Android and Web depend on. A mission-book migration has a different and later requirement:
MB-006 must be consumed by an existing task/control flow. The two are reconciled only as
follows: consumption may reach `services/**` when the mission-book requires it, and it must
be an equivalence-preserving rewiring. `services/dev-gateway/server.mjs` therefore decides
whether work interrupted by a restart may resume through the migrated `checkpoint-gate`,
with Utopia's policy supplied as data (a task that never started requires no checkpoint; a
task that had started has no bound checkpoint port, so the donor's fail-closed default
refuses it).

## 8. MB-003 Worker Gateway migration

`Digital-City/mission-book` is a second, Owner-defined control plane. It lands code
directly under `city/` on a `mission/<MISSION_ID>-<slug>` branch, and a **different** host
verifies it against the donor before the branch may reach `main`. That is a second
incubation identity beside the Room Pack, and the two must never be blurred: no Room ever
ran for these modules, so recording them as Room Pack promotions would be false provenance.

A mission-derived incubator id has the form `mb-<MISSION_ID>-<module>-lab` and must be
accompanied by a `mission` block on the module. `city/tests/manifest.test.mjs` refuses a
module that claims one without the other, and refuses a manifest entry that disagrees with
the module's own `DONOR.json`.

MB-003 (donors `Codex-Boss @ 8df428e` and `DS-Hns @ eeb57ca`) added three modules to the
existing `02-worker-gateway` building:

| Module | Donor source | What it provides |
| --- | --- | --- |
| `worker-task-contract` | DS-Hns `app/extensions/mega/scheduler/lifecycle.js` | canonical task-lifecycle vocabulary, persisted-status compatibility, terminal-event identity and idempotency, notification-safe summaries |
| `provider-adapter` | Codex-Boss `electron/runtimes/{runtime,unsupported-runtime,web/provider-runtime-adapter}.ts`, `src/shared/provider-state.ts` | the provider/runtime adapter contract, readiness, unsupported-capability refusal, provider lifecycle state |
| `provider-resilience` | Codex-Boss `electron/commander/circuit-breaker.ts`, `src/shared/provider-outcome.ts` | provider failure/interruption semantics, circuit-breaker health isolation, provider outcome codes |

### `capabilityProvider`

These three modules are adapter infrastructure. They really exist in the city, but they
expose no user-facing capability, so they declare `"capabilityProvider": false` and the
capability registry skips them. Without that flag the Web and Android capability lists
would advertise them as "unavailable" capabilities awaiting a bridge — an assertion about
a product surface that does not exist.

### The freeze, and mission-book consumption

§5 freezes the product surfaces so a city module cannot quietly rewrite the protocol
Android and Web depend on. A mission-book migration has a different and later requirement:
MB-003 must be consumed by an existing task/control flow. The two are reconciled only as
follows: consumption may reach `services/**` when the mission-book requires it, and it must
be an equivalence-preserving rewiring — the City Control Protocol, Gateway API v0 shapes,
runtime node task state names, event names, payload shapes and the Android contract stay
unchanged. `services/capability-bridge/bridge.mjs` therefore decides per-capability
degradation through the migrated `provider-resilience` breaker, with Utopia's policy (one
failure threshold, two provider-technical error codes) supplied as data.

## 9. RF-001 Device Identity — the first programme-task incubator

`Digital-City/mission-book` was later restructured from a single migration queue into four
asynchronous programmes — Butler Assistant (`BA-`), Remote Fabric (`RF-`), General AI
Gateway (`GAI-`) and Engineering Manager (`EM-`) — scheduled by
`CROSS_PROGRAMME_EXECUTION_CONTRACT.md`. Those tasks land code under `city/` exactly the way
the migration missions did, but they are **new construction**: there is no donor, so there is
nothing to pin and no `DONOR.json` to write. That is the third incubation identity described
in §4.

RF-001 added a new building, `00-foundation/02-city-node-network`, which the published City
map already reserved as *City Node Network — Device Node Fabric* with "node/device principal
identity below Owner/Root authority" in its declared ownership. It holds one module:

| Module | Provenance | What it provides |
| --- | --- | --- |
| `device-identity` | new construction (`PROVENANCE.json`, `donor: null`) | versioned `DeviceIdentity`/`device_id` and installation records, first-install enrollment, reinstall/rebind, key rotation, rename, retirement, cloned-credential detection and quarantine, and the non-authoritative MAC/metadata rule |

The module's incubation room is `mb-rf-001-device-identity-lab`, its lifecycle is
`PROMOTED` (code lives in this tree; the branch is not yet merged), and it declares no
capability: it is identity infrastructure, so it stays out of the capability registry the
same way `01-city-core` does.

### Why this is not a Room Pack promotion

No Room ever incubated `device-identity`. Naming a `device-identity-lab` Room Pack room
would have required an `apps/rooms/promotions/<room>.json` record for a room that never
ran, which is the false provenance §4 refuses. The programme-task form exists so the honest
statement — "a mission-book programme task landed this, and here is its
`PROVENANCE.json`" — is expressible.

### The freeze, and programme-task consumption

§5 freezes the product surfaces. RF-001 is a component task, so it wires no consumer: the
natural seam is `services/dev-gateway` node registration, which today stores
`{id, devicePrincipalId, displayName, metadata.platform, agentVersion, capabilities, online,
lastHeartbeatAt}` with `devicePrincipalId === id` and no key material, no separation of
logical device from installation and no clone detection. `migrateDeviceIdentity` accepts
exactly that row shape so the upgrade path is real and tested, but this branch changes no
runtime behaviour. The unresolved seam is recorded in the module's `PROVENANCE.json` and is
deferred to the Remote Fabric merge workbook, as
`CROSS_PROGRAMME_EXECUTION_CONTRACT.md` §5 requires — deferral is not success.
