# One host City and remote login

All updated installations and the production Gateway entry share the fixed `127.0.0.1:4389` reservation. Repeated launches, including requests for another City port, reuse the running City. An unrelated coordination listener prevents startup. A listening legacy Gateway must be stopped explicitly; startup does not kill it automatically.

The canonical directory pointer defaults to `%ProgramData%/Utopia/host/city.json`. First startup adopts the requested installation's existing `city.sqlite`, or uses the shared `city` directory when no database exists. Other installations and crash recovery retain that directory and City identity. A missing registered database blocks startup rather than silently creating a new City. Multiple historical databases are not merged; the first registered City becomes this host's City.

The Gateway, reference node and Rooms share one process. Closing the launcher window leaves the background City running. `scripts/start-city.ps1` starts or reuses the host City; `scripts/stop-city.ps1` explicitly stops it; `scripts/restart-gateway.ps1` restarts it while preserving endpoint, Rooms, discovery and telemetry options. Repeated startup does not override live options.

Device enrollment lives in `%LOCALAPPDATA%/Utopia/client/device-enrollment.json`, with migration from the current installation's old record. The ordinary launcher reconnects to the recorded remote endpoint. Failure stops without starting a local fallback City. Host scripts use `--host-only` so remote enrollment does not redirect host startup.

Remote invitations retain their destination. Short-code enrollment is:

```powershell
node scripts/utopia-client-launcher.mjs --enroll-code 123456 --enroll-host https://your-city.example --no-open
```

The six-digit code belongs to the target City's active pairing session. Existing single-use, expiry and attempt limits apply. It is not a global City locator. Cross-region login requires a reachable endpoint; local IP addresses, mDNS and Bluetooth do not discover Cities across the internet. No public relay, global short-code directory or automatic NAT traversal is deployed by this change. Public use requires an actual HTTPS and routing deployment. Local HTTP regressions do not establish real cross-region acceptance.

Tests may use `UTOPIA_HOST_STATE_DIR` and `UTOPIA_CLIENT_STATE_DIR` for temporary data; the production coordination port remains fixed. Low-level `createGateway()` retains multi-City test support and is not a production launch entry.
