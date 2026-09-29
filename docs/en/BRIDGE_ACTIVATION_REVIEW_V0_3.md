# V0.3 consumer activation review

PAIR_STATUS: SYNCHRONIZED
FACT: CITY_LIFECYCLE=PROMOTED_PRESERVED
FACT: AUTOMATIC_ACTIVE=NO
FACT: THEME_OWNERSHIP=REVIEW_PENDING
FACT: D6B=DEFERRED_SCOPE_ALLOCATION
FACT: MECH_FUTURE_MIGRATION_BLOCKED_BY_ALIEN=NO

| Owning module | Explicit product consumer | Remaining boundary |
| --- | --- | --- |
| ingestion-core | Services Document Intake and document-to-knowledge mapping | Local City execution; original bytes are not retained |
| document-readers | Services DOCX/XLSX/PDF readers | Bounded files, pages, rows and expansion; not universal document fidelity |
| knowledge-core | Services temporary entries and mapped document queries | No hidden permanent knowledge database; matching results remain in invocation history |
| skill-intake | Services reference, SKILL.md, archive and catalog inspection | No installer, remote code execution or package lifecycle UI |
| evidence-engine | Optional Services review and tamper consumer | Integrity/reference checks do not establish factual truth; no mandatory business broker |
| theme-engine | Services generate, preview and validate | Ownership remains for review; no global application or D6b builder |

Product consumption is evidenced separately from City lifecycle. This review does not edit the manifest or rewrite promotion history. Future promoted modules can remain BRIDGE_PENDING without disabling these consumers. Runtime state AVAILABLE/DEGRADED is not a lifecycle promotion.
