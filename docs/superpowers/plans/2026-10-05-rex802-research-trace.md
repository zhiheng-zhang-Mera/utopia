# REX-802 Research trace foundation plan

Authority: claim288cbdf on Digital-City; exact baseline0e9bea3ce739b979e582a428af8fb233045a5e75; immutable ancestor69a097b5394a9fece39dd11cc13f04c9b4d28bfe verified. Owner delegates optimal choices and inline execution. CAP-RESEARCH-TRACE-001, OBSERVABLE_ADVANCED. Neither unaccepted REX801 nor WBC modules imported.

Thin slice: read-only Research trace entry in Web Advanced / Android More, real authenticated Gateway summary, canonical event reference collector. A recording run is explicitly distinct from an experiment run (unknown until supplied). Collector never owns/mutates task/action state.

Design decisions: pure versioned normalization retains whitelisted raw references plus context/digest so raw-to-normalized output is reproducible; source event id/seq and capture clocks distinguish missing, duplicate, out-of-order, stale-clock cases. Metric unknown is null with reason, never fabricated0. Optional validated provider/model/channel, handoff, retry/backoff, resource, intervention, liveness/watchlist, authority and exactGit/config/evidence references are supported without raw payload/credential capture. Schema rejects invalid measurements and unknown keys.

Storage: bounded in-memory records/queue and bounded JSONL retention, asynchronous writes; collector state exposes failures/drop/retention/partial completeness. Product events are tapped after canonical persistence. Storage/normalizer exceptions are contained; HTTP task/claim still functions. Restart loads bounded previous references and starts new recording epoch. Independent injected I/O failure/deferred storage verifies liveness. No automatic task/research experiment creation.

Security: read-only API follows existing authentication; owner sees full research view, member receives explicit owner-required guidance. No raw credentials, fingerprints or arbitrary user payload copied to trace/UI. Full identifiers folded. Exact source/config refs absent from configuration remain NOT_OBSERVABLE; no guessed branch identity.

- [ ] Task1: test-first pure schema/normalization, refs/unknown policy, duplicate/missing/reorder/stale clocks, bounded collector/restart/failure; implement minimal collector and documented contract.
- [ ] Task2: real Gateway event integration + owner API, fail-safe collector negative product tests, metadata/observability surfaces on Web/Android; browser unit/build and available physical checks.
- [ ] Task3: passive evidence/materials/registry candidate and exact final CI; independent technical critique; handoff opposite physical-host Formal Review. Do not emit terminal marker locally.

Research watchlist inherits latest workbook G3/G4 candidates; collect bounded factual data, no hidden reasoning or novelty/performance claims.
