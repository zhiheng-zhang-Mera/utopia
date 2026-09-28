# Product V0 implementation plan

Goal: a usable Android + Web control surface commanding real safe tasks on a reference node. Product first; collect only acceptance evidence.

Spec: user supplied `utopia_digital_city_product_v0_codex_engineering_book_v2.md`. Execution: native, stages A through G. Architecture: Node.js HTTP/WebSocket gateway, SQLite durable registry, separate capability-based node agent and filesystem adapter, Compose Android and API-only Web clients. apiVersion = 0; schemaVersion = 0.

- [ ] A: `contracts/city-control-v0/protocol.mjs`, `services/dev-gateway/server.mjs`; test health, authentication, incompatible versions and unknown task rejection before implementing.
- [ ] B: `agents/reference-node/main.mjs`; register and heartbeat through versioned HTTP; verify node online/offline and explicit capabilities.
- [ ] C: `services/dev-gateway/store.mjs`, `agents/reference-node/runner.mjs`, `platform/windows/filesystem.mjs`; integration tests for real file hashing, cancellation and restart durability. Never accept arbitrary paths or shell commands.
- [ ] D: `apps/web/`; Home, Nodes, Tasks/detail, Activity and Settings. Verify a browser-created task and WebSocket refresh; display stale connection clearly.
- [ ] E: `apps/android/`; Kotlin Compose, private settings, HTTP snapshot and authenticated WebSocket. Build, install and operate on physical device over LAN.
- [ ] F: compare one Android-created task ID, state, events and result with Web.
- [ ] G: restart gateway and interrupt device Wi-Fi, check preserved history and reconnect. Complete bilingual acceptance records, limited CI and GitHub delivery.

Review focus: wrong token/version fails visibly; unavailable nodes do not receive tasks; terminal tasks cannot be overwritten; reconnect refreshes snapshot; restart marks interrupted work failed instead of silently repeating side effects.

Scope: one runtime node, LAN only, fixed five-task allow-list. Digital-City and Boss/Hns are untouched. Device evidence remains NOT_RUN until observed. Full source and minimal bilingual runbooks are deliverables.
