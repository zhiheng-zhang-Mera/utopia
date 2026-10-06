# REX-805 execution ledger / 执行账本

Baseline8798ba9, clean isolated D:/Utopia-REX805-20261006. Frozen install and dependency smoke29/29 PASS. Claim recorded in Digital-City ed65a33. Resident MEMBER worktree untouched.

Ruling: user continuous-workbook authorization supplies execution method and scope; proceed inline under existing REX-805 contract without a new programme approval loop. Existing acceptance gate remains opposite-host review, not this ledger.

Ruling: seedIndexOffset bound0..19999 with offset+totalRuns<=20000, rather than the draft0..999. Existing runner permits10000 measured+10000 warmup; the smaller draft bound excluded valid original indices. Retain legacy seedPolicy label at offset0.

Task1 RED:3/3 new tests failed for actual missing seed offset/validation/recovery behavior. GREEN: offset tests3 plus existing runner12 and adversarial2 =17/17 PASS. Added persisted offset, recovery/cancel/skip seed derivation, bounds and resume conflict. Final project suite NOT_RUN at this checkpoint. Gateway resume payload must propagate offset in task3; Web resume payload must propagate it in task4.

Task2–4: adapter6 tests RED for missing behavior, then GREEN; gateway2 RED404 then GREEN, with existing two-worker rehearsal2 also passing. A real registry boundary exposed parsed software refs being supplied where wire strings are required: deterministic503 before repair, explicit normalized-to-wire conversion afterward. No production registry change.

Web RED for missing control then GREEN. Further actual defect: parent campaign view stayed on the original campaign after replay (stop unavailable/stale identity); regression timed out on the exact new campaign ID and passed after onStarted refresh/poll. First draft looked for the word replay in identifiers rather than the actual new campaign ID: MEASUREMENT_DEFECT, corrected before product fix. Further delayed-comparison test reproduced old-source results reappearing after source selection changed, and passed after requested active ID fencing. Its initial option visibility wait was a MEASUREMENT_DEFECT (option exists but is not visible); corrected to DOM-presence wait.

Ruling: v1 execution is stateless WAIT only; other safe task types consume filesystem/checkpoint state not captured by the receipt. Explicit REPLAY_CONDITION_UNAVAILABLE, not a deterministic replay claim. Referenced faults are refused for the same reason. Source software refs do not attest the new process; lineage currentProcessSoftwareSha remains null with NOT_OBSERVED reason. Canonical parsed receipt SHA256 is explicitly distinguished from exact-byte hashes. Future mechanisms are typed unsupported; unknown request switches refuse.

Current related14/14 PASS; bilingual validation synchronized. Initial full-suite attempt started before final source freeze and with city dependencies missing:3 deterministic reader/audit failures, root frozen install alone was insufficient. city frozen install repaired setup and those12 tests pass;3 host launcher failures also observed while resident coord4389 remains intentionally online. Initial full run is INTERMEDIATE and cannot certify a final exact head. Task5 final full suite, hosted CI, fresh independent review and physical replay/ablation gate remain pending. 不以本地fixture代替实体验收，不把未执行检查写PASS。
