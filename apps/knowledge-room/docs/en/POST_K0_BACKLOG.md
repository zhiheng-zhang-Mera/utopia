# MECH-K0 Post-K0 Backlog

This file records only the Knowledge Room's own later enhancement ideas. None of them is a current blocker, and none blocks `MECH_KNOWLEDGE_ROOM_READY_TO_ATTACH` / `MECH_KNOWLEDGE_ROOM_ATTACHED`. They are recorded as found and are not built in this round.

| ID | Type | Item | Trigger |
| --- | --- | --- | --- |
| KR-B01 | Product | Link into Utopia's main navigation (a very small integration commit, requiring Alien-side cooperation or user approval) | Once Alien's mainline is stable |
| KR-B02 | Product | Rich text / Markdown rendering and preview | Once the plain-text shape is in real use |
| KR-B03 | Product | Bulk tag management and tag rename | Once the tag count grows |
| KR-B04 | Product | Sort switching (created / title / updated) | Once the entry count grows |
| KR-B05 | Product | Pagination or virtual scrolling | At thousands of entries on one host |
| KR-B06 | Data | Import merge mode with conflict resolution | When a real multi-source merge need appears |
| KR-B07 | Data | Automatic backup and version history (pre-save snapshots) | When users report hard-to-recover deletions |
| KR-B08 | Data | Recycle bin / soft delete | Same as above |
| KR-B09 | Engineering | Cross-process write locking (multiple instances on one host) | When a real multi-instance scenario appears |
| KR-B10 | Engineering | Per-entry full-text index | When plain substring search is insufficient at real scale |
| KR-B11 | Engineering | Structured audit log (who changed what, when) | When an audit requirement appears |
| KR-B12 | UI | Multiple themes / accessibility pass (full keyboard flow, contrast audit) | When concrete usability feedback arrives |
| KR-B13 | Enhancement | Semantic retrieval / embeddings / LLM summaries | Only after an explicit project decision; not part of K0 |
| KR-B14 | Enhancement | Attachments, images, PDF/OCR | Only after an explicit project decision; not part of K0 |

## Known technical debt (does not affect this acceptance)

- The `.gitignore` inside `runtime-data/` slightly overlaps the root `.gitignore`, but the root file must not be modified, so it stays inside the directory;
- Browser acceptance uses an external driver script (headless Chrome over CDP) that is neither repository content nor a deliverable;
- The UI uses no frontend framework; the rendering strategy must be re-evaluated as the entry count grows (see KR-B05).
