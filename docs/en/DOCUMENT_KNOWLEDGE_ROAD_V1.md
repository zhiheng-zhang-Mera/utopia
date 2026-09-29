# Document → Knowledge Road v1

PAIR_STATUS: SYNCHRONIZED
FACT: ROAD=document-knowledge-v1
FACT: TRUST=UNVERIFIED
FACT: SHELF=temporary
FACT: DOMAIN=document
FACT: PERSISTENCE=NONE
FACT: MAX_SECTIONS=200

`contracts/city-roads/document-knowledge-v1/` owns the semantic contract between Document Intake and Knowledge Service. It contains JSON Schema, a pure ESM mapping SDK, validators and conformance tests. It starts no process, opens no file, and uses no network, clock or database. Bridge `fromDocument` calls this SDK before `knowledge-core`; it no longer owns a duplicate mapping.

`documentSectionsToKnowledgeEntries(sections)` consumes parser-produced `{kind, heading?, text, start, end}` objects. Text and optional headings must be strings; source bounds are nonnegative safe integers with `end >= start`. Bounds retain the owning parser's units (for example PDF page positions), rather than claiming universal character offsets. Parser metadata such as heading level is allowed and ignored by the mapping.

The output preserves array order and uses IDs `document-0`, `document-1`, …, heading or `Section N` titles, unchanged text content, `tags:["document"]`, fixed UNVERIFIED/temporary/document labels and epoch `updatedAt`. IDs are deterministic within one temporary document query; they are not globally unique across a permanent multi-document store. Each call returns fresh values. Caller-supplied trust, shelf, domain or IDs cannot elevate output authority.

`validateDocumentSections` and `validateTemporaryKnowledgeEntries` return `{ok,errors}` with field-oriented errors that do not echo document contents. The output validator also checks that IDs agree with array order. Mapping invalid sections throws `RoadContractError` with `INVALID_DOCUMENT_SECTIONS`; the Bridge preserves `DOCUMENT_REQUIRED` for missing documents and `INVALID_ENTRIES` for more than 200 sections. Strict malformed-input validation is an additive contract boundary; valid parser-output mapping retains its prior behavior.

`node --test tests/city-roads.test.mjs` runs Road conformance and Bridge parity. Six exact public TXT/JSON/YAML/DOCX/XLSX/PDF fixtures retain the retrieval digests observed before extraction at hardening main `393f3b89a9c4fae61be1e431c4bcd47fee945e88`. Root CI includes these tests. No module promotion provenance or lifecycle changes in this extraction.
