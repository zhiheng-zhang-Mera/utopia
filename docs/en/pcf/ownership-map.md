# PCF-700 ownership and call-chain reality audit

One of PCF-700's deliverables. It freezes which existing implementations are reused, which must be extended and which
do not exist at all, and it writes out **declaration → caller → live API → user surface → exact evidence** layer by
layer. It creates **no runtime code**: the architecture's candidate directories (`contracts/personal-compute-fabric-v1/`,
`services/personal-compute-fabric/`) remain **uncreated** after this audit.

> Authority: the workbook outranks this file. This file describes the **current head** only; where it says `NOT_WIRED`
> that is not a defect claim but a warning not to assume the seam is connected.

```text
baseline / 基线   utopia main 312b627 (= PCF-700's claim-time baseline)
branch / 分支     pcf/PCF-700-mech-ownership-and-reality-audit
tests / 配套测试  tests/pcf700-compatibility.test.mjs (7/7 green, see section 6)
```

## 1. Reuse points: declaration → caller → live API → user surface → evidence

**D** declaration, **C** caller, **A** live HTTP API, **S** user-visible surface, **E** evidence.

| Reuse point | D | C | A | S | E | Verdict |
|---|---|---|---|---|---|---|
| Canonical store (task/device/event truth) | `services/dev-gateway/store.mjs:1` (`Store`, `StoreUnavailableError`) | all of `server.mjs` | backs every `/api/v0/*` read route | Home/Devices/Tasks | `tests/city-store-diagnostic.test.mjs` (typed diagnostic adopted on this branch) | **REUSE (live-wired)** |
| Canonical task creation and transitions | `createCityTask` / `changeTask` in `server.mjs` | `POST /api/v0/tasks`, the campaign runner, `node/report` | `POST /api/v0/tasks`, `POST /api/v0/node/{claim,report}` | Tasks page, Activity | `tests/pcf700-compatibility.test.mjs` C2/C4 | **REUSE (live-wired)** |
| Strict target (the user names a device) | `targeting.mjs:30` (`STRICT_TARGET_FIELD='targetDeviceRef'`) | imported at `server.mjs:51`; **used inside the claim path** by `standard-devices.mjs:89/97/193/211/221` | `POST /api/v0/node/claim` (the `withheld` projection); the campaign runner writes it when it creates a task | Devices/Tasks detail (waiting reason) | C3 + `tests/mesh301-strict-target.test.mjs` | **REUSE (wired at the live dispatch/claim layer, not merely a helper)** |
| Execution profile (WBC-604) | `execution-profile.mjs:41` (`createExecutionProfileController`), `:166` (`chooseHybridTarget`) | controller built at `server.mjs:503`; `currentProfile=()=>profileController.profile()` (`server.mjs:504`) | `GET/POST /api/v0/execution-profile` (`server.mjs:963/967`); city snapshot's `executionBackend` (`server.mjs:718`) | the profile control in the advanced settings | C6/C7 + `tests/wbc604-*` | **REUSE**; but **`chooseHybridTarget` = NOT_WIRED** (only its own tests call it, see section 3) |
| Backend registry and selection | `server.mjs:498` (registry), `:522` (standard-devices registered), `:524` (worker-pool registered), `:527` (`executionBackends.active(currentProfile())`) | `executionBackend()` returns the active one | `/api/v0/node/{claim,report}`, the `/city` snapshot | Devices and profile pages | C7 | **REUSE**; **the worker pool is registered but `enabled=false`** |
| Standard-devices backend | `execution-backend/standard-devices.mjs:84` | built at `server.mjs:509` | as above | as above | `tests/wbc601-*` | **REUSE (live)** |
| Worker-pool backend | `execution-backend/worker-pool.mjs:5` (`enabled=false` by default) | `server.mjs:524` registers it **with no arguments** (hence disabled) | none (not active) | none | `tests/wbc603-*` | **EXTEND (seam exists, not activated)** |
| Headless node agent | `services/headless-node-agent/agent.mjs:6` (`createHeadlessAgent`), `index.mjs:1` | **the gateway does not reference it** (`git grep createHeadlessAgent -- services/dev-gateway/` is empty) | none | none | `tests/wbc603-headless-agent.test.mjs` | **COMPONENT_TESTED, NOT_WIRED into the gateway** |
| Node descriptor contract | `contracts/node-descriptor-v1/node-descriptor.mjs` (roles/presence/resource kinds, `describeLegacyNode`) | `server.mjs:60`, `worker-pool.mjs:2`, `agent.mjs:1` | `POST /api/v0/node/register` (validation), `GET /api/v0/nodes` (`nodeDescriptors`) | Devices detail | C5 + `tests/wbc602-*` | **REUSE** (legacy records are handled by the contract; see the measured divergence in section 3) |
| Handoff bridge | `handoff.mjs:23` (`createHandoffBridge`) | `server.mjs:334` | handoff outcomes in tasks/events | Tasks/Activity | `tests/uxi391-remote-handoff-closeout.test.mjs` | **REUSE (live)** |

