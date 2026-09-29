# V0.2 dataset collection and interpretation

This document describes collectors and their output schema. It does not declare acceptance or infer completed trial counts. Read the saved rows, their errors, source provenance, and limitations to determine what was observed.

## Preparation and sequencing

Run commands from the repository root. Start the main City with `scripts/start-city.ps1` on an explicit reachable LAN address. The phone drivers read `.runtime/processes.json` and private `.runtime/local-config.json`. Make the platform-tools `adb` executable available on `PATH`, or set the `ADB` environment variable to its executable path. Install the intended debug APK and keep the phone unlocked with the Utopia app available.

Run only one phone driver at a time. These scripts manipulate the real Android UI, pairing state, radios, and runtime processes. UI coordinates and OS prompt handling are tailored to the pilot handset, so inspect failures rather than assuming another device has the same layout. Re-running a collector may overwrite its corresponding output file; preserve earlier attempts under distinct private filenames before retrying.

## Pairing UI pilots

```powershell
node scripts/device-pairing-pilot.mjs manual 5
node scripts/device-pairing-pilot.mjs mdns 5
node scripts/device-pairing-pilot.mjs ble 5
node scripts/device-pairing-pilot.mjs mdns 2 wrong-code
```

The numeric argument requests a run count; it is not an observed completion count. The driver stops after a recorded failure. Before each attempt it restarts the app and clears saved pairing through the UI. It creates a host session, selects the real onboarding route, and enters the control token for manual setup or the session short code for discovery modes. mDNS and BLE use native discovery observed through ADB UI inspection; the driver does not inject descriptors or discovery results. The wrong-code scenario checks for HTTP 403 in the Android UI and absence of an ONLINE indication.

Each run records Git HEAD, the hash of the APK actually installed on the device, host-side start/end timestamps, success/error, mode, and driver description. The pairing driver verifies that the installed APK hash matches the locally built debug APK before proceeding. It copies the app-private pairing event log into `.runtime/evidence/v0.2/<mode>-events.jsonl` and writes `<mode>-runs.json`; scenario-specific files use `<mode>-<scenario>` instead.

The general pairing driver deliberately excludes `qr`. The separate `node scripts/device-qr-pilot.mjs 5` driver uses ADB only for onboarding and requires physical positioning of the camera toward the visible host QR. After requesting camera launch it observes allowlisted app-private events, without camera screenshots or UI dumps. It writes `qr-runs.json` and `qr-events.jsonl`; a timeout or failed decode remains a failed observation. An injected URI, deep link, descriptor, or API exchange must not substitute for physical scanning. Read the recorded results rather than inferring a successful scan from driver availability.

## Connection and discovery recovery

```powershell
node scripts/device-recovery-pilot.mjs wifi 3
node scripts/device-recovery-pilot.mjs node 3
node scripts/device-recovery-pilot.mjs gateway 3
node scripts/device-discovery-recovery.mjs all
```

The connection recovery driver disables/re-enables phone Wi-Fi or stops/restarts the selected main runtime process. It records sampled Android status strings, the Web connection indicator, disconnect/restore/observed transition timestamps, City identity comparison, and preservation checks for the pre-existing task states and events. It records the installed APK hash. Outputs are `.runtime/evidence/v0.2/<kind>-recovery.json` and captured `<kind>-<run>-offline.xml` files. These are sampled observations, not proof that every instant of a transition was observed.

The discovery recovery driver accepts `all`, `ble`, or `mdns`; `all` requests both mechanisms. Its configured loop requests two trials per mechanism and stops that mechanism after a failure. It requires the main Gateway on port 4310, verifies the installed APK against the local build, and uses the actual onboarding discovery UI. BLE trials toggle the phone's Bluetooth; mDNS trials verify the Gateway process identity before stopping/restarting it. The driver observes disappearance and rediscovery of the main City, checks identity, and records any restoration after failure. Outputs are `discovery-recovery.json` and allowlisted `ble-discovery-<run>-<phase>.xml` / `mdns-discovery-<run>-<phase>.xml` projections under the private evidence directory. These projections omit editable/password text. Run this driver after other phone pilots; it clears saved pairing.

## Isolated API failure pilots

```powershell
node scripts/pairing-failure-pilot.mjs
```

This harness creates independent loopback Gateways with discovery disabled under `.runtime/failure-pilot`. Two expiry sessions run concurrently with the real default 300000 ms lifetime and wall-clock waits beyond expiration. No shortened TTL or fake clock is used. Other cases submit incorrect short codes, replaced QR-session material, and previously consumed QR-session material. Assertions cover rejection HTTP status, absence of credentials/material in rejection responses, and stable City identity.

