# REX-805 execution ledger / 执行账本

Baseline8798ba9, clean isolated D:/Utopia-REX805-20261006. Frozen install and dependency smoke29/29 PASS. Claim recorded in Digital-City ed65a33. Resident MEMBER worktree untouched.

Ruling: user continuous-workbook authorization supplies execution method and scope; proceed inline under existing REX-805 contract without a new programme approval loop. Existing acceptance gate remains opposite-host review, not this ledger.

Ruling: seedIndexOffset bound0..19999 with offset+totalRuns<=20000, rather than the draft0..999. Existing runner permits10000 measured+10000 warmup; the smaller draft bound excluded valid original indices. Retain legacy seedPolicy label at offset0.

Task1 RED:3/3 new tests failed for actual missing seed offset/validation/recovery behavior. GREEN: offset tests3 plus existing runner12 and adversarial2 =17/17 PASS. Added persisted offset, recovery/cancel/skip seed derivation, bounds and resume conflict. Final project suite NOT_RUN at this checkpoint. Gateway resume payload must propagate offset in task3; Web resume payload must propagate it in task4.

Task2–5 pending. No physical replay/ablation gate, hosted CI or independent review yet. 不以本地fixture代替实体验收，不把未执行检查写PASS。
