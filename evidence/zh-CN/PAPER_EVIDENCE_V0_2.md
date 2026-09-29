# V0.2 论文候选证据台账

STATUS: NOT_ACCEPTED
PAIR_STATUS: SYNCHRONIZED
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
FACT: APK_SHA256=3152625605bfde912d508e47c4f555dc4f7902e25ba32c33551ead17768be6db
FACT: FINAL_ACCEPTANCE=NOT_ACCEPTED
FACT: RADIO_FIX_APK_SHA256=0f2c3091661bf8818cd0995741ce6fea1f8fe00b4a0cf5867e705294dd383b77
FACT: RADIO_FIX_SOURCE_SHA=3d7b8c9647fa13f75bc62829b5c96966dfba6dd2
FACT: RADIO_FIX_TARGETED_RADIO=2_OF_2_PASS
FACT: RADIO_FIX_TARGETED_BLE_PAIRING=NOT_RUN_SUPERSEDED_BY_LATEST_APK
FACT: RADIO_FIX_CI=36514942297_PASS
FACT: QR_CAMERA_ATTEMPTS=1_NO_CAMERA_DECODE_OBSERVED
FACT: LATEST_SOURCE_SHA=5410fa8ade8c671189cd37bff0d2c34de8b55c6f
FACT: LATEST_APK_SHA256=7acd40e0d1d39b412b4cbd0e916cb2b66c38a2c944f0914f598cb4a9fbf85451
FACT: LATEST_WRONG_CODE_UI=2_OF_2_PASS
FACT: LATEST_ANDROID_UNIT=13_PASS
FACT: LATEST_CI=36515630417_PASS
FACT: LATEST_BLE_PAIRING=1_OF_1_PASS
FACT: LATEST_TELEMETRY_AND_TASK=PASS
FACT: BUNDLE_MANIFEST=103_FILES_VALID
FACT: DELIVERY_AUDIT=219_FILES_ZERO_KNOWN_FINDINGS

本台账是单台 Alien Windows 主机与单台 Android 设备的施工检查点。上述 SHA 与 APK 标识已完成的 pilot 矩阵；无线电修复事实字段标识较新的候选版本。各原始文件的自身溯源信息决定适用范围。正在集成的观测在绑定经过筛查的最终构建文件之前均为临时记录。本台账不声称跨平台普适性、已完成 QR 试验或完整连接验收。

三个源码/APK 版本分别保留：pilot 基线 cb50fdd/315262… 对应各五次矩阵；无线电修复 3d7b8c9/0f2c30… 对应切换 2/2 及一次摄像头未解码尝试；最新配对错误修复 5410fa8/7acd40… 对应 Android 错码 UI 2/2、定向 BLE 配对 1/1、Android 单测 13/13 及 CI 36515630417 PASS。此前错误文本被覆盖的尝试仍为历史失败。最新 telemetry 与真实任务重跑现在明确绑定源码 5410fa8 和 APK 7acd40…：时间戳/精确样本/显示值检查均通过，Android 提交的真实任务完成，Android/Web 的结果文件 SHA-256 一致。历史 pre-APK-provenance 记录保留 UNKNOWN，不计入此次最新 APK 验证。整体验收保持 NOT_ACCEPTED。

## C-V02-01

CLAIM-ID: C-V02-01
STATUS: BLOCKED
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: manual=5_OF_5_PILOT_BASELINE_PASS; qr=0_OF_5_SUCCESS_1_NO_DECODE_ATTEMPT; mdns=5_OF_5_PILOT_BASELINE_PASS; ble=5_OF_5_PILOT_BASELINE_PASS; API_NEGATIVE=8_OF_8_PASS

CLAIM: 四种 bootstrap 路径最终收敛到同一经过认证的 City authority、API 和任务语义。

ENVIRONMENT: 单台 Alien Windows 主机；单台 Android 设备。自动化浏览器/Node 证据与实机证据分别记录。

RAW-EVIDENCE: `evidence/raw/v0.2/manual-trials.json`；`evidence/raw/v0.2/mdns-trials.json`；`evidence/raw/v0.2/ble-trials.json`；对应的 `<mode>-<1..5>-events.jsonl` 文件；`evidence/raw/v0.2/pairing-api-failures.json`。历史非最终试验：`evidence/raw/v0.2/historical-attempts.json`。

LIMITATIONS: 无线电修复 APK 的一次真实 QR 摄像头尝试结束为 NO_CAMERA_DECODE_OBSERVED；成功次数仍为 0/5，因此四路径结论保持 BLOCKED。Pilot 基线 Manual、mDNS 和 BLE 各有五次成功试验，均绑定 pilot 基线代码/APK，并记录 authenticated、snapshot-loaded 和 WebSocket-online 事件。这些是通过 ADB 操作 UI、使用真实发现的试验，并非真人可用性比较。八次隔离 HTTP 负向试验全部通过：过期、错误短码、已替换 session、已使用 session 各两次。过期试验使用真实默认 300000 ms TTL，没有虚拟时钟；记录的源码哈希在运行前后保持一致。这些 API 检查不使用摄像头，不能证明真实 QR 扫描成功。历史试验明确标记为非最终结果，不计入最终次数。