Only sanitized timing, booleans, statuses, exact starting Git SHA, dirty-worktree flag, and source hashes are written to `evidence/raw/v0.2/pairing-api-failures.json`. Source hashes are checked again at the end and Gateways are closed in `finally`. This is HTTP API integration evidence using genuine temporary material held in memory. It does not observe Android rejection UI, QR camera scanning, mDNS, or BLE.

## Full-stack resource pilot

```powershell
$env:CITY_RESOURCE_HOST = '192.168.1.20'
node scripts/stack-resource-pilot.mjs
```

Replace the example with an IPv4 address actually assigned to the host's LAN interface. The Windows-only driver starts a temporary City on port 4311, separate from the main City. Baseline disables discovery and telemetry; normal mode enables both and genuinely advertises the temporary City. Avoid running phone discovery pilots concurrently. `UTOPIA_RESOURCE_PILOT_MS` optionally sets each measurement window from 3000 to 300000 ms; the default is 30000 ms after a five-second warmup.

The output `evidence/raw/v0.2/stack-resource-pilot.json` contains per-process-role CPU time and working-set samples, discovery/telemetry checks, and derived CPU percentage of one logical core and combined RSS. Missing counters or inactive required discovery produce incomplete measurements. One sequential baseline/normal pair is not a general overhead claim: host load and ordering are uncontrolled, shared pages can be counted twice, and Windows services, startup, clients, user tasks, and network bytes are outside the measured scope.

## Timestamps, actions, and sanitization

App events use UTC `Instant.now()` timestamps and trial IDs; host drivers use ISO wall-clock start/end timestamps. The bundle associates app trials with host observation windows, so clock offsets or missing events can leave fields null or cause incomplete associations. Do not replace missing timestamps with guessed values. `discoveryLatencyMs`, `pairingExchangeLatencyMs`, and `timeToOnlineMs` are timestamp differences between their named events. Overall UI-driven timings include ADB commands, UI hierarchy inspection, polling, and driver delays; they are not natural-human speed measurements.

`userActions` counts instrumented primary app button actions. It excludes typed characters, OS permission gestures, and driver setup. `retryCount` comes from instrumented app retries; discovery recovery has its own explicitly recorded retry count. The Manual-route entry tap and field-focus taps are not instrumented; do not compare this field as complete effort across methods. Neither is an exhaustive measure of human effort. Inspect repeated events and historical attempts before aggregating.

```powershell
node scripts/bundle-v02-evidence.mjs
```

The bundler selects private records from `.runtime/evidence/v0.2/` and writes the publication candidate to `evidence/raw/v0.2/`: `<mode>-trials.json`, per-trial `<mode>-<run>-events.jsonl`, recovery JSON/XML, available telemetry-consistency records and device screenshots, `historical-attempts.json`, and `environment.json`. The API and resource pilots already write sanitized JSON to that destination. `manifest.json` hashes every destination file other than the manifest itself; regenerate it after changing bundle contents. Per-run source/APK bindings remain in the records rather than being inferred from the manifest timestamp.

QR records are published separately as `qr-runs.json`, `qr-trials.json`, `qr-events.jsonl`, and `qr-<run>-events.jsonl`, including failures. Targeted manual/mDNS/BLE files with a `-radiofix` suffix (and optional further suffix) retain that complete prefix in their corresponding runs, trials, and event filenames. They do not replace the original `<mode>` series. Each row keeps its original `codeSha` and installed `apkSha256`; older APK results must not be relabeled as a newer build. Normalized `startTimestamp` is the app start event, while `driverStartTimestamp` and `driverEndTimestamp` preserve the driver window. Missing event associations or counters remain null/explicitly unobserved.

Discovery publication is split: `mdns-discovery-recovery.json` selects only mDNS rows from private `discovery-recovery-mdns-and-ble-attempt.json`; `ble-discovery-recovery.json` selects only BLE rows from private `discovery-recovery.json`. Each retains the source document's top-level commit/APK metadata plus its source filename and SHA-256. Published `discovery-recovery.json` is an index of these files, not a merged same-build result. Historical and driver records are retained in `historical-attempts.json` and `historical-<original-filename>`, including `historical-pre-radio-fix-discovery-recovery.json` and `historical-mdns-wrong-code-driver-attempt.json`.

Historical discovery wrappers explicitly set `originalSnapshotReferencesUnresolved: true`. Their snapshot names are original private filenames, not links to current published XML: earlier XML was not preserved before reruns, and filenames overlap. A newer XML file must never be used as evidence for an older historical observation merely because the filename matches.

For textual copied/generated records the bundler rejects known local credentials and selected sensitive fields or Windows paths. PNG copies require separate visual inspection; the script does not redact image pixels. The manifest also covers files already present in the destination, so stale or manually added files must be reviewed. Do not capture active pairing codes/QRs, permanent credentials, unnecessary device identifiers, or private paths. Preserve failed attempts and their applicability limits; sanitization and hashing do not turn incomplete observations into acceptance evidence.
