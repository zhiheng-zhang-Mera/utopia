# V0.2 final release acceptance

STATUS: ACCEPTED
PAIR_STATUS: SYNCHRONIZED
FACT: UTOPIA_V0_2=ACCEPTED
CODE-SHA: 25f1ec019296a8f4f06dc06ee591d99647fcdc4f
FACT: PRODUCT_APK_SHA256=ec30b0829a242aac05e604d3ade1aa5e91da2bbe45d22d4d9b5bcef222a5c9a7
FACT: EVIDENCE_MANIFEST=158_FILES_VERIFIED
FACT: RESEARCH_CLAIMS=PILOT

This final report supersedes the pending-release checkpoint in the source archive. ACCEPTED describes the bounded V0.2 engineering acceptance on one Windows host and one physical Android device, with release assets delivered together with this report. It does not assert universal reliability or complete the separate context-compression configuration request.

| Gate | Verified outcome |
|---|---|
| A | Integrated physical Android task completed on the real Node; Android/Web task and result agree. Gateway restart preserved City identity and six existing tasks. |
| B | Alien CPU, memory, disk, uptime, version, last seen and capabilities visible. Android/host timestamp and Web exact-sample checks pass; both screenshots reviewed. |
| C | Five current-APK camera successes plus one restoration; expired QR rejected twice after a real five-minute wait, replaced unexpired QR rejected twice. Expiry scans share one session. API one-use rejection also verified. |
| D | Historical real-network mDNS pairing5/5 and disappearance/reappearance2/2; later wrong-code UI2/2, each bound to its own source/APK. |
| E | Real BLE pairing5/5, radio toggle2/2, later targeted pairing1/1. No unsupported-hardware waiver. |
| F | Manual baseline5/5 and current-APK restoration pass. |
| G | Wi-Fi, Gateway and Node recovery3/3 each; nine confirmed-outage observations. Cached/live state and restored snapshot verified. Sampling cannot establish zero transient stale duration. |
| H | Sanitized raw trials, environment, per-trial provenance, failed attempts, paired claim ledger and158-file hash manifest delivered. Research claims remain PILOT. |
| I | Exact-source archive, device-tested debug APK, paired docs, this paired final report, sanitized data and manifest are included as release assets with SHA256SUMS. |

Android tree equals2607912. Physical integrated regression is bound to937e1dc; later main changes only affect Rooms/City and have separate tests. Camera zoom readbacks were1x/1.45x/2x with continuous-picture focus. Display enlargement overlaps camera changes; these trials do not isolate a causal autozoom improvement. Historical mechanism pilots are not relabeled as five current-APK trials.

No live QR, preview frame or permanent credential is included. The394-file known-value/path audit returned zero findings; it is bounded, not a general secret detector. No Computer Use was used. Final CI and GitHub integration provenance are recorded in RELEASE_PROVENANCE.json.
