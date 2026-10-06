# MON-902 plan — Overview graph + node/path progressive disclosure

Baseline `7eb38f1b930dfe6cc13dab0e17dedee467b1254b` (dependency union = MON-901 accepted head, which contains `main`).
Worktree `D:/utopia-mon902`, branch `mon/MON-902-mech-overview-graph`. Development host Mech (Mech-DS).

## 1. What MON-901 already gives us (do not rebuild)

`services/dev-gateway/observation.mjs` → `createObservation({read})` → `refresh()` returns one non-authoritative view:

```text
{schemaVersion, authoritative:false, eventSource:'CANONICAL_GATEWAY_STORE', cityId,
 health: COMPLETE|PARTIAL|UNAVAILABLE|DISCONNECTED, scope:'BOUNDED_CANONICAL_WINDOW',
 safeSummaryAvailable:false, unobservedTaskRisk:bool, stale?,
 nodes: [{kind:'HOST', id, displayName, online} | {kind:'TASK', id, state, taskType, hostRef, ownerRef:null,
          ownerObservability:'NOT_OBSERVABLE', progress}],
 edges: [{from, to, type:'ASSIGNED_TO', reason, targetPresent}],
 events:[{canonicalEventId, seq, type, taskRef, actorRef, timestamp, evidenceRef}],
 evidence:[{canonicalEventId, seq, source, path:'/api/v0/events', cityId}],
 completeness:{tasksOmitted, nodesOmitted, eventsOmitted, historyGap, firstSeq, lastSeq, canonicalHighWatermark, ...},
 observedAt, projectedAt, projectionLatencyMs}
```

Route already exists: `GET /api/v0/monitor` → `{monitor: await observation.refresh()}`.

## 2. Rule the graph must not break (CITY_WORK_MONITOR README §2.3)

The monitor is a **projection**, never a second task truth. So MON-902 adds **no new persisted state, no scheduler,
no decision logic** (that is MON-903). The graph is a pure function of one observation view.

## 3. Deliverables

1. `services/dev-gateway/monitor-graph.mjs` — pure `buildGraph(view, options)`:
   - `nodes` with derived `risk` (`NONE | WATCH | ACTIVE`) and `riskReasons` (typed, each carrying its own evidence ref);
   - `edges` with causality completeness (`reason`, `reasonSource`, `targetPresent`) and an `incomplete` flag;
   - `clusters` — auto-collapse when the visible node count exceeds a budget (default 120), by kind/state;
   - `summary` for the overview: counts per state, `activeRiskPresent`, `riskBubbled`, `falseSafeSummary:false`,
     `unobservedRisk` (carried from MON-901's completeness), `ownerRequired`;
   - `layout` — deterministic ordering so a refresh does not reshuffle the graph (`reflow` is a function of structure,
     not of time or of event arrival).
2. `GET /api/v0/monitor/graph?edges=…&collapse=…` on the gateway, built from the same single-flight observation; no
   new canonical read path, no lock, no timer.
3. `apps/web/monitor-graph.js` — pure string builders `monitorOverview(graph)`, `monitorNodePanel(graph, id)`,
   `monitorPathPanel(graph, edgeId)`, `monitorTechnicalPanel(...)` with L1/L2/L3 disclosure; wired into the shell as
   its own page; i18n keys in both locale packs; no raw token leaks by default.
4. Tests:
   - `tests/mon902-monitor-graph.test.mjs` — projection rules (risk bubbling, no false-safe summary, edge causality,
     honest `NOT_OBSERVABLE` when the window is truncated, collapse, layout stability, navigation depth).
   - `tests/mon902-monitor-panel.test.mjs` — UI rules (user language, risk visible, technical detail behind an
     explicit Advanced disclosure, escaping, both locales, shell integration, no duplicate ids).
5. Evidence + bilingual docs + `CAP-MON-002` registry record + `PAPER_MATERIAL_INDEX.md`.

## 4. Honesty rules that decide the implementation

- **Never claim absence from a truncated window.** "No repeated retry" is only sayable when
  `completeness.historyGap === false`; otherwise the risk is `NOT_OBSERVABLE`, never `NONE` (§14B: no `0` for unknown).
- **Risk may be hidden in the overview, but never dropped**: every `ACTIVE` risk in the graph must be reachable from
  the overview within the interaction budget (≤3 steps), and the overview shows the count plus the worst severity.
- **`PARTIAL` / `UNAVAILABLE` health is itself a risk**, because a monitor that cannot see must not look calm.
- **Edge causality**: an edge whose `reason` is missing is `incomplete`, not merely quiet; it is reported.
- **No model calls, no timers**: the graph is computed on request from the canonical window.

## 5. Order of work (vertical slice first, §14A.7)

```text
projection + route  → projection tests → Web overview on the real route → node/path inspector
→ technical disclosure → UI tests → docs/evidence/registry → development report
```
