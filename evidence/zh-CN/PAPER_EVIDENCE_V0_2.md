# V0.2 论文候选证据台账

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

六项结论均保持 PILOT。适用范围由文件溯源决定，集成/发布尚未完成。保留失败、中断及溯源未知的尝试。

## C-V02-01

CLAIM-ID: C-V02-01
STATUS: PILOT
CODE-SHA: 2607912f85c22f6075367dc0eff1c45a58d75419
RUNS: QR_CURRENT=5_PASS_1_NO_DECODE; QR_NEGATIVE=4_PASS_SHARED_EXPIRY_SESSION; OTHER_MODES=HISTORICAL_PILOTS

CLAIM: 四种 bootstrap 路径收敛到 City 控制 authority。

ENVIRONMENT: 单台 Alien Windows 主机与单台 Android 设备。

RAW-EVIDENCE: `evidence/raw/v0.2/qr-autozoom-trials.json`; `evidence/raw/v0.2/qr-negative-2026-09-29T04-39-14.835Z-runs.json`; `evidence/raw/v0.2/manual-trials.json`; `evidence/raw/v0.2/mdns-trials.json`; `evidence/raw/v0.2/ble-trials.json`.

LIMITATIONS: 当前摄像头正向/负向已验证，其他模式保留较早源码/APK 溯源。两次过期扫描共享一个 session。一次成功期间显示几何改变，不将结果单独归因于 autozoom，也不声称此 APK 所有模式重跑五次。

NOTES: 各原始记录保留自身源码/APK 绑定，文件头不重新标记历史运行。

## C-V02-02

CLAIM-ID: C-V02-02
STATUS: PILOT
CODE-SHA: 2607912f85c22f6075367dc0eff1c45a58d75419
RUNS: SOURCE_INSPECTION

CLAIM: 发现仅改变 bootstrap，不复制数据面。

ENVIRONMENT: 单台 Alien Windows 主机与单台 Android 设备。

RAW-EVIDENCE: `services/dev-gateway/pairing.mjs`; `platform/windows/ble.mjs`.

LIMITATIONS: 源码检查支持同一 HTTP/WebSocket 控制面。Windows 保留 service UUID 广告段，因此 manufacturer data 使用 UUID16+locator7。这不是普适安全结论。

NOTES: 各原始记录保留自身源码/APK 绑定，文件头不重新标记历史运行。

## C-V02-03

CLAIM-ID: C-V02-03
STATUS: PILOT
CODE-SHA: 2607912f85c22f6075367dc0eff1c45a58d75419
RUNS: CURRENT_APK_TELEMETRY=PASS; CURRENT_APK_TASK=PASS

CLAIM: Android 与 Web 共享权威 telemetry 和任务状态。

ENVIRONMENT: 单台 Alien Windows 主机与单台 Android 设备。

RAW-EVIDENCE: `evidence/raw/v0.2/telemetry-consistency.json`; `evidence/raw/v0.2/task-regression.json`.

LIMITATIONS: 当前 ec30 观测的 Android/host 时间戳及 Web 精确样本匹配。两个 UI 的完成任务和结果文件与验收报告一致。顺序采样及格式化显示并非同时原子捕获；此前未知 APK 记录保留但不计入。

NOTES: 各原始记录保留自身源码/APK 绑定，文件头不重新标记历史运行。

## C-V02-04

CLAIM-ID: C-V02-04
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: WIFI=3; NODE=3; GATEWAY=3; OUTAGE_AUDIT=9; RADIO_TOGGLE=2

CLAIM: 已确认中断显示为非实时状态。

ENVIRONMENT: 单台 Alien Windows 主机与单台 Android 设备。

RAW-EVIDENCE: `evidence/raw/v0.2/wifi-recovery.json`; `evidence/raw/v0.2/node-recovery.json`; `evidence/raw/v0.2/gateway-recovery.json`; `evidence/raw/v0.2/recovery-outage-audit.json`; `evidence/raw/v0.2/ble-discovery-recovery.json`.

LIMITATIONS: 这些是历史、版本绑定的采样观测。Node 停止后早期样本仍显示 Android ONLINE，之后才确认 OFFLINE；不证明全过程零过期或即时检测。QR 后缓存到在线观测同样是采样。

NOTES: 各原始记录保留自身源码/APK 绑定，文件头不重新标记历史运行。

## C-V02-05

CLAIM-ID: C-V02-05
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: BASELINE_MANUAL=5; BASELINE_MDNS=5; BASELINE_BLE=5; CURRENT_QR=5_SUCCESS

CLAIM: 配对与恢复时延可为产品接受。

ENVIRONMENT: 单台 Alien Windows 主机与单台 Android 设备。

RAW-EVIDENCE: `evidence/raw/v0.2/manual-trials.json`; `evidence/raw/v0.2/mdns-trials.json`; `evidence/raw/v0.2/ble-trials.json`; `evidence/raw/v0.2/qr-autozoom-trials.json`.

LIMITATIONS: 基线认证中位数 103/24/32 ms、整体 ADB 中位数 24987/37301/30358 ms 仅描述 Manual/mDNS/BLE。驱动等待不等于真人速度，新 QR 运行不混入。不能推导阈值或普适性能验收。

NOTES: 各原始记录保留自身源码/APK 绑定，文件头不重新标记历史运行。

## C-V02-06

CLAIM-ID: C-V02-06
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: STACK_BASELINE=1x30s; STACK_NORMAL=1x30s

CLAIM: Telemetry/discovery 资源开销较低。

ENVIRONMENT: 单台 Alien Windows 主机与单台 Android 设备。

RAW-EVIDENCE: `evidence/raw/v0.2/stack-resource-pilot.json`; `evidence/raw/v0.2/resource-pilot.json`.

LIMITATIONS: 历史全栈一组试验：单核 CPU 0.817%/0.966%，平均合计工作集 125.73/223.60 MB。Normal 包含 PowerShell BLE。共享页、主机噪声、顺序与测量效应仍存在。本项是 PILOT 测量，不支持普适低开销或单独较新 APK 的结论。

NOTES: 各原始记录保留自身源码/APK 绑定，文件头不重新标记历史运行。

