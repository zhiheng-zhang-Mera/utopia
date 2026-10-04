# City members, communication and local host roles

DATE: 2026-10-04
PAIR_STATUS: SYNCHRONIZED

A host initially owns its own City with a stable host identity and name. After successfully joining another City, it stores its admission name and installation identity, retires only its own Gateway, Rooms and original agent, preserves its original database, and runs a member agent against the target City. The remote primary stays running. Selected membership is persisted separately; restart reconnects to that target and missing credentials or an unreachable target never trigger a primary fallback.

The device list unifies the City host, enrolled members, computing nodes and Web controls. This device is pinned first; other devices use admission names. Tabs of one identity are merged, while equal names do not merge different identities. Only a local request with the local owner credential may change host roles; an enrolled member cannot demote the remote host.

Device details support messages. City persists and relays them, and marks receipt only after the recipient confirms it. Members see only messages they send or receive. Server acceptance does not imply device receipt.

Installed agents share existing safe task capabilities and real CPU, memory and disk telemetry. Device details can stop or enable local sharing; tasks may strictly target a device. Stopping sharing prevents further claims and does not interrupt work already running. Web-only clients provide control and communication; without an agent they do not claim hardware sharing. GPU, arbitrary commands and model services are not verified capabilities of this version.

Failed joins and unfinished local tasks preserve the original primary. New admissions cannot assume existing identities; member identity constrains heartbeat, claim and result operations. Browsers hold renewable sessions only; durable keys stay in native files. HTTP and relay use the same admission implementation.

Physical two-host results remain NOT_RUN when unavailable; isolated multi-agent and browser tests do not establish geographical reachability or hardware performance.