## 2. Candidate interfaces → reality (the section 4 table, checked line by line)

None of the nine interfaces in `ARCHITECTURE.md` section 4 exists under that name on this head; two names are claimed
by other domains and are **name collisions, not reuse points**:

| Candidate interface | Exists? | Note (measured) |
|---|---|---|
| `observeResources(sample, context)` | **no** | a same-named symbol lives in `contracts/engineering-foreman-scheduler-v1/foreman.mjs` (EM domain) => **name collision** |
| `resolveEffectivePolicy(...)` | **no** | - |
| `normalizeWorkload(...)` | **no** | - |
| `planPlacement(...)` | **no** | - |
| `admit(proposal, expectedVersion)` | **no** | the word `admit` appears in 17 files (capability routing etc.) => **different thing, same word** |
| `resolveArtifact(...)` | **no** | - |
| `executeAttempt(...)` | **no** | - |
| `validateCheckpoint(...)` | **no** | - |
| `reconcileExecution(...)` | **no** | - |
| `ResourceObservation` / `WorkloadEnvelope` / `EffectivePolicy` / `PlacementProposal` / `ReservationReceipt` / `AttemptReceipt` / `CheckpointRef` / `ArtifactRef` | **all absent** | the minimal shared-type table is a **design**, not code |

So every PCF interface and type is MISSING in V1 and must be created under `contracts/personal-compute-fabric-v1/`;
this audit created none of them.

## 3. The three wiring layers the workbook insists on separating

```text
(1) profile switching   the controller is built (server.mjs:503), the routes exist (:963/:967) and the snapshot
                        exposes it (:718)  => LIVE_WIRED; switching the profile is a real Owner action.
(2) pure HYBRID helper  chooseHybridTarget is declared (execution-profile.mjs:166) and called by the WBC-604 tests,
                        but the gateway has NO call site (`git grep chooseHybridTarget -- services/` returns only the
                        declaration) => NOT_WIRED. C6 freezes that fact as an assertion: whoever wires it later turns
                        the test red and must update this map.
(3) real dispatch/claim the strict target is consulted INSIDE the claim path (claimAllowedByTarget / withheldTasks /
                        classifyTarget in standard-devices.mjs) and C3 verifies it through a real /node/claim: a task
                        whose target is absent is withheld from other nodes with reason=STRICT_TARGET_BOUND and
                        heldFor=<target>  => the live dispatch layer is wired.
```

Two more "exists but inactive" facts: the **worker-pool backend is registered and disabled** (`createWorkerPoolBackend()`
with no arguments => `enabled=false`), and the **headless agent has no import relationship with the gateway at all**.

## 4. Single writers, and the "no new canonical database" evidence

