# Room Pack Promotion History

This file records how each donor room moved from incubation into `city/`. The
machine-readable record lives in `../promotions/<room-id>.json`; the full code
stays in Git history.

---

## D1 · skill-intake-lab → city/02-engineering/02-worker-gateway/skill-intake

| Item | Value |
| --- | --- |
| Donor repository | `zhiheng-zhang-Mera/DS-Hns` |
| Donor SHA | `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b` |
| Donor source files | `app/extensions/mega/skills/skill-format.js`, `app/extensions/mega/skills/tar.js` |
| Incubator room | `apps/rooms/rooms/skill-intake-lab/` (removed from the live tree) |
| Accepted incubator commit | `1ba5b4809f05a155ed76fecdbb9479f900686fa1` |
| Promotion commit | `6b29e84430ba888b6bc1d5bcde344e16f23b64c2` |
| Final city path | `city/02-engineering/02-worker-gateway/skill-intake` |
| Lifecycle | `ACTIVE` |
| Promotion record | `../promotions/skill-intake-lab.json` |

### What was ported

| Donor file | City module file |
| --- | --- |
| `app/extensions/mega/skills/skill-format.js` | `format.mjs` |
| `app/extensions/mega/skills/tar.js` | `archive.mjs` |

### Adaptation

- CommonJS → ESM with named exports;
- `readSkillFile` / `scanSkillRoot` / `resolveInstalled` were dropped: the city core
  touches no disk and has no dependency on the HNS installation directory;
- `extractTar` was not carried over: this module only inspects archives in memory
  and never writes files, so there is no extraction path to get wrong;
- `readSkillFile`'s size guard moved into `parseSkillText`, so a pasted document is
  bounded by the same `MAX_SKILL_BYTES` rule;
- archive inspection reports accepted / refused entries instead of a written-files list.

### Known differences

- No skill installation in this wave: validation and inspection only;
- `readEntries` filters unsafe paths out of the entry list (donor behaviour) rather
  than surfacing them as refused entries;
- No GitHub download or source resolution (`skill-source.js`, `skill-service.js`
  belong to a later wave).

### Parity tests

The vectors come from the donor suite `tests/unit/skills-service.test.js` and cover:
name grammar, the frontmatter subset (whenToUse / metadata / every invocation
boolean spelling), malformed-frontmatter reasons, `renderSkillDocument` round-trip,
tar listing with `stripComponents`, traversal and absolute-path refusal,
symlink/hardlink/device refusal, byte and entry caps, transparent gzip and corrupt
checksum refusal.

### After promotion

```text
apps/rooms/rooms/skill-intake-lab/     removed (Git history keeps it)
apps/rooms/tests/skill-intake.test.mjs removed (the parity suite travelled with the core)
apps/rooms/promotions/skill-intake-lab.json  kept
city/.../skill-intake/tests/           the module carries its own focused tests
```