NOTES: 候选结论；验收前必须由主集成流程更新最终试验次数、哈希与文件链接。

## C-V02-02

CLAIM-ID: C-V02-02
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: CODE_INSPECTION_ONLY

CLAIM: QR、mDNS 和 BLE 只改变 bootstrap，不复制控制数据面。

ENVIRONMENT: 单台 Alien Windows 主机；单台 Android 设备。自动化浏览器/Node 证据与实机证据分别记录。

RAW-EVIDENCE: `services/dev-gateway/pairing.mjs`; `services/dev-gateway/discovery.mjs`; `platform/windows/ble.mjs`; `contracts/pairing-v1/descriptor.mjs`.

LIMITATIONS: 本项是源码检查结果，不是四条路径的实机验收。Windows 保留 service UUID 广告段，因此实现采用 manufacturer payload：16 字节 UUID 标记加 7 字节 locator。广播不包含 credential 或 ephemeral secret。

NOTES: 候选结论；验收前必须由主集成流程更新最终试验次数、哈希与文件链接。

## C-V02-03

CLAIM-ID: C-V02-03
STATUS: PILOT
CODE-SHA: 5410fa8ade8c671189cd37bff0d2c34de8b55c6f
RUNS: LATEST_TELEMETRY_MATCH=PASS; LATEST_REAL_TASK=PASS; HISTORICAL_APK=UNKNOWN

CLAIM: Android 与 Web 通过同一权威 snapshot 获取 Node telemetry 和状态。

ENVIRONMENT: 单台 Alien Windows 主机；单台 Android 设备。自动化浏览器/Node 证据与实机证据分别记录。

RAW-EVIDENCE: `evidence/raw/v0.2/telemetry-consistency.json`；`evidence/raw/v0.2/android-telemetry.xml`；`evidence/raw/v0.2/android-devices.png`；`evidence/raw/v0.2/web-devices.png`；`evidence/raw/v0.2/task-regression.json`。

LIMITATIONS: 记录明确包含最新源码 5410fa8ade8c671189cd37bff0d2c34de8b55c6f 和已安装 APK 7acd40e0d1d39b412b4cbd0e916cb2b66c38a2c944f0914f598cb4a9fbf85451。Android host 时间戳、Web 精确样本及两个客户端显示值检查全部通过。任务 Q-8c990031-136b-4de9-8c56-adf67d4e13aa 由真实 reference Node 完成，checkpoint/result 可用；两个 UI 均匹配结果文件 SHA-256 ae149a46984f46a35f4e64f3e745084b66973b38aebe85b67af704a748cc827c。缺少已安装 APK 哈希的历史记录在单独保留文件中继续标记 UNKNOWN。顺序 snapshot 和格式化 UI 观测并非同时原子捕获；更新传播时中间 host/Web 样本可以不同。本项是单主机 PILOT，不是持续同步或跨平台精度结论。

NOTES: 候选结论；验收前必须由主集成流程更新最终试验次数、哈希与文件链接。

## C-V02-04

CLAIM-ID: C-V02-04
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: WIFI=3_OF_3_PASS; NODE=3_OF_3_PASS; GATEWAY=3_OF_3_PASS; MDNS_DISAPPEAR_REAPPEAR=2_OF_2_PASS; BLE_TOGGLE=2_OF_2_RADIOFIX_PASS

CLAIM: 客户端或 Node 失联不会留下仍以实时绿色状态显示的过期 telemetry。

ENVIRONMENT: 单台 Alien Windows 主机；单台 Android 设备。自动化浏览器/Node 证据与实机证据分别记录。

RAW-EVIDENCE: `evidence/raw/v0.2/wifi-recovery.json`；`evidence/raw/v0.2/node-recovery.json`；`evidence/raw/v0.2/gateway-recovery.json`；对应的连接事件 JSONL 和离线 XML。原生 mDNS 恢复：`evidence/raw/v0.2/mdns-discovery-recovery.json`。单独绑定的无线电修复结果为 `evidence/raw/v0.2/ble-discovery-recovery.json`，CI 证据为 `evidence/raw/v0.2/ci-radiofix-product.json`。

LIMITATIONS: Wi-Fi、Node 与 Gateway 恢复各通过三次记录试验，历史与 City identity 均保留。最终 Node/Gateway 数据包含 Web Node 观测。指定的已确认中断观测显示 OFFLINE/UNKNOWN，而非实时绿色状态，随后观察到恢复。但 UI dump 与 Web 读取采用顺序采样；Node 停止后的早期观测中，Android 仍显示 ONLINE，之后才在较晚观测中确认为 OFFLINE。因此 staleGreenObserved=false 仅适用于指定的已确认中断样本，不代表整个过程 stale-green 时长为零，也不代表即时检测。原生 mDNS 消失/重现通过两次。首次 BLE toggle helper 虽然改变了无线电状态，却返回非零值，不计为通过。之后无线电修复源码/APK 的两次试验通过明确关闭/启用 UI 检查及原生重新发现，单独保留溯源。这些有边界的观测仅支持 PILOT。 已发布中断审计检查了全部九份 XML，确认明确 Utopia OFFLINE/UNKNOWN/RECONNECTING 或 Node OFFLINE 状态与记录一致，见 `evidence/raw/v0.2/recovery-outage-audit.json`。

