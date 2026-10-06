# Controlled research campaigns

Open Research, register a manifest, then enter its ID in Controlled campaigns. Choose a safe task scenario, measured repetitions, warmups and run timeout. Start returns immediately; the progress list and selected receipt refresh every second. Stop cancels only the current campaign task and prevents further runs.

The manifest must name live canonical worker and control-surface references. Seed selects a declared worker deterministically and canonical strict targeting keeps execution inside the declared topology. Explicit API targets bypass seed selection and say so. Warmups, failures, timeouts and exclusions remain in receipts. Completion means the bounded campaign ended; it does not certify the manifest's research hypothesis or independent reproduction.

`GET/POST /api/v0/research/campaigns`, `GET /api/v0/research/campaigns/:id`, and `POST /api/v0/research/campaigns/:id/stop` require the City owner. Workers and enrolled members are refused. Manifest registration still executes nothing.

Restart uses `INTERRUPT`; active campaigns never resume silently. Canonical tasks carry research run ownership atomically, allowing startup to find tasks created before their receipt pointer was saved. Receipt timings use host wall time, not cross-host latency. Software references are declared exact identity and require independent runtime verification. Android control parity and an Alien/Mech/Android physical campaign remain acceptance work; this component exposes its control in Web Research.

Run `node --test tests/rex803-*.test.mjs` and `pnpm test`. Evidence: `evidence/raw/mission-book/REX-803/`.
