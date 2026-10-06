# Scenario review hardening

Independent Alien review adopted the author proposals after observing five failing probes on the original target. Further probes found malformed recovery records, scenario/context drift on resume, destructive readiness refusal, late cleanup crossing run boundaries, contradictory measurement records and shutdown bounded by a frozen experiment clock. Recovery now validates retained invariants before effects; resumption verifies the persisted context and preserves the interrupted campaign on refusal; each run owns cleanup; shutdown uses a monotonic clock. Related62 tests pass. The physical Alien + Mech + Android campaign gate remains unobserved and this is not accepted closeout.

Original target a695bb9; adopted proposals07e8c3c/42acdc6; raw evidence: evidence/raw/mission-book/REX-803/alien-review.
