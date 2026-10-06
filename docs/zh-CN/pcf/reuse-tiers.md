# PCF-700 复用成熟度五档核对 / Reuse-maturity five-tier check

本文件是 PCF-700 的交付物之一（工作书「规格修订 2」要求：核对已接受的 EM 连接器/Foreman、RF、GAI、WBC 与原端工具接线，并分别列出五档）。它**不创建任何运行时代码**，也不把「合同目录存在」当成「已启用」。

```text
STATUS: MEASURED_AT_BASELINE_312b627
PAIR_STATUS: SYNCHRONIZED
产线测量 / instrument   scripts/pcf700-reuse-audit.mjs（可重跑）
机器可读记录 / record   data-records/{zh-CN,en}/pcf/reuse-wiring-audit.json
配套守卫 / guards       tests/pcf700-dependency-direction.test.mjs（D1–D4，4/4 通过）
```

## 1. 档位不是声明出来的，是量出来的

```text
MISSING            没有这个合同目录
DECLARED           目录存在，但目录之外没有任何引用
COMPONENT_TESTED   只有 tests/ 引用它
LIVE_WIRED         至少一个产线文件（不在 tests/ 下）引用它
TWO_HOST_VERIFIED            **不能由本机 grep 推出**：必须由另一实体主机独立跑通样本调用链
ORIGIN_AGENT_CONSUMED        **不能由本机 grep 推出**：必须有「原端会话真实消费结果」的实测链
```

最后两档一律写 `NOT_MEASURED_HERE`，并注明它属于哪本工作书的验收——本机不替异机签名。

## 2. 按域实测（baseline 312b627，49 个合同目录）

| 域 | 目录数 | LIVE_WIRED | COMPONENT_TESTED | 唯一产线引用者 |
|---|---:|---:|---:|---|
| EM（`engineering-*`） | 13 | **0** | 13 | 无 |
| GAI（`general-ai-*`） | 9 | **0** | 9 | 无 |
| RF / 回端面（`remote-*`、`rs-*`） | 10 | **2** | 8 | `services/dev-gateway/nearby.mjs`、`services/dev-gateway/presentation.mjs` |
| WBC（`execution-backend-v1`、`node-descriptor-v1`） | 2 | **2** | 0 | `standard-devices.mjs`、`worker-pool.mjs`、`execution-profile.mjs`、`server.mjs`、`services/headless-node-agent/agent.mjs` |

精确到合同：**LIVE_WIRED 的只有四个** —— `execution-backend-v1`、`node-descriptor-v1`（WBC）、`remote-local-discovery-v1`、`rs-presentation-contract-v1`（RF）。其余 30 个 EM/GAI/RF 合同**只有测试引用**，没有一个进入网关进程。

## 3. 逐域五档结论

```text
WBC   DECLARED ✓   COMPONENT_TESTED ✓（`tests/wbc60{1,2,3,4}-*`）   LIVE_WIRED ✓（网关导入并驱动 /api/v0/node/*）
      TWO_HOST_VERIFIED：PCF 语境下**未建立**。WBC 自己的复检是异机做的，但「一台设备为一台异机上的原端执行任务
      并把结果送回原端」这条链尚未在 PCF 语义下跨机跑过 —— 归 PCF-721/724 验收。
      ORIGIN_AGENT_CONSUMED：未建立（归 PCF-728）。
EM    DECLARED ✓（13 个目录、共 21+17+22+39+15+15+40+100+22+19+39+13+17 = 379 条 export 语句）
      COMPONENT_TESTED ✓（每个目录恰有一本 `tests/engineering-*.test.mjs`）
      LIVE_WIRED ✗ —— 网关**一条 engineering-* 都不导入**；没有 /api/v0 路由暴露它们。
      ⇒ 结论：EM 是**已测组件**，不是 PCF 可依赖的活服务；PCF 若要用 Foreman/连接器，必须自己接线（PCF-727）。
GAI   DECLARED ✓（9 个目录、共 264 条 export 语句）   COMPONENT_TESTED ✓   LIVE_WIRED ✗（同样零产线引用）
      ⇒ 结论同 EM：provider/approval 逻辑已存在且被测，但不在 City 进程里；PCF 不能声称「已有真实 provider」。
RF    DECLARED ✓   COMPONENT_TESTED ✓（10 个目录）   LIVE_WIRED **部分**：只有发现（nearby）与呈现（presentation）
      两个合同真的被网关调用；`remote-typed-dataplane-v1`、`remote-path-manager-v1`、`remote-fabric-public-api-v1`、
      `remote-capability-registry-v1`、`remote-invite-rendezvous-v1`、`remote-presence-reconnect-v1`、
      `remote-bluetooth-bootstrap-v1` 全部**未接线**。
      特别注意 `rs-cross-device-return-v1`（跨设备回端）**只有测试**，而它正是 PCF-714「原端状态与结果连续性」
      要接的缝 ⇒ 回端连续性现在**没有被任何产线路径证明**。
原端工具 rs-presentation-contract-v1 LIVE_WIRED（`presentation.mjs` → `/api/v0/presentation`，Web 与 Android 都消费）
      rs-cross-device-return-v1 见上：COMPONENT_TESTED，NOT_WIRED。
```