```text
serial integration seams (this audit registers them, it does not modify them)
  services/dev-gateway/server.mjs   122680 B / 1350 lines - the only writer of routes and controller construction
  services/dev-gateway/store.mjs    the only writer of canonical task/action/device/event truth
  contracts/node-descriptor-v1/*    the only writer of node-descriptor fields (both server.mjs and worker-pool import it)
  apps/web/*, apps/android/*        the only writers of the user surfaces

no new canonical database (measured)
  * after a bare City starts, the data directory contains NO pcf-named state (C1 asserts readdir has no pcf name)
  * repo-wide, `personal-compute-fabric` appears only in mission-book planning files and docs, never in a runtime module
  * the Store remains the single canonical store; this audit creates no second Task/Action/device/credential database
```

## 5. Downstream owners and the acyclic UI->backend direction (what this round covers)

```text
component/evidence owners (as the workbooks declare)
  701 resource observation   pure collection + bounded state, no UI decision   owner PCF-701; surface owned by 715
  706 policy/consent         creates neither trust nor budget authority         owner PCF-706; surface owned by 715
  708 workload envelope      legacy tasks unaffected                            owner PCF-708
  702/704 placement/admission proposes only / serialised by the canonical owner owner PCF-702 / PCF-704
  709/710/711/712            artifact / execution / checkpoint / reconciliation owner each; surfaces owned by 714/715
  715 public UI host          the only UI host; 714 origin continuity; 790 final composition

UI -> backend direction (measured)
  apps/web and apps/android reach the City only through /api/v0/*; no backend file imports a front-end module
  => no cycle found this round; the per-file dependency matrix is queued as the next audit increment (section 7)
```

## 6. Compatibility counter-examples (written and run)

`tests/pcf700-compatibility.test.mjs` - **7/7 green** at baseline 312b627:

```text
C1 a bare City with no fabric or workbench configuration still starts, still serves, defaults to
   profile=STANDARD_DEVICES and backend=standard-devices, and creates NO PCF state directory
C2 a legacy untargeted task is still claimable by any able node (the pre-PCF scheduling behaviour)
C3 a task whose target is absent is withheld from other nodes (reason=STRICT_TARGET_BOUND, heldFor=<target>,
   askedBy=<asker>), and the pure guard agrees with the live route (classifyTarget=UNKNOWN/claimable=false)
C4 a result returns to the canonical origin (the City's task list reads COMPLETED with the same result object)
C5 the contract tolerates legacy records (describeLegacyNode => roleSource=LEGACY_DEFAULT, assertNodeDescriptor
   passes); the LIVE route measurably requires capabilities (400 without) and treats roles as optional
C6 chooseHybridTarget exists but the gateway never calls it (NOT_WIRED frozen as an assertion)
C7 the worker pool is registered but not the active backend; the strict-target guard really is in the claim path
```

**Three of this host's own instrument errors are recorded rather than hidden**: treating `POST /tasks` as able to carry
`targetDeviceRef` (it accepts only `type`; parameters are refused 400); reading the withheld row's fields as `id` and
`reason=UNKNOWN` (they are `taskId` and `STRICT_TARGET_BOUND`); and expecting `classifyTarget` to return `{ok}` (it
returns `{state, claimable, reason}`).

## 7. NOT finished this round (next round continues; nothing is passed off as done)

```text
a the revision-2 five-level check (EM connector/Foreman, RF, GAI, WBC, origin tooling): the only evidence so far is
  that the contract directories exist (contracts/engineering-*, remote-*, general-ai-*, rs-*); the per-item verdicts
  DECLARED / COMPONENT_TESTED / LIVE_WIRED / TWO_HOST_VERIFIED / ORIGIN_AGENT_CONSUMED are not done yet
b the two-host independent walk of sample call chains - the opposite physical host must do it; this host does not
  substitute for it
c the per-file UI->backend dependency matrix and a machine-readable single-writer list
d the "accepted EM/RF/GAI components vs PCF reuse boundary" table (who supplies identity/transport, who supplies
  providers/approvals)
```

This map therefore freezes only what has been measured; `UNKNOWN` here is a conclusion, not a blank.
