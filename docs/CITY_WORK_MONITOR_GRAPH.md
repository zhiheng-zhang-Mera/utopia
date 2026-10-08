# MON-902 — City Work Monitor: overview graph and node/path inspector

Bilingual summary / 中英对照说明 of what MON-902 adds and how to use it.

## What you get / 你得到什么

A **City monitor** page in the Web control surface. It reads the canonical observation projection
(`GET /api/v0/monitor/graph`) and answers, in one screen:

- what needs attention right now, in plain language;
- what is only worth watching;
- what cannot be determined at all from this picture;
- and what the monitor can never tell you, so a calm screen is never mistaken for a complete one.

Web 控制面新增**全城监视器**页面，读取规范观察投影（`GET /api/v0/monitor/graph`），在一屏之内回答：
当前哪些事项需要处理、哪些只需留意、哪些根本无法从这张图判定，以及这个监视器永远看不到什么——因此"看起来平静"
永远不会被误读为"一切完整"。

## Three levels / 三个层级

```text
Level 0  Overview          risk first, then watch, then unknown, then other work, then collapsed clusters
Level 1  Node / Path       what / why / who / what next, and the paths attached to that node
Level 2  Technical         raw projection fields, exact references, counts, reflow key — one explicit disclosure
```

```text
Level 0  总览        风险优先，其后是留意项、无法判定项、其他工作、被折叠的簇
Level 1  节点 / 路径  是什么 / 为什么 / 谁负责 / 下一步，以及该节点上的路径
Level 2  技术细节    投影原始字段、精确引用、计数、重排键——单一显式折叠入口
```

## The rules this surface keeps / 本界面遵守的规则

1. **Risk may be collapsed, never hidden.** When the graph is too large, unremarkable work is clustered; a node
   carrying active risk is always drawn on its own, and every cluster reports the risk inside it.

   **风险可以折叠，绝不隐藏。** 图太大时，无异常的工作会被折叠成簇；带活跃风险的节点始终单独绘制，且每个簇都会报告
   其中包含的风险。

2. **A monitor that cannot see must not look calm.** Health, history gaps, omitted populations, unknown retry history
   and unexplained paths are stated at the top of the overview, not buried.

   **看不见的监视器不许显得平静。** 健康状况、历史缺口、被省略的总体、不可知的重试历史、无法解释的路径，都在总览顶部
   说明，而不是埋起来。

3. **Absence is never claimed from a truncated window.** "Nothing has been retrying" is only sayable when the event
   window is continuous; otherwise the answer is "cannot be determined", never a comfortable zero.

   **窗口被截断时绝不声称"没有发生"。** 只有事件窗口连续时才可以说"没有任何东西在重试"；否则答案是"无法判定"，
   而不是一个令人安心的零。

4. **Raw vocabulary stays behind one gate.** Risk codes, state tokens, exact references and the reflow key appear only
   inside the Technical details disclosure.

   **原始词汇只留在一个门后。** 风险代码、状态 token、精确引用与重排键只出现在"技术细节"折叠中。

5. **The monitor decides nothing.** It offers no control that would change the city; the decision overlay is MON-903.

   **监视器不做任何决策。** 它不提供任何会改变城市的控件；决策叠加层属于 MON-903。

6. **Layout is stable.** Row order comes from the projection's deterministic ordering, so a live event cannot reshuffle
   the graph under the pointer.

   **布局稳定。** 行序来自投影的确定性排序，实时事件不会在指针下把图重排。

## Surfaces / 界面载体

```text
Web         nav: City monitor  (L1_PRIMARY), page id `Monitor`, route GET /api/v0/monitor/graph
Android     NOT in this task. The parity decision and its reason are recorded in the development report: the Compose
            surface should be built once, together with the MON-903 decision overlay, rather than twice.
```

## Evidence / 证据

```text
tests/mon902-monitor-graph.test.mjs   14 probes  projection rules: risk bubbling, no-false-safe, truncation honesty,
                                                 edge causality, clustering, layout stability, interaction budget
tests/mon902-monitor-panel.test.mjs   11 probes  surface rules: risk visible, no raw vocabulary outside the gate,
                                                 calm never over a blind city, escaping, both locales, real route wiring
```
