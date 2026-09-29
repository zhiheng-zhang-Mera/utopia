# V0.3 implementation plan

PAIR_STATUS: SYNCHRONIZED
FACT: BASE_MAIN_SHA=4ac287b5dd6cd7214c0129b23bb1cad09aab0e97
FACT: MECH_FUTURE_MIGRATION_BLOCKED_BY_ALIEN=NO

Goal: repair Wave2, merge, then expose five owning modules through one capability authority. Execute inline with focused red/green tests and final independent review.

- [ ] 1. Repair: Audit source semantics; record real GitHub search with offline preservation; classify Evidence provenance; compare read-only map; run all baseline gates; commit and merge short branch.
- [ ] 2. Bridge contract: Add contracts/capability-bridge-v1/protocol.mjs and schema.json, services/capability-bridge/{registry,adapters,store}.mjs. Strict operation allowlist, bounded input, deterministic result digest, durable invocation states. Test unknown promoted module, malformed input, restart interruption and no credential errors.
- [ ] 3. Windows: Add dynamic Services UI with five real adapters. Browser acceptance uses generated document bytes, document-to-knowledge mapping, skill refusal, evidence tamper and deterministic theme preview. Test all specified inputs and same-invocation history.
- [ ] 4. Android: Add Services with HTTP descriptor/invocation consumption, ACTION_OPEN_DOCUMENT, previews and shared history. Build/install; drive real system picker and five capabilities, compare digests.
- [ ] 5. Recovery and closeout: Verify physical Wi-Fi and Gateway restart, cached/offline and interrupted states. Merge latest main without lifecycle promotion; full regression, bounded secret audit, paired evidence and activation review; publish branch/PR.

Review focus: unbridged new modules remain available as pending descriptors; errors do not leak secrets; malformed/oversize files fail with typed errors; request metadata is excluded from canonical digests; restart never converts an interrupted invocation to completion. No installer, global theme apply, hidden knowledge database or automatic lifecycle change.
