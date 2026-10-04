# Node role, capability and resource descriptors

DATE: 2026-10-05
STATUS: WBC-602 REVIEW_CORRECTION_PENDING_EXACT_CI

A City node is now described by what it can do rather than by the name of the machine it runs on. The
`node-descriptor-v1` contract gives every node a stable descriptor: its roles, the capabilities it advertises,
the resources it has reported, its current availability, its health and a reference to the City registry that
owns its identity. A future scheduler can therefore choose an execution endpoint by capability, role and
resource instead of matching a hostname.

The descriptor is a read-only projection, not a stored record. It is computed from the canonical node record at
the moment it is read, so a heartbeat, a sharing change or a new telemetry sample is reflected immediately and
no second copy of node truth can go stale beside the first. The raw node list is unchanged and the descriptors
are published as a sibling field, so a surface that knows nothing about them sees exactly what it saw before.

Backward compatibility is the point of the contract, not a concession in it. Every new field is optional, and a
node record written before this contract existed translates with the legacy default role of `EXECUTION_NODE`,
marked `LEGACY_DEFAULT` so a reader can always tell a declared role from a defaulted one. A missing measurement
is `UNKNOWN` with a reason — never `0`, never `unavailable` — and a task requirement that names a resource
nobody measured produces an undecided fit rather than a refusal, because "we did not measure this" and "this
node is too small" are different answers.

The City can preserve explicitly configured execution and validation roles through registration and restart.
Legacy Windows workers retain EXECUTION_NODE only; validation roles are never inferred from a hostname or
platform. The Android client is a control surface. Android is not a City node and is not registered
as one; it is described by a separate control-surface descriptor whose `isExecutionResource` is false, and the
contract refuses any attempt to give such an entity the `EXECUTION_NODE` role. No combination of capabilities or
resource fields can promote a control surface into a worker.

A resource report is a claim a node makes about itself and never an authority. Identity stays in the City's own
node registry, the descriptor carries a reference rather than a copy of it, and the descriptor decides nothing:
it reports, and it says so.

Physical two-host results remain NOT_RUN when unavailable; isolated single-host tests do not establish hardware
performance, and no real Workbench or GPU pool is required or assumed.

Opposite-host correction: omitted GPU/network data remains UNKNOWN rather than asserting absent hardware or
unreachability. Only an explicit supported:false accelerator report is UNSUPPORTED. Platform mismatches and
measured zero accelerators have distinct requirement-fit reasons; unknown capacity remains undecided. Busy
workers report acceptingWork:false using canonical assigned nonterminal tasks. Optional worker role declarations
are validated, preserved on legacy reconnect and reference existing identity; they confer no new authority.
Malformed explicit role/requirement arrays are typed refusals, while omitted legacy fields remain compatible.
