# Legacy branch audit and `mech/knowledge-room-k0` disposition

```text
STATUS: FINAL
HOST: Mech
DATE: 2026-09-30
AUTHORITY: direct Owner instruction (2026-09-30), option A of the two-question
           confirmation: "push to origin to preserve history + record as
           superseded in City; do NOT merge into main"
SCOPE: legacy branch audit only. BUTLER_MERGE lock untouched.
CODE-SHA (utopia main at audit): 8104f8289a76d15ff0197c953730edcef42cab5e
MERGED_MAIN_CI: 36692675561 - android success, gateway-web success
REMOTE_BRANCHES_AUDITED: 34
REMOTE_BRANCHES_UNMERGED: 0
BRANCH_UNDER_DECISION: mech/knowledge-room-k0
BRANCH_HEAD: db7cfc5ef4b631c00149fe3657cc85b90d6f4356
BRANCH_BASE: 3e0bfb09b94b2d58c36948feb5e2f4b60676e4a9
DISPOSITION: PRESERVED_ON_ORIGIN / SUPERSEDED / NOT_MERGED
```

## 1. Problem

The Owner instructed: "以主机Mech的身份，对utopia的各个分支进行main合并，保留工作历史，如果出现
Github CI测试报错，解决到全绿并记录到city和utopia的存档处."

Reconnaissance showed the instruction's premise no longer matched reality, and that the
one branch it *could* still apply to would cause harm if merged literally.

**Finding.** Every remote branch was already merged into `origin/main`:

```text
git branch -r --no-merged origin/main   ->  (none)
git branch    --no-merged origin/main   ->  mech/knowledge-room-k0   (local-only)
remote branch count                     ->  34
merged-main CI                          ->  36692675561 success (and the 4 runs before it)
```

The only unmerged ref was `mech/knowledge-room-k0`, a **local-only** branch that had
never been pushed. Merging it would not have integrated outstanding work; it would have
**added a second live implementation of a product main already ships**.

## 2. Evidence that the branch is superseded, not outstanding

| Fact | Value |
|---|---|
| Branch content | 25 files / 3034 insertions, **all** under `apps/knowledge-room/**` |
| Wiring | `ACCEPTANCE_K0.md`: "Changed files outside `apps/knowledge-room/**` = 0" — never attached to the Room Pack hub |
| Branch tests | 18/18 pass (store 6, search 4, import-export 4, http 4) |
| Product | Knowledge Room: title+body search, tag filtering, whole-bundle export, replace import |
| Main's equivalent | `apps/rooms/rooms/knowledge/` (`client.mjs`, `room.server.mjs`) — the same feature set, integrated into the Room Pack hub, Web and Android |
| Branch first commit | `9208903` @ 2026-09-29 **10:58:11** |
| Main's knowledge room | `67b27bf` "feat(rooms): add knowledge room" @ 2026-09-29 **12:02:56** |

The branch was authored **first** and then replaced about an hour later by the Room Pack
implementation, which is the one wired into the hub and shipped. `git merge-base
--is-ancestor 67b27bf 3e0bfb0` returns false, confirming the branch's baseline predates
main's room; `67b27bf` is an ancestor of `origin/main` today.

## 3. Choice and judgement logic

Merging `mech/knowledge-room-k0` into main would have satisfied the instruction literally
while creating three concrete harms:

1. **Two live implementations of one room.** The City's own
   `apps/rooms/docs/en/INCUBATION_POLICY.md` §5 states "Room and City must never drift
   apart as two live implementations." Main would hold both `apps/knowledge-room/`
   (unwired) and `apps/rooms/rooms/knowledge/` (wired).
2. **3034 lines of dead product code on main**, covered by no CI job: the root workflow
   runs `tests/*.test.mjs`, `apps/rooms/tests/*.test.mjs` and `city/test-all.mjs`, and
   `apps/knowledge-room/`'s four test files are in none of them. The branch's tests would
   never run on main.
3. **Rule conflict.** The current mode is `BUTLER_ASSISTANT_PARALLEL_DEVELOPMENT` with
   `BUTLER_MERGE = FORBIDDEN` and the merge workbook gated on all BA-001..BA-009
   completing. README §7.3 requires integration "without dropping valid behavior"; here
   nothing is dropped, a duplicate is added.

The instruction's own escape clause ("如果出现任何未明确指定选项，选择最优解") covers
*unspecified* options; this was a material product-topology decision inside an explicit
rule conflict, so it was put to the Owner rather than decided unilaterally.

**Owner decision (recorded): option A** — push the branch to origin to preserve its
history, record it as superseded in City, and **do not merge it into main**. The BA merge
lock was explicitly left untouched.

## 4. Action taken

```text
git push -u origin mech/knowledge-room-k0
  -> refs/heads/mech/knowledge-room-k0 = db7cfc5ef4b631c00149fe3657cc85b90d6f4356
```

The pushed ref equals the local head exactly, so the branch's work history is preserved
byte-for-byte; nothing was rewritten, squashed or rebased. The branch remains available
for a future Owner-directed integration or deletion.

## 5. Why this satisfies "保留工作历史"

Before this action the branch existed on **one machine only** — a real single-point loss
risk. It is now durable on origin, at its original head, with its four commits
(`9208903` bootstrap, `61a464d` CRUD, `0ae5707` acceptance, `db7cfc5` acceptance record)
intact. Nothing was merged into main, so no rule was overridden and no duplicate product
was introduced.

## 6. CI

The pushed ref triggers the workflow **as it exists at that commit** ("V0 checks":
`pnpm test` + `pnpm check:docs`, plus the Android job). The branch adds only
`apps/knowledge-room/**`, which no job in that workflow covers, so main's green state is
unaffected either way.

```text
branch push CI (mech/knowledge-room-k0 @ db7cfc5)  = 36700716264  success
origin/main                                        = 8104f8289a76d15ff0197c953730edcef42cab5e
merged-main CI                                     = 36692675561  success
post-record merged-main CI                         = recorded in the City counterpart
```

No CI failure was produced by this work, so no repair was required. Both the branch run
and the merged-main run are green.
