# Mission evolution feed

STATUS: BOOTSTRAP_V1
PAIR_STATUS: SYNCHRONIZED

This feed records structured experience from Digital-City Mission Book migrations without turning raw construction history into active Utopia rules.

## Storage model

- `.runtime/evidence/mission-book/<MISSION_ID>/<run-id>/`: local/raw runtime evidence; Git ignored.
- `data-records/evolution/inbox/mission-book/<MISSION_ID>/events.jsonl`: bounded structured handoff history on the mission branch.
- `data-records/evolution/episodes/mission-book/<MISSION_ID>/episode.json`: verifier-produced normalized episode after acceptance.

Raw evidence is evidence, not policy. Inbox events are non-authoritative. Only a verified episode is eligible for later retrieval/self-evolution use, and even then its authority is `EXPERIENCE_ONLY`.

## Record an event

```bash
pnpm mission:event -- \
  --mission MB-001 \
  --role migration \
  --host Mech \
  --type TEST_FAIL \
  --outcome fail \
  --summary "Root Trust parity failed" \
  --source-ref "Codex-Boss@8df428..." \
  --target-ref "mission/MB-001-core-os" \
  --evidence ".runtime/evidence/mission-book/MB-001/migration-Mech/root-trust-fail.json"
```

Allowed event types are fixed by `contracts/evolution/mission-event-v1.schema.json`. Do not invent new event labels in a Mission.

## Finalize after verification

The verifier runs finalization only after independent review, repair if needed, real-use verification, and required CI success:

```bash
pnpm mission:finalize -- \
  --mission MB-001 \
  --migration-host Mech \
  --verification-host Alien \
  --branch-sha <final-branch-sha> \
  --ci-run <final-green-ci-run>
```

Finalization refuses:
- the same host in both roles;
- missing PASS `MIGRATION_COMPLETE`;
- missing `VERIFIER_FINDING`;
- a non-PASS final verification `CI_RESULT`;
- missing PASS `VERIFICATION_COMPLETE` after the final green CI.

On success it creates the verified episode and removes the current-tree inbox file. Git history still preserves the branch construction trail.

## Safety/data rules

Do not record credentials, tokens, secrets, device serials, private model reasoning, or unbounded terminal dumps. Publish only bounded non-sensitive candidate evidence needed for cross-host verification.
