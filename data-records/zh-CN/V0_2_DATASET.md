# V0.2 数据采集与解读

本文描述采集脚本及输出结构，不声明验收结果，也不推断已完成的试验次数。应根据保存的记录、错误、源码溯源信息与局限判断实际观察到了什么。

## 准备与执行顺序

从仓库根目录运行命令。使用 `scripts/start-city.ps1`，在明确且可达的局域网地址启动主 City。手机驱动读取 `.runtime/processes.json` 和私有 `.runtime/local-config.json`。将 platform-tools 的 `adb` 可执行文件加入 `PATH`，或通过 `ADB` 环境变量指定其可执行文件路径。安装目标 debug APK，保持手机解锁并可操作 Utopia 应用。

同一时间只运行一个手机驱动。这些脚本会操作真实 Android 界面、配对状态、无线开关和运行进程。坐标及系统提示处理针对试验手机编写；更换设备后应检查失败原因，不能假定布局相同。重跑可能覆盖对应输出文件；重试前应将历史尝试另存为不同的私有文件名。

## 配对界面试验

```powershell
node scripts/device-pairing-pilot.mjs manual 5
node scripts/device-pairing-pilot.mjs mdns 5
node scripts/device-pairing-pilot.mjs ble 5
node scripts/device-pairing-pilot.mjs mdns 2 wrong-code
```

数字参数是请求执行的次数，不是已观察到的完成次数。驱动记录失败后会停止。每次尝试前，它重启应用，并通过界面清除已保存配对；随后创建主机会话、选择真实入口，在手工模式输入控制 token，在发现模式输入会话短码。mDNS 与 BLE 使用原生发现，并通过 ADB 检查界面；驱动不注入描述符或发现结果。错误短码场景检查 Android 界面中的 HTTP 403，并检查没有 ONLINE 提示。

每次记录包含 Git HEAD、设备实际安装 APK 的哈希、主机侧开始/结束时间、成功/错误、模式与驱动说明。配对驱动开始前会验证已安装 APK 的哈希与本地构建的 debug APK 一致。它将应用私有配对日志复制到 `.runtime/evidence/v0.2/<mode>-events.jsonl`，并写入 `<mode>-runs.json`；带场景的文件改用 `<mode>-<scenario>` 前缀。

通用配对驱动有意排除 `qr`。独立的 `node scripts/device-qr-pilot.mjs 5` 驱动仅用 ADB 操作首次配对界面，必须实际摆放相机，使其朝向主机上可见的二维码。请求启动相机后，它只观察白名单应用私有事件，不保存相机截图或 UI 转储。输出为 `qr-runs.json` 和 `qr-events.jsonl`；超时或未解码仍保留为失败观察。不得用注入 URI、深链、描述符或 API 交换替代物理扫码。应读取实际结果，不能因驱动存在就推断扫码成功。

使用 `node scripts/device-qr-pilot.mjs 5 --resume`，可保留已有行与事件并继续配置的运行序列。记录中保留阶段和驱动诊断，包括相机启动前的失败。包含成功扫码及 UIAutomator exit-255 失败的文件，不能汇总为全成功序列，也不能删除该失败行。较早的 `pre-position-qr-runs.json`、`qr-usb-interrupted-runs.json` 和 `qr-onboarding-attempt-runs.json` 应作为历史尝试保留。

审查工具并完成其他手机操作后，`node scripts/device-qr-negative-pilot.mjs --run all` 会打开新的私有可见浏览器窗口。工具在 1440×1000 视口中认证进入真实 Web 配对页，创建仅用于布局测量的会话，测量二维码区域后才创建试验会话。本环境实测区域为 240×360 像素，并非正方形。固定覆盖层按实测 x/y/宽/高保留真实试验 SVG，TEST 标签不会移动二维码。仍需确认手机与此窗口的物理对准；相同视口几何不保证操作系统窗口位置相同。停止竞争的手机驱动和自动刷新会话的显示工具。过期场景等待超过真实默认五分钟有效期，然后请求对同一过期会话进行两次物理扫描。这是两次扫描，不是两个独立过期会话。替换场景则为两次扫描分别创建并替换独立会话。可用 `expired` 或 `replaced` 替换 `all`，只运行一种场景。

