# DGX full-series development plan

> Execute inline with executing-plans; review the whole branch once at the end.

Goal: finish all eight DGX development workbooks on Alien-GPT-DGX, with one second-host acceptance package.

Spec: Digital-City mission-book/mission-group/deliberative-governance-expansion-migration plus Owner's latest whole-series ruling.

Architecture: keep canonical City tasks and identities authoritative. Implement the required PCF-owned capsule schema slice in its original namespace, consumed by DGX. Bind contributions to canonical node/task/snapshot and include all contributors in joint release review. Preserve safe unavailable domain/identity seams; missing verified identity/evidence cannot become approval.

Tech stack: Node 24 ESM, node:test, existing Gateway and Web inspector.

- [x] PCF-726 substrate: compile bounded immutable capsules, validate exact host/session/attempt/epoch/SHA/artifact references and expiry; reject duplicates with an explicit caller-owned result ledger.
- [x] DGX integration: default Gateway capsule port, binding result to node/task/candidate and participant; test real substrate and persistent case restart.
- [x] Whole-series runner: execute all DGX tests and 13-scenario manifest, retain exact SHA and checksums, no fabricated formal review. Document second-host one-command workflow.
- [ ] Local checks, exact-head full cloud CI, fresh whole-branch review, fix findings, commit/push.
- [ ] Record Owner's override in series control plane: all development complete after evidence, formal series review pending, no main merge; synchronize/check documentation CI.

Ruling: prior per-workbook accepted dependency gates are suspended for development by current Owner instruction. This is not permission to invent accepted SHA or relax runtime identity, privacy, independence or release policy. Implement the necessary PCF-owned schema slice locally, without activating the entire PCF programme or making its completion claim.

Review focus: cross-case result reuse, author masquerading as opposite-host reviewer, changing node/task linkage, output/artifact tampering, post-run source dirtiness, stale result ledger, missing domain evidence.
