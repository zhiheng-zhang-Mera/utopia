# V0.2 验收检查点

STATUS: NOT_ACCEPTED
PAIR_STATUS: SYNCHRONIZED
CODE-SHA: 2607912f85c22f6075367dc0eff1c45a58d75419
FACT: UTOPIA_V0_2=NOT_ACCEPTED
FACT: PRODUCT_APK_SHA256=ec30b0829a242aac05e604d3ade1aa5e91da2bbe45d22d4d9b5bcef222a5c9a7
FACT: COLLECTION_SHA=ee3f3134efeabc3ff58d3c4fcbac6b57a5adec5c
FACT: QR_AUTOZOOM=5_PASS_1_INITIAL_NO_DECODE
FACT: QR_NEGATIVE=EXPIRED_2_PASS_SHARED_SESSION_REPLACED_2_PASS_INDEPENDENT_SESSIONS
FACT: PRODUCT_CI=36521350387_PASS
FACT: ANDROID_UNIT=16_PASS
FACT: LATEST_TASK_AND_TELEMETRY=PASS
FACT: MANUAL_RESTORATION=PASS
FACT: BUNDLE_MANIFEST=150_FILES_VALID
FACT: DELIVERY_AUDIT=273_FILES_ZERO_KNOWN_FINDINGS
FACT: MAIN_INTEGRATION=IN_PROGRESS_NOT_VERIFIED
FACT: RELEASE=NOT_PUBLISHED

真实正向与负向摄像头试验已关闭 QR 产品缺口。Gate I 集成/发布仍待完成，因此整体保持 **NOT_ACCEPTED**；不声称已完成合并或发布。独立改变的 main 正在隔离检出中进行语义集成，尚未验证。

产品源码 2607912/ec30… 与采集源码 ee3f313 分别记录。当前 APK 有五次成功摄像头配对（2–6）及一次初始未解码尝试。第 2 次运行期间显示几何发生改变，之后四个成功行记录 scale 2。这些观测不能证明单独由 autozoom 导致成功。较早的 5410/7acd 五成功序列保留为历史，不计入当前 APK 次数。

04:39:14.835 UTC 序列的放大负向摄像头试验已成功完成：两次过期扫描复用真实五分钟 TTL 到期后的**同一个** session；两次替换扫描分别使用独立替换且尚未过期的 session。因此支持两次观察到的过期拒绝，而不是两个独立过期 session 实验。失败的未放大 04:22 序列记录真实摄像头 zoom 回读 1×/1.45×/2× 与 continuous-picture 对焦，但没有成功拒绝。04:18 对焦缺陷尝试在摄像头试验前中断，保留零行。所有失败均保留为证据。

| 门禁 | 证据与边界 |
|---|---|
| A — V0 回归 | 当前 APK 的 Android 提交任务由真实 Node 完成，两个 UI 结果一致。历史恢复保留历史。产品 CI 通过，合并候选回归尚未验证。 |
| B — Device Center | 当前 APK 的 Android/host 时间戳与 Web 精确样本匹配通过，最新截图经过目视检查。观测是采样的，并非同时持续相等。 |
| C — QR | 当前 APK 五次正向成功与四次负向拒绝通过，受上述共享过期 session 限制。 |
| D — mDNS | 单独绑定的 pilot 基线配对 5/5、消失/重现 2/2，之后错码 UI 2/2。不声称当前 APK 做了五次 mDNS。 |
| E — BLE | 基线配对 5/5、无线电修复切换 2/2 及之后定向配对 1/1 各保留自己的版本。不适用硬件阻塞例外，也不声称当前 APK 做了五次。 |
| F — Manual | 基线 5/5 和较早恢复通过。当前 ec30 manual 恢复已通过，绑定采集源码 ee3f313。 |
| G — 恢复/故障 | 历史 Wi-Fi/Node/Gateway 各 3/3 和九次中断审计，API 负向 8/8 与新的真实摄像头负向分开记录。不声称全过程零过期。 |
| H — 证据 | 源码/APK 版本与未成功尝试保留；150 文件清单已校验，273 个交付文件的有限审计无已知匹配。候选结论均为 PILOT，不是普适结论。 |
| I — 集成/发布 | 语义集成与候选验证进行中，release 为 NOT_PUBLISHED。并行 main 工作保留，不声称已完成合并。 |

当前 APK 任务 `Q-688f30f7-11b5-451a-a7d8-52a4fa69bfb0` 完成，Android/Web 均匹配结果 SHA-256 `b2cd04407ccb978ee9c04ae504e1c1d724372540e3abc49b56cf193f106b91de`。时间戳一致性和当前任务证据位于 [telemetry](../raw/v0.2/telemetry-consistency.json) 与[任务](../raw/v0.2/task-regression.json)。

证据目标：[autozoom 试验](../raw/v0.2/qr-autozoom-trials.json)、[放大负向](../raw/v0.2/qr-negative-2026-09-29T04-39-14.835Z-runs.json)、[负向索引](../raw/v0.2/qr-negative-index.json)、[autozoom 单测](../raw/v0.2/android-autozoom-unit-tests.json)、[产品 CI](../raw/v0.2/ci-autozoom-product.json)、[manifest](../raw/v0.2/manifest.json)、[候选台账](PAPER_EVIDENCE_V0_2.md)。新增证据已纳入校验后的证据包；发布证据不需要秘密或摄像头预览。
