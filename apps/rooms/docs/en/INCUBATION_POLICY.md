# Room Pack Incubation and Promotion Policy

**Status:** in force
**Applies to:** `apps/rooms/**` (the Room Pack is the incubator for every new room, not the final city property)
**Related records:** `apps/rooms/promotions/*.json`, `city/CITY_IMPLEMENTATION_MANIFEST.json`

---

## 1. Why this policy exists

The Room Pack started as "ten local product rooms". From this round on its role is explicit:

```text
ROOM PACK
= local utility product
+ incubation / proving ground for every future new room
```

Any new feature whose final home is a formal city module must first become an
**operable, testable, single-host acceptable** temporary room here, and only then
be considered for promotion. **Skipping incubation and pushing low-maturity donor
code straight into `city/` is forbidden.**

There are only three exceptions:

1. existing city infrastructure that already has its own repository and mature acceptance;
2. pure schema / contract material with no user product behaviour;
3. an explicit user instruction to go directly into `city/`.

---

## 2. Lifecycle

A room must declare one of these (`ROOM_LIFECYCLES` in `hub/manifest.mjs`):

| Lifecycle | Meaning |
| --- | --- |
| `LOCAL_PRODUCT` | a finished local product room; **never** forced into `city/` by this policy |
| `INCUBATING` | a donor room being proved inside the Room Pack |
| `ACCEPTED_LOCAL` | the incubating room passed local acceptance |
| `PROMOTION_CANDIDATE` | accepted and queued for promotion |
| `PROMOTED` | the live incubator implementation is gone; the core lives in `city/<district>/<building>/<module>` |
| `REJECTED` | abandoned; kept only in Git history |

The existing ten rooms stay `LOCAL_PRODUCT`. A new donor room starts `INCUBATING`.

`PROMOTED` and `REJECTED` rooms no longer appear in the active catalog (`ROOMS` in
`hub/manifest.mjs`); they remain only in `ALL_ROOMS`, Git history and the promotion
record.

---

## 3. Room metadata contract

Every incubating room carries at least (`apps/rooms/hub/manifest.mjs`):

```text
id
label
lifecycle
targetCityPath        # e.g. city/02-engineering/02-worker-gateway/skill-intake
donorRepository       # e.g. zhiheng-zhang-Mera/DS-Hns
donorCommit           # the pinned donor SHA
donorSourcePaths[]    # the exact files copied from the donor
```

Plain local rooms:

```text
donorRepository = null
targetCityPath  = null
```

---

## 4. Promotion records

Every successfully promoted room leaves a record at `apps/rooms/promotions/<room-id>.json`:

```json
{
  "roomId": "skill-intake-lab",
  "acceptedRoomCommit": "<commit of the accepted incubator state>",
  "promotedAtCommit": "<the promotion commit>",
  "targetCityPath": "city/02-engineering/02-worker-gateway/skill-intake",
  "donor": {
    "repository": "zhiheng-zhang-Mera/DS-Hns",
    "commit": "eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b",
    "sourcePaths": ["app/extensions/mega/skills/skill-format.js"]
  },
  "status": "PROMOTED"
}
```

`hub/promotions.mjs` validates the record shape and cross-checks that:

- the recorded room is no longer in the active catalog;
- the room's `lifecycle` is `PROMOTED`;
- the recorded `targetCityPath` matches the one declared in the manifest.

`tests/incubation.test.mjs` runs these checks.

---

## 5. No second living implementation after promotion

After a successful promotion:

```text
apps/rooms/rooms/<lab>/
```

is removed from the final tree. What remains:

```text
Git history
promotions/<room-id>.json
the bilingual catalog / history documentation
```

**Room and City must never drift apart as two live implementations.**

---

## 6. The full promotion sequence

```text
1. branch from the latest main
2. pin the donor SHA and record the source files (DONOR_COPIED)
3. port only the minimum semantic closure; no donor runtime or data directory
4. align parity tests with the donor's equivalent vectors (DONOR_PARITY_PROVED)
5. create the incubator room under apps/rooms/rooms/<lab>/
6. focused tests plus a browser core action (ROOM_PRODUCT_ACCEPTED)
7. commit the accepted state and record the accepted room commit
8. extract the core into city/<district>/<building>/<module> (CITY_PROMOTED)
9. remove the live incubator implementation from the final tree
10. write promotions/<room-id>.json
11. update the city manifest
12. run the city module tests and the impacted Room Pack tests
13. verify the donor repository is unchanged
14. PR → merge → re-verify on the merged result
```

---

## 7. Failure and stop-work policy

If a donor shows any of these:

```text
still needs the donor runtime after the minimal closure is copied
would require copying a huge scheduling/permission system
cannot form a verifiable product inside a single-host room
parity is unclear
behaviour depends heavily on hidden state
```

then:

```text
DONOR_STATUS = DEFERRED
```

Record the reason, move to the next donor, and **never let one donor block the wave**.
A `DEFERRED` item must never be faked as `ACTIVE` in the city manifest.

Only these stop everything:

```text
the Utopia repository is unavailable
the Room Pack baseline is corrupted
the migration would require a history rewrite
credentials would have to be exposed
```

---

## 8. Donor provenance discipline

The old projects `Codex-Boss` and `DS-Hns` stay:

```text
READ ONLY
NO PR
NO source cleanup
NO migration marker written back
NO deprecation
NO redirect to Utopia
NO shared runtime data
```

Adapted code inside Utopia is owned by Utopia going forward; **no two-way sync
obligation is created.**
