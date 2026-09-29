# UTOPIA · Knowledge Room

**Task:** `MECH-K0-KNOWLEDGE-ROOM`
**Status:** `MECH_KNOWLEDGE_ROOM_READY_TO_ATTACH`
**Ownership:** `apps/knowledge-room/**` (single host, local only, zero Alien dependency)

The Knowledge Room is the first real product slice of Utopia's `Planning & Knowledge` area: a plain-text knowledge base that runs only on this machine at `127.0.0.1`. It does not depend on the Utopia Gateway, a Runtime Node, Android, a second host, or any cloud service.

```
Utopia
└── Planning & Knowledge
    └── Knowledge Room
```

---

## Features

| Feature | Notes |
| --- | --- |
| Create / edit | Title, body and tags; durably persisted on save |
| Browse | List sorted by `updatedAt`, showing title, tags, update time and a body preview |
| Search | Title / body substring matching plus tag matching, one consistent case rule |
| Tag filter | Exact tag matching (case and whitespace normalized), multi-select |
| Delete | One confirmation first; V0 deletes permanently |
| Export | Complete JSON bundle (`format` / `schemaVersion` / `exportedAt` / `entries`) |
| Import | `IMPORT_MODE = replace`: the bundle replaces the current data set |

Out of scope for this round: attachments, images, PDF/OCR, vector stores, embeddings, semantic search, LLM summaries, knowledge graphs, collaboration, accounts, cloud sync.

---

## Start

Requires Node.js 24 or newer (Node built-ins only, no third-party dependency, no build step).

```cmd
apps\knowledge-room\Start-Knowledge-Room.cmd
```

or:

```cmd
cd apps\knowledge-room
node src\server.mjs
```

Then open:

```
http://127.0.0.1:4317/
```

Optional environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `KNOWLEDGE_ROOM_PORT` | `4317` | Local port |
| `KNOWLEDGE_ROOM_DATA_DIR` | `apps/knowledge-room/runtime-data` | Data directory |

The bind address is fixed at `127.0.0.1`; it cannot be changed to `0.0.0.0` through configuration, and public internet exposure is out of scope.

---

## Layout

```text
apps/knowledge-room/
├── package.json
├── Start-Knowledge-Room.cmd
├── README.md
├── src/
│   ├── server.mjs            # local HTTP server + static product UI
│   ├── store.mjs             # durable JSON store + deterministic search
│   ├── model.mjs             # KnowledgeEntry model and validation
│   ├── import-export.mjs     # bundle export / import (replace)
│   └── public/
│       ├── index.html
│       ├── app.js
│       └── app.css
├── tests/
│   ├── store.test.mjs        # 6 model/store tests
│   ├── search.test.mjs       # 4 search tests
│   ├── import-export.test.mjs# 4 import/export tests
│   ├── http.test.mjs         # 4 HTTP/API tests
│   └── helpers.mjs
├── runtime-data/             # real user data (never committed)
│   ├── .gitkeep
│   └── .gitignore
├── samples/
│   └── knowledge-sample-v0.json
└── docs/
    ├── zh-CN/{README.md,ACCEPTANCE_K0.md,POST_K0_BACKLOG.md}
    └── en/{README.md,ACCEPTANCE_K0.md,POST_K0_BACKLOG.md}
```

---

## Data model

```json
{
  "id": "uuid",
  "title": "Example title",
  "body": "Plain text or Markdown-like source text",
  "tags": ["research", "utopia"],
  "createdAt": "ISO-8601 timestamp",
  "updatedAt": "ISO-8601 timestamp"
}
```

Tags are normalized before writing: trimmed, inner whitespace collapsed, lowercased, and deduplicated.

---

## Local storage

Data file:

```text
apps/knowledge-room/runtime-data/knowledge-v0.json
```

```json
{ "schemaVersion": 0, "entries": [] }
```

- Each save writes a temporary file in the same directory and renames it over the target, so a half-written store is impossible;
- Writes inside one process are serialized and cannot overwrite each other;
- Only its own data directory is read or written: no scanning of other directories, no Gateway / Boss / Hns state files;
- `runtime-data/*.json` is excluded by a `.gitignore` inside that directory; the repository commits only `.gitkeep` and the sample data.

---

## Local API

These endpoints are the Knowledge Room's own implementation detail. They are **not** `City Control Protocol v0` and must never be written into `contracts/city-control-v0/`.

```text
GET    /health
GET    /local-kb/v0/entries            supports ?q= and ?tag=
POST   /local-kb/v0/entries
GET    /local-kb/v0/entries/:id
PATCH  /local-kb/v0/entries/:id
DELETE /local-kb/v0/entries/:id
GET    /local-kb/v0/search?q=&tag=
GET    /local-kb/v0/export
POST   /local-kb/v0/import
```

Import validation: `format = "utopia-knowledge-room"`, `schemaVersion = 0`, `entries` must be an array and every entry must be structurally valid. If any of that fails, the whole payload is rejected and existing data is untouched.

---

## Tests

```cmd
cd apps\knowledge-room
node --test tests/*.test.mjs
```

18 tests: 6 store/model, 4 search, 4 import/export, 4 HTTP. Tests use the OS temporary directory only and never touch `runtime-data/`.

---

## Boundary with Alien

Mech writes only `apps/knowledge-room/**`. Mech does not modify, extend, or wait for Alien's Web, Android, Gateway, Runtime Node, protocol contracts, CI, or V0 acceptance material. The attachment shape is:

```text
Alien final tree
+
apps/knowledge-room/**
=
combined Utopia tree
```

After the merge, the Knowledge Room still starts and works standalone through `Start-Knowledge-Room.cmd`.

---

## Documentation

- 中文：[docs/zh-CN/README.md](docs/zh-CN/README.md) · [docs/zh-CN/ACCEPTANCE_K0.md](docs/zh-CN/ACCEPTANCE_K0.md) · [docs/zh-CN/POST_K0_BACKLOG.md](docs/zh-CN/POST_K0_BACKLOG.md)
- English: [docs/en/README.md](docs/en/README.md) · [docs/en/ACCEPTANCE_K0.md](docs/en/ACCEPTANCE_K0.md) · [docs/en/POST_K0_BACKLOG.md](docs/en/POST_K0_BACKLOG.md)
