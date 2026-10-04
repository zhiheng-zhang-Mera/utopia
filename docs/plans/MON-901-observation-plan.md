# MON-901 implementation plan

Baseline d3262ce2dd81e51a53e39e6f9add8dee650a7682; Alien-codex.

1. Red tests: live canonical task/event projection, bounded overflow/gap, sanitized evidence pointers; HTTP auth and no write authority; stalled/disconnected observer does not block an independent task.
2. Store bounded read-only observation window (SQL LIMIT; total populations and retained event range).
3. Pull-based JEV observer with injected canonical reader, single-flight refresh, preserved stale data/error/disconnected states; Node/Edge/Event/Evidence projections with no scheduler mutation or callback on task path. No automatic model decisions.
4. Authenticated read-only Gateway projection endpoint. Unsupported canonical sources explicitly NOT_OBSERVABLE. MON-902 owns graph UI; MON-903 owns decisions.
5. Run focused tests and gateway regression; record actual controlled integration evidence, docs, registry candidate and Digital-City paper index. Commit/push exact candidate and check terminal CI; opposite-host Formal Review remains separate.

Design choice: demand-driven read-only sampling instead of subscribing before transactions commit. Observer never participates in task transition persistence and cannot hold a global lock. Bounded windows expose missing history/populations instead of claiming continuous completeness. SQL snapshot coherence must be preserved across events/tasks/nodes reads.
