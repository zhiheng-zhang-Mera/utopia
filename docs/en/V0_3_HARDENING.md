# V0.3 hardening contract

PAIR_STATUS: SYNCHRONIZED
FACT: SUMMARY_LIMIT=500
FACT: DETAIL_LIMIT=50
FACT: SNAPSHOT_LIMIT=50
FACT: LIST_MAX=200
FACT: THEME_OPERATIONS=generate
FACT: LIFECYCLE_AUTOMATION=NONE

Invocation storage separates summary metadata from retained payloads. `/city` includes at most 50 recent summaries, never invocation results. `GET /api/v0/capability-invocations?limit=N` defaults to 50 and caps positive integer requests at 200; invalid limits return `INVALID_LIMIT`. Ordering is oldest-to-newest within the selected recent set, based on the latest state change.

`GET /api/v0/capability-invocations/:id` returns summary plus retained result, or `result:null` when pruned. `resultAvailable=false` does not mean execution failed: a completed invocation stays `COMPLETED`, with its digest retained while its summary exists. Once a summary ages out of the 500-summary bound the detail endpoint returns `INVOCATION_NOT_FOUND` (404). Published evidence is independent of runtime retention.

SQLite startup transactionally moves legacy inline results into `invocation_details`, preserving IDs, status, timestamps, error codes and digests. A corrupt legacy row rolls back the whole migration and refuses bridge startup. Saves and retention run in one transaction; running jobs survive summary pruning, and completion updates recency. Payloads are bounded to the latest 50 retained results (each already limited to 3 MiB). SQLite may reuse freed pages; this is logical retention, not a secure-erasure claim. No live database deletion or recreation is required.

Both clients fetch a detail only when its history entry is selected. Snapshots update metadata without repeatedly fetching payloads. A stale RUNNING summary cannot overwrite a newer terminal result. A genuinely pruned completed detail displays “Result detail expired / pruned. Digest retained.” A detail/network failure is shown separately from the saved invocation status. Clients may retain the loaded result in process memory; the limit describes Gateway persistence, not forced erasure from client memory.

Module identity is `{districtId,buildingId,moduleId}` with canonical key `districtId/buildingId/moduleId`. Each descriptor lists every `moduleRef` and lifecycle. Mixed states report `cityLifecycle:MIXED`; inspect `moduleLifecycles` instead of interpreting MIXED as promotion. Unbridged IDs use `city.` followed by the qualified key; encode the entire ID when placing it in an API path.

Availability is restrictive across dependencies: any DEPRECATED module makes the capability UNAVAILABLE; any PLANNED/INCUBATING module keeps it BRIDGE_PENDING; missing or unknown dependencies are DEGRADED; only all-PROMOTED/ACTIVE dependencies with an adapter are AVAILABLE. Duplicate qualified identities refuse registry construction. Duplicate bare names in different Buildings remain independent. Bridge never changes lifecycle.

Theme exposes only `generate`, already returning preview, tokens, readability, overlay, protected-surface checks and validation. The former false `validate` operation is refused. Android preserves HTTP code, status and message through `CapabilityRequestException`; transport IO failure is OFFLINE even if the WebSocket flag is stale.

The bounded-payload claim concerns invocation history, not the existing task/event collections. Existing V0.3 physical acceptance remains historical evidence. New acceptance records its own source/APK/checks. Wave3 starts after hardening merge and successful main CI.
