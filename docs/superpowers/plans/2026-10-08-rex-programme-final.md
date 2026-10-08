# REX programme final Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Owner approved direct execution without staged confirmations.

**Goal:** Ship operable Android and natural-language owner controls, validate the integrated REX programme, and merge verified product and records into main.
**Architecture:** Keep the existing canonical City tasks and Action adapter. A bounded deterministic intent module produces drafts only; Web and Android use existing owner endpoints after typed confirmation. Integrate the frozen REX-890 ancestor, already done without conflicts, and retain all four-series content.
**Tech Stack:** Node 24 ES modules, existing Playwright, Kotlin/Compose/OkHttp, Gradle, Python Mission Book tools.
**Spec:** `docs/superpowers/specs/2026-10-08-rex-programme-final-design.md`.

## Global Constraints

No first-pass execution; no parameter guesses; owner authorization enforced at Gateway; strict target; argv as data; bounded operations; no new task truth; agent observation and collection acknowledgement remain explicit. Preserve original evidence and device enrollment. Owner authorized merge after functional/user-operation verification; no new staged permission questions.

## Review Focus

- Requests bearing `confirm:true` must still produce drafts rather than bypass owner control flow (Task 1 HTTP test).
- Two matching device labels must never silently select one (Task 1 unit test).
- Editing a field, losing connection or changing credential context must invalidate confirmation (Tasks 2/3 E2E and pure state tests).
- Delayed completion and typed backend refusals must not turn into UI success (Tasks 1/3 backend and DTO tests).
- Refresh/recomposition must preserve current drafts and focus without replaying a seed (Tasks 2/3 live UI).

## Task 1: Gateway owner-control intent drafts

Files: create `services/dev-gateway/owner-control-intents.mjs`, `tests/owner-control-intents.test.mjs`, `tests/owner-control-intents-gateway.test.mjs`; modify `services/dev-gateway/server.mjs` and `intents.mjs`.
Interfaces: `ownerControlTargets(context)` returns two existing CITY_TASK owner target descriptors. `prepareOwnerControlAsk(request, context)` returns null for legacy requests or a complete Ask envelope containing a nonexecuting `draft` with kind, requestText, targetDeviceRef, operation/job fields and missing fields. Context carries isOwner, nodes and current configuration.

- [ ] Write assertions for Chinese/English drafts, incomplete input, ambiguity, no invented purpose/cwd, member refusal and confirm bypass.
- [ ] Run `node --test tests/owner-control-intents*.test.mjs`; observe missing behavior RED.
- [ ] Implement bounded extraction and Gateway integration, retaining legacy handleAsk routing. Validate real HTTP responses leave task count unchanged; direct action execution continues on existing adapter.
- [ ] Run new tests plus `tests/city-remote-operation-gateway.test.mjs`, `tests/city-agent-job.test.mjs`, `tests/uxi390-action-wiring.test.mjs`; expect all pass. Commit and push.

## Task 2: Web draft handoff

Files: modify `apps/web/terminal.js` (actual terminal file resolved before edits), `apps/web/app.js`, `remote-operation.js`, `agent-jobs.js`; create `tests/owner-control-draft-web.test.mjs`.
Interfaces: view `seedDraft(draft)` consumes Task 1 envelope once inside the matching credential context; terminal gets `openOwnerDraft` callback and shows an explicit review-draft button. No Task 1 draft submission itself creates work.

- [ ] Write real-browser tests for Ask → review draft → fill → confirmation → dispatch, member refusal, seed consumption and confirmation invalidation.
- [ ] Observe RED, implement handoff using existing forms and typed confirm gates.
- [ ] Run new and existing remote/agent-job/rebuild browser tests; expect all pass. Commit and push.

## Task 3: Android native controls

Files: create `OwnerControls.kt`, `OwnerControlsPanel.kt`, `OwnerControlsTest.kt`; modify `CityClient.kt`, `Actions.kt`, `AskPanel.kt`, `MainActivity.kt` under `apps/android/app/src/{main,test}/java/city/utopia/control/`.
Interfaces: `OwnerControlDraft` parses Task 1 `draft`; `ownerControlAction(draft)` builds the existing actions body; `ownerControlValidation` returns missing/invalid fields. `CityClient.ownerControls`, `dispatchOwnerControl`, `cancelOwnerControl`, `collectAgentJob` use typed callback envelopes and existing auth. Panel consumes draft and actual operation/job row views.

- [ ] Write JUnit assertions for draft parsing, argv preservation, required fields, valid bounds, confirmation invalidation, row states and authority labels.
- [ ] Run `gradlew.bat :app:testDebugUnitTest --console=plain`; observe missing behavior RED.
- [ ] Implement panels with callback fences, explicit node selection, purpose, editable fields, typed confirmation, true result/error/receipt state, cancel and collect. Add Advanced navigation and Ask draft callback.
- [ ] Run unit tests and `:app:assembleDebug`; expect exit 0. Install APK on connected PERM00 and exercise both controls and Ask through actual UI. Commit and push.

## Task 4: Programme evidence and comprehensive verification

Files: create integration workbook, English mirror and reports in a new Digital-City docs branch; update scoped registry surfaces/intent refs and derived indexes.
- [ ] Record immutable baseline/dependencies, actual task/action/device/City IDs and current gates without preclaiming success.
- [ ] Run full root, Rooms and City regressions, APK unit/build, promotion-history/docs checks, real cross-host operations, directed job lifecycle and REX reproduction. Preserve every failure and fix meaningful failures before declaring green.
- [ ] Save UI trees/screenshots/logs and exact artifact hashes; run docs consistency/dependency/progress/navigation checks. Commit and push evidence and status at the appropriate measured stage.

## Task 5: Independent review and authorized merge

- [ ] Use requesting-code-review skill for a fresh-context whole-branch reviewer; provide exact base/head, design/plan and actual test evidence, without session history.
- [ ] Re-grade findings by user impact, fix Critical/Important with RED→GREEN and regressions; preserve deferred minors and rulings in ledger/report.
- [ ] Confirm exact-head hosted CI terminal success, fetch current main and verify ancestry/clean trees. Merge product PR under Owner authorization, verify merged-main runtime/UI and CI, then finalize the integration workbook and merge records PR.
- [ ] Report actual SHAs, APK location, user instructions, gates and any material remaining boundaries.
