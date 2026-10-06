# REX-805 Implementation Plan

**Goal:** Replay a selected recorded canonical run and compare an exact alternate-device ablation without editing original evidence.

**Spec:** [Bilingual design](../specs/2026-10-06-rex805-replay-ablation-design.md).

**Architecture:** Adapter over existing registry/runner/task paths. Add a bounded seed-index offset, fresh experiment identity and immutable receipt lineage. Owner-only Research controls.

**Tech stack:** Node24 ESM, node:test, existing Web view patterns and bilingual i18n.

## Constraints and review focus

Source receipt/context identity and raw material stay immutable. New experiment and run IDs; exact mechanism names. No Owner bypass, production rule edits, external determinism or performance claims. Store failures, stale source, unsupported mechanisms, original index>0 and outside cancellations need explicit outcomes.

## Tasks

1. [ ] Runner: add seedIndexOffset validated integer0..999, persisted on campaigns and guarded during resume/recovery. Test original index1 gives identical seed and restart keeps it; negative/overflow/mismatched resume refuses. RED then GREEN.
2. [ ] `research/replay.mjs`: pure/injected adapter `createReplayEngine({receipt,experiment,register,start,identity,context,limits})`, `start({sourceCampaignId,sourceRunIndex,mode,disabledMechanisms})`, `compare(campaignId)`. Tests fresh identities, original unchanged, source manifest/seed mismatch refusal, unavailable source, unsupported/ineffective policy and exact comparison. RED then GREEN.
3. [ ] Gateway: Owner-only GET/POST `research/replays`, GET `research/replays/<campaignId>`, reuse campaign stop. Wire alternate-device policy into real canonical target selection. Two actual fixture workers execute original/replay/ablation; assert targeted tasks, unchanged source bytes, distinct lineage and response refusals. RED then GREEN.
4. [ ] Web: ResearchCampaign view explicit source run selection and Replay/Ablation controls, comparison table with caveat, escaped source details, bilingual keys. Test selected run and context reset/member/offline refusal. RED then GREEN.
5. [ ] Full suite, docs validation, immutable feature commit/push and CI. Reconcile workbooks/registry/paper material; obtain opposite-host review and physical comparison without claiming them from local fixtures.

Execution: current root agent under the user's continuous authorized workbook instruction; no new programme or product-main merge.
