# PCF complete-flow candidate / PCF 完整流候选施工

> For agentic workers: use superpowers:executing-plans for continuous inline execution. A single whole-branch code review precedes the final physical-host handoff.

Goal: develop the existing PCF-700–728 programme on Alien and publish one independent pending-verification branch. 在 Alien 本机完成可实现的全线施工，以独立待验证分支提交。

Architecture: preserve canonical City Task/Action, enrollment, engineering ConnectorPort, WBC and REX owners. PCF supplies versioned policy, workload, proposals, reservations, artifacts, attempts and projections; it does not create another task database.

Tech Stack: Node 24 ESM, existing SQLite Store, existing Web/Android clients and engineering contracts.

Spec: Digital-City `mission-book/mission-group/personal-compute-fabric`, snapshot e41674e472d6d2a2f7050c4747878473c2805511. Existing 29 books (700–728), including optional 717–720/722/723. Reserved 790/990 are not additional existing books.

Global Constraints:
- SINGLE_BATCH_OPPOSITE_HOST_VERIFICATION. The complete flow will be submitted once to Mech; individual components will not be handed off for separate physical validation. 整条完整流一次性交给对侧主机验证，不分拆逐任务异机验收。
- This user-authorized development order supersedes per-book activation/handoff ordering for this isolated branch only. Historical accepted and review records remain unchanged. 本分支允许未异机验收的本机组件继续组合开发；不修改历史验收事实。
- Local tests, real local execution, simulated transport and physical opposite-host verification are distinct evidence classes. No main merge. No cloud fees, new credentials, privileged installation or arbitrary session takeover.
- Preserve logs including failures; unavailable external prerequisites are NOT_RUN, not PASS. Optional scope is tracked, not silently omitted.

Review Focus: malformed/versioned inputs, stale authorization and observations, quota race, crash-before-start, old epoch receipts, artifact traversal/revocation, bounded process I/O/cancellation, origin session ownership, concurrent workloads and optional hardware honesty.

## Execution units / 施工单元

1. Preserve 700/701 baseline and Windows repair; branch from cf07f4a and merge current main. Write this protocol and a durable ledger; publish candidate branch.
2. Foundation: 706 effective consent/budget policy, 725 provider boundary, 726 capsule/receipt, 708 workload. Write negative tests first, observe RED, implement GREEN, commit.
3. Scheduling: 702 feasibility before ranking/cost intervals, 704 atomic admission/quota/fair queue and canonical state seam. Test stale policy, resource unknown, CAS races and release.
4. Execution: 709 authorized bounded artifact/cache, 710 actual allowlisted CPU process, 711 explicit checkpoint, 712 durable supervision/epochs. Test digest, cancellation, restart and late output.
5. Composition: 703 explicit DAG/credit, 705 recovery, 713 reversible SLO ladder, 714 authorized origin cursor, 715 existing UI projection and 716 opt-in deployment. Run combined local CPU workloads and existing compatibility checks.
6. Engineering: 727 existing ConnectorPort adapter, 728 canonical session-bound bridge, 724 two real software pilots; inspect installed provider before attempting live execution. No synthetic provider acceptance.
7. Research: 707 existing REX sidecar, 721 frozen comparison protocol and 723 shadow adaptation. Record actual local measurements and absent cross-host values separately.
8. Optional: 717 real model residency, 718 Linux worker, 719 Android opt-in worker, 720 real accelerator telemetry, 722 fenced continuity. Probe available prerequisites, develop fail-closed seams and record unavailable physical evidence explicitly.
9. Run appropriate complete suites/builds, whole-branch independent code review, repair verified findings. Publish exact source SHA, hashes/logs, per-book evidence matrix and ONE complete-flow Mech handoff. Keep all unobserved physical acceptance pending.

## Progress / 进度

2026-10-07: isolated worktrees created; cf07f4a preserved, origin/main merged without conflicts. Implementation has not yet met full programme acceptance. 已建立隔离工作树，保留原基线并合入当前 main；全系列验收尚未完成。

## 中文施工说明 / Chinese execution specification

架构：保留既有 City Task/Action、设备注册、Engineering ConnectorPort、WBC 和 REX 的单一所有权；PCF 仅提供版本化策略、工作负载、放置提案、预留、工件、执行尝试和投影，不建立第二份 task 数据库。

