# MON-903 — Event-triggered decision overlay and escalation provenance

Bilingual summary / 中英对照说明 of what MON-903 adds, and of the two things it deliberately does **not** do.

## What you get / 你得到什么

A **Decision provenance** page in the Web control surface, and three routes behind it:

```text
GET  /api/v0/monitor/decisions          the bounded decision window + metrics
GET  /api/v0/monitor/decisions/<id>     one decision receipt
POST /api/v0/monitor/decisions          ask for a decision (owner only)
```

The page answers, in one screen:

- which decisions the City recorded, what triggered each one, who resolved it and how long it took;
- which decisions are **waiting for the owner** (shown first, because they are the only ones that need a person);
- where each decision came from: the canonical event id and sequence it cites;
- what the City is **not** able to observe, stated as `NOT_OBSERVABLE` rather than as a zero.

页面上方会先显示等待所有者处理的决策；每条决策都带有触发事件、解决方、耗时与规范事件证据。无法观察的指标会明确写成
`NOT_OBSERVABLE`，不会填 0 冒充。

## What a decision is / 决策是什么

The overlay watches the canonical event stream. Only a few events genuinely require a choice:

```text
TASK_FAILED                 -> FAILED
TASK_TARGET_WAITING         -> BLOCKED
TASK_HANDOFF_REFUSED        -> RESOURCE_CONFLICT
NODE_OFFLINE                -> RESOURCE_CONFLICT   (only when work is actually waiting on that node)
NODE_SHARING_CHANGED        -> RESOURCE_CONFLICT   (same condition)
JOIN_REQUEST_CREATED        -> OWNER_DECISION_CANDIDATE
RESEARCH_EXPERIMENT_REJECTED-> OWNER_DECISION_CANDIDATE
```

Everything else — heartbeats, progress reports, completed work, resource samples, client connections — is recorded and
**never** becomes a decision. The four trigger kinds that no canonical event expresses yet (review readiness, retry
request, scope change, merge gate) can be submitted explicitly by the owner.

Heartbeat、进度回报、已完成工作、资源采样、客户端连接只记录，绝不进入决策路径。规范事件尚未表达的四种触发，只能由
所有者显式提交。

## The ladder / 决策梯

```text
deterministic rule            (an attributable failure, a blocked target, a resource conflict)
   ↓ unresolved
fast model (optional seam)    (only when no rule applies - e.g. a failure whose cause the record does not state)
   ↓ uncertain / invalid / timeout
critic (optional seam)
   ↓ owner boundary
Owner
```

- An **owner boundary** (scope change, merge gate, review readiness, owner-decision candidate) goes straight to the
  owner; no resolver is consulted, because an owner matter is not an inference problem.
- A resolver returns a **bounded contract**: an action from a closed vocabulary, an optional confidence in `0..1`, and a
  reason of at most 120 characters. Free text is never authority. A resolver that hangs, throws or returns something
  outside the contract becomes a **fallback with a typed code**, and the decision escalates.
- A rule never reports a confidence: a deterministic rule is not a probability.

## What it never does / 它绝不做什么

1. **It applies nothing.** The overlay receives a task *reader* and no writer. Every receipt says
   `appliedBy: null` and `application: RECORDED_ONLY`, so a recommendation cannot be mistaken for a performed action.
   The page repeats this in words.
2. **It never blocks the City.** Decisions are queued **per task**, bounded per task, and run in parallel across tasks.
   `observe()` is called from the canonical event path and is never awaited; it cannot throw. There is no city-wide lock
   anywhere, so one task's pending decision cannot delay another task's work. The metrics report this as
   `unrelatedTaskBlocking: ABSENT_BY_CONSTRUCTION` with the basis stated.

叠加层只读取任务，没有任何写入权限；每条回执都写明 `appliedBy: null`（无人执行）。决策按任务分别排队、有界、可并行，
`observe()` 在规范事件路径中调用但从不被等待，也不会抛出，因此不存在全城锁。

## Reading the metrics / 指标怎么读

```text
bySource                  RULE | FAST_MODEL | CRITIC | OWNER
ownerRequired             how many decisions needed a person
autoResolutionRate        null + reason when no decision has been recorded (never a fabricated 0)
timeouts                  how many decisions fell back because a resolver timed out
meanDecisionLatencyMs     measured only where a decision actually happened
unrelatedTaskBlocking     ABSENT_BY_CONSTRUCTION (structural, with the basis stated)
unsupportedSources        what this overlay cannot answer - e.g. "wrong auto-decision and repair",
                          which needs an independent judge rather than the overlay judging itself
```

## Where this is going / 后续归属

`MON-990` owns cross-device monitor acceptance and reality reconciliation. The decision window is currently surfaced as
its own Advanced page because the City monitor page that will host it (MON-902) is developed separately; the projection
already carries the decisions (`GET /api/v0/monitor` → `monitor.decision`), so folding the panel into that page later is
a presentation change, not a data change.
