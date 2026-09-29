# MECH ROOM PACK V1 Acceptance Record

**Task:** `MECH-ROOM-PACK-V1`
**Host:** Mech / single host (acceptance completed on one machine)
**Baseline:** `main` @ `3e0bfb09b94b2d58c36948feb5e2f4b60676e4a9`
**Branch:** `mech/room-pack-v1`
**Allowed surface:** `apps/rooms/**`
**Runtime version:** Node.js `v24.14.0` (Windows)
**Start command:** `apps\rooms\Start-Rooms.cmd` (equivalent to `node hub\server.mjs`)
**Bind address:** `127.0.0.1` (acceptance used `ROOMS_PORT=4321`; the product default is `4320`)

This file records only acceptance that was **actually executed**. A sample run is never reported as acceptance.

---

## 1. Verdict

```text
MECH_ROOM_PACK_V1_READY_TO_ATTACH
```

Gates P1–P7 all pass.

---

## 2. Focused tests (really executed)

```cmd
cd apps\rooms
node --test tests/*.test.mjs
```

```text
tests 60 | pass 60 | fail 0
```

| File | Count | Coverage |
| --- | --- | --- |
| `tests/hub.test.mjs` | 9 | store atomicity and schemaVersion, corrupt-file failure, no lost concurrent writes, shared helpers, health/room catalog/static assets, unknown rooms and traversal, room data isolation, port config |
| `tests/knowledge.test.mjs` | 6 | create/edit/delete, restart retention, three search classes, export shape, replace import with whole-payload rejection, ordering |
| `tests/bookmarks.test.mjs` | 5 | CRUD, http(s) only, title fallback and search, export/import, restart retention |
| `tests/checklist.test.mjs` | 5 | lists, items and progress, move and delete, clear completed, restart retention, no City Control task vocabulary |
| `tests/prompts.test.mjs` | 5 | variable detection, render and missing, saved values, search, export/import and no AI dependency |
| `tests/text-workshop.test.mjs` | 6 | stats, whitespace and blank lines, sort and dedupe, case, line diff, HTTP and zero persistence |
| `tests/hash.test.mjs` | 3 | comparison against Node crypto, expected-value matching, bad algorithm and zero persistence |
| `tests/data-lab.test.mjs` | 6 | CSV parsing and summary, JSON error position, pretty/minify, invalid JSON, CSV preview and zero persistence |
| `tests/focus.test.mjs` | 5 | presets and completion, interrupted-after-reload, input validation, delete, summary and restart retention |
| `tests/calendar.test.mjs` | 5 | event CRUD, date/time validation, grouping and ordering, scope filters, export/import and restart retention |
| `tests/decisions.test.mjs` | 5 | new OPEN record, stable option ids, decide/revisit, search and status filter, export/import and restart retention |

Tests use the OS temporary directory only and never touch `.runtime-rooms/`.

---

## 3. Canonical browser walkthrough (real product UI)

Method: `hub/server.mjs` was started for real, headless Chrome opened the hub, and each of the ten rooms was visited and given at least one core action, with every assertion read from the live DOM.

```text
pass 26 | fail 0
```

| Check | Result |
| --- | --- |
| Walkthrough starts from a clean runtime (previous leftovers removed) | PASS |
| Hub shell loads with ten rooms in the navigation | PASS |
| Hub reports a working local backend | PASS |
| R1 knowledge: create + search hit; no-result search stays healthy | PASS |
| R2 bookmarks: add URL with tags and note | PASS |
| R3 checklist: add item, toggle, progress 1 of 1 | PASS |
| R4 prompts: detect two variables, fill and render | PASS |
| R5 text workshop: live counts (4 lines / 6 words), dedupe applied | PASS |
| R6 hash: file digest matches an independent Web Crypto computation; MATCH and MISMATCH correct | PASS |
| R7 data lab: pretty print, invalid JSON reports a position, quoted CSV commas parsed | PASS |
| R8 focus: pause really stops the countdown, session lands in history as interrupted, today totals shown | PASS |
| R9 calendar: today scope shows the new event with its times | PASS |
| R10 decisions: DECIDED records the choice and rationale, reopen becomes REVISIT | PASS |
| Hub stays usable in a 420px window | PASS |
| A page reload keeps persisted room data | PASS |
| Room export bundle is complete | PASS |
| No page error was recorded during the walkthrough | PASS |

