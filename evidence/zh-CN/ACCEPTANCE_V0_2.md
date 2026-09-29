# V0.2 验收检查点

STATUS: NOT_ACCEPTED
PAIR_STATUS: SYNCHRONIZED
CODE-SHA: 5410fa8ade8c671189cd37bff0d2c34de8b55c6f
FACT: UTOPIA_V0_2=NOT_ACCEPTED
FACT: PRODUCT_APK_SHA256=7acd40e0d1d39b412b4cbd0e916cb2b66c38a2c944f0914f598cb4a9fbf85451
FACT: QR_RUN_SOURCE_SHA=f8285134f6ac8ef58f34c9c48bc6e21f21c1317e
FACT: QR_DEVICE_OBSERVER_SOURCE_SHA=5855a927e42ae2945728f509a7b4ef07bcd372bf
FACT: QR_POSITIVE=5_PASS_2_PRE_CAMERA_DRIVER_ERRORS
FACT: QR_NEGATIVE=0_PASS_3_NO_DECODE_ATTEMPTS_1_GUARD_INVOCATION
FACT: QR_NEGATIVE_LEGACY_DRIVER_HASH=UNKNOWN
FACT: MANUAL_RESTORATION=PASS
FACT: PRODUCT_CI=36515630417_PASS
FACT: BUNDLE_MANIFEST=126_FILES_VALID
FACT: DELIVERY_AUDIT=244_FILES_ZERO_KNOWN_FINDINGS
FACT: RELEASE=NOT_PUBLISHED
FACT: MERGE=NOT_DONE

**NOT_ACCEPTED：**真实 QR 摄像头正向配对现已有五次成功，但实物负向 QR 拒绝验证和发布交付仍未完成。用户定位了手机；成功运行序号为 1、2、5、6、7。摄像头启动前的驱动失败 3、4 保留可见，不计为摄像头失败。

APK 产品源码仍为 5410fa8/7acd40…。QR 试验绑定仓库源码 f828513…；Device Center 观测绑定采集器 5855a9…。这些采集器修订不代表新 APK。Pilot 基线 cb50fdd/315262… 保留 Manual/mDNS/BLE 各 5/5；无线电修复 3d7b8c9/0f2c30… 保留切换 2/2。最新产品错码 UI 2/2、定向 BLE 配对 1/1、精确 APK 的 telemetry/任务及 CI 已通过。此前错误文本覆盖、未解码、USB/首次进入界面及未知 APK 尝试保留为历史记录。

| 门禁 | 证据与剩余边界 |
|---|---|
| A — V0 回归 | 最新 APK 的真实任务完成，Android/Web 任务与结果文件一致。基线恢复保留历史。产品 CI 已通过；证据提交后再验证最终分支 CI/干净工作区。 |
| B — Device Center | 最新 telemetry 时间戳/精确样本/显示值检查通过。QR 成功后 Alien 最初显示 UNKNOWN · Cached，随后无需重新配对自动 ONLINE。这是两个采样观测，不证明零过期时长。 |
| C — QR | 摄像头正向五次成功，另保留两次摄像头前驱动错误。负向摄像头拒绝仍为零次通过：过期一次、已替换 session 两次均未观察到解码/拒绝。门禁未完成。 |
| D — mDNS | Pilot 基线发现/配对 5/5；原生消失/重现 2/2。最新错码 UI 拒绝 2/2 单独绑定。 |
| E — BLE | Pilot 基线配对 5/5；无线电修复切换 2/2；最新定向配对 1/1。不声称最新 APK 做了五次，不适用硬件阻塞例外。 |
| F — Manual | 基线干净 manual 试验 5/5；最新 QR 后 manual 恢复通过，主机已恢复可用在线状态。 |
| G — 故障/恢复 | Wi-Fi/Node/Gateway 各 3/3，九份中断 XML 审计通过。API 负向 8/8 与摄像头 UI 分别记录。要求的过期/已替换 QR 摄像头拒绝重复试验尚未验证。 |
| H — 证据 | 已有双语台账和有边界 pilot。刷新后的 manifest 覆盖 126 文件，244 文件交付审计报告零项已知发现。历史负向驱动哈希保持 UNKNOWN，不从新版源码补填。 |
| I — 发布 | [草稿 PR #1](https://github.com/zhiheng-zhang-Mera/utopia/pull/1) 仍开放，release 为 NOT_PUBLISHED。并行 main 变更保留且未合并，不声称已经测试它们。经验证的功能分支发布不要求覆盖或合并 main。 |

负向尝试分三次调用保留：03:46 UTC 含一次过期、一次已替换 session 的未解码尝试；03:58 在摄像头前触发几何 guard，零行试验；03:59 含一次已替换 session 的未解码尝试。尝试的过期协议计划复用一个过期 session 重复扫描，不是两个独立过期 session。不因 API 测试通过而把任何摄像头尝试升级为 PASS。

已发布来源包括[基线试验](../raw/v0.2/manual-trials.json)、[mDNS](../raw/v0.2/mdns-trials.json)、[BLE](../raw/v0.2/ble-trials.json)、[telemetry](../raw/v0.2/telemetry-consistency.json)、[任务](../raw/v0.2/task-regression.json)、[中断审计](../raw/v0.2/recovery-outage-audit.json) 和[候选台账](PAPER_EVIDENCE_V0_2.md)。新增发布记录：[QR 试验](../raw/v0.2/qr-trials.json)、[QR Device Center](../raw/v0.2/qr-device-center.json)、[负向尝试索引](../raw/v0.2/qr-negative-index.json) 和 [manual 恢复](../raw/v0.2/manual-qr-restoration-trials.json)。筛查后证据包保留未成功尝试，manifest 已验证。

基线认证间隔中位数为 Manual 103 ms、mDNS 24 ms、BLE 32 ms。整体 ADB 中位数 24987 / 37301 / 30358 ms 包含驱动/输入等待，不能用于真人比较；较新的 QR 计时不混入该基线。单组全栈资源试验是 PILOT，不是普适低开销证据。仍待实物负向 QR 验证，不声称全部自主工作已经完成。

恢复后的主机观测：[在线主机](../raw/v0.2/post-qr-restoration-host.json)。