负向工具仅将 Gateway 经认证生成的真实二维码材料保留在私有浏览器 DOM/内存中，Android 只能通过相机接收。它要求观察白名单 `descriptorError` 或 `pairingError` 事件、确认返回 MainActivity，并在相机关闭后观察到匹配的拒绝提示；被替换会话可能在本地显示“QR session changed; scan a new QR”，也可能显示 HTTP 410。工具检查未出现认证事件及 City 身份稳定，不转储相机预览界面，保存阶段/错误诊断而非原始异常文本。每次运行创建 `.runtime/evidence/v0.2/qr-negative-<timestamp>/runs.json` 和 `events.jsonl`，保留先前输出；缺失证明仍标为失败/不完整。

## 连接与发现恢复

```powershell
node scripts/device-recovery-pilot.mjs wifi 3
node scripts/device-recovery-pilot.mjs node 3
node scripts/device-recovery-pilot.mjs gateway 3
node scripts/device-discovery-recovery.mjs all
```

连接恢复驱动关闭/打开手机 Wi-Fi，或停止/重启选定的主运行进程。它记录抽样的 Android 状态字符串、Web 连接指示、断开/恢复/观察到的转换时间、City 身份比较，以及原有任务状态和事件的保留检查，同时记录已安装 APK 哈希。输出为 `.runtime/evidence/v0.2/<kind>-recovery.json` 和 `<kind>-<run>-offline.xml`。这些是抽样观察，不能证明转换中的每一瞬间都已被观察。

发现恢复驱动接受 `all`、`ble` 或 `mdns`；`all` 请求运行两种机制。其配置循环对每种机制请求两次试验，该机制出现失败后停止。它要求主 Gateway 位于 4310 端口，验证已安装 APK 与本地构建一致，并使用真实首次配对发现界面。BLE 试验切换手机蓝牙；mDNS 试验在停止/重启前验证 Gateway 进程身份。驱动观察主 City 消失与重新发现、检查身份，并记录失败后的恢复操作。输出是私有证据目录下的 `discovery-recovery.json`，以及白名单投影 `ble-discovery-<run>-<phase>.xml` / `mdns-discovery-<run>-<phase>.xml`，其中不保留可编辑框/密码文本。此驱动会清除已保存配对，应在其他手机试验之后运行。

## 隔离 API 失败试验

```powershell
node scripts/pairing-failure-pilot.mjs
```

该工具在 `.runtime/failure-pilot` 下创建相互独立的回环 Gateway，并关闭发现功能。两个过期会话并发运行，使用真实默认 300000 毫秒有效期，按实际墙钟等待至过期之后；没有缩短 TTL，也没有使用假时钟。其他场景提交错误短码、已被替换的二维码会话材料，以及已消耗的二维码会话材料。断言覆盖拒绝 HTTP 状态、拒绝响应不包含凭据/配对材料，以及 City 身份稳定。

工具只将脱敏后的时间、布尔值、状态、准确的起始 Git SHA、工作区修改标记和源码哈希写入 `evidence/raw/v0.2/pairing-api-failures.json`。结束时再次检查源码哈希，并在 `finally` 中关闭 Gateway。这是使用真实临时材料、材料仅保留于内存中的 HTTP API 集成证据，不观察 Android 拒绝界面、二维码相机扫描、mDNS 或 BLE。

## 完整运行栈资源试验

```powershell
$env:CITY_RESOURCE_HOST = '192.168.1.20'
node scripts/stack-resource-pilot.mjs
```

将示例地址替换为本机局域网网卡实际拥有的 IPv4 地址。此 Windows 专用驱动在 4311 端口启动临时 City，与主 City 分离。baseline 关闭发现与遥测，normal 启用两者并真实广播临时 City。不要与手机发现试验并发运行。可用 `UTOPIA_RESOURCE_PILOT_MS` 将每个测量窗口设为 3000 至 300000 毫秒；默认先预热五秒，再测量 30000 毫秒。

输出 `evidence/raw/v0.2/stack-resource-pilot.json` 包含各进程角色的 CPU 时间与工作集采样、发现/遥测检查，以及按一个逻辑核计算的 CPU 百分比和合计 RSS。计数器缺失或要求的发现服务未启用时，结果标为不完整。单组顺序执行的 baseline/normal 不能支持普遍开销结论：主机负载与顺序效应未受控制，共享内存页可能重复计数，Windows 服务、启动阶段、客户端、用户任务及网络字节均不在测量范围内。

## 时间戳、操作计数与脱敏

应用事件使用 UTC `Instant.now()` 时间戳和 trial ID；主机驱动使用 ISO 格式的墙钟开始/结束时间。打包脚本按主机观察窗口关联应用试验，因此时钟偏移或事件缺失可能造成空字段或关联不完整。不得用猜测值补充缺失时间。`discoveryLatencyMs`、`pairingExchangeLatencyMs` 和 `timeToOnlineMs` 由相应命名事件的时间差计算。界面驱动的整体时长包含 ADB 命令、UI 层级检查、轮询及驱动等待，不是自然人操作速度测量。

