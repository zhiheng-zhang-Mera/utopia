# Bounded research faults

Open Research → Advanced / Danger Zone. Select a currently online worker, fault kind and duration up to 30000 ms. Read the impact, type `FAULT:<kind>:<nodeId>`, then confirm injection. Select a receipt in history to inspect it or stop it. Emergency stop remains available while status refresh is pending.

- HEARTBEAT_LOSS refuses the target's heartbeat requests. Canonical timeout may mark it offline and fail work. Agent register fallback is not suppressed; this fault is specifically heartbeat loss, not full network disconnection.
- PROVIDER_UNAVAILABLE refuses target execution claims, not an external model/provider API.
- DELAY_RESULT holds target reports until bounded expiry or emergency stop. Canonical validation still decides whether a released report is stale or acceptable.
- DUPLICATE_EVENT repeats target-authored canonical events into research observation only. Canonical task/event execution is never duplicated.

Every task on the selected worker can be affected. Other workers continue. These faults do not kill processes, modify OS resources, change credentials, delete data or attack networks. Stop removes injection; it does not resurrect failed tasks. Restart records interruption and never automatically restores a fault. Owner credentials are required; node credentials and enrolled members cannot operate fault controls.

Receipts persist in the runtime research directory. Detection is recorded only when an exercised active heartbeat fault coincides with canonical NODE_OFFLINE. Recovery measures from injection removal until a successful target operation after an exercised fault. Unobserved measurements remain null with reasons; these values do not prove external provider or physical-host recovery. Summary responses retain the most recent 128 receipts and disclose truncation. Full receipts stay on disk.

API: `GET/POST /api/v0/research/faults`, `GET /api/v0/research/faults/:id`, `POST /api/v0/research/faults/:id/stop`. Test with `node --test tests/rex804-*.test.mjs`. Web is the current control surface; Android parity remains an explicit exposure seam for REX-807. Formal Mech review must add a previously unused fault probe.
