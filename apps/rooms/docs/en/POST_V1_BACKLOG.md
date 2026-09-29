# Room Pack V1 Post-V1 Backlog

This file records only the Room Pack's own later ideas. None of them is a current blocker and none blocks `MECH_ROOM_PACK_V1_READY_TO_ATTACH`.

## Second-batch room candidates (only after an explicit decision)

| Room | Why it is deferred |
| --- | --- |
| Hospital / health records | Sensitive data with a much stronger privacy boundary |
| Quant / data processing | Easily becomes a large independent domain |
| Digital-Me | Needs long-term profiling and cross-room integration |
| Wearables | Needs external devices and protocols |
| File manager | Collides with the operating system's file boundary |
| Password vault | High security requirements; needs dedicated cryptographic design |
| Cloud sync | Contradicts the single-host local product positioning |
| AI chat | Needs an external provider and would cross the Boss/Hns boundary |
| Automation | Becomes a scheduler and overlaps City Control responsibilities |

## Enhancements for the current ten rooms

| ID | Room | Item |
| --- | --- | --- |
| RP-B01 | Hub | Cross-room full-text search |
| RP-B02 | Hub | Custom room order / favourites |
| RP-B03 | Knowledge | Markdown rendering, entry version history |
| RP-B04 | Bookmarks | Bulk import of a browser bookmarks HTML export |
| RP-B05 | Checklist | Checklist templates, copy across lists |
| RP-B06 | Prompts | Variable presets, reusable template fragments |
| RP-B07 | Text Workshop | Regex find/replace, word-count targets |
| RP-B08 | Hash | More algorithms (SHA-1 / MD5 for verification display only), batch files |
| RP-B09 | Data Lab | JSON path queries, CSV column filtering and export |
| RP-B10 | Focus | Custom presets, daily/weekly statistics views |
| RP-B11 | Calendar | Week view, simple recurrence |
| RP-B12 | Decisions | Local review-due hints (not OS notifications) |
| RP-B13 | Global | One bundle that exports/imports every room at once |
| RP-B14 | Global | Link into Utopia's main UI navigation (a very small integration change) |

## Known technical debt

- Some repetition remains between rooms (list + editor layout, export/import interactions). By design, an abstraction is only extracted into `shared/` once at least **three** rooms really use it; today that is store, room-kit, http, text-tools, csv and client-kit.
- The frontend has no framework and no build step: the rendering and splitting strategy must be revisited if the room count keeps growing.
- Each room's `client.mjs` manipulates the DOM directly, with no component tests; browser acceptance is one canonical walkthrough (within the agreed test budget).
- `.runtime-rooms` has no cross-process write lock (see section 6 of the acceptance record).
- Room frontend errors surface through the hub shell as "failed to load"; finer error codes could follow.
