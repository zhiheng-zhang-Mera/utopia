# REX-805 Trace Replay / Ablation 设计 / Design

任务授权来自已有 REX-805 workbook 及持续领取指令。范围是 Research Advanced 中已有 experiment/campaign 流程的扩展；不创建任务真相库，不重写原始 trace，不修改生产规则。已有 Alien MEMBER 继续在线。

Authorization comes from the existing workbook and continuous execution instruction. Extend Research Advanced experiment/campaign controls without a second task store, original-trace mutation or production-rule changes. Keep the resident Alien MEMBER online.

采用有界 replay adapter，复用现有 registry、runner 和 canonical strict-target task 执行。另建完全独立执行器会复制取消/timeout/recovery 真相；仅重算 JSON 则无法验证真实执行。本方案直接执行原场景，保留 original seed/index，创建新 experiment/campaign/run ID。

Use a bounded replay adapter over the registry, runner and canonical strict-target tasks. A separate executor would duplicate lifecycle behavior; JSON-only reprocessing cannot measure real execution. Execute the original scenario with its seed/index under fresh experiment/campaign/run identities.

## 数据流 / Data flow

Owner 选择 immutable campaign receipt 和 run index。adapter 验证完整来源、原始 manifest identity、run seed、场景和实际 workers；拒绝不完整或不可观测真实条件。复制已注册完整 manifest 到新 ID，声明 original→replay lineage、source receipt SHA256、原实验/运行/seed/worker、mode、exact disabled mechanism、确定性边界。新 campaign 单次 measured、warmup0、原 timeout/limits；runner 新增 seedIndexOffset，有界验证、持久化并纳入 resume/restart 不变量。

The Owner selects an immutable receipt and run index. Validate source context, registered manifest identity, seed, scenario and workers. Refuse incomplete sources or unavailable real-world conditions. Copy the full manifest to a new ID and bind lineage, source receipt digest, original experiment/run/seed/worker, mode, exact disabled mechanism and determinism limits. Run one measured repetition without warmup, preserving timeout/limits. Add validated, persisted seedIndexOffset to the runner's resume/restart invariants.

v1 消融 `alternate-device`：关闭 seed-modulo workers 选择，使用原声明 workers[0] 作为固定主节点；所有 task 仍走 canonical strict targeting，其他生产策略不变。原 explicit target 或只有一个 worker 时拒绝不能证明机制变化的消融。Replay 保留原 target 及 seed-modulo 选择。handoff/retry/backoff/recovery/governance 等未来 candidate 可在有版本的 schema 中命名，但当前不支持则 typed refusal，不假装禁用了机制。

The v1 alternate-device ablation disables seed-modulo worker selection and pins the first declared worker. Canonical strict targeting still applies. Reject ineffective ablations on an explicitly pinned or single-worker source. Replay retains the original targeting rule. Versioned mechanism descriptors can name future candidates; unsupported mechanisms receive typed refusals rather than fictitious effects.

比较读取 source 和新 receipt，核验 source digest 与 scenario/seed/topology/control inputs 一致后展示原值和差异。只声称控制输入一致与确切 policy 差异；动态资源、时钟、external provider 不保证确定性，时间差不是因果性能结论。当前没有可用 provider snapshot 时不能冒充重放现实条件。

Comparison re-reads both receipts and verifies source digest and controlled inputs before reporting original values and differences. Claim controlled-input identity and exact policy differences only. Dynamic resources, clocks and external providers remain nondeterministic; timing differences are not causal performance results. Unavailable provider snapshots cannot become deterministic replay claims.

## 验证 / Validation

TDD 覆盖 selected index>0 的精确 seed、来源变更/残缺拒绝、原始bytes不变、新ID、Owner限制、busy/offline/storeguard、unsupported/ineffective mechanism拒绝、UI context reset和escaping。实际双worker canonical scenario 原始→replay→ablation 比较必须显示真实 placement policy 变化；实体 Mech/Alien/Android 留独立对机review，不用fixture替代。最终 exact-head CI、完整项目套件、registry/exposure和素材索引同步。

Use TDD for exact seed at index>0, tampered/incomplete-source refusals, unchanged original bytes, new IDs, Owner boundaries, busy/offline/store failures, unsupported/ineffective mechanisms and UI context reset/escaping. A real two-worker canonical scenario must demonstrate actual placement-policy changes across original/replay/ablation. Physical Mech/Alien/Android acceptance remains a separate opposite-host review gate; fixtures cannot replace it. Finish with exact-head CI, the project suite and reconciled registry/exposure/material records.
