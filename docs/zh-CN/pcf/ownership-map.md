# PCF-700 所有权与调用链现实审计 / Ownership and call-chain reality audit

本文件是 PCF-700 的交付物之一，冻结「哪些既有实现被复用、哪些要扩展、哪些根本还不存在」，并把**声明 → 调用者 → 活的 API → 用户面 → 精确证据**逐层写清。它**不创建任何运行时代码**：架构候选目录（`contracts/personal-compute-fabric-v1/`、`services/personal-compute-fabric/`）由本审计核实后仍为**未创建**。

> 权威层级：工作书 > 本文件。本文件只描述**当前 head** 的现实；标注 `NOT_WIRED` 的地方不是缺陷断言，而是「不要以为它已经接线」。

```text
审计基线 / baseline   utopia main 312b627（= PCF-700 的 claim-time baseline）
任务分支 / branch     pcf/PCF-700-mech-ownership-and-reality-audit
配套测试 / tests      tests/pcf700-compatibility.test.mjs（7/7）、tests/pcf700-dependency-direction.test.mjs（4/4）
同伴交付 / companions reuse-tiers.md（五档核对 + 复用边界）、ui-backend-matrix.md（UI→后端矩阵 + 单写者）
机器可读 / record     data-records/{zh-CN,en}/pcf/reuse-wiring-audit.json（由 scripts/pcf700-reuse-audit.mjs 生成）
```

## 1. 复用点：声明 → 调用者 → 活的 API → 用户面 → 证据

七个层次列的含义：**D**=声明处、**C**=调用者、**A**=活的 HTTP API、**S**=用户可见面、**E**=证据/测试。

| 复用点 | D 声明 | C 调用者 | A 活的 API | S 用户面 | E 证据 | 判定 |
|---|---|---|---|---|---|---|
| 规范库（Task/device/event 真相） | `services/dev-gateway/store.mjs:1`（`export class Store`、`StoreUnavailableError`） | `server.mjs` 全程 | 所有 `/api/v0/*` 读路由都由它支撑 | Home/Devices/Tasks 等 | `tests/city-store-diagnostic.test.mjs`（本分支已采纳的 typed 诊断） | **REUSE（live-wired）** |
| 规范任务创建与状态转移 | `server.mjs` 的 `createCityTask` / `changeTask` | `POST /api/v0/tasks`、campaign runner、node/report | `POST /api/v0/tasks`、`POST /api/v0/node/{claim,report}` | Tasks 页、Activity | `tests/pcf700-compatibility.test.mjs` C2/C4 | **REUSE（live-wired）** |
| 严格目标（用户指定设备） | `services/dev-gateway/targeting.mjs:30`（`STRICT_TARGET_FIELD='targetDeviceRef'`） | 导入于 `server.mjs:51`；**在 claim 路径内**由 `standard-devices.mjs:89/97/193/211/221` 使用 | `POST /api/v0/node/claim`（`withheld` 投影）、campaign runner 建任务时写入 | Devices/Tasks 详情（等待原因） | C3 + `tests/mesh301-strict-target.test.mjs` | **REUSE（live dispatch/claim 层已接线，非仅 helper）** |
| 执行 profile（WBC-604） | `services/dev-gateway/execution-profile.mjs:41`（`createExecutionProfileController`）、`:166`（`chooseHybridTarget`） | 控制器构造于 `server.mjs:503`；`currentProfile=()=>profileController.profile()`（`server.mjs:504`） | `GET/POST /api/v0/execution-profile`（`server.mjs:963/967`）；城市快照的 `executionBackend`（`server.mjs:718`） | 高级设置里的 profile 控件 | C6/C7 + `tests/wbc604-*` | **REUSE**；但 **`chooseHybridTarget` = NOT_WIRED**（helper 只有测试调用，网关从不调用，见 §3） |
| 后端注册表与选择 | `server.mjs:498`（registry）、`:522`（注册 standard-devices）、`:524`（注册 worker-pool）、`:527`（`executionBackends.active(currentProfile())`） | `executionBackend()` 取当前后端 | `/api/v0/node/{claim,report}`、`/city` 快照 | Devices 页与 profile 页 | C7 | **REUSE**；**worker-pool 已注册但 `enabled=false`（未激活）** |
| 标准设备后端 | `execution-backend/standard-devices.mjs:84` | 构造于 `server.mjs:509` | 同上 | 同上 | `tests/wbc601-*` | **REUSE（live）** |
| 工作池后端 | `execution-backend/worker-pool.mjs:5`（`enabled=false` 默认） | `server.mjs:524` 注册（**无参数** ⇒ 关闭） | 无（未激活） | 无 | `tests/wbc603-*` | **EXTEND（已存在的缝，未激活）** |
| 无头节点代理 | `services/headless-node-agent/agent.mjs:6`（`createHeadlessAgent`）、`index.mjs:1` | **网关不引用**（`git grep createHeadlessAgent -- services/dev-gateway/` 为空） | 无 | 无 | `tests/wbc603-headless-agent.test.mjs` | **COMPONENT_TESTED，NOT_WIRED 进网关** |
| 节点描述合同 | `contracts/node-descriptor-v1/node-descriptor.mjs`（roles/presence/resource kinds、`describeLegacyNode`） | `server.mjs:60`、`worker-pool.mjs:2`、`agent.mjs:1` | `POST /api/v0/node/register`（校验）、`GET /api/v0/nodes`（`nodeDescriptors`） | Devices 详情 | C5 + `tests/wbc602-*` | **REUSE**（legacy 记录由合同兜底，见 §3 的实测差异） |
| 交接桥 | `services/dev-gateway/handoff.mjs:23`（`createHandoffBridge`） | `server.mjs:334` | 任务/事件流中的交接结果 | Tasks/Activity | `tests/uxi391-remote-handoff-closeout.test.mjs` | **REUSE（live）** |

