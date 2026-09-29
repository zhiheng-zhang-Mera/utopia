# Device Center and connectivity implementation

Spec: owner-supplied UTOPIA-ALIEN-DEVICE-CENTER-CONNECTIVITY-V0.2.md. Product-first continuation of accepted V0; no changes to Digital-City/Boss/Hns. Work on codex/alien-device-center-connectivity-v0.2, retaining V0 regression and bilingual records. Computer Use minimal.

## Shared interfaces (frozen for parallel implementation)

All existing API versions stay zero. Authentication and version headers unchanged. Public pairing endpoints still require version headers.

- GET /api/v0/pairing/info: public envelope with cityId, displayName, descriptor, activeSession boolean, expiresAt, shortCodeEnabled. No credential, code or secret.
- POST /api/v0/pairing/session: control-authenticated, empty body. Returns envelope with descriptor, pairingSessionId, shortCode, expiresAt, qrPayload, qrSvg. Ephemeral QR material and code are only rendered interactively; never evidence/logged. Existing session is revoked. Default TTL 300 seconds.
- POST /api/v0/pairing/exchange: public versioned body {cityId, sessionId, method: qr|mdns|ble, secret? or shortCode?}. Atomic use-once; returns {apiVersion:0,schemaVersion:0,cityId,endpoint,credential}. Wrong material rejected, expired/reused rejected. Gateway throttles wrong guesses. No caller-supplied endpoint accepted.
- Descriptor: {descriptorVersion:1,cityId,displayName,endpoint:{scheme:'http',host,port},apiVersion:0,schemaVersion:0,pairingSessionId:string|null,expiresAt:string|null}.
- QR: utopia://pair?v=1&host=<encoded http origin>&city=<cityId>&session=<sessionId>&expires=<ISO>&secret=<ephemeral>. Android rejects bad version, malformed URI, missing host, unknown scheme, invalid port, expired session and city/endpoint mismatch.
- /city adds cityId, displayName, descriptor, discovery:{mdns:{state,reason?},ble:{state,reason?}}. Existing nodes/tasks/events unchanged.
- Node registration/heartbeat add agentVersion:'0.2.0' and telemetry:{observedAt,cpu:{usagePercent},memory:{usedBytes,totalBytes},disk:{usedBytes,freeBytes,totalBytes},uptimeSeconds}. CPU may be null before a delta sample; unavailable data never fabricated. Telemetry samples every 3 seconds. Freshness limit 10 seconds; disconnected client -> UNKNOWN, offline node -> OFFLINE, stale metrics -> Cached/UNKNOWN.
- mDNS _utopia-city._tcp: TXT v=1, city, api=0, schema=0, session hint; no secrets. Native Android NsdManager; dedup cityId and reject conflicting endpoints.
- BLE UUID 6f9a0001-6c53-4b92-a319-75746f706961. Manufacturer id 0xffff. Payload 23 bytes: canonical network-order UUID (16), version=1 (1), IPv4 octets (4), port big-endian (2). Full city/session descriptor fetched through pairing/info; advertising space excludes identity/session hints. No secret. Publisher and capability detection strictly platform/windows. WinRT reserves service UUID AD fields, so Android scanner filters the manufacturer UUID prefix, reads manufacturer data, verifies endpoint and dedups full cityId.

## Sequence and ownership

- [x] Contract/Gateway: root adds descriptor/parser tests, persistent city identity, single-use sessions, throttling, discovery lifecycle and validated telemetry. Keep V0 tests.
- [x] Windows: adapter worker adds real telemetry sampler and native WinRT BLE publisher/detection; register/heartbeat integration and tests. No gateway/UI edits.
- [x] Android: Android worker owns apps/android only; Device Center, onboarding four routes, ZXing camera scan + scheme handling, NsdManager/BLE permissions, exchange, clear pairing, bounded pilot instrumentation without secrets. Focused unit tests and build.
- [x] Web: Web worker owns apps/web and new Web-specific test only; Devices/detail and authenticated pairing QR/code/status page. Never store screenshots of active pairing material.
- [ ] Integration: root installs on physical device, checks telemetry and all achievable real bootstrap paths. QR scan requires an actual camera view, not descriptor injection. BLE hardware limitation must be measured.
- [ ] Pilots: five clean pairing trials per available mode; Wi-Fi/gateway/node recovery three each; expiry/wrong code/old QR two each; mDNS stale two; BLE toggle two when supported. Product first, collect timestamped evidence as side effect. Missing observations stay null/NOT_RUN.
- [ ] Delivery: sanitized hash manifests, candidate PILOT claim ledger, bilingual docs, final branch SHA, CI, exact APK, release. Accepted only if every gate is proven; BLE-only hardware block may use the specified conditional status.

Review focus: one-time session races; brute-force short codes; endpoint identity conflicts; stale telemetry/live display; permission and camera lifecycle; accidental secret capture in QR/UI trees/logs. Parallel workers do not commit or operate the physical device; root integrates and owns acceptance.

STATUS: NOT_ACCEPTED
PAIR_STATUS: SYNCHRONIZED

The implementation and available pilot results are recorded in [the acceptance checkpoint](../../evidence/en/ACCEPTANCE_V0_2.md). Unchecked integration/pilot/delivery items include the remaining real-camera QR gates and accepted release; they must not be inferred from successful builds or other pairing routes.
