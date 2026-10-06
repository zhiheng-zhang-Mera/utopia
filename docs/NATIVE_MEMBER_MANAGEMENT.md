# Android City and member management / 城市与成员管理

Devices lists the canonical City's members by admission name, with the enrolled session's device pinned as 本机. Settings exposes City rename for owner credentials and scoped installation revocation. Member cards distinguish online, computeOnline and sharing; unknown flags stay unknown. Messages remain PENDING until the intended recipient explicitly acknowledges receipt.

Owner control represents the City's host actor and does not label that host as the physical phone. Session authority requires matching City, installation and device identity. Invalid populations and unknown scopes disable privileged actions. Only the canonical actor's own registered node can toggle sharing. Credentials/fingerprints are excluded from display projections; technical IDs are folded.

每台未入网主机默认拥有自己的主城；入网成功后仅本机降级，目标主城不受影响。此管理入口不指定或迁移主城代理。后续用户指定主城代理仍是独立待实现功能。

Validation: 87 Android unit tests and debug APK build passed. Eight focused canonical Gateway/member/enrollment tests passed, including task execution by a controlled member worker, authority refusal, persistence, revocation and receipts. OPPO PERM00 observed online enrolled self first, admission-named peer, and native receipt changing the controlled Gateway message to RECEIVED. This physical smoke uses seeded fixture connection preferences and a simulated peer; it is not a product onboarding test or two-physical-host campaign. Native rename, revoke, sharing toggle and outbound send still require physical validation and opposite-host Formal Review.

Failures retained: malformed populations and mismatched City/enrollment were rejected after red regressions; technical review identified same-installation/wrong-device scope, reproduced by a failing test and fixed by matching device identity. Network-uncertain sends warn about possible duplicates and are never automatically retried. No latency/performance improvement is claimed.
