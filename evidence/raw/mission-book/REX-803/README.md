# REX-803 physical campaign evidence (Mech host, 2026-10-06)

Two controlled campaigns were run against the **live resident City** on the Mech host (`http://172.31.12.151:4391`,
cityId `031fdba6-e94c-4298-a095-6ff04a65481d`), with the physical **Android handset (OPPO PERM00, ADB
`BICIPVNB5HS85H9T`) connected as the live control surface** and the host's own reference node agent executing the work.
Both were driven through the campaign surface this workbook adds; nothing here was produced by a simulator.

| # | When | Experiment | Campaign | Result |
|---|---|---|---|---|
| 1 | 2026-10-06T01:24Z | `mech-android-canonical-repetition` (softwareRef `utopia@85a79eca…`) | `campaign-96b56dc0-c90c-454c-8088-1118143806d8` | COMPLETED, 3 measured of 4 planned (1 warmup), 0 unexplained |
| 2 | 2026-10-06T01:26Z | `mech-android-canonical-repetition-r2` (softwareRef `utopia@e284b712…`) | `campaign-b0ebb3af-bf86-451a-b508-1aa9e115c8d7` | COMPLETED, 3 measured of 4 planned (1 warmup), 0 unexplained |

Campaign 1 is kept because it is the run that FOUND a defect: its campaign seed was
`experimentId@<the entire manifest as JSON>`, because REX-801's registry exposes `digest` as a canonical serialisation
rather than a hash. Campaign 2 is the same experiment after that repair, with the short identity
`mech-android-canonical-repetition-r2@b872f35c85a66fc1d9304d5cf0b7be2f`. The runner-side copies of both receipts are in
the City's own runtime directory; the JSON below is what the City answered.

## Files

```text
physical-pre-state.json              city, nodes, control surfaces and members before the campaign (measured, not assumed)
physical-live-topology.json          the identities this City could actually offer at start time
physical-experiment.json             the registered manifest and its digest, exactly as the registry stored it
physical-campaign-progress.json      every progress sample the driver observed, ending in the terminal state
physical-campaign-receipt.json       the FILED receipt of campaign 1 (immutable once written)
physical-canonical-tasks.json        the canonical City tasks the campaign created, read back from /api/v0/city
physical-run-receipts.json           the research-trace run receipts, each naming the real task it measured
physical-surface-observation.json    what the owner-facing page displayed (text, not only a picture)
physical-campaign-live-surface.png   the owner-facing Research campaigns page, on the live City
android-control-surface-online.png   the physical handset, connected to that City
```

## What the evidence shows

* Each repetition is an ordinary canonical `WAIT` task. Four tasks exist, all `COMPLETED`, each carrying
  `researchRunRef = <campaignId>:<repetition index>`, all executed by `dev-031fdba6…` (this host's reference node).
* The receipt accounts for every planned repetition exactly once: `planned 4 = warmup 1 + measured 3`,
  `terminalAccountingComplete: true`, no run in any failure, timeout, exclusion, cancellation or interruption class.
* Per-repetition seeds are distinct and derived (`275013131`, `276690950`, `278368569` for campaign 1; the same
  derivation produced campaign 2's set), and the campaign seed is a short stable identity of the registered manifest.
* One run receipt per settled run exists in the research trace, each with `canonicalRefs.taskRef` pointing at the real
  task and a measured `latencyMs` (≈7.0–7.1 s per repetition on this host, which is the host agent's polling cadence
  rather than a claim about execution cost).
* The owner-facing page showed the campaign, the measured repetitions with their durations and task ids, the
  "Repetitions without a measurement" section with its explanation, and both filed receipts.

## What this evidence does NOT show

```text
Alien host          OFFLINE during both campaigns (last heartbeat 2026-10-05T11:15:06Z). The Alien + Mech + Android
                    topology the workbook's completion gate names was therefore NOT available, and this is a
                    Mech + Android campaign, recorded as PARTIAL GATE.
Android as an       The handset was a connected CONTROL SURFACE, not an execution node: no work was placed on it.
execution node
Failure paths       No repetition failed, timed out or was excluded in these two campaigns. The explained-absence and
                    cancellation behaviour is covered by the automated tests, not by these runs.
Performance         The durations above are observed wall-clock values from one host; they are not a performance claim.
```

## Method note

The handset was re-enrolled during this work (its previous enrollment was retired by the JOIN-590 revocation
acceptance). The pairing session that was used is deliberately **not** in this directory: its payload contains a
secret. The enrollment left the campaign's declared control-surface identity as a device id (`dev-be7832e3…`) rather
than the app's own `android-<MODEL>` client ref, which is recorded as finding F8 in the development report.