技术栈：Node 24 ESM、既有 SQLite Store、Web/Android 客户端及工程契约。规格快照为 Digital-City e41674e 下的 29 本 PCF-700～728 任务书，包含六本可选任务；保留的 790/990 尚无任务书。

全局约束：整条完整流一次性交给 Mech；本机组合施工允许未异机验收的组件作为后续开发输入，但历史验收记录不变。区分本机测试、真实本机运行、模拟传输和实体异机验收。不得合并 main、产生云端费用、增加凭据、执行特权安装或接管任意会话。失败日志照常保留，缺少前提不能标记 PASS。

审查重点：版本化异常输入、过期授权与观测、配额竞争、启动前崩溃、旧 epoch 回执、工件路径和撤权、进程输出限额与取消、原会话所有权、并发负载、可选硬件证据。

施工单元：1 保留基线、隔离分支、日志；2 开发 706/725/726/708 基础契约；3 开发 702/704 可行性与原子准入；4 开发 709/710/711/712 工件、执行、checkpoint 和监督；5 组合 703/705/713/714/715/716；6 接入 727/728/724 工程与原端；7 连接 707/721/723 研究及影子策略；8 核查并开发具备前提的 717/718/719/720/722 可选能力；9 测试、独立整体代码审查、修复，并生成带源码 SHA 和逐任务缺口的整体待验证包。组件先写失败反例、再修复验证；无法观察的实体验收保持待验证。

当前账本：首批组件测试与真实本机 CPU 流已运行。独立代码审查的任务所有权、attempt 保留限额、工件多实例竞争，以及可选前提字符串误判均已用 RED→GREEN 修复。新 UI 仅只读；完整任务书覆盖仍未完成。普通全回归尝试保留失败：常驻 City 占用协调端口，三个 launcher 测试拒绝干扰；默认高并发另触发一个既有计时断言。随后使用低并发验证可运行集合，launcher 实机用例单独记录环境阻塞。

Execution ledger: component and real local CPU flow checks ran. Independent-review ownership, attempt retention, artifact multi-instance race and optional string-state findings were repaired RED→GREEN. The new UI is read-only; full workbook coverage remains incomplete. Initial full regression retained failures: three launcher cases refused to disturb the resident City; default high concurrency also triggered an existing timing assertion. The available set is subsequently checked with lower concurrency; launcher cases retain an explicit environment block.

Ruling: retain 15b1e61 as immutable Stage A evidence; continue independent remaining components with subagent-driven-development and dispatching-parallel-agents, while the root owns integration and one physical handoff. This avoids stopping at a partial candidate; cost if wrong is component rework, not changed historical acceptance. 裁定：保留 15b1e61 阶段 A 证据不变，后续互不重叠的组件采用子代理并行施工，主代理统一集成及一次性异机交接；如判断有误，仅产生组件返工，不改变历史验收。

Stage B/C ledger: artifact resumable transfer, durable cleanup journal/quota, checkpoint fencing, Android foreground opt-in worker and reversible deployment controller completed component reviews. Canonical Task success now uses COMPLETED (capsule/Action retain SUCCEEDED); Stage A CPU evidence does not establish canonical state conformance. Local service persists the owned child identity before stdin, excludes legacy worker claims/reports, retains unknown reservations and refuses automatic supervisor takeover. Engineering runtime/tools, opt-in Gateway and frozen research flow remain in development. 所有新组件仍待完整流统一异机验证，不单独送验；阶段 A 真实 CPU 记录不等于 canonical 状态合同通过。

Final local-development ruling: retain external prerequisites and unobserved physical evidence as NOT_RUN; do not implement HA promotion without its explicitly required substrate or claim a licensed model runtime. Local portable-worker Linux CI, real GPU driver constraints, reversible own-queue protection, actual browser local controls, persisted artifact/checkpoint/deployment components, canonical remote/headless port, durable engineering fixture/tools and frozen local REX study are developed and component reviewed. The broad integration review passed 31 disposable-fixture tests with no Critical/Important finding in its reviewed scope. One complete-flow pending-verification branch is the delivery boundary; actual Mech/phone/provider/restart/process-tree/SLO and formal experiment evidence remain pending, not programme acceptance. 中文裁定：保留外部前提和未观察实体验证为 NOT_RUN，不在无基础时启动 HA 或宣称获准模型。单一候选整流送验，组件审查不替代 Mech/手机/provider/重启/进程树/SLO 或正式研究验收。
