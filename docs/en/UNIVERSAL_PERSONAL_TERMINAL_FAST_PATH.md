# Utopia Universal Personal Terminal — Fast Path

> Scheduling priority after V0.3 hardening. Historical Wave plans and acceptance records remain valid evidence; this document changes **what should be built next**, not what already passed.

## 1. Product target

Utopia should feel like **one personal terminal**, not three engineering consoles.

The user should be able to open Utopia on Windows/Web or Android and think:

> “Tell Utopia what I want; it finds the right local tool, City capability, device node or external runtime, then gives me one truthful result/history.”

The target experience is:

```text
one Utopia shell
  ↓
one Ask / Do command entry
  ↓
one Action model
  ↓
routing
  ├─ local Room
  ├─ City Capability Bridge
  ├─ runtime Node
  ├─ Boss connector
  ├─ Hns connector
  └─ later domain connectors
  ↓
one result / progress / history experience on Web + Android
```

Utopia remains a product/reference implementation. It does not become permanent City Core ownership.

---

## 2. What already exists

At main `393f3b89a9c4fae61be1e431c4bcd47fee945e88`:

### Product/control
- Web control surface;
- Android control surface;
- pairing / QR / mDNS / BLE / manual paths;
- device/node state and telemetry;
- task/activity views.

### Capability plane
- five accepted bridged services:
  - Document Intake;
  - Knowledge Query;
  - Skill Inspect;
  - Evidence Review;
  - Theme Generate;
- qualified identities and lifecycle-aware availability;
- bounded invocation summary/detail retention;
- typed failures;
- Web/Android digest parity and recovery evidence.

### Local personal tools
Room Pack V1 already has ten accepted rooms:

- Knowledge;
- Bookmarks;
- Checklist;
- Prompt Library;
- Text Workshop;
- Hash;
- Data Lab;
- Focus;
- Calendar;
- Decisions.

The Room Pack is already attached to main, but not to Utopia's main navigation/lifecycle.

**The bottleneck is therefore experience fragmentation, not lack of functions.**

---

## 3. Current conflict: three user planes

Today a user must understand three different concepts:

```text
Tasks
  City Control v0
  runtime execution state

Services
  Capability Bridge
  module invocation state

Rooms
  local personal tools
  separate local Hub
```

These backends may stay separate, but the **product must stop exposing that separation as the primary mental model**.

A Checklist item must not become a City Task. A Room must not pretend to be a promoted City module. A capability invocation must not be rewritten as an Engineering task.

Instead, add a user-level facade over them.

---

# 4. Fast implementation order

## T1 — Attach what already works

**Goal:** make Utopia immediately feel larger without adding new domain logic.

1. Start the Room Hub from the normal Utopia host launcher lifecycle.
2. Add **Rooms / Tools** to the main Web shell.
3. Surface the ten accepted Rooms from Utopia Home as user tools.
4. Keep the Room Hub loopback-only; do not weaken its existing isolation merely to expose it.
5. On Android, initially show Room availability and launch/consume only through a later authenticated bridge; do not expose port 4320 directly to LAN.

Visible result:

```text
Utopia
├─ Home
├─ Ask / Do        (T2)
├─ Tools / Rooms   ← ten useful local tools
├─ Devices
├─ Activity
└─ Advanced
   ├─ Services
   └─ Tasks
```

**Do not build another Room before this integration.**

---

## T2 — Create one Action facade

**Goal:** unify user-facing history without merging backend ownership.

Introduce a product-level Action record that can reference an existing backend execution:

```text
Action
├─ actionId
├─ requestedIntent
├─ route
│  ├─ ROOM
│  ├─ CAPABILITY
│  ├─ CITY_TASK
│  ├─ BOSS
│  └─ HNS
├─ backendRef
├─ target
├─ status
├─ progress
├─ resultRef
├─ error
└─ timestamps
```

The facade **adapts** existing IDs/statuses. It does not replace or rewrite:

- City tasks;
- capability invocations;
- Room data models.

Web and Android should read the same Action truth.

Then the current **Tasks** and **Services** pages become advanced/debug views rather than the normal starting point.

---

## T3 — Add one Ask / Do command bar

**Goal:** remove the need to manually choose the subsystem first.

Start with deterministic routing and explicit user confirmation; an LLM router is optional later.

Examples:

```text
“Read this PDF”
→ Document Intake

“Search what that document said about X”
→ Knowledge Query using the document result

“Add buy milk to a checklist”
→ Checklist Room

“Save this link”
→ Bookmark Room

“Hash this file”
→ Hash Room

“Run this safe task on Alien”
→ City Task / Node

“Check this evidence bundle”
→ Evidence Review
```

Routing rules:

