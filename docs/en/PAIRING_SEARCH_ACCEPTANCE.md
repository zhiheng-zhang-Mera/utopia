# Pairing search and short-code repair

DATE: 2026-10-04
PAIR_STATUS: SYNCHRONIZED

The Web connection screen and connected Pairing page expose Wi-Fi/mDNS and Bluetooth search. Select a discovered City and enter its six-digit code. With no selection, the code applies to the City serving the page. Invite links and approval-based joining remain available.

Background snapshots retain the pairing input DOM node, focus, partial code and failure message. Navigating away and back restores the draft in memory; drafts are not saved as durable credentials. A remote code exchange navigates to the selected origin using a fragment and removes the fragment before exchanging. The target City identity stays pinned after a failed handoff and through retries. Wrong code, expired/used session, lockout, identity mismatch and unreachable device have distinct messages.

The Gateway performs discovery using its host's network and Bluetooth adapter. Windows BLE scanning reads the existing UUID/manufacturer locator used by Android; it does not require browser Web Bluetooth. BLE discovers the LAN address, while pairing and control use HTTP/WebSocket over the local network. Unsupported platforms, disabled radios and discovery failures are reported. mDNS identification checks the advertised addresses instead of discarding a multi-NIC City after its first unreachable address.

Validation:

- Focused pairing, join, invitation and i18n tests: see `evidence/raw/pairing-search/validation.json` for final counts and source hashes.
- Real non-loopback Windows interface: three reachable mDNS City endpoints, including the probe Gateway; six-digit exchange succeeded and consumed its session.
- Real Windows BLE scan: completed with no Utopia locators received. Discovery and pairing between two physical BLE devices: **NOT_RUN**.
- The Chinese screenshot uses a scripted nearby-device row to review layout, not evidence of a second physical device. See `evidence/raw/pairing-search/web-zh.png`.
- Hardware observations are recorded in `evidence/raw/pairing-search/hardware-probe.json` without pairing secrets or credentials.

Restart the Gateway from this feature checkout to load the server changes, then reload the Web page. A Gateway bound only to `127.0.0.1` cannot accept another device's LAN connection; use the normal Utopia launcher or configure the actual LAN IPv4 address. The tested host's active non-loopback connection was Ethernet, so physical same-Wi-Fi acceptance is **NOT_RUN**.
