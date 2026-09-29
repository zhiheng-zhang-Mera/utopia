# Android physical-device runbook

Use Java 17+ and Android SDK 36. Set SDK location in untracked `apps/android/local.properties` or ANDROID_HOME. From apps/android run `gradlew.bat :app:testDebugUnitTest :app:assembleDebug`. Install `app/build/outputs/apk/debug/app-debug.apk` with `adb install -r`. Confirm the device's installation dialog when needed. Launch package city.utopia.control.

Settings contains City URL, pairing token and diagnostics. Enter the Gateway LAN URL and control token from the host's private configuration. Save and connect. The token is kept in app-private preferences with backup disabled. Do not include it in screenshots, logs or GitHub.

Home shows connection, node, counts and Run Test Task. Tasks shows state, progress, node, checkpoint, result and cancellation. Activity shows the canonical event sequence. Create CHECKPOINT_DEMO on the phone; compare its ID, state, event sequence and SHA-256 result with the browser.

With historical tasks present, restart the Gateway and verify both clients recover the same history. Turn Wi-Fi off and on while the app is visible; OFFLINE and RECONNECTING must not be shown as live healthy nodes. After reconnection verify a fresh snapshot and event stream. Mobile data, if available, may remain enabled; a private LAN host remains unreachable through cellular networking.

This reference is foreground-oriented, uses development cleartext LAN transport and is not a background daemon or store release. The scripts/device.mjs helper uses ADB and stores local screenshots/UI dumps under `.runtime/evidence/`.

FACT: minSdk=26; compileSdk=36; targetSdk=35; versionName=0.1.0
PAIR_STATUS: SYNCHRONIZED
