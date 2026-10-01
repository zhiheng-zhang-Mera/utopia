# 论文证据——外部恢复后的控制面状态回填滞后

PAIR_STATUS: SYNCHRONIZED
FACT: INCIDENT_ID=CONTROL-PLANE-STATE-RECONCILIATION-LAG-2026-10-01
FACT: TRIGGER=GITHUB_ACTIONS_BILLING_RECOVERY
FACT: FAILURE_CLASS=CONTROL_PLANE_STATE_RECONCILIATION_LAG
FACT: REPAIR_CLASS=AUTHORITATIVE_EXTERNAL_STATE_RECONCILIATION
FACT: DEVELOPMENT_GREEN_AFTER_RECOVERY=41/41
FACT: CORRECTION_COMPLETE_AT_RECONCILIATION=36/41
FACT: STALE_DEVELOPMENT_TASKS=5
FACT: STALE_TASK_IDS=BA-007,BA-009,GAI-009,EM-012,EM-013
FACT: EVIDENCE_POINTER_MISMATCHES=1
FACT: REQUIRED_EVIDENCE_BINDING=BRANCH+HEAD_SHA+CONCLUSION
FACT: DIGITAL_CITY_RECONCILIATION_COMMIT=da309a6ef6a45ed747a270bc6576204b0455c363

## 证据摘要

GitHub Actions 的 Billing/账号级阻断解除后，原先被阻断的 run 已经在各自 exact implementation head 上重新执行成功。执行层已经恢复，但 Digital-City 控制层仍然把 5 个 Development 阶段描述为 Billing blocked。

这 5 个任务是 BA-007、BA-009、GAI-009、EM-012 和 EM-013。它们引用的 run 实际已经 success。同时，Mission Book dashboard 仍停留在最初的 all-unclaimed 快照；GAI-005 的 Correction evidence pointer 还错误指向 RF-009 的 run `36746849199`，而不是 GAI-005 自己的绿色 run `36746845955`。

因此形成了一个不同于 Billing outage 本身的第二事故：

```text
外部执行事实 = 已恢复
Canonical 调度元数据 = 仍然过期
一个绿色 evidence pointer = 指向错误任务/branch
```

如果调度器只消费过期控制面，就可能错误压制已经可领取的 Correction，或者在真实外部门禁已经打开后仍然不唤醒 programme integration。

## Reconciliation 修复

Digital-City 提交 `da309a6ef6a45ed747a270bc6576204b0455c363` 完成当前控制事实回填：

- 5 个恢复后的 Development 按 exact green head 标为 COMPLETE；
- 历史 Billing 失败继续保留在 report/evidence，不被擦除；
- GAI-005 Correction CI 改为绑定自己的 run `36746845955`；
- dashboard 重算为 41/41 Development green、36/41 Correction complete；
- Remote Fabric 记录为 10/10 + 10/10，并解锁 programme integration；
- 跨 programme 契约新增强制规则：外部恢复后，以及 pool-drain / merge / terminal 判断前必须做权威状态 reconciliation。

强制证据绑定为：

```text
task branch == run head_branch
task head   == run head_sha
required stage terminal state == run conclusion/status
```

机器可读的事故摘要保存在 `evidence/raw/control-plane-reconciliation-2026-10-01/incident-summary.json`。

## 学到的规则

外部系统变绿并不等于恢复闭环。只有 Canonical control metadata 已根据权威源完成回填，外部恢复才算真正完成。

本记录作为 Utopia 后续调度器/控制面自进化狗粮保留，不把失败过程润色成单纯的成功叙事。
