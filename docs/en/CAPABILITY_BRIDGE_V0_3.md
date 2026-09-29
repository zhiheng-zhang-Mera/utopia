# Capability Bridge v1

PAIR_STATUS: SYNCHRONIZED
FACT: API_VERSION=0
FACT: CAPABILITY_CONTRACT_VERSION=1
FACT: FILE_LIMIT_BYTES=1048576
FACT: INVOCATION_HISTORY=DURABLE
FACT: LIFECYCLE_AUTOMATION=NONE

Services uses existing control authentication and version checks. Explicit operations call owning City modules inside bounded worker threads. Neither client imports business algorithms. Input files are limited to1MiB; concurrent workers to2, execution to20seconds, and each result to3MiB.

GET /api/v0/capabilities; GET /api/v0/capabilities/:id; POST /api/v0/capabilities/:id/invoke; GET /api/v0/capability-invocations; GET /api/v0/capability-invocations/:id.

The request is {operationId,input}. The result contains invocationId, capabilityId, operationId, startedAt, finishedAt, status, resultDigest, errorCode and result. A canonical digest sorts object keys and excludes invocation metadata. COMPLETED means execution finished; evidence PASS/HOLD and theme validation are separate result fields.

Original input bytes are not retained. Results, metadata and events are explicitly retained in City invocation history, including matched temporary knowledge entries; this is not a permanent knowledge database. Gateway restart preserves terminal records and marks unfinished RUNNING records INTERRUPTED. Clients keep cached views visibly offline and disable invocation until authority returns.

Capability adapters cover Document Intake, Knowledge Query, Skill Inspect, Evidence Review and Theme Lab. New modules without an adapter remain BRIDGE_PENDING. Dependency failures become DEGRADED. Evidence samples require explicit sample:true; other missing task input is TASK_REQUIRED. Unsafe skill archive paths use opt-in strict refusal. Theme builder/global apply, installer, provider automation and automatic ACTIVE changes remain outside scope.
