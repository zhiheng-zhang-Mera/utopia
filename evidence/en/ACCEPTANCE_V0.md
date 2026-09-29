# V0 acceptance

STATUS: DIGITAL_CITY_PRODUCT_V0 = ACCEPTED
SHA: 52217fd81fe9fba672e99f7df09a24b63014e9e5
TASK_ID: Q-74be4775-1d81-46c2-8de1-3b43593cebb7
FACT: androidSource=7fa99306a16fb2a7a43107c1afbe0ea77df2edbf
FACT: apkSha256=5e41f5ca109ca7304bf42d26cb749a5f1852de76904697d83c3348f18419d26e
FACT: android=OPPO-PERM00; os=Android-12; api=31; app=0.1.0; versionCode=1
FACT: host=Windows-10.0.26200; node=v24.19.0; gateway=0.1.0
FACT: taskState=COMPLETED; taskEvents=7; artifactBytes=65; artifactSha256=25b63368c214dab2c75a4a475b89bc0f368dd700603d14a06e4275eeace31f31; cleaned=true
FACT: restart=PASS; preservedTasks=2; preservedEvents=31; wifiReconnect=PASS; staleGreen=ABSENT
FACT: nodeTests=5; androidUnitTests=2; bilingual=PASS; platformNeutrality=PASS; repositorySeparation=PASS
PAIR_STATUS: SYNCHRONIZED

All nine workbook gates passed in the reference environment. Android created the canonical CHECKPOINT_DEMO over the physical LAN; the separate Alien node wrote a 65-byte file, checkpointed, hashed and cleaned it. Android and a visible Microsoft Edge Web surface displayed the same task ID, terminal state, result and all seven task events. The final canonical task was run after installing the connection-diagnostics build. The earlier smoke task remains in history.

Gateway restart preserved both tasks and all 31 pre-restart events, compared by stable event ID and full payload. Both surfaces recovered. ADB disabled then restored real Wi-Fi; UI trees show OFFLINE with node UNKNOWN, then ONLINE. Connection logs also show RECONNECTING. The final gateway includes the separately tested ASSIGNED-to-FAILED report fix; Android sources are unchanged since the source SHA above.

Gate results: Build PASS; LAN connectivity PASS; real task PASS; shared truth PASS; durability PASS; reconnect PASS; platform neutrality PASS; repository separation PASS; bilingual audit PASS. Platform audit inspected contracts and task semantics; Windows code is behind the filesystem adapter and platform is metadata only. All work was confined to Utopia; Digital-City, Boss and Hns were not modified.

Evidence: [task UI](../raw/android-task-final.png), [Web UI](../raw/web-task.png), [events](../raw/android-events-final.png), [offline](../raw/android-wifi-offline.png), [restored](../raw/android-wifi-restored.png), [restart](../raw/android-restarted.png), [shared truth](../raw/shared-truth.json), [recovery](../raw/recovery-result.json), [connection transitions](../raw/connection-transitions.json). Matching raw UI trees are alongside the images. No Computer Use tool was needed; ADB and Playwright operated real surfaces, and screenshots were visually inspected.

Known limits: one physical Android device and one Windows reference node; foreground LAN HTTP/WS only; shared control token and trusted node token; no arbitrary shell, public access, background service, multi-node failover or Boss/Hns migration. Abrupt node termination can leave bounded temporary files. Context compaction settings were not changed: no current-chat control for the original threshold or a front-half-only compression range was exposed.

CI and delivery references are recorded in RELEASE_V0.md. APK is available from the release and local apps/android/app/build/outputs/apk/debug/app-debug.apk.
