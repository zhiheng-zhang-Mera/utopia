# 论文证据——异步调度中的瞬时静默

PAIR_STATUS: SYNCHRONIZED
FACT: INCIDENT_ID=ASYNC-DISPATCH-TRANSIENT-QUIESCENCE-2026-10-01
FACT: GLOBAL_COMPONENT_TASKS=41
FACT: DEVELOPMENT_IMPLEMENTED=41
FACT: FULLY_TWO_STAGE_COMPLETE_AT_FINAL_SNAPSHOT=20
FACT: CORRECTION_CODE_COMPLETE_CI_BLOCKED=2
FACT: DEVELOPMENT_CODE_COMPLETE_CI_BLOCKED=5
FACT: DEVELOPMENT_GREEN_WAITING_CORRECTION=14
FACT: UTOPIA_MAIN_STAYED_AT=82ed36933fb4c5b00e44768d9e1aedec1d525d9c
FACT: FAILURE_CLASS=TRANSIENT_ZERO_ELIGIBILITY_MISREAD_AS_TERMINAL_OR_PARKABLE
FACT: REPAIR_CLASS=ELIGIBILITY_AWARE_BOUNDED_RESCAN
FACT: DEFAULT_RESCAN_INTERVAL_MINUTES=20
FACT: STRUCTURAL_INELIGIBILITY_BYPASSES_PERIODIC_RESCAN=true
FACT: GLOBAL_EXTERNAL_BLOCK_BYPASSES_PERIODIC_RESCAN=true
FACT: SINGLE_EMPTY_SCAN_PROVES_POOL_DRAINED=false

## 证据摘要

四条 programme 并发施工暴露出一个调度层失败模式：任务资格会动态变化，但主机退出依据的是某一个瞬间的扫描。因此，即使全局任务池没有完成，worker 也可能在另一台主机即将把任务推进到“可领取”状态之前退出。

控制仓库观测序列：

| 时间 (+10) | 控制提交 | 观测 |
| --- | --- | --- |
| 03:32:29 | `b2672fa` | Alien 记录 RF-006 Correction 代码完成但 hosted CI 无法启动，随后停止 |
| 03:36:42 | `d9201af` | Mech 领取/完成 BA-007 Development 的本地实现，CI 外部阻断 |
| 03:42:35 | `802d4c9` | Mech 领取/完成 EM-013 Development 的本地实现，CI 外部阻断 |
| 03:48:00 | `d4e2847` | Mech 领取/完成 GAI-009 Development 的本地实现，CI 外部阻断 |

最终可见状态为 41/41 已实现，但只有 20/41 完成双阶段；2 个 Correction 和 5 个 Development 已代码完成但被 hosted CI 阻断，另有 14 个 Development 已绿、等待另一台主机 Correction。

机器可读的原始事件摘要保存在 `evidence/raw/async-dispatch-2026-10-01/incident-summary.json`。

## 学到的调度规则

某一时刻 eligible set 为空，不能直接解释为 terminal，除非全局任务池本身已经终态。未来编排必须区分 `TEMPORARILY_UNCLAIMABLE`、`STRUCTURALLY_INELIGIBLE`、`GLOBAL_EXTERNAL_BLOCK` 和 `POOL_TERMINAL`。

`TEMPORARILY_UNCLAIMABLE` 的默认恢复：park，并在约 20 分钟后重新进入全局扫描。结构性无资格和明确的全局外部阻断不要求周期重试。

本记录故意保留失败过程，不将其润色成“顺利完成”的成功叙事。