`userActions` 统计已埋点的主要应用按钮操作，不包含输入字符、系统权限手势和驱动准备操作。`retryCount` 来自应用重试埋点；发现恢复另有明确记录的重试计数。两者都不是完整的人力操作成本度量。聚合前应检查重复事件与历史尝试。

```powershell
node scripts/bundle-v02-evidence.mjs
```

打包脚本从 `.runtime/evidence/v0.2/` 选择私有记录，将发布候选材料写入 `evidence/raw/v0.2/`：`<mode>-trials.json`、逐次 `<mode>-<run>-events.jsonl`、恢复 JSON/XML、已有的遥测一致性记录和设备截图、`historical-attempts.json`、`environment.json`。API 与资源试验已将脱敏 JSON 直接写入此目标目录。`manifest.json` 对目标目录中除清单自身之外的每个文件计算哈希；修改内容后应重新生成。每次试验的源码/APK 绑定保留在记录中，不能从清单生成时间推断。

QR 记录独立发布为 `qr-runs.json`、`qr-trials.json`、`qr-events.jsonl` 和 `qr-<run>-events.jsonl`，其中也保留失败。带 `-radiofix` 后缀（以及可选附加后缀）的定向 manual/mDNS/BLE 文件，在对应 runs、trials 和事件文件名中保留完整前缀，不替换原始 `<mode>` 系列。每行保留原有 `codeSha` 与实际安装的 `apkSha256`，不得将旧 APK 结果改标为新构建。标准化后的 `startTimestamp` 是应用 start 事件，`driverStartTimestamp` 和 `driverEndTimestamp` 保留驱动观察窗口。缺失的事件关联或计数保持为空或明确未观察。

发现记录分开发布：`mdns-discovery-recovery.json` 只选择私有 `discovery-recovery-mdns-and-ble-attempt.json` 中的 mDNS 行；`ble-discovery-recovery.json` 只选择私有 `discovery-recovery.json` 中的 BLE 行。两者均保留来源文档顶层的 commit/APK 元数据，并附上来源文件名及 SHA-256。发布的 `discovery-recovery.json` 是这些文件的索引，不是同一构建的合并结果。历史和驱动记录保留于 `historical-attempts.json` 及 `historical-<原文件名>`，包括 `historical-pre-radio-fix-discovery-recovery.json` 和 `historical-mdns-wrong-code-driver-attempt.json`。

历史发现记录包装层明确设置 `originalSnapshotReferencesUnresolved: true`。其中的快照名是原始私有文件名，不是当前发布 XML 的链接：重跑前没有保留旧 XML，且文件名发生重叠。不得仅因文件名相同，就把较新的 XML 当作旧历史观察的证据。

每个负向相机目录发布为独立前缀的 `qr-negative-<timestamp>-runs.json` 和 `qr-negative-<timestamp>-events.jsonl`，列于 `qr-negative-index.json`。源码哈希、commit/APK 身份、阶段、失败、`sessionGroup` 和 `sharedExpiredSession` 均被保留。索引只统计记录行，不将行数等同于成功次数或独立试验次数。QR 历史文件另外包装在 `historical-<原文件名>` 及历史索引中。应在采集器完成写入后再打包。

对于复制或生成的文本记录，打包脚本拒绝已知本地凭据及部分敏感字段或 Windows 路径。PNG 副本需要另外目视检查，脚本不会脱敏图像像素。清单也会覆盖目标目录中原有文件，因此应审查过时文件或手工加入的文件。不得捕获仍有效的配对短码/二维码、永久凭据、不必要的设备标识或私有路径。应保留失败尝试及其适用范围限制；脱敏和哈希不会把不完整观察转化为验收证据。

补充计数限制：Manual 入口点击和输入框聚焦点击没有埋点，不能把 userActions 当作不同方式的完整操作成本进行比较。

`manual-qr-restoration` 系列以独立 runs/trials/events 前缀发布，保留原始手工配对基线。`post-qr-restoration-host.json` 保存另外的恢复后主机观察。后续负向工具在启动时记录 `driverSha256` 和 `workingTreeDirty`。未记录工具哈希的旧包明确标注 `driverHashMissingInOriginal: true`，工具哈希为空，不会事后套用当前脚本哈希。驱动曾被修改时，相同 Git HEAD 不代表执行过程相同。