1. high-confidence deterministic match → show route and run;
2. several plausible routes → show 2–3 choices;
3. side-effecting/destructive route → require explicit confirmation;
4. no route → show capability search/manual picker.

A general AI model must not be required to route basic local commands.

---

## T4 — Connect existing Boss and Hns; do not migrate them first

This is the step that turns “personal utility dashboard” into **general personal terminal**.

### Boss connector

Expose a thin stable connector to existing Boss-owned capabilities such as:

- general Chat / Work;
- provider routing;
- research workflows;
- global task/orchestration where appropriate.

Utopia owns the user shell; Boss keeps its runtime/domain ownership.

### Hns connector

Expose Hns as the Engineering provider:

- project/repository work;
- coding-agent dispatch;
- Engineering progress/results.

Utopia should send a bounded Engineering request and display the returned Action state. It should **not** copy the Hns runtime into Utopia.

Target mental model:

```text
Ask Utopia
  ├─ ordinary question → Boss/general provider
  ├─ engineering work → Hns
  ├─ local personal utility → Room
  ├─ document/knowledge/evidence → City service
  └─ device action → Node/Automation
```

This provides much more “universal” value than migrating Health, Quant or Digital-Me first.

---

## T5 — Add a Personal Workspace / Inbox

**Goal:** give the terminal continuity between commands.

Minimum scope:

- recent files intentionally handed to Utopia;
- recent text/snippets;
- recent Actions;
- pinned Rooms/capabilities;
- explicit user notes/bookmarks;
- result references/digests.

This is **user-owned workspace data**, not Digital-Me identity/memory.

Reuse rather than merge:

- Room Knowledge can store simple personal notes;
- 09 Knowledge Core can provide retrieval/trust semantics;
- Document Intake parses files;
- Action history references results.

Do not create an autonomous “memory brain” at this stage.

---

## T6 — Cross-device handoff

After Actions and Workspace are canonical:

- start an Action on Web, inspect it on Android;
- upload/select a file on Android, continue analysis on Windows;
- choose target node when necessary;
- preserve one action ID/result truth across clients;
- make offline/cached state explicit;
- reconnect without duplicate execution.

Android does not need to become a full compute Node to participate; it can remain a control/client endpoint until it advertises executable capabilities.

---

## T7 — Make the host always ready

A daily personal terminal should not begin with a developer ritual.

Package the existing processes behind one supported host lifecycle:

```text
Utopia Host
├─ Gateway
├─ reference/runtime Agent
├─ Room Hub
└─ health/restart supervision
```

Priority items:

- one launcher;
- optional Windows tray/background startup;
- visible health/restart state;
- automatic reconnect;
- graceful stop/restart;
- reuse dsh-health-scheduler / dsh-restart semantics through adapters where useful;
- no public Internet exposure required.

This is productization, not a City-Core rewrite.

---

## T8 — Attach domains only after the terminal spine works

Then add domain cards/connectors independently:

- Digital-Me;
- Health / Drug Simulator;
- Quant;
- Automation / Computer Use;
- VR/AR/devices;
- richer Research;
- voice/avatar/presentation.

Each domain should be able to appear as:

```text
capability + route + Action result
```

without changing the main terminal interaction model.

---

# 5. What to postpone

To reach the intended feel quickly, do **not** make these blockers:

- physical Theme Engine move from `city/11` to its new 00/05 ownership;
- D9 theme-builder expansion;
- General Logic Engine implementation;
- Customs / Runtime Compliance extraction;
- Health/Quant/Digital-Me migration;
- public cloud/networking;
- 3D City visualization;
- iOS/HarmonyOS/Linux clients;
- full autonomous memory;
- arbitrary shell access.

The existing Theme Generate service is already enough for the terminal milestone.

---

# 6. Minimal “universal personal terminal” acceptance

The milestone is reached when the following can be demonstrated on one Windows host + one physical Android device:

1. Utopia starts as one supported host product and brings up its required local services.
2. Web Home exposes the accepted local Rooms without launching a separate mental product.
3. Web and Android both have the same **Ask / Do** entry.
4. A document request routes to Document Intake and its result can continue into Knowledge.
5. A personal utility request routes to a Room (for example Checklist or Bookmark).
6. An ordinary AI request can route through a Boss/general-provider connector.
7. An Engineering request can route through Hns.
8. A device/runtime request can target the appropriate Node.
9. All four routes appear as one Action/history model with truthful backend provenance.
10. An Action started on one client can be inspected from the other without duplicate execution.
11. Offline/restart state is visible and does not turn stale RUNNING into false success.
12. No Health, Quant, Digital-Me, VR or theme-builder migration is required to pass this milestone.

At that point Utopia already has the intended **“one terminal, many abilities”** feel. Later City buildings increase what the terminal can do; they no longer determine whether it feels like a terminal.
