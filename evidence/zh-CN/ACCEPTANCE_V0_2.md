# V0.2 验收检查点

STATUS: NOT_ACCEPTED
PAIR_STATUS: SYNCHRONIZED
CODE-SHA: 5410fa8ade8c671189cd37bff0d2c34de8b55c6f
FACT: UTOPIA_V0_2=NOT_ACCEPTED
FACT: PILOT_BASELINE_SOURCE_SHA=cb50fdd6ba5f23c16167672f32853485701772fb
FACT: PILOT_BASELINE_APK_SHA256=3152625605bfde912d508e47c4f555dc4f7902e25ba32c33551ead17768be6db
FACT: RADIO_FIX_SOURCE_SHA=3d7b8c9647fa13f75bc62829b5c96966dfba6dd2
FACT: RADIO_FIX_APK_SHA256=0f2c3091661bf8818cd0995741ce6fea1f8fe00b4a0cf5867e705294dd383b77
FACT: RADIO_FIX_TARGETED_RADIO=2_OF_2_PASS
FACT: RADIO_FIX_CI=36514942297_PASS
FACT: QR_CAMERA=0_OF_5_SUCCESS_1_NO_DECODE_ATTEMPT
FACT: LATEST_SOURCE_SHA=5410fa8ade8c671189cd37bff0d2c34de8b55c6f
FACT: LATEST_APK_SHA256=7acd40e0d1d39b412b4cbd0e916cb2b66c38a2c944f0914f598cb4a9fbf85451
FACT: LATEST_WRONG_CODE_UI=2_OF_2_PASS
FACT: LATEST_ANDROID_UNIT=13_PASS
FACT: LATEST_CI=36515630417_PASS
FACT: LATEST_BLE_PAIRING=1_OF_1_PASS
FACT: LATEST_TELEMETRY_AND_TASK=PASS
FACT: BUNDLE_MANIFEST=103_FILES_VALID
FACT: DELIVERY_AUDIT=219_FILES_ZERO_KNOWN_FINDINGS
FACT: RELEASE=NOT_PUBLISHED
FACT: MERGE=NOT_DONE

**NOT_ACCEPTED：**要求五次真实摄像头 QR 试验，目前成功为零；一次真实尝试在允许系统相机权限后结束为 NO_CAMERA_DECODE_OBSERVED。API 过期/旧 session 拒绝不等于摄像头或 Android 负向 QR UI 验收。[草稿 PR #1](https://github.com/zhiheng-zhang-Mera/utopia/pull/1) 尚未合并，不声称已发布。

各版本分别溯源。Pilot 基线完成 Manual/mDNS/BLE 各 5/5 以及恢复/资源矩阵。无线电修复版本完成蓝牙切换 2/2 和 CI。最新配对错误修复使错误独立于发现状态保留：Android 错码 UI 拒绝现已通过 2/2，单元测试 13/13。最新 BLE 配对通过 1/1，telemetry/任务重跑通过且明确记录已安装 APK 溯源，CI 36515630417 两个作业通过。此前发现状态覆盖拒绝文本的尝试是历史失败，不是本次 UI 通过。历史 telemetry/任务观测遗漏已安装 APK 哈希；保留的 pre-APK-provenance 记录继续标记 UNKNOWN，不重新归属于任何 APK。

| 门禁 | 证据与剩余边界 |
|---|---|
| A — V0 回归 | 基线恢复保留历史。最新真实任务完成，两个 UI 的结果 SHA-256 一致，源码/已安装 APK 溯源明确。历史未知 APK 记录单独保留。最新 CI 36515630417 两个作业通过，无线电修复 CI 已通过。 |
| B — Device Center | 最新精确 APK 的 host 时间戳、Web 精确样本及 Android/Web 显示值检查全部通过。历史未知 APK 记录单独保留。 |
| C — QR | 成功 0/5，一次真实未解码尝试。摄像头交换与 Android 过期/旧 QR UI 路径未验证。 |
| D — mDNS | Pilot 基线发现/配对 5/5；原生消失/重现 2/2。最新错码 UI 拒绝 2/2 单独绑定。 |
| E — BLE | Pilot 基线发现/配对 5/5；无线电修复切换 2/2，检查关闭文本、启用/重试提示和原生重新发现。最新定向配对通过 1/1。硬件具备能力，不适用硬件阻塞验收。 |
| F — Manual | Pilot 基线干净 manual 试验 5/5。不声称最新 APK 也做过五次。 |
| G — 恢复/故障 | Wi-Fi/Node/Gateway 各 3/3；九份已发布中断 XML 均审核了明确 Utopia 中断状态且与记录一致。这是指定中断时刻的采样证据，不是全过程零过期。API 负向 8/8；最新错码 UI 2/2。QR 负向 UI 覆盖仍缺失。 |
| H — 证据 | 已有双语台账、筛查后试验、资源数据及 manifest。103 文件证据包 manifest 有效；219 文件审计未发现已知 secret、私人路径或已连接设备 serial，两张发布图片经过目视检查。这是有边界的审计，不证明所有潜在秘密均不存在。历史失败/未知记录继续可见。 |
| I — 发布 | 仅草稿 PR。没有已验收 release、合并或最终干净工作区/资产验证。最新 CI 已通过；最终干净工作区/资产验证仍待完成。 |

证据：[基线试验](../raw/v0.2/manual-trials.json)、[mDNS 试验](../raw/v0.2/mdns-trials.json)、[BLE 试验](../raw/v0.2/ble-trials.json)、[mDNS 恢复](../raw/v0.2/mdns-discovery-recovery.json)、[中断审计](../raw/v0.2/recovery-outage-audit.json)、[最新 Android 单测](../raw/v0.2/android-errorfix-unit-tests.json)、[API 负向](../raw/v0.2/pairing-api-failures.json)、[资源 pilot](../raw/v0.2/stack-resource-pilot.json)、[候选台账](PAPER_EVIDENCE_V0_2.md)。最新定向记录：[错码 UI](../raw/v0.2/mdns-wrong-code-runs.json)、[BLE 配对](../raw/v0.2/ble-radiofix-trials.json)、[telemetry](../raw/v0.2/telemetry-consistency.json)、[任务](../raw/v0.2/task-regression.json)、[产品 CI](../raw/v0.2/ci-errorfix-product.json)、[交付审计](../raw/v0.2/delivery-audit.json)。截至本检查点可自主工作已完成；仍缺真实 QR 成功与负向 QR UI 覆盖、已验收发布，以及提交后的分支 CI/干净工作区验证。

基线认证间隔中位数：Manual 103 ms、mDNS 24 ms、BLE 32 ms；QR 为 null。ADB 驱动的整体中位数为 24987 / 37301 / 30358 ms，包含驱动/输入等待，不能用于真人速度比较。单组 30 秒全栈试验测得单 CPU 核 0.817% / 0.966%，合计工作集 125.73 / 223.60 MB；normal 包含 PowerShell BLE。噪声、共享页及测量扰动使其不能支持普适低开销结论。
