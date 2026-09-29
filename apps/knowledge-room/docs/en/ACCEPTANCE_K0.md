# MECH-K0 Acceptance Record (Knowledge Room)

**Task:** `MECH-K0-KNOWLEDGE-ROOM`
**Host:** Mech / single host (acceptance completed on one machine)
**Repository baseline:** `main` @ `3e0bfb09b94b2d58c36948feb5e2f4b60676e4a9`
**Work branch:** `mech/knowledge-room-k0`
**Acceptance scope:** `apps/knowledge-room/**`
**Runtime version:** Node.js `v24.14.0` (Windows)
**Start command:** `apps\knowledge-room\Start-Knowledge-Room.cmd` (equivalent to `node src\server.mjs`)
**Bind address:** `127.0.0.1:4318` (acceptance used `KNOWLEDGE_ROOM_PORT=4318`; the product default is `4317`)

This file records only acceptance that was **actually executed**. A sample run is never reported as acceptance.

---

## 1. Verdict

```text
MECH_KNOWLEDGE_ROOM_READY_TO_ATTACH
```

Gates K1–K7 all pass. Changed files outside `apps/knowledge-room/**` = 0.

---

## 2. Automated tests (really executed)

```cmd
cd apps\knowledge-room
node --test tests/*.test.mjs
```

```text
tests 18 | pass 18 | fail 0
```

| File | Count | Coverage |
| --- | --- | --- |
| `tests/store.test.mjs` | 6 | create/validate, schemaVersion and reload, update, delete, three-create/one-update/one-delete across restart, corrupt file must fail loudly |
| `tests/search.test.mjs` | 4 | title hit, body-only hit, exact normalized tag matching, query combined with tag filter |
| `tests/import-export.test.mjs` | 4 | bundle structure and SHA-256, malformed payload rejection, export → empty → import restores every field, import replaces instead of merging |
| `tests/http.test.mjs` | 4 | `/health` and loopback binding, HTTP CRUD with 404/400 branches, search plus static UI (including traversal guard), export/import round trip |

Tests use the OS temporary directory and never touch `runtime-data/`.

---

## 3. Browser acceptance (real product UI, headless Chrome over CDP)

Method: the real `src/server.mjs` was started, headless Chrome opened the product page, and every check was driven through real DOM interaction (clicks, typing, form submit, confirmation dialog) with assertions read from the live DOM. Two passes:

**Pass 1 (21/21)**

| Check | Result |
| --- | --- |
| Product page loads, `document.title` = `Utopia · Knowledge Room` | PASS |
| UI shows `local · ready` (backend reachable) | PASS |
| Empty store renders the empty state | PASS |
| Three entries created through the UI, each reporting `saved` | PASS |
| List shows 3 entries; tag filter built from real data (5 tags) | PASS |
| Body and tags edited through the UI and reflected immediately | PASS |
| Search `gateway` narrows to 1 hit and reports match state | PASS |
| No-result search keeps the UI healthy (`No entry matches…`) | PASS |
| Tag filter selects the matching set; clearing restores 3 entries | PASS |
| Delete asks for confirmation first (`Delete "…"? This cannot be undone.`) | PASS |
| Delete removes the entry; list and count become 2 | PASS |
| Export produces a complete bundle (format / schemaVersion / 2 entries) | PASS |
| Export button reports a sha256 in the UI | PASS |
| Both panes stay usable at 420px with no horizontal overflow | PASS |
| Page reload keeps the 2 surviving entries | PASS |

**Pass 2 (import replace, 5/5)**

| Check | Result |
| --- | --- |
| Starts from a real exported bundle (2 entries) | PASS |
| After clearing, the product shows a fresh empty state | PASS |
| Bundle imported through the real file input; UI reports `imported 2 entr(ies) · current data replaced` | PASS |
| Every id / title / body / tags / createdAt / updatedAt matches the pre-import export | PASS |

---

## 4. Gate results

### Gate K1 — Independent start ✅

- None of Gateway, Reference Node, Android, Boss, Hns was running;
- `GET /health` → `200`, `{"status":"ok","product":"utopia-knowledge-room","host":"127.0.0.1","schemaVersion":0}`;
- The browser loads the product page;
- The bind address is loopback.

### Gate K2 — CRUD ✅

Three entries created, one edited, one deleted through the product UI; the HTTP layer has its own CRUD tests covering the 400 / 404 branches.

### Gate K3 — Durability ✅

The Knowledge Room process was deleted and shut down (the port stopped responding), then restarted as a new process:

```text
the two surviving entries keep id / title / body / tags
the deleted entry stays deleted
schemaVersion = 0 is readable after the restart
```

### Gate K4 — Search ✅

Three query classes against real data:

```text
q=utopia        → 1 title hit
q=gateway       → 1 body-only hit (title does not contain the term)
tag=SEARCH      → 1 exact tag hit after case normalization
tag=sear        → 0 hits (tags are not substring matched)
q=zzzz-nothing  → 0 hits
```

### Gate K5 — Export / import ✅

```text
export (2 real entries, SHA-256 recorded as 43e43f8c5a81949f6594e8a0721a09fad66d8cb04aa1b12561d636ee0beee303)
→ clear to a fresh/empty data state
→ a malformed payload (wrong format) is rejected and existing data is untouched
→ import the bundle
→ entry id / title / body / tags / createdAt / updatedAt fully restored
→ export again; semantic content is identical
```

The two exports differ byte-wise only because `exportedAt` is regenerated (`43e43f8c…` vs `f5a7ec25…`), which the acceptance rules allow.

### Gate K6 — Isolation ✅

```text
changed paths outside apps/knowledge-room/** in git status --porcelain = 0
```

Untouched: `apps/web/**`, `apps/android/**`, `services/dev-gateway/**`, `agents/reference-node/**`, `contracts/city-control-v0/**`, `platform/**`, `tests/**`, `evidence/**`, `data-records/**`, `scripts/**`, `.github/**`, the root `package.json` and `pnpm-lock.yaml`.

### Gate K7 — No hidden Alien dependency ✅

K1–K5 were completed with all of those services off, Android absent, and no second host. The Knowledge Room reads and writes only its own `runtime-data/`.

---

## 5. Real defects found and fixed during acceptance

1. **The tag filter highlighted a chip without filtering the list.** The list render reused the `state.visible` array left over from the previous `refresh()`, so clicking a tag changed state but not the rendered list. Rendering now derives the list from `visibleEntries()` using the current `activeTags`. Re-verified in the browser.
2. **The "saved" confirmation was wiped by the refresh that followed it.** `saved` was written before `refresh()` / `openEditor()`, which cleared the feedback line, so the user never saw it. The feedback is now written after the editor redraw. Re-verified in the browser.
3. **Leading whitespace was not fully normalized.** `normalizeText` only trimmed the tail, so a title could keep leading spaces. It now trims both ends.

---

## 6. Known limitations

- V0 handles plain text only: no attachments, images, OCR, or vector retrieval;
- Import is fixed to replace: no merge and no conflict resolution;
- No accounts, collaboration, cloud sync, or notifications;
- Single-process, single-user assumption: the data file offers no cross-process write protection;
- The UI is one dark theme: no theme system and no animation system;
- Not yet linked into Utopia's main navigation (a later, very small integration commit; not a MECH-K0 completion condition).

Later enhancements are recorded in [POST_K0_BACKLOG.md](POST_K0_BACKLOG.md) and are never promoted to current blockers.
