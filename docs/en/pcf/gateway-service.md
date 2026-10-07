# Opt-in local PCF Gateway service

The existing Gateway remains readonly at `GET /api/v0/pcf` unless its caller explicitly passes `pcf: {enabled: true, approvedLocalContext: {deviceId: 'candidate-host'}}` together with `hostDeviceId: 'candidate-host'` to `createGateway`. This is an isolated candidate configuration; do not change or start an existing Alien, Mech, or phone City for this test.

Only the existing City owner control bearer may use these endpoints. Every request checks the existing authentication boundary. Enrolled member sessions and node credentials cannot submit or inspect owner fabric jobs. The adapter binds the owner to `owner:<cityId>` and the explicitly approved local device; `parentSessionId` returned by GET is an identifier, never a credential. Body identity fields cannot confer authority. Browser requests must have the Gateway endpoint as their Origin; CLI requests may omit Origin. Existing API/schema version headers remain required.

- `POST /api/v0/pcf/submit`: `{appId: 'cpu-sort' | 'cpu-sum', idempotencyKey, input: {values: [...]}}`; at most 1024 finite numbers, optional local strict target and bounded deadline.
- `GET /api/v0/pcf/tasks/:id`: inspect the authenticated owner's job.
- `POST /api/v0/pcf/tasks/:id/cancel`: `{}`; asks the PCF service to stop, preserving stop evidence.
- `POST /api/v0/pcf/tasks/:id/collect`: `{}`; returns actual CPU output and digest.
- `POST /api/v0/pcf/tasks/:id/acknowledge`: `{digest}`; records owner consumption, separate from completion and delivery.

The service starts only with opt-in, uses the Gateway's canonical Store, and stops before Store close. Supervisor ownership is exclusive; an unresolved crashed supervisor is refused rather than timed out. Legacy Gateway mutations refuse PCF tasks and its restart recovery excludes `pcf-v1`. The existing worker backend cannot claim or report these tasks. PUBLIC scope, zero fee, local CPU applications only; this is explicitly configured owner authority, not member sharing consent. Remote WBC execution is not connected.

Run `node --test tests/pcf-stagec-gateway.test.mjs` on the isolated candidate checkout. Tests allocate disposable directories and dynamic loopback ports. RED/GREEN evidence is under `.runtime/pcf-stagec-gateway-*`. Deliver the reviewed candidate once to Mech for separate operator-approved physical verification; no installation, merge, live-device execution, or physical PASS is implied. Physical acceptance remains NOT_RUN.
