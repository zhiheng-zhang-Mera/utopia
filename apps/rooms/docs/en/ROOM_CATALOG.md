# Room Pack V1 · Room Catalog

This file describes each of the ten rooms: user value, data shape, local API and acceptance points. The order matches both the construction order and the hub navigation.

---

## Hub (R0)

**Responsibilities (all of them):** `listen 127.0.0.1`, serve room assets, local navigation, the thinnest local storage, export/download, basic local routing, health page.

**Forbidden:** City Control routing, gateway proxying, node discovery, task scheduling, an authentication framework, a permission engine, multi-user, LAN exposure, remote/cloud sync, Boss/Hns bridging.

**Entry files:** `hub/server.mjs`, `hub/manifest.mjs`, `hub/registry.mjs`, `hub/public/*`.

**Acceptance:** the hub starts on its own; the browser can use it; `/health` reports ten rooms; the bind address is loopback.

---

## 01 Knowledge Room (durable: `knowledge.json`)

- **Value:** local plain-text knowledge entries.
- **Data:** `{ id, title, body, tags[], createdAt, updatedAt }`.
- **API:** `GET/POST /entries`, `GET/PATCH/DELETE /entries/:id`, `GET /export`, `POST /import`.
- **Acceptance:** create 3 → edit 1 → delete 1 → the remaining content survives a restart completely; title/body/tag searches are correct; export → empty store → import restores every id/title/body/tags.
- **Not in scope:** embeddings, semantic search, LLM, PDF/OCR, knowledge graph.

---

## 02 Bookmark Room (durable: `bookmarks.json`)

- **Value:** local URLs and reference entry points.
- **Data:** `{ id, title, url, tags[], note, createdAt, updatedAt }`.
- **API:** `GET/POST /bookmarks`, `PATCH/DELETE /bookmarks/:id`, `GET /export`, `POST /import`.
- **Safety boundary:** only absolute `http(s)` URLs are accepted; the server never fetches, crawls, previews or downloads remote content; a link opens in a new tab only after an explicit user click.
- **Acceptance:** several real URLs, tag filtering, search, restart, export and restore.

---

## 03 Checklist Room (durable: `checklist.json`)

- **Value:** checklists and ticking items off.
- **Data:** `{ id, title, note, items[{ id, text, done, note, dueDate }], createdAt, updatedAt }`, with `progress` computed by the API.
- **Model constraint:** the room uses only `Checklist` / `ChecklistItem` and deliberately does **not** reuse the City Control `Task`, `QUEUED`, `RUNNING`, `COMPLETED` vocabulary (a test asserts those words never appear in the implementation).
- **API:** checklist CRUD, `POST /checklists/:id/items`, `PATCH/DELETE /checklists/:id/items/:itemId`, `POST /checklists/:id/items/:itemId/move`, `POST /checklists/:id/clear-completed`.
- **Acceptance:** add items, toggle, move up/down (moving the first item up is a no-op rather than an error), delete, clear completed, with state surviving a restart.
- **Not in scope:** runtime assignment, node assignment, automation, notifications.

---

## 04 Prompt Library (durable: `prompts.json`)

- **Value:** reusable prompt templates, with **no AI connection** in this round.
- **Data:** `{ id, title, template, tags[], note, values{}, createdAt, updatedAt }`; `variables` are derived live from `{{name}}`.
- **API:** `GET/POST /prompts`, `PATCH/DELETE /prompts/:id`, `POST /prompts/:id/render`, `GET /export`, `POST /import`.
- **Rendering rules:** known variables are substituted; unknown ones stay as `{{name}}` and are listed under `missing`, so the user can see what is still needed.
- **Acceptance:** detect variables, fill and render, copy the final prompt, and have saved values come back as defaults after a restart.
- **Not in scope:** any model API, model routing, conversation history.

---

## 05 Text Workshop (no persistence)