## 2. 架构候选接口 → 现实（§4 表的逐条核对）

`ARCHITECTURE.md §4` 列的九个接口，在当前 head 上**没有一个以该名字存在**；其中两个名字被别的领域占用，属于**同名不同物**，不得当作复用点：

| 候选接口（工作书） | 现实中是否存在 | 备注（实测） |
|---|---|---|
| `observeResources(sample, context)` | **不存在** | 同名符号存在于 `contracts/engineering-foreman-scheduler-v1/foreman.mjs`（EM 领域）⇒ **名称冲突，不是复用点** |
| `resolveEffectivePolicy(...)` | **不存在** | — |
| `normalizeWorkload(...)` | **不存在** | — |
| `planPlacement(...)` | **不存在** | — |
| `admit(proposal, expectedVersion)` | **不存在** | `admit` 一词在 17 个文件里出现（capability routing 等）⇒ **同名不同物** |
| `resolveArtifact(...)` | **不存在** | — |
| `executeAttempt(...)` | **不存在** | — |
| `validateCheckpoint(...)` | **不存在** | — |
| `reconcileExecution(...)` | **不存在** | — |
| `ResourceObservation` / `WorkloadEnvelope` / `EffectivePolicy` / `PlacementProposal` / `ReservationReceipt` / `AttemptReceipt` / `CheckpointRef` / `ArtifactRef` | **全部不存在** | 最小共享类型表目前是**设计**，不是代码 |

⇒ 结论：PCF 的九个接口与八个类型在 V1 都是**新增物**（MISSING），必须在 `contracts/personal-compute-fabric-v1/` 里新建；本审计**没有**为它们创建任何文件（架构 §2 的路径仍是候选）。

## 3. 三个必须区分的接线层次（工作书硬要求）

```text
① profile 切换        控制器已构造（server.mjs:503）、路由已存在（:963/:967）、快照已暴露（:718）
                      => LIVE_WIRED。切 profile 是 Owner 可操作的真实行为。
② 纯 HYBRID helper    chooseHybridTarget 已声明（execution-profile.mjs:166）并被 WBC-604 测试调用，
                      但 **网关里没有任何调用点**（`git grep chooseHybridTarget -- services/` 只有声明那一行）
                      => NOT_WIRED。C6 把这个事实**冻结成断言**：将来有人接线，测试会红，记录必须同步更新。
③ 真实 dispatch/claim 严格目标在 **claim 路径内部**被使用（standard-devices.mjs 的 claimAllowedByTarget /
                      withheldTasks / classifyTarget），并由 C3 用真实 /node/claim 验证：
                      目标缺席的任务对其它节点显示 withheld(reason=STRICT_TARGET_BOUND, heldFor=…)
                      => LIVE dispatch 层已接线。
```

另外两处「存在但未激活」：**worker-pool 后端已注册但默认关闭**（`createWorkerPoolBackend()` 无参 ⇒ `enabled=false`）；**无头代理与网关没有任何 import 关系**。

## 4. 单写者与「不新增规范库」的证据

```text
串行集成缝（本审计不得改动，只登记）
  services/dev-gateway/server.mjs          122680 B / 1350 行 —— 所有路由与控制器构造的唯一写者
  services/dev-gateway/store.mjs           规范 Task/Action/device/event 真相的唯一写者
  contracts/node-descriptor-v1/*           节点描述字段的唯一写者（server.mjs 与 worker-pool.mjs 都从这里导入）
  apps/web/*、apps/android/*               用户面的唯一写者

不新增规范库（实测）
  · 裸 City 启动后数据目录里**没有**任何 PCF 命名的状态（C1 断言 readdir 不含 pcf/personal-compute-fabric）
  · 全仓 `git grep -l 'personal-compute-fabric'` 只命中 mission-book 计划文件与 programming 文档，没有运行时模块
  · Store 仍是唯一规范库；本审计不创建第二份 Task/Action/device/credential 数据库
```

