# CHK series development plan

Owner ruling: develop CHK-101/201/301/401/990 together on Alien-GPT-CHK. Old per-workbook opposite-host acceptance dependencies do not block internal development. Whole-series second-host review remains NOT_RUN; no main merge.

Implement a bounded read-only library under city/02-engineering/05-city-self-health-check/ with a CLI under scripts/. Read Git-tracked source, JSON/YAML registry records and canonical workbook frontmatter. Compare generated progress, source exports/API seams, dependency graph, path/symbol/evidence identity and optional supplied runtime snapshots. Do not start services or read credentials. Report bounded coverage and UNKNOWN explicitly.

1. Write and fail twelve CHK-990 scenario tests with real temporary repository trees.
2. Implement bounded collection/reconciliation and findings with owner/severity/evidence/destination.
3. Implement queryable self model, multiple diagnostic hypotheses, hash-linked append-only case revisions, BLG-001..006 dispositions and non-authoritative routing receipts with safety ladder.
4. Add strict CLI and whole-series exact-SHA second-host runner; produce actual repository first-run artifacts and checksums.
5. Run full root/room/city/bilingual tests and push incremental commits. Bind final successful CI SHA to capability candidate and CHK workbooks. Generate/check dependency, progress, documentation navigation and run integrity tests.
6. Push City branch, dispatch read-only documentation-integrity CI, verify remote heads and clean trees. Development completion is separate from whole-series independent acceptance.

No scheduler, repairs, rule changes, self promotion, hidden reasoning, secrets or live City disturbance. Findings are observations/candidates with provenance, not repair instructions with authority.
