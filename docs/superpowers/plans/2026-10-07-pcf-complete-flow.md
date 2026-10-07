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
