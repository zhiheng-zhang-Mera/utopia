# Device Center 与连接能力实施计划

规格：用户提供的 UTOPIA-ALIEN-DEVICE-CENTER-CONNECTIVITY-V0.2.md。以产品优先接续已验收 V0，不修改 Digital-City/Boss/Hns。在 codex/alien-device-center-connectivity-v0.2 施工，保留 V0 回归与双语记录，尽量少用 Computer Use。

## 并行实现共用接口（冻结）

既有 API 版本保持零，认证和版本请求头不变，公开配对端点仍需版本头。

- GET /api/v0/pairing/info：公开 envelope 包含 cityId、displayName、descriptor、activeSession 布尔值、expiresAt、shortCodeEnabled。不包含凭据、code、secret。
- POST /api/v0/pairing/session：需要 control 认证，空 body；返回 descriptor、pairingSessionId、shortCode、expiresAt、qrPayload、qrSvg。短期 QR 信息与 code 仅在交互界面显示，不进入证据/日志。撤销旧 session，默认有效期 300 秒。
- POST /api/v0/pairing/exchange：公开版本化 body {cityId,sessionId,method:qr|mdns|ble,secret? 或 shortCode?}。原子单次交换，返回 {apiVersion:0,schemaVersion:0,cityId,endpoint,credential}。拒绝错误、过期和已用材料；限制错误猜测。不接受调用方传入 endpoint。
- Descriptor：{descriptorVersion:1,cityId,displayName,endpoint:{scheme:'http',host,port},apiVersion:0,schemaVersion:0,pairingSessionId:string|null,expiresAt:string|null}。
- QR：utopia://pair?v=1&host=<encoded http origin>&city=<cityId>&session=<sessionId>&expires=<ISO>&secret=<ephemeral>。Android 拒绝错误版本、畸形 URI、缺失主机、未知 scheme、无效端口、过期和 city/endpoint 不一致。
- /city 新增 cityId、displayName、descriptor、discovery:{mdns:{state,reason?},ble:{state,reason?}}，既有 nodes/tasks/events 不变。
- 节点注册/心跳新增 agentVersion:'0.2.0' 与 telemetry:{observedAt,cpu:{usagePercent},memory:{usedBytes,totalBytes},disk:{usedBytes,freeBytes,totalBytes},uptimeSeconds}。CPU 首次无差分时允许 null，不伪造不可用数据。每 3 秒采样，新鲜度限 10 秒；客户端断开为 UNKNOWN，节点离线为 OFFLINE，过期指标标 Cached/UNKNOWN。
- mDNS _utopia-city._tcp：TXT v=1、city、api=0、schema=0、session hint，不含 secret。Android 原生 NsdManager，按 cityId 去重并拒绝 endpoint 冲突。
- BLE UUID 6f9a0001-6c53-4b92-a319-75746f706961；Manufacturer id 0xffff；23 字节载荷：网络字节序 UUID（16）、version=1（1）、IPv4（4）、大端 port（2）。通过 pairing/info 获取完整 city/session；广告空间不包含身份/session hint。无 secret。发布器和能力检测限定 platform/windows。WinRT 保留 service UUID AD 字段，因此 Android 根据 manufacturer UUID 前缀扫描并读取数据，再校验 endpoint 和完整 cityId 去重。

## 顺序与所有权

- [x] 契约/Gateway：总控补 descriptor/parser 测试、持久化城市身份、单次 session、限速、发现生命周期与遥测校验，保留 V0 测试。
- [x] Windows：适配器子任务实现真实采样、WinRT BLE 发布/检测、注册/心跳集成及测试，不改 Gateway/UI。
- [x] Android：Android 子任务仅修改 apps/android；Device Center、四入口引导、ZXing 摄像扫码/scheme、NsdManager/BLE 权限、exchange、清除配对、不含秘密的轻量 pilot 记录，完成单元测试和构建。
- [x] Web：Web 子任务仅修改 apps/web 和独立 Web 测试；Devices/详情及认证 QR/code/status 配对页，不截取有效配对材料。
- [ ] 集成：总控负责安装实机，检查遥测与所有可运行 bootstrap；QR 必须实际摄像扫描，不用 descriptor 注入替代；实测 BLE 硬件限制。
- [ ] Pilot：每种可用方式五次 clean pairing；Wi-Fi/Gateway/Node 恢复各三次；过期/错 code/旧 QR 各两次；mDNS stale 两次；支持时 BLE toggle 两次。产品优先，时间戳数据作为副产品；缺失观察保留 null/NOT_RUN。
- [ ] 交付：脱敏 hash manifest、候选 PILOT claim 台账、双语文档、最终分支 SHA、CI、精确 APK 与 release。所有门禁有证据后才接受；仅 BLE 硬件受阻可使用指定条件接受状态。

评审重点：单次 session 竞态、短码暴力猜测、端点身份冲突、过期遥测/实时显示、权限及摄像生命周期、QR/UI 树/日志误录秘密。子任务不提交、不操作实机，由总控集成并负责验收。

STATUS: NOT_ACCEPTED
PAIR_STATUS: SYNCHRONIZED

实现与已观测的实机结果见[验收检查点](../../evidence/zh-CN/ACCEPTANCE_V0_2.md)。未勾选的集成、Pilot、交付项包含真实摄像头 QR 门禁与正式验收发布，不能由构建成功或其他配对方式通过推定完成。