## 5. 下游 owner 与 UI→后端无环（本轮完成的部分）

```text
组件/证据 owner（按工作书声明）
  701 资源观测        纯采集+有界状态，无 UI 决策         owner: PCF-701；用户面归 715
  706 政策/同意        不创建信任与预算授权               owner: PCF-706；用户面归 715
  708 负载封套         legacy 任务不受影响                 owner: PCF-708
  702/704 放置与准入   只提案 / 经 canonical owner 串行化   owner: PCF-702 / PCF-704
  709/710/711/712      artifact / 执行 / 检查点 / 对账      owner: 各自；用户面归 714/715
  715 公共 UI 宿主      唯一 UI 宿主；714 发起端连续性；790 最终组合
UI→后端方向（实测）
  apps/web 与 apps/android 只通过 /api/v0/* 与网关通信；**后端模块 import 前端模块 = 0 条**
  => 无环。逐文件端点矩阵、单写者指纹与三段方向分类见 ui-backend-matrix.md（本轮已交付）
```

## 6. 兼容反例测试（已写、已跑）

`tests/pcf700-compatibility.test.mjs` —— **7/7 通过**（基线 312b627）：

```text
C1 无 fabric/workbench 配置的裸 City 仍启动、仍服务、默认 profile=STANDARD_DEVICES、默认后端=standard-devices，
   且**不创建**任何 PCF 状态目录
C2 legacy 无目标任务仍可被任意合格节点领取（既有调度行为不变）
C3 目标缺席的任务对其它节点 withheld（reason=STRICT_TARGET_BOUND、heldFor=目标、askedBy=请求者），
   且纯 guard 与活路由结论一致（classifyTarget=UNKNOWN/claimable=false）
C4 结果回到**规范 origin**（City 的 tasks 列表里读到 COMPLETED 与同一 result 对象）
C5 合同层容忍 legacy 记录（describeLegacyNode ⇒ roleSource=LEGACY_DEFAULT、assertNodeDescriptor 通过）；
   活路由层实测**要求 capabilities**（缺则 400），roles 可选 ⇒ 两层差异如实记录
C6 `chooseHybridTarget` 存在但网关不调用（NOT_WIRED 被冻结为断言）
C7 worker-pool 已注册但非活动后端；严格目标 guard 确实在 claim 路径里
```

**过程中本机自己的三处仪器错误**（记录，不掩盖）：把 `POST /tasks` 当成能带 `targetDeviceRef`（实测只接受 `type`，参数一律 400）；把 withheld 投影的行字段当成 `id`/`reason=UNKNOWN`（实测是 `taskId`/`STRICT_TARGET_BOUND`）；把 `classifyTarget` 的返回值当成 `{ok}`（实测是 `{state,claimable,reason}`）。

## 7. 本审计的完成状态（逐条对照，不冒充完成）

```text
已完成（本轮，可重跑）：
a  revision 2 的五档核对（EM connector/Foreman、RF、GAI、WBC、原端工具）→ reuse-tiers.md
   实测：49 个合同目录中只有 4 个 LIVE_WIRED（execution-backend-v1、node-descriptor-v1、remote-local-discovery-v1、
   rs-presentation-contract-v1）；EM 13 个与 GAI 9 个**全部只有测试引用、零产线引用**；rs-cross-device-return-v1
   只有测试 ⇒ 回端缝没有被任何产线路径证明
c  UI→后端逐文件依赖矩阵、单写者清单与机器可读记录 → ui-backend-matrix.md +
   data-records/{zh-CN,en}/pcf/reuse-wiring-audit.json（D1/D2 守卫：后端 import 前端 = 0；未解析端点数 = 0）
d  EM/RF/GAI 与 PCF 的复用边界表（谁供 identity/transport、谁供 provider/审批）→ reuse-tiers.md §4

仍未完成：
b  两主机独立核对样本调用链（子步骤最后一条）——**必须由另一实体主机执行**，本机不代做；TWO_HOST_VERIFIED 与
   ORIGIN_AGENT_CONSUMED 两档在本轮**全部为空**，已在 reuse-tiers.md §5 逐条写明
e  Android 侧 BuildConfig：**实测关闭（不适用）** —— 仓库内 Kotlin/Gradle 源码没有任何 `BuildConfig` 引用，
   也没有 `buildConfigField` ⇒ 不存在 Gradle 生成的 URL 缺口；运行期点击路径不属静态证据，归 b
```

本文件因此**只冻结已经实测的部分**；`UNKNOWN` 是结论，不是空白。