Screenshots and per-check details live in the construction environment's acceptance directory (not repository content).

---

## 4. Gate results

### Gate P1 — Isolation ✅

```text
changed paths outside apps/rooms/** in git status --porcelain = 0
apps/web, apps/android, services/dev-gateway, agents/reference-node, contracts,
platform, root tests, evidence, .github, scripts, root package.json / pnpm-lock.yaml untouched
```

### Gate P2 — Single Host ✅

With Gateway / Reference Node / Android / Boss / Hns all off and no second host:

```text
/health reports ten rooms with host = 127.0.0.1
all ten rooms' core features work (see the walkthrough in section 3)
the seven persistent rooms each have a .runtime-rooms/<room>.json file
Text Workshop / Hash / Data Lab created no runtime file at all
```

### Gate P3 — Restart ✅

The hub process was stopped (the port stopped responding) and restarted as a new process:

```text
knowledge entries, bookmarks, checklist + item state, prompt template and saved values,
focus session history (active = null), calendar event with its times, decision status
and chosen option — all restored
all seven durable files are schemaVersion 1 + updatedAt + data
```

### Gate P4 — Room Independence ✅

```text
import replace on the knowledge room: bookmarks/calendar/decisions data completely unchanged
writing an invalid JSON room file: the hub fails loudly at load time and names that file
(instead of silently resetting it), while the other rooms' data is untouched
```

### Gate P5 — Full Focused Tests ✅

```text
apps/rooms/** tests = 60 pass / 0 fail
```

### Gate P6 — Manual Product Walkthrough ✅

```text
all ten rooms opened with at least one core action = 26 assertions passed
```

### Gate P7 — No Alien Regression by Construction Surface ✅

No Alien-owned file was modified (verified under Gate P1). The pack therefore does not claim a full Alien device regression run; it proves by file boundary that the main product was not touched.

---

## 5. Real defects found and fixed during acceptance

1. **Two hub instances shared room data.** `RoomStore` held the manifest default object directly, so a second hub in the same process could read the first hub's in-memory data (test counts went 1 → 2). The default is now `structuredClone`d both in the constructor and on load. Fifteen of the sixty tests flipped from failing to passing after this fix.
2. **The shared browser kit was loaded as an ES module.** `client-kit.js` was ESM (it had `export`s) while the hub included it as a classic script, so the browser threw `Unexpected token 'export'` and the navigation never rendered. It is now an IIFE that only publishes `globalThis.RoomsKit`.
3. **Hash Room could not mount.** The `dom` map was missing `verifyButton`, so `addEventListener` threw and the room showed "failed to load". Fixed.
4. **Decision save lost option ids.** PATCH rebuilt options by text and produced new ids, which invalidated the submitted `selectedOptionId` with a 400. Existing option ids are now reused by matching text.
5. **Decision `decision` field did not fall back to the chosen option text.** Fixed in the decide flow.
6. **Missing JSON error position.** Node 24's `Unexpected token` error no longer carries a position. Data Lab now locates the offending snippet and derives line/column.

---

## 6. Known limitations

- Single-process, single-user assumption: `.runtime-rooms` has no cross-process write lock, so multiple instances on one host writing the same room are not protected;
- The room set is fixed at ten and the pack has no plugin mechanism — adding a room means changing code (a deliberate design choice);
- No accounts, collaboration, cloud sync or notifications;
- The focus countdown runs in the page; closing the browser records the session as interrupted by design;
- The calendar room sends no reminders and implements no recurrence;
- Not yet linked into Utopia's main UI navigation (a later, very small integration change; not a completion condition for this pack).

Later enhancements are recorded in [POST_V1_BACKLOG.md](POST_V1_BACKLOG.md) and are never promoted to current blockers.
