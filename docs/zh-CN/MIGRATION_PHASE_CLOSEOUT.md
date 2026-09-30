# 迁移阶段收尾 / 冻结

> 阶段：donor 迁移时代 → 产品整合
> 绑定控制文件：`Digital-City/mission-book/response-9-30.md#R12` 与
> `Digital-City/mission-book/ENGINEERING_BOOK-2026-09-30-PRE-ASSISTANT-UPT-CLOSEOUT.md`
> 由主机 `Alien` 记录于产品分支 `product/upt-pre-assistant-closeout`。

## 1. 本文档的用途

donor 迁移计划（Mission Book MB-001 … MB-012）已经结束，队列中不再有可领取任务。
本文档在**任何产品整合工作开始之前**把该时代冻结为一个可审计的基线，使后续工作无法
悄悄改写已经验收的内容，也无法为了制造更多迁移而重新打开一个已闭环 Mission。

## 2. 冻结基线

```text
SHA: UTOPIA_MAIN d0dea7bcb66cf57edee73c67ddfb9526337dfb4e
SHA: CITY_CONTROL_RECORD 8dfffca0d7a9d0a4f271d9c6dfbe26ba478af4ff
RUNS: MERGED_MAIN_CI 36678805229 PASS
FACT: MB_001_012_ALL_VERIFICATION_COMPLETE true
FACT: MB_010_012_ASSESSMENT NO_VALUE
FACT: MB_010_012_MERGED_MAIN_SHA null
STATUS: MIGRATION_QUEUE_CLOSED
STATUS: REOPENED_MISSIONS 0
STATUS: UNMERGED_IMPLEMENTATION_MISSION_BRANCHES 0
STATUS: BASELINE_TRUTH_RECORDED true
PAIR_STATUS: SYNCHRONIZED
```

该 `main` 提交上的必需 CI：`V0.2 checks` workflow，run `36678805229` ——
`gateway-web` **success**，`android` **success**。

## 3. Mission 台账

| Mission | 完成依据 | 迁移分支合入于 | 备注 |
| --- | --- | --- | --- |
| MB-001 Core OS | implemented | `d81a567` | 迁移的 donor 内核 |
| MB-002 Capability Fabric | implemented | `83ea44e` | |
| MB-003 Worker Gateway | implemented（Owner 接受的 completion repair） | `756c7d7` | 主机分离依 `response-9-30.md#R10` 豁免 |
| MB-004 Project Foreman | implemented | `0eed05b` | |
| MB-005 Host Health | implemented | `cfe34df` | |
| MB-006 Restart Recovery | implemented | `ce33792` | |
| MB-007 Research Institute | Owner accepted | `cb8e0bd` | |
| MB-008 Computer Use | Owner accepted | `168182c` | |
| MB-009 Theme Relocation | implemented | `b4bd602` | |
| MB-010 Node Fabric | `SKIPPED_NOT_REQUIRED` | *（无）* | `NO_VALUE` |
| MB-011 Customs | `SKIPPED_NOT_REQUIRED` | *（无）* | `NO_VALUE` |
| MB-012 Runtime Compliance | `SKIPPED_NOT_REQUIRED` | *（无）* | `NO_VALUE` |

十二个 Mission 在当前 Mission Book front matter 中均为
`migration_complete = true` 且 `verification_complete = true`。

## 4. MB-010 / MB-011 / MB-012 究竟是什么

这三个 Mission 经评估后判定**没有迁移价值**：全部计划能力在领取时点已被 Utopia 等价或
更优覆盖，其余 donor 代码要么在生产中根本没有被构造，要么没有任何消费者。

因此它们被记录为**负结论 provenance**，而不是被转移的能力：

- `assessment_result = NO_VALUE`；
- `migration_completion_basis = SKIPPED_NOT_REQUIRED`；
- `merged_main_sha = null` —— **这三个 Mission 没有任何实现落到 `main`**；
- 没有为它们生成 verified implementation episode。

它们的评估分支**确实**是 `main` 的祖先，但这只是因为 Owner 裁决
`response-9-30.md#R11` 把它们作为 provenance 归档。每一次合并只新增五个文件
（一个事件日志加四个评估证据文件），**零行实现代码**。其原始远端分支被保留。

把那三次合并读成实现合并，或者把 `NO_VALUE` 读成"没做完"，都是错的。它们已经完成，
并且没有任何东西被迁移。

## 5. 分支审计

在冻结基线上，仓库内每一个远端分支都可从 `main` 到达：

```text
refs checked          : 34
unmerged (ahead > 0)  : 0
mission branches      : MB-001..MB-012 all 0 ahead of main
```

因此不存在"已验收但未合并"的实现工作。三个 `mission/MB-010|011|012-*` 分支作为
provenance **保留**在远端，**不删除**。

## 6. 已知的非阻塞 backlog

自 Mission Book 收尾继承而来，且**明确不属于**本阶段：

- 三个已迁移但尚未被消费的 City 模块 —— `fleetNodeStateFor`、
  `createProtectedSurfaceGuard`、`evaluateGuardian` —— 目前只有测试作为消费者；
  给它们接线属于整合工作而非迁移，且这里未获授权；
- MB-003 仍 deferred 的 donor 面（`scheduler.js`、`gate.js`、`system.js`）保持 deferred，
  记录在该模块的 `DONOR.json` 中；
- Room Pack 已挂到 `main`，但**尚未接入 Utopia 的主导航与主机生命周期** ——
  填补这个缺口正是产品工程书的 T1。

这些都不阻塞产品阶段，也都不授权新的 donor 迁移。

## 7. 转换

迁移已经关闭。此后的唯一授权工作是 Pre-Assistant Closeout Workbook 的产品整合序列：

```text
T0  migration closeout / freeze            <- this document
T1  attach the accepted Room Pack to the normal Utopia shell
T2  one canonical Action facade, shared by Web and Android
T3  one deterministic Ask / Do entry
T4  independent product acceptance, merge, merged-main CI
```

本阶段不允许新 Mission、不重开 Mission、不新增 Room、不做人格/个人助理层、不引入
LLM router、不接 Boss/Hns、不做新领域整合、不做任意 shell。T4 之后的下一个阶段
必须等待**新的 Owner 指示**。

STATUS: MIGRATION_PHASE_CLOSED
PAIR_STATUS: SYNCHRONIZED
