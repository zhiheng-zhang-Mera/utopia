# Device Center and pairing operator guide

## Start the City on Windows

Use PowerShell from the repository root with Node.js 24 or newer and the repository dependencies installed (`pnpm install --frozen-lockfile`). Start the Gateway and reference node with an explicit address assigned to the host's trusted LAN interface:

```powershell
.\scripts\start-city.ps1 -BindAddress 192.168.1.20 -Port 4310
```

Replace the example address with this computer's actual LAN IPv4 address. Android must be able to reach that address on the same trusted LAN; permit the configured port only as needed on the private network. The default address, `127.0.0.1`, is for local use and cannot be reached from a phone. Do not use a wildcard bind address or expose the Gateway through Internet port forwarding.

The script starts background Gateway and node processes, saves their process IDs and URL in `.runtime/processes.json`, and prints the City and pairing-page URLs. It creates separate control and node credentials in `.runtime/local-config.json` on first use. Preserve this private configuration across restarts. `-DisableDiscovery` and `-DisableTelemetry` are optional diagnostic switches; normal operation leaves both features enabled.

## Open the Web controller

Open the printed City URL or run `scripts/show-pairing.ps1` to open its `/pairing` page. Read the `token` field privately from `.runtime/local-config.json` and enter it in the Web **Pairing token** field. Do not use `nodeToken`. The Web controller retains the control token in browser session storage. **Settings → Change pairing token** clears that browser's saved token.

**Devices** lists nodes from the Gateway snapshot. Select a device to view its identity, platform, agent version, last-seen time, CPU, memory, disk, uptime, capabilities, current tasks, and recent events. **Tasks** and **Activity** continue to show the same control-plane task history.

## Create a temporary pairing session

In **Pairing**, check the City URL and discovery diagnostics, then choose **Generate pairing session**. The page displays a QR code, a six-digit short code, the current session identifier, and an expiry countdown. The default lifetime is five minutes. One successful exchange consumes the session; it cannot pair a second device.

**Revoke and refresh session** immediately replaces the previous session. Expired, consumed, or replaced material must be refreshed before another pairing attempt. Five incorrect exchange attempts lock that session; generate a new one on the host. The QR contains temporary pairing material, not the permanent control credential.

The Web page clears displayed QR/code material on expiry, disconnect, or navigation away. Leaving the page hides the material but does not itself revoke the Gateway session; creating another session revokes the previous one. Never save an active QR, short code, or permanent credential in screenshots, UI dumps, logs, source control, or experiment records.

## Pair Android

With no saved credential, the Android app opens **Find your City**:

1. **Scan QR:** allow camera access and point the camera at the active Web QR. The app exchanges the temporary secret and connects without copying a URL or token.
2. **Nearby Cities (LAN):** discover the City through mDNS, select it, enter the short code displayed on the host, and choose **Connect**. Create a host pairing session first. The app refreshes session information when connecting.
3. **Nearby via Bluetooth:** enable Bluetooth and grant the requested Nearby devices permissions (or location permission on older Android). Select a discovered City and enter the host's short code. A reachable LAN connection is still required; Bluetooth supplies discovery information only. Permission denial, disabled Bluetooth, and unavailable scanners produce readable messages. Check the Web Bluetooth diagnostic if no City appears.
4. **Manual connection:** enter the City URL and the private control `token`, then choose **Save and connect**. This fallback does not need a temporary session or discovery service.

After authentication, **Devices** displays the shared Gateway snapshot. In Android **Settings**, **Clear pairing / Find your City** removes the saved connection and returns to onboarding. This clears this client's saved credential; it does not rotate the host's permanent credential.

All four routes converge on the existing authenticated HTTP/WebSocket control plane. Discovery does not create a second task or device database. Conflicting endpoints for one City identity must be investigated rather than silently merged.

## Read telemetry and connection state

The reference node samples telemetry approximately every three seconds. Samples include an observation timestamp; the UI freshness limit is ten seconds. CPU may initially be unavailable until a second sample allows a delta calculation. Unavailable or `null` fields mean **Unknown**, not zero.

An offline node is **OFFLINE**. A client disconnected from the Gateway cannot assert live node state and shows **UNKNOWN**; the client may separately show **RECONNECTING**. Stale telemetry is explicitly cached/unknown. Cached numbers remain historical observations and must not be interpreted as live measurements. Restore the LAN/Gateway or node connection and allow the next authoritative snapshot to refresh the display.

## Discovery details and boundary

mDNS advertises `_utopia-city._tcp` with non-secret version, City, and session hints. Windows BLE uses manufacturer ID `0xffff` and a 23-byte payload: the canonical 16-byte UUID `6f9a0001-6c53-4b92-a319-75746f706961`, one protocol-version byte, four IPv4 bytes, and a two-byte big-endian port. The UUID is a manufacturer-data prefix because the Windows WinRT publisher reserves service-UUID advertisement fields. Android filters that prefix and fetches the full City/session descriptor through `pairing/info`; the small advertisement does not carry identity/session hints, pairing secrets, or permanent credentials.

BLE advertising depends on the host's adapter and driver. The Web diagnostic reports the publisher/capability state and any available reason. Use QR, mDNS, or manual connection when advertising is unavailable. BLE never carries task commands or telemetry.

**LAN DEVELOPMENT ONLY · NOT FOR PUBLIC INTERNET.** This development setup uses a trusted LAN and does not provide public-network account or transport-security infrastructure.
