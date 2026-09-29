# Alien host runbook

Install Node.js 24 and pnpm. In the repository run `pnpm install --frozen-lockfile`. Start with `./scripts/start-city.ps1 -BindAddress <LAN-IPv4>`. It launches hidden Gateway and Reference Agent processes, writes their PIDs to `.runtime/processes.json`, and stores generated credentials in `.runtime/local-config.json`. Open the printed URL in your browser and enter the control `token`. Never expose the nodeToken to control surfaces.

Use a specific LAN IPv4 address, not all interfaces. If Windows Firewall blocks the phone, allow only the selected TCP port from the local subnet. Do not disable the firewall. Default port is 4310. Both devices must be on the same LAN. No public forwarding, cloud deployment, arbitrary shell, background service or native Windows wrapper is provided.

For restart, stop only the Gateway PID recorded for this checkout, then relaunch `services/dev-gateway/main.mjs` with CITY_HOST, CITY_PORT, CITY_DATA, CITY_TOKEN and CITY_NODE_TOKEN as used by the start script. Keep the agent alive; it re-registers after the Gateway returns. Do not run two gateways against one database. Keep `.runtime/city.sqlite` and its SQLite sidecars together when backing up with the Gateway stopped. Never commit credentials or runtime databases.

Tests: `pnpm test` (Web test needs Microsoft Edge), `pnpm check:docs`. The Gateway needs no bundling step; the Web is static ES modules. Logs are in `.runtime/`. Completed file tasks clean their private artifacts. After abrupt termination, inspect only the failed task's generated directory under `.runtime/workspace/` before removing it.

FACT: nodeMajor=24; port=4310; apiVersion=0; schemaVersion=0
PAIR_STATUS: SYNCHRONIZED
