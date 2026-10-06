# PCF-700 Reuse-maturity five-tier check

One of PCF-700's deliverables (specification revision 2 asks for the accepted EM connector/Foreman, RF, GAI, WBC and
origin-tool wiring to be checked and listed tier by tier). It **creates no runtime code** and never treats "the
contract directory exists" as "the seam is enabled".

```text
STATUS: MEASURED_AT_BASELINE_312b627
PAIR_STATUS: SYNCHRONIZED
instrument   scripts/pcf700-reuse-audit.mjs (re-runnable)
record       data-records/{zh-CN,en}/pcf/reuse-wiring-audit.json
guards       tests/pcf700-dependency-direction.test.mjs (D1-D4, 4/4 green)
```

## 1. The tiers are measured, not declared

```text
MISSING            no such contract directory
DECLARED           the directory exists and nothing outside it references it
COMPONENT_TESTED   only tests/ reference it
LIVE_WIRED         at least one production file (not under tests/) references it
TWO_HOST_VERIFIED           **NOT derivable from this host's grep**: the opposite physical host must walk a sample
                            call chain itself
ORIGIN_AGENT_CONSUMED       **NOT derivable from this host's grep**: it needs a measured chain in which the
                            originating session really consumes the result
```

The last two are always reported as `NOT_MEASURED_HERE` together with the workbook that owns that acceptance - this
host does not sign for the other one.

## 2. Measured by domain (baseline 312b627, 49 contract directories)

| Domain | Directories | LIVE_WIRED | COMPONENT_TESTED | Sole production referrer |
|---|---:|---:|---:|---|
| EM (`engineering-*`) | 13 | **0** | 13 | none |
| GAI (`general-ai-*`) | 9 | **0** | 9 | none |
| RF / return surface (`remote-*`, `rs-*`) | 10 | **2** | 8 | `services/dev-gateway/nearby.mjs`, `services/dev-gateway/presentation.mjs` |
| WBC (`execution-backend-v1`, `node-descriptor-v1`) | 2 | **2** | 0 | `standard-devices.mjs`, `worker-pool.mjs`, `execution-profile.mjs`, `server.mjs`, `services/headless-node-agent/agent.mjs` |

Contract by contract, **only four are LIVE_WIRED**: `execution-backend-v1`, `node-descriptor-v1` (WBC),
`remote-local-discovery-v1`, `rs-presentation-contract-v1` (RF). The other 30 EM/GAI/RF contracts are referenced by
**tests only** - not one of them enters the gateway process.

## 3. Tier verdicts by domain

```text
WBC   DECLARED yes   COMPONENT_TESTED yes (`tests/wbc60{1,2,3,4}-*`)   LIVE_WIRED yes (the gateway imports them and
      drives /api/v0/node/*)
      TWO_HOST_VERIFIED: NOT established in the PCF sense. WBC's own review was done on the opposite host, but the
      chain "a device executes for an origin session living on the other host and the result returns to that origin"
      has not been walked across hosts under PCF semantics - owned by PCF-721/724.
      ORIGIN_AGENT_CONSUMED: not established (owned by PCF-728).
EM    DECLARED yes (13 directories, 379 export statements in total)
      COMPONENT_TESTED yes (each directory has exactly one `tests/engineering-*.test.mjs`)
      LIVE_WIRED no - the gateway imports **not one** engineering-* module, and no /api/v0 route exposes them.
      => EM is a TESTED COMPONENT SET, not a live service PCF can lean on; if PCF needs Foreman or a connector it must
      wire it itself (PCF-727).
GAI   DECLARED yes (9 directories, 264 export statements in total)   COMPONENT_TESTED yes   LIVE_WIRED no (zero
      production references, same as EM)
      => the provider/approval logic exists and is tested, but it is not inside the City process; PCF may not claim a
      real provider already exists.
RF    DECLARED yes   COMPONENT_TESTED yes (10 directories)   LIVE_WIRED PARTIAL: only discovery (nearby) and
      presentation are really called by the gateway. `remote-typed-dataplane-v1`, `remote-path-manager-v1`,
      `remote-fabric-public-api-v1`, `remote-capability-registry-v1`, `remote-invite-rendezvous-v1`,
      `remote-presence-reconnect-v1` and `remote-bluetooth-bootstrap-v1` are all NOT_WIRED.
      Note especially `rs-cross-device-return-v1` (cross-device return): tests only, and it is exactly the seam
      PCF-714's origin continuity has to attach to - so return continuity is currently proven by NO production path.
origin tooling   rs-presentation-contract-v1 LIVE_WIRED (`presentation.mjs` -> `/api/v0/presentation`, consumed by both
      Web and Android); rs-cross-device-return-v1 as above: COMPONENT_TESTED, NOT_WIRED.
```

## 4. The EM / RF / GAI reuse boundary (who supplies what, what PCF must not rebuild)

| Concern | Supplier | State | What PCF should do |
|---|---|---|---|
| Identity and trust | City canonical store + `pairing-v1` + `remote-capability-registry-v1` | pairing is wired; the capability registry is tests-only | **Reuse** it; build no second trust or credential store (the workbook's non-negotiable) |
| Transport and reachability | `remote-local-discovery-v1` (wired), `remote-typed-dataplane-v1`/`remote-path-manager-v1` (not wired) | only discovery is live | Attach to the existing contracts where needed; list the unwired ones as explicit gaps |
| Engineering planning and Review->Repair | EM (`engineering-manager-v1`, `engineering-foreman-scheduler-v1`, `engineering-job-v1`) | all COMPONENT_TESTED, zero production references | **Do not rebuild**; PCF supplies execution/resource interfaces, planning stays with Foreman (PCF-727) |
| Provider, approval, conversation | GAI (`general-ai-registry-v1`, `general-ai-gateway-v1`, `general-ai-health-resilience-v1`) | same | Build no second provider platform; PCF-725/726 only define the execution provider and capsule boundary |
| Origin state and result re-injection | `rs-presentation-contract-v1` (live) + `rs-cross-device-return-v1` (tests only) + `handoff.mjs` (live) | presentation live, the return seam tests-only | PCF-714/728 attach to the existing return seam, not a second result channel |
| Research, tracing, replay | REX (`/api/v0/research/*`, wired) | live | PCF-707 adds an adapter, never a second research platform |

## 5. What this file does NOT prove (written out, never zeroed)

```text
* Nothing reached TWO_HOST_VERIFIED this round - this host does not sign for the other physical host (section 3
  forbids self-review).
* ORIGIN_AGENT_CONSUMED is empty: calling "the originating session consumes the result" achieved needs PCF-728's
  measured chain.
* EM/GAI's "tested" is CONTRACT-LEVEL unit testing, not end to end; it may not be used to claim a real
  provider/connector is available.
* rs-cross-device-return-v1 being NOT_WIRED means the result reaches the origin today through the combination of
  handoff.mjs and presentation rather than through that dedicated contract; PCF-714 must prove it attaches.
```

## 6. How to re-run it (for the reviewer)

```bash
node scripts/pcf700-reuse-audit.mjs                 # print the full JSON
node scripts/pcf700-reuse-audit.mjs --out /tmp/x.json
node --test tests/pcf700-dependency-direction.test.mjs
```

**The instrument itself was repaired twice, recorded here**: the first version used one loose regex and reported 19
"backend imports front-end", all false positives (serve paths and test/script drivers); the repair then matched only
`import ... from '...'` and was bypassed by a SIDE-EFFECT import (`import '../apps/web/app.js';`, a real dependency),
which was found by deliberately falsifying the guard. The probe now separates module imports, static serve paths, and
tool/test drivers.
