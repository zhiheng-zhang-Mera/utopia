# REX-805 execution ledger / 执行账本

Baseline8798ba9, clean isolated D:/Utopia-REX805-20261006. Frozen install and dependency smoke29/29 PASS. Claim recorded in Digital-City ed65a33. Resident MEMBER worktree untouched.

Ruling: user continuous-workbook authorization supplies execution method and scope; proceed inline under existing REX-805 contract without a new programme approval loop. Existing acceptance gate remains opposite-host review, not this ledger.

Ruling: seedIndexOffset bound0..19999 with offset+totalRuns<=20000, rather than the draft0..999. Existing runner permits10000 measured+10000 warmup; the smaller draft bound excluded valid original indices. Retain legacy seedPolicy label at offset0.

Task1 RED:3/3 new tests failed for actual missing seed offset/validation/recovery behavior. GREEN: offset tests3 plus existing runner12 and adversarial2 =17/17 PASS. Added persisted offset, recovery/cancel/skip seed derivation, bounds and resume conflict. Final project suite NOT_RUN at this checkpoint. Gateway resume payload must propagate offset in task3; Web resume payload must propagate it in task4.

Task2–4: adapter6 tests RED for missing behavior, then GREEN; gateway2 RED404 then GREEN, with existing two-worker rehearsal2 also passing. A real registry boundary exposed parsed software refs being supplied where wire strings are required: deterministic503 before repair, explicit normalized-to-wire conversion afterward. No production registry change.

Web RED for missing control then GREEN. Further actual defect: parent campaign view stayed on the original campaign after replay (stop unavailable/stale identity); regression timed out on the exact new campaign ID and passed after onStarted refresh/poll. First draft looked for the word replay in identifiers rather than the actual new campaign ID: MEASUREMENT_DEFECT, corrected before product fix. Further delayed-comparison test reproduced old-source results reappearing after source selection changed, and passed after requested active ID fencing. Its initial option visibility wait was a MEASUREMENT_DEFECT (option exists but is not visible); corrected to DOM-presence wait.

Ruling: v1 execution is stateless WAIT only; other safe task types consume filesystem/checkpoint state not captured by the receipt. Explicit REPLAY_CONDITION_UNAVAILABLE, not a deterministic replay claim. Referenced faults are refused for the same reason. Source software refs do not attest the new process; lineage currentProcessSoftwareSha remains null with NOT_OBSERVED reason. Canonical parsed receipt SHA256 is explicitly distinguished from exact-byte hashes. Future mechanisms are typed unsupported; unknown request switches refuse.

Current related14/14 PASS; bilingual validation synchronized. Initial full-suite attempt started before final source freeze and with city dependencies missing:3 deterministic reader/audit failures, root frozen install alone was insufficient. city frozen install repaired setup and those12 tests pass;3 host launcher failures also observed while resident coord4389 remains intentionally online. Initial full run is INTERMEDIATE and cannot certify a final exact head. Task5 final full suite, hosted CI, fresh independent review and physical replay/ablation gate remain pending. 不以本地fixture代替实体验收，不把未执行检查写PASS。


## Independent review repairs / 独立审查修复

Candidate a574e009 retained as reviewed history. Initial independent review requested changes: derived replay lost inherited ablation policy, comparison omitted effective controls, and inconsistent source placement passed. Three regressions reproduced RED (7/10 pass), then GREEN. A second review identified MIN_SUCCESSFUL_RUNS transformation, fabricated lineage, and normalized registry reference correspondence gaps. The success-stop regression reproduced LIMITS_EXCEED_DECLARED before repair.

候选 a574e009 保留为审查历史。首轮独立审查要求修改：派生回放丢失继承的消融策略、比较遗漏有效控制项、来源落点不一致仍获接纳。三条回归先 RED（7/10通过）再 GREEN。第二轮发现 MIN_SUCCESSFUL_RUNS 转换、虚构关联字段和规范化注册引用对应关系缺口；成功停止条件回归先复现 LIMITS_EXCEED_DECLARED，再修复。

Repairs preserve inherited policy, refuse ineffective repeated ablation and inconsistent source placement, compare effective controls/lineage/registry references, and validate single-run limits before registering an experiment. Only the selected-run success stop changes to one; failure and wall-clock limits remain. Real Gateway regression covers original→ablation→replay, canonical placement and success/failure bounds. Core/Gateway/seed focused suite: 17/17 PASS; enhanced real Gateway: 2/2 PASS. Independent re-review and exact repaired-head full suite/CI remain pending. No physical-host replay acceptance is claimed.

修复保留继承策略，拒绝无效重复消融及不一致的来源落点，比较有效控制项、关联字段和注册引用，并在注册新实验前校验单次执行限制。仅选定单次执行的成功停止条件转为1，失败与墙钟限制保留。真实 Gateway 回归覆盖原始→消融→回放、规范任务落点及成功/失败界限。核心/Gateway/种子聚焦17/17通过，增强真实 Gateway 2/2通过。独立复审和修复后精确版本完整测试/CI待完成；尚未声称实体联机回放验收。
