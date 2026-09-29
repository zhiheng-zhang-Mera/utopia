# UTOPIA · Room Pack promotion records.

One JSON file per promoted room, named `<room-id>.json`.

A record is written when an incubator room is formally promoted into
`city/<district>/<building>/<module>` and the live incubator implementation is
removed from the final tree. It is the machine-readable half of the promotion;
the human-facing policy lives in `../docs/zh-CN/INCUBATION_POLICY.md` and
`../docs/en/INCUBATION_POLICY.md`.

Required shape (see `hub/promotions.mjs` for the exact validation):

```json
{
  "roomId": "skill-intake-lab",
  "acceptedRoomCommit": "0123456789abcdef0123456789abcdef01234567",
  "promotedAtCommit": "fedcba9876543210fedcba9876543210fedcba98",
  "targetCityPath": "city/02-engineering/02-worker-gateway/skill-intake",
  "donor": {
    "repository": "zhiheng-zhang-Mera/DS-Hns",
    "commit": "eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b",
    "sourcePaths": ["app/extensions/mega/skills/skill-format.js"]
  },
  "status": "PROMOTED"
}
```

`donor` may be `null` for a room that was not derived from an external donor.

This directory is read by `hub/promotions.mjs` and asserted by
`tests/incubation.test.mjs`. A record whose room is still in the active catalog,
or whose `targetCityPath` disagrees with the room manifest, fails those checks.
