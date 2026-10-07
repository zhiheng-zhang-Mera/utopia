# DGX whole-series development and second-host verification

STATUS: DEVELOPMENT_CANDIDATE
FACT: Per-workbook second-host gates are suspended for development by the Owner's 2026-10-07 ruling; independent verification is performed once for the whole series.
FACT: No main merge and no fabricated accepted dependency, clinical, identity or release evidence.

The PCF-owned `contracts/personal-compute-fabric-v1/execution-capsule.mjs` provides the necessary DGX substrate slice. It retains canonical task/action/parent/stage, attempt/epoch, origin and execution identity, exact SHA, approved write scope, permissions, budget and expiry. Results require bounded structured output, validation evidence and artifact digest verification. The caller-owned replay ledger can be serialized; Governance also persists one immutable result per node.

`createGateway({governancePorts})` is the host composition seam. The PCF adapter is available by default, but approved specs, participant receipts/facts, canonical execution references, artifact bytes and release receipt readers must come from trusted host adapters. HTTP JSON cannot install these readers or grant approval. Without them, the corresponding operation refuses explicitly. No production identity or artifact verification is claimed by the existence of the seam.

`readApprovedExecutionSpec(refs)` returns the actual task/user/attempt/epoch approval with `input_refs`, `output_contract`, `stop_condition`, `independence_floor_ref`, `write_scope`, `permission_ref`, `budget_ref`, `expires_at`, `fact_version`. `readExecutionRefs(node, case, receipt)` returns canonical execution refs; action-supplied identity fields are ignored when this reader is installed. `readArtifact(ref, capsule)` returns verified local bytes and must enforce the caller's owner/permission boundary. DGX never resolves arbitrary receipt paths. Result executors join joint final review; a validated result does not grant release authority.

On the second machine, fetch and check out `Alien-GPT-DGX` at the exact SHA listed in the Digital-City series report, install locked dependencies as in CI, then run:

```powershell
node scripts/verify-dgx-series.mjs --expected-sha <full-40-character-SHA> --second-host --out D:/DGX-series-evidence/<new-directory>
```

This runs the complete thirteen-scenario controlled test package once, including actual local Gateway/Web tests and real PCF substrate integration. It records physical hostname, exact SHA, Node version, clean source before/after, logs and checksums. The output directory must be new and outside source. The developer machine cannot use `--second-host`. A successful controlled run is evidence for the reviewer, not an automatic formal acceptance marker; the second-machine operator reviews the entire series, full CI and residual unavailable production/domain seams, then records one series verdict in Digital-City. The eight workbook reviews may reference that single verdict. No per-workbook execution pause is required.

Result receipts must match case/node/snapshot; `readExecutionRefs` is mandatory. Final reviews must carry the current `content_revision`. Integration changes archive previous reviews and require renewed review, retaining both initial judgments and correction history. Release selections must reference collected claims/evidence/assumptions; recorded claim uncertainty and unresolved questions remain visible.

Clinical simulation, autonomous execution/promotion and production release are outside this development claim. Keep unknowns, dissent and fail-closed gates visible. No scheduler, reputation store, device identity or canonical task lifecycle is added.