NOTES: 候选结论；验收前必须由主集成流程更新最终试验次数、哈希与文件链接。

## C-V02-05

CLAIM-ID: C-V02-05
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: MANUAL=5; MDNS=5; BLE=5; QR=0; WIFI_RECOVERY=3; NODE_RECOVERY=3; GATEWAY_RECOVERY=3

CLAIM: 配对与重连时延满足产品可接受范围。

ENVIRONMENT: 单台 Alien Windows 主机；单台 Android 设备。自动化浏览器/Node 证据与实机证据分别记录。

RAW-EVIDENCE: `evidence/raw/v0.2/manual-trials.json`；`evidence/raw/v0.2/mdns-trials.json`；`evidence/raw/v0.2/ble-trials.json`，及对应的逐次事件文件。排除在最终统计之外的历史试验：`evidence/raw/v0.2/historical-attempts.json`。

LIMITATIONS: pilot 基线构建每种模式各五次试验，观察到的提交至 authenticated 间隔（`pairingExchangeLatencyMs`）为 Manual 40–280 ms、mDNS 17–922 ms、BLE 22–275 ms。Manual 使用既有 credential 路径，其该项指标并非短码交换。整体 start-to-online 时间包含 ADB/UI 驱动等待和输入开销，不能估计真人配对速度，也不能作为不同模式间公平的可用性比较。现在每种中断类型均有三次恢复记录，但顺序 UI 采样及事件/捕获时间差异限制了时延解读。目前没有最终产品可接受阈值或 QR 摄像头计时。小样本范围仅作描述；本项为 PILOT 数据，并非 SUPPORTED 时延结论。 基线认证间隔中位数为 103 / 24 / 32 ms，ADB 驱动整体时间中位数为 24987 / 37301 / 30358 ms（Manual / mDNS / BLE）；QR 为 null。整体时间不能作为真人速度基准。

NOTES: 候选结论；验收前必须由主集成流程更新最终试验次数、哈希与文件链接。

## C-V02-06

CLAIM-ID: C-V02-06
STATUS: PILOT
CODE-SHA: cb50fdd6ba5f23c16167672f32853485701772fb
RUNS: STACK_BASELINE=1x30s_PILOT; STACK_NORMAL=1x30s_PILOT; ISOLATED_SAMPLER_BASELINE=1x30s; ISOLATED_SAMPLER_ENABLED=1x30s

CLAIM: Telemetry 与 discovery 的主机资源开销较低。

ENVIRONMENT: 单台 Alien Windows 主机；单台 Android 设备。自动化浏览器/Node 证据与实机证据分别记录。

RAW-EVIDENCE: `evidence/raw/v0.2/stack-resource-pilot.json`；命令：将 `CITY_RESOURCE_HOST` 设置为本机 LAN IPv4，然后执行 `node scripts/stack-resource-pilot.mjs`。补充：由 `node scripts/resource-pilot.mjs` 生成的 `evidence/raw/v0.2/resource-pilot.json`。

LIMITATIONS: 全栈 pilot 已完成一组顺序 baseline/normal 试验，每种模式配置为预热 5 秒后测量 30 秒（实际窗口为 30.581 与 30.726 秒）。Baseline 为关闭 discovery/telemetry 的 Gateway + Node，CPU 为单逻辑核的 0.817%，平均合计 WorkingSet64 为 125.73 MB。Normal 为 Gateway + Node + telemetry + mDNS + WinRT BLE publisher，CPU 为 0.966%，平均合计 WorkingSet64 为 223.60 MB。两次均标记 PILOT；normal 模式在测量前后 mDNS/BLE 均为 ACTIVE。Normal 工作集包含 PowerShell WinRT publisher；工作集求和可能重复计算共享页，并不等同于私有内存。共享主机噪声及顺序效应未受控制，单独的 PowerShell 测量进程会扰动主机，但不计入这些计数器。共享 Windows 服务、其他内核工作、初始化、Android/Web 客户端、用户任务及网络字节均未计入。单组试验不能证明普适的低开销或资源差异的因果关系；本项保持 PILOT，不标记 SUPPORTED。全栈 JSON 记录 pilot 基线代码 SHA，且 `worktreeModified=true`。此前独立 sampler 补充记录（CPU 0.210% 对 0.470%；平均 RSS 53.11 对 53.77 MB）保留自身历史溯源，不得归属于当前候选版本。

NOTES: 候选结论；验收前必须由主集成流程更新最终试验次数、哈希与文件链接。
