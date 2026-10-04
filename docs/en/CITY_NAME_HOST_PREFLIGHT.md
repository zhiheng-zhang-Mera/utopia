# City names, admission names and startup preflight

DATE: 2026-10-04
PAIR_STATUS: SYNCHRONIZED

The database persists the City display name, initially derived from the host name. Settings can change it; snapshots, pairing, discovery descriptors and the page label use that canonical name. Renaming retains cityId and does not create another City. Joined clients show the target City's name rather than their own host name.

An admission request first asks for this device's display name. Cancelling submits nothing. Cross-origin navigation carries the selected name to the approval card and connected Web surface. Display text grants no trust.

Startup checks the fixed host reservation, then older Gateway processes and listening ports. One existing City is reused across requested ports. Multiple processes, or a known listener whose identity cannot be established, block creation and report existing endpoints. A relative-path legacy launch with unavailable credential location opens its existing pairing page instead of creating another City.

The production Gateway entry performs the same check. Unmodified old launchers do not acquire this behavior automatically; update the installation actually used. Preflight targets local Gateway processes, leaves other devices' Cities alone and preserves historical databases. Equal names do not establish equal City identity; use cityId and endpoint.
