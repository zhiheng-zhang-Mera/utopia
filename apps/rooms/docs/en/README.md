# UTOPIA · Room Pack V1

**Task:** `MECH-ROOM-PACK-V1`
**Status:** `MECH_ROOM_PACK_V1_READY_TO_ATTACH`
**Allowed surface:** `apps/rooms/**`
**Shared baseline:** `main` @ `3e0bfb09b94b2d58c36948feb5e2f4b60676e4a9`

The Room Pack is Utopia's **single-host local product zone**: one Room Hub listening only on `127.0.0.1`, plus ten loosely coupled product rooms that can each be used and accepted on one machine.

```text
Utopia
└── Rooms
    ├── Room Hub (local entry point, navigation, thinnest storage, loopback HTTP)
    ├── 01 Knowledge Room
    ├── 02 Bookmark Room
    ├── 03 Checklist Room
    ├── 04 Prompt Library
    ├── 05 Text Workshop
    ├── 06 Hash Room
    ├── 07 Data Lab
    ├── 08 Focus Room
    ├── 09 Calendar Room
    └── 10 Decision Room
```

---

## Start

Requires Node.js 24 or newer. Node built-ins only: no third-party dependency, no build step, no `install`.

```cmd
apps\rooms\Start-Rooms.cmd
```

or:

```cmd
cd apps\rooms
node hub\server.mjs
```

Then open:

```text
http://127.0.0.1:4320/
```

Optional environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ROOMS_PORT` | `4320` | Local port |
| `ROOMS_RUNTIME_DIR` | `apps/rooms/.runtime-rooms` | Local data directory |

The bind address is fixed at `127.0.0.1`; it cannot be changed to `0.0.0.0`, and LAN or public exposure is out of scope.

---

## Tests

```cmd
cd apps\rooms
node --test tests/*.test.mjs
```

60 focused tests: hub/store 9, knowledge 6, bookmarks 5, checklist 5, prompts 5, text workshop 6, hash 3, data lab 6, focus 5, calendar 5, decisions 5. Tests use the OS temporary directory only and never touch `.runtime-rooms/`.

Browser acceptance is **one canonical walkthrough**: headless Chrome opens all ten rooms and performs at least one core action in each (26 assertions).

---

## Rooms and persistence

| # | Room | Durable file | Core capability |
| --- | --- | --- | --- |
| 01 | Knowledge | `knowledge.json` | Entry CRUD, title/body search, tag filter, export + replace import |
| 02 | Bookmarks | `bookmarks.json` | URL collection CRUD, tags, notes, search, explicit-click open only |
| 03 | Checklist | `checklist.json` | Lists and items, toggle, move up/down, clear completed |
| 04 | Prompts | `prompts.json` | Templates, `{{variable}}` detection and fill-in, render, copy, saved values |
| 05 | Text Workshop | none | Character/word/line counts, trim, normalize, remove blank lines, sort, dedupe, case, line diff |
| 06 | Hash | none | Local file SHA-256 with size, name and expected-value MATCH / MISMATCH |
| 07 | Data Lab | none | JSON parse/pretty/minify/validate with error position, light CSV preview |
| 08 | Focus | `focus.json` | Countdown, presets, pause/resume/reset, session history, today totals |
| 09 | Calendar | `calendar.json` | Local event CRUD, today/upcoming views, ordering |
| 10 | Decisions | `decisions.json` | Decision records (OPEN / DECIDED / REVISIT), options, rationale, search and tags |

The stateless rooms (Text Workshop / Hash / Data Lab) create no runtime file at all.

---

## Local API

```text
GET  /health
GET  /local-rooms/v1/rooms
     /local-rooms/v1/<room-id>/...
```

`/local-rooms/v1/*` is the Room Pack's own local implementation detail. It is **not** `City Control Protocol` and must never be written into `contracts/`. The Room Pack registers no Node / Task / Event / Capability and uses no `/api/v0/*`, gateway token or WebSocket event stream.

---

## Storage format

```text
apps/rooms/.runtime-rooms/
├── knowledge.json
├── bookmarks.json
├── checklist.json
├── prompts.json
├── focus.json
├── calendar.json
└── decisions.json
```

Each file looks like:

```json
{ "schemaVersion": 1, "updatedAt": "ISO-8601", "data": {} }
```

- Writes use a temporary file plus rename, and in-process writes are serialized;
- A room can only touch its own file: clearing or corrupting one room never affects another;
- A corrupt room file is reported loudly at start-up instead of being silently reset to empty;
- `.runtime-rooms/*.json` is excluded by a `.gitignore` in that directory; only `.gitkeep` is committed;
- The directory is named `.runtime-rooms` rather than `.runtime` because the repository root `.gitignore` (owned by Alien and not modified by this pack) already ignores any `.runtime/` path.

---

## Layout

```text
apps/rooms/
├── package.json
├── Start-Rooms.cmd
├── README.md
├── hub/
│   ├── server.mjs          # Room Hub: loopback binding, routing, static assets, /health
│   ├── manifest.mjs        # room catalog (order = construction order)
│   ├── registry.mjs        # room factories and store wiring
│   └── public/             # hub shell (index.html / app.js / hub.css)
├── shared/
│   ├── atomic-store.mjs    # atomic JSON persistence
│   ├── room-kit.mjs        # ids, timestamps, text/tag normalization, validation, collection CRUD
│   ├── http.mjs            # local HTTP helpers (JSON, static, route matching)
│   ├── text-tools.mjs      # text workshop transforms
│   ├── csv.mjs             # minimal RFC4180 CSV parser
│   └── client-kit.js       # shared browser kit (global RoomsKit)
├── rooms/<room-id>/{room.server.mjs,client.mjs}
├── tests/*.test.mjs
├── .runtime-rooms/               # real data (never committed)
└── docs/{zh-CN,en}/...
```

---

## Boundary with Alien

Mech only adds `apps/rooms/**`. `apps/web`, `apps/android`, `services/dev-gateway`, `agents/reference-node`, `contracts`, `platform`, root `tests`, `evidence`, `.github`, `scripts`, and the root `package.json` / `pnpm-lock.yaml` are untouched.

```text
Alien tree
+
apps/rooms/**
=
combined Utopia tree
```

---

## Documentation

- [ROOM_CATALOG.md](ROOM_CATALOG.md): each room's features, data and acceptance points
- [ACCEPTANCE_PACK_V1.md](ACCEPTANCE_PACK_V1.md): the real Gate P1–P7 acceptance record
- [POST_V1_BACKLOG.md](POST_V1_BACKLOG.md): second batch candidates and later enhancements
- 中文对应目录：[../zh-CN/](../zh-CN/)
