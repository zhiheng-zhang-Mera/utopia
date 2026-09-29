# Wave3 independent activation review

PAIR_STATUS: SYNCHRONIZED
STATUS: WAVE3_A=PASS
FACT: ACTIVE_MODULES=ingestion-core,document-readers,knowledge-core,skill-intake,evidence-engine
FACT: THEME_LIFECYCLE=PROMOTED
FACT: THEME_OWNERSHIP=REVIEW_PENDING
FACT: AUTOMATIC_ACTIVE=NO
FACT: ROOT_CITY_PROMOTION_GATES=51_114_9

Hardening main `393f3b89a9c4fae61be1e431c4bcd47fee945e88` and CI `36549170404` passed before Road work. Road extraction commit `762d677f1981` preserves all six document retrieval digests. This review then approves five explicit lifecycle changes in a separate activation commit, rather than having the Bridge modify the manifest.

For every candidate, all nine conditions passed: real accepted-Room and promotion commits are ancestors of the reviewed source; owning-module focused/parity tests are green; a real runtime consumer exists; Windows product acceptance passed; Android product acceptance passed; the qualified descriptor is AVAILABLE; manifest/DONOR agree on ownership and reviewed records show no unresolved dispute; operation semantics are genuine; and recovery preserves result identity/digests. The detailed per-module evidence is in [activation-review.json](../../evidence/raw/wave3/activation-review.json).

| Qualified module | Accepted consumption supporting ACTIVE |
| --- | --- |
| 09-planning-knowledge/02-document-intake/ingestion-core | TXT/JSON/YAML through Document Intake and the explicit Document→Knowledge Road |
| 09-planning-knowledge/02-document-intake/document-readers | Actual DOCX/XLSX/PDF parsing, including physical Android's historical system-picker cases |
| 09-planning-knowledge/01-knowledge-service/knowledge-core | Temporary entries and document-derived retrieval; no permanent knowledge store |
| 02-engineering/02-worker-gateway/skill-intake | Reference/SKILL/archive/catalog inspection, including unsafe archive refusal; no installer claim |
| 06-research/01-research-institute/evidence-engine | Review and tamper rejection; integrity/references, not external factual verification |

Evidence combines the [full historical V0.3 product series](../../evidence/en/BRIDGE_ACCEPTANCE_V0_3.md), [current hardening acceptance](../../evidence/en/V0_3_HARDENING_ACCEPTANCE.md), six-format Road parity, and fresh post-change root 51 / City 114 / promotion-history 9 gates. Owning module implementation files are unchanged from the hardening baseline. Historical physical evidence remains labeled historical; it is not relabeled as a new device run.

Theme remains PROMOTED because ownership review and D9 promotion are still pending. The previously promoted Room commits, promotion records and donor SHAs are unchanged. Availability remains a separate runtime state: a future unbridged PROMOTED module can be BRIDGE_PENDING without stopping Mech or existing consumers.
