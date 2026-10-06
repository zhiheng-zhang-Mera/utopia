# PCF-700 UI->backend dependency matrix and single-writer list

One of PCF-700's deliverables (acceptance sub-step 4: name each downstream owner and **check the UI->backend
direction for cycles**). It lists, file by file, which user surface can reach which backend endpoint, and proves the
reverse dependency does not exist.

```text
STATUS: MEASURED_AT_BASELINE_312b627
PAIR_STATUS: SYNCHRONIZED
instrument   scripts/pcf700-reuse-audit.mjs
record       data-records/{zh-CN,en}/pcf/reuse-wiring-audit.json
guards       tests/pcf700-dependency-direction.test.mjs D1 (direction) and D2 (endpoint existence)
```

## 1. Direction: three categories, not one impression

```text
81 front-end source files scanned (apps/web/**.{js,mjs} + apps/android/**.kt).
Backend modules importing front-end modules: **0** (D1 asserts the empty list) - that is what "acyclic" means here,
  measured.
Backend references to the front end as a FILESYSTEM PATH: `services/dev-gateway/static.mjs` (it is the static host
  that serves apps/web, which is the correct direction) + `tests/web-i18n.test.mjs`.
Drivers that import front-end modules on purpose: 4 under `scripts/` (browser-relay-check, uxi301-* x3) + 13 under
  `tests/`.
```

Verdict: **UI->backend is acyclic**. The backend's only contact with the front end is serving the directory as static
assets; no backend module imports a front-end module.

## 2. Per-file endpoint matrix (measured: 14 files carry an `/api/v0` literal)

| User surface file | Endpoints |
|---|---|
| `apps/web/app.js` | `/api/v0/`, `/api/v0/events/stream`, `/api/v0/join/`, `/api/v0/pairing/exchange`, `/api/v0/pairing/info` |
| `apps/web/discovery.js` | `/api/v0/join/nearby` |
| `apps/web/enrollment.js` | `/api/v0/device/session`, `/api/v0/device/installations`, `/api/v0/device/installations/${encodeURIComponent(...)}` |
| `apps/web/short-code.js` | `/api/v0/pairing/exchange`, `/api/v0/pairing/info` |
| `apps/web/scheduler.js` | `/api/v0/presentation`, `/api/v0/tasks`, `/api/v0/tasks/` |
| `apps/web/relay-dial.mjs` | `/api/v0/relay`, `/api/v0/device/session`, `/api/v0/join/{info,nearby,request,status,exchange}` |
| `apps/web/relay-join.mjs` | `/api/v0/join/{info,request,status,exchange}` |
| `apps/android/.../CityClient.kt` | `/api/v0/`, `/api/v0/ask`, `/api/v0/rooms`, `/api/v0/presentation`, `/api/v0/device/session`, `/api/v0/events/stream` |
| `apps/android/.../Actions.kt` | `/api/v0/actions` |
| `apps/android/.../PairingApi.kt` | `/api/v0/pairing/` |
| `apps/android/.../SchedulerPresentation.kt` | `/api/v0/presentation` |
| `apps/android/.../RelayDial.kt` | `/api/v0/relay`, `/api/v0/device/session`, `/api/v0/join/{info,nearby,request,status,exchange}` |
| `apps/android/.../RelayPairing.kt` | `/api/v0/join/{info,request,status,exchange}` |
| `apps/android/app/src/test/.../RoomsTest.kt` (unit-test driver, not a product surface) | `/api/v0/rooms` |

The backend side measures **49 `/api/v0` route literals** in `services/dev-gateway/server.mjs`. **D2 asserts that every
front-end literal resolves against that route table (static-prefix match, id concatenation allowed): unresolved = 0**, so
"the UI calls an endpoint the City does not serve" turns the test red immediately.

## 3. Single-writer list (with fingerprints the other host can recompute)

| File | Role (sole-writer claim) | Lines | Bytes | SHA256 |
|---|---|---:|---:|---|
| `services/dev-gateway/server.mjs` | only writer of routes and backend/profile construction | 1351 | 122700 | `766f7b778bb35ac66ce5b6eeedc950c5015f3faa9d6acde66fb3d5e7d0df5a90` |
| `services/dev-gateway/store.mjs` | only writer of canonical task/action/device/event truth | 109 | 8533 | `4a977deefb9200fe871b721f4d4aed7db6c5dc8a92e9f59f231e479d21f5fd2c` |
| `services/dev-gateway/targeting.mjs` | strict-target classification (pure; writes no state) | 127 | 6408 | `09df5bf1ce3782dede4f5d381b7e63411fc01fb643c09f7acf38b53bac59cd19` |
| `services/dev-gateway/execution-profile.mjs` | only writer of profile state | 208 | 12043 | `cfc2f3cf4777c273cc6e52d33c2453d8ab366415369c4bb9deedc9bd2647ce1c` |
| `contracts/node-descriptor-v1/node-descriptor.mjs` | the single definition of node-descriptor fields (imported by both the gateway and the worker pool) | 332 | 21692 | `5c64f0020995aa4256676054ce684dce83e5f10d27d126615b916d25075caa7b` |

The fingerprints exist for the opposite-host review: bytes/lines/SHA256 can be **recomputed** on the reviewer's own
checkout instead of being taken from this file.

## 4. Downstream component/exposure owners (the first half of sub-step 4)

```text
715  resource control and the Monitor projection: the single host of every PCF user surface (the exposure of 701, 702
     and 704 all converges there)
714  origin state and result continuity: owner of the origin surface, attaching to rs-cross-device-return-v1 (currently
     NOT_WIRED)
790  final composition acceptance: only it can turn accepted contracts into a real product combination
every other workbook keeps its own component owner, contract directory and tests; this table grants no exposure-gate
exception to anyone.
```

## 5. Not finished / not proven this round (written out)

```text
* This matrix is STATIC dependency evidence (source literals), not a runtime capture; the real click path across two
  hosts is TWO_HOST_VERIFIED and must be done by the opposite physical host.
* Endpoint semantics that need a query, a header or a WebSocket subprotocol negotiation are outside a literal matrix
  (for example authorisation on events/stream).
* The Android side covers Kotlin source literals only; a URL carried in a Gradle-generated BuildConfig is not in this
  matrix and is listed as the next increment.
```

## 6. How to re-run

```bash
node scripts/pcf700-reuse-audit.mjs --out data-records/zh-CN/pcf/reuse-wiring-audit.json
node --test tests/pcf700-dependency-direction.test.mjs
```

The instrument itself was repaired twice (nineteen false positives from a loose regex, and a side-effect import that
bypassed the repair); see `reuse-tiers.md` section 6 - both were falsified before being fixed.