## 4. EM / RF / GAI 与 PCF 的复用边界（谁供什么，PCF 不重造什么）

| 关注点 | 供体 | 现状 | PCF 的正确做法 |
|---|---|---|---|
| 身份与信任 | City canonical store + `pairing-v1` + `remote-capability-registry-v1` | pairing 已接线；capability registry 仅测试 | **复用**，不建第二套 trust/credential（工作书「不可让步」） |
| 传输与到达 | `remote-local-discovery-v1`（已接线）、`remote-typed-dataplane-v1`/`remote-path-manager-v1`（未接线） | 只有发现是活的 | 需要时接现有合同，不新建传输层；未接线的部分列为显式缺口 |
| 工程规划与 Review→Repair | EM（`engineering-manager-v1` / `engineering-foreman-scheduler-v1` / `engineering-job-v1`） | 全部 COMPONENT_TESTED、零产线引用 | **不重做**；PCF 只提供执行/资源接口，规划权仍在 Foreman（PCF-727 承接） |
| Provider / 审批 / 会话 | GAI（`general-ai-registry-v1` / `general-ai-gateway-v1` / `general-ai-health-resilience-v1`） | 同上 | 不造第二个 provider 平台；PCF-725/726 只定义执行 provider 与胶囊边界 |
| 原端状态与结果回注 | `rs-presentation-contract-v1`（活）+ `rs-cross-device-return-v1`（仅测试）+ `handoff.mjs`（活） | 呈现活、回端缝仅测试 | PCF-714/728 接现有回端缝，不新建第二套结果通道 |
| 研究/追踪/回放 | REX（`/api/v0/research/*` 已接线） | 活的 | PCF-707 只做适配器，不造第二个研究平台 |

## 5. 本文件没有证明的（写明，不填 0）

```text
· 没有任何一项在本轮达到 TWO_HOST_VERIFIED —— 本机不替另一实体主机签名（§3 禁止自审）。
· ORIGIN_AGENT_CONSUMED 一项都没有：把「原端会话消费结果」当作已达成需要 PCF-728 的实测链。
· EM/GAI 的「已测」是**合同层单测**，不是端到端；不得据此声称真实 provider/连接器已可用。
· rs-cross-device-return-v1 的 NOT_WIRED 意味着：结果回原端目前靠 handoff.mjs 与 presentation 的组合，
  而不是这条专门的合同；PCF-714 必须自己证明它接上了。
```

## 6. 如何重跑（复检方用）

```bash
node scripts/pcf700-reuse-audit.mjs                 # 打印完整 JSON
node scripts/pcf700-reuse-audit.mjs --out /tmp/x.json
node --test tests/pcf700-dependency-direction.test.mjs
```

**产线测量脚本自身修过两个 bug，记录在此**：第一版用一条宽松正则，报了 19 条「后端导入前端」，全部是假阳性（服务路径与测试/脚本驱动器）；修好后只匹配 `import ... from '...'`，又被**副作用导入**（`import '../apps/web/app.js';`，是真实依赖）绕过——这一条是靠**故意证伪守卫**发现的。现在按「模块导入 / 静态服务路径 / 工具与测试驱动器」三类分开统计。
