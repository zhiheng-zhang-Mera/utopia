# Three-device mesh + task execution demo runbook

> Functional baseline: MESH-301 accepted at `9f3e20e8ec99d591812430bee71d27e68c4ad498`, plus later documentation/linkage-only commits.
>
> Before recording, the current `main` GitHub Actions run must still be green.

## Demo topology

The current "three devices" should be described accurately as:

1. **Alien Windows** — worker node `Alien-Win` plus a Web control surface;
2. **Mech Windows** — worker node `Mech-Win` plus a Web control surface;
3. **Physical Android device** — a control surface, **not** a worker node.

All three endpoints connect to the **same canonical City**. Android can observe state, create work, and strict-target a real Windows worker, but it must not be presented as a third execution worker.

## Recommended recording sequence

### 0. Preflight

- Both Windows machines and Android are mutually reachable on the current network;
- the canonical City is running and has printed the actual address for this session;
- `Alien-Win` and `Mech-Win` are online;
- Android has joined through temporary pairing;
- Web and Android are connected to the same City;
- current Utopia `main` CI is green;
- any window containing a permanent token, `.runtime/local-config.json`, private path, or personal information is hidden.

Do not expose a permanent bearer token in the recording. If a temporary QR/short code is shown, invalidate or rotate it afterwards.

### 1. Prove all three endpoints are in one City

Use a split view or quick cuts:

- Alien Web shows `Alien-Win` and `Mech-Win` on the device/node surface;
- Mech Web shows the same two workers;
- Android stays ONLINE and shows the same City's node state.

The point is not that three UIs look the same; it is that **all three endpoints read the same canonical truth**.

### 2. Android -> Alien-Win task

Using Android's existing Run / target-device flow:

- select `Alien-Win`;
- submit a task;
- keep the task id/state transition visible;
- switch to Alien Web/Activity and show the Alien worker actually owns the task;
- wait for COMPLETED;
- return to Android and show the same task's final state/result.

This is the strongest visual proof that a phone is controlling a real PC worker.

### 3. Alien Web -> Mech-Win task

From Alien Web:

- choose `Mech-Win` as the target;
- submit a task;
- show on Mech that the Mech worker owns it;
- return to Alien Web and show the result returning to the original control surface.

This proves strict target-device routing is not an Android-only path.

### 4. Optional: Mech Web -> Alien-Win

For a visually closed loop, add:

`Mech Web -> Alien-Win -> COMPLETED -> result on Mech Web`

This is optional. The first two task runs are already enough to demonstrate three-device connectivity plus two real execution workers.

### 5. Finish on Activity/events

Show:

- the three connected control endpoints/clients;
- the two worker nodes;
- target node, status, and completion for the two tasks just run;
- no UNKNOWN-target fallback and no duplicate terminal completion.

## Do not do these things in the recording

- Do not claim there are "3 workers": the current topology is **2 workers + 3 control endpoints**.
- Do not intentionally break networking just for spectacle; offline/reconnect is a separate resilience demo.
- Do not conflate remote handoff with strict-target routing.
- Do not expose permanent tokens, local-config, or private pairing secrets.
- Do not present a historical fixed IP as a product contract; use the address printed by the current run.

## Suggested title

**Utopia 3-End Mesh Demo — Android controlling two Windows workers**

Avoid:

**Three devices all acting as AI workers and executing each other's tasks**

because that does not match the current architecture.