- **Tools:** character count (with/without whitespace), word count, line count, trim, whitespace normalization, blank-line removal, line sort (optionally descending), line dedupe (optionally case-insensitive), upper/lower/title case, and a line diff (LCS).
- **API:** `GET /operations`, `POST /analyze`, `POST /transform`, `POST /diff`.
- **Acceptance:** every transform verified against a fixed input; added/removed/same line counts and order verified on a fixed pair of texts; confirmed to create no runtime file.

---

## 06 Hash Room (no persistence)

- **Value:** quickly verify a local file fingerprint.
- **API:** `POST /digest` (a string reference implementation), `POST /verify` (expected-value comparison).
- **Privacy:** the file is hashed in the page with Web Crypto; the server provides only the reference implementation; file contents are never uploaded, written to disk or copied into runtime.
- **Acceptance:** the UI SHA-256 of a fixed file matches an independent Web Crypto / Node crypto computation; an expected value yields MATCH / MISMATCH; an invalid expectation is reported clearly.

---

## 07 Data Lab (no persistence)

- **JSON:** `POST /json/parse`, `POST /json/transform` (pretty / minify / validate).
- **Error reporting:** invalid JSON returns message, position, line and column; when a newer V8 build omits the position, the room locates the offending snippet and derives it.
- **CSV:** `POST /csv/preview` with a minimal RFC4180-style parser (quotes, escaped quotes, embedded newlines, CRLF) returning columns, row count, preview rows and a truncation flag.
- **Acceptance:** deterministic pretty/minify output; a position for invalid JSON; quoted commas parsed correctly; confirmed to create no runtime file.
- **Not in scope:** Excel, databases, SQL, large-file streaming, schema registry.

---

## 08 Focus Room (durable: `focus.json`)

- **Value:** local focus timing with an honest record of what actually happened.
- **Data:** `{ sessions[{ id, label, note, plannedMinutes, elapsedSeconds, startedAt, completedAt, interrupted }], active }`.
- **API:** `GET /state`, `POST /sessions/start`, `POST /sessions/complete`, `POST /sessions/abandon`, `DELETE /sessions/:id`, `GET /export`.
- **Reload semantics:** a running session is written to `active` when it starts; if a reload finds `active` still set, the session is marked interrupted and only the real elapsed time is recorded.
- **Acceptance:** a short countdown really completes and lands in history; pause really stops the countdown; a reload terminates the session as designed and records it as interrupted; today's minutes are correct.
- **Not in scope:** OS notifications, a background daemon, mobile synchronization, calendar integration.

---

## 09 Calendar Room (durable: `calendar.json`)

- **Value:** a local plan of dated events that sends no reminders and connects to no system calendar.
- **Data:** `{ id, title, date(YYYY-MM-DD), startTime(HH:MM|null), endTime, label, note, createdAt, updatedAt }`.
- **API:** `GET /events?scope=today|upcoming|all&q=`, `POST /events`, `PATCH/DELETE /events/:id`, `GET /export`, `POST /import`.
- **Acceptance:** ordering and grouping across today and future dates, editing and deletion, and retention across a restart; invalid dates/times and `endTime < startTime` are rejected.
- **Not in scope:** Google Calendar, Outlook, notifications, recurrence engine, timezone sync, meeting invites.

---

## 10 Decision Room (durable: `decisions.json`)

- **Value:** a record of decisions — question, options, choice and rationale — not a todo list.
- **Data:** `{ id, question, context, options[{ id, text }], selectedOptionId, decision, rationale, status, tags[], createdAt, updatedAt, decidedAt }`.
- **Status:** only `OPEN` / `DECIDED` / `REVISIT`.
- **API:** `GET/POST /decisions`, `PATCH/DELETE /decisions/:id`, `POST /decisions/:id/options`, `POST /decisions/:id/decide`, `POST /decisions/:id/revisit`, `GET /export`, `POST /import`.
- **Acceptance:** a new record is OPEN; choosing an option moves it to DECIDED and records the rationale and `decidedAt`; reopening makes it REVISIT; option ids stay stable while editing; search and status filtering work; everything survives a restart.
- **Not in scope:** voting, multi-user, approval workflow, policy engine.
