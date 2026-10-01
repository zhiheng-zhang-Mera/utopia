# UTOPIA · City — 城市实现层架构

**状态：** 生效
**清单：** [`city/CITY_IMPLEMENTATION_MANIFEST.json`](../CITY_IMPLEMENTATION_MANIFEST.json)
**孵化入口：** [`apps/rooms/docs/zh-CN/INCUBATION_POLICY.md`](../../apps/rooms/docs/zh-CN/INCUBATION_POLICY.md)

---

## 1. 两个东西，别混

```text
Digital-City 仓库 = 地图 / 规划 / 同步参考
Utopia/city/      = 当前实际的城市模块实现层
```

`city/` 只登记**已经实际存在**的实现。清单不是愿望列表：只有从 Room Pack 孵化并通过验收、正式晋升进来的模块才会写进 `ACTIVE` / `PROMOTED`，`DEFERRED` 的内容绝不写成 `ACTIVE`。

本树承认两种孵化身份，两者不得混淆：

| 孵化身份 | 记录位置 | 含义 |
| --- | --- | --- |
| Room Pack 孵化房间 | `apps/rooms/promotions/<room>.json` | `apps/rooms/rooms/<room>/` 下真实存在过一个房间，本地验收后才晋升 |
| mission-book 迁移孵化 | module 上的 `mission` 块 + `DONOR.json` + `Digital-City/mission-book/reports/<MISSION_ID>/` | `Digital-City/mission-book` 是另一套由 Owner 定义的施工控制面：它在 `mission/<MISSION_ID>-<slug>` 分支上直接把代码落到 `city/`，并由**另一台**主机独立验证后才合并 |
| mission-book 项目任务孵化 | module 上的 `mission` 块 + `PROVENANCE.json` + `Digital-City/mission-book/reports/<TASK_ID>/` | 同一控制面下的异步 `BA-`/`RF-`/`GAI-`/`EM-` 任务池；属于 Owner 定义的全新施工，没有 donor，落在 `<programme>/<TASK_ID>-<slug>` 分支上并由另一台主机独立验证 |

mission 形式的孵化 id 形如 `mb-<task>-<module>-lab`。`city/tests/manifest.test.mjs` 会拒绝：声称该形式却没有对应 `mission` 块的模块，以及清单条目与该模块自己的溯源文件（迁移是 `DONOR.json`，项目任务是 `PROVENANCE.json`）不一致的模块。同一个 module 内不得混用这些身份：mission-book 任务不是 Room Pack 晋升，混写会让房间晋升记录失去可验证性。项目任务为何必须记 `donor: null` 而不是写一个 donor，见 §4。

---

## 2. 层次与产权

```text
City
  ↓
District
  ↓
Building
  ↓
Module / Capability
```

三个概念各有明确边界：

| 概念 | 含义 |
| --- | --- |
| Room（`apps/rooms/**`） | 孵化场 / 本地产品 / 面向用户的实验 |
| Building（`city/<district>/<building>/`） | 产权 + 生命周期 + 服务边界 |
| Module（`city/<district>/<building>/<module>/`） | Building 内部的实现单元 |

**Room 不是 Building。** 一个 Module 不得为了好听被提升成独立 Building。

---

## 3. 当前实际存在的区

只建立当前真正需要的区，不预建 00–11 的空目录。

```text
city/
├── CITY_IMPLEMENTATION_MANIFEST.json
├── manifest.mjs
├── test-all.mjs
├── docs/{zh-CN,en}/ARCHITECTURE.md
├── 00-foundation/
│   ├── 01-city-core/
│   │   ├── root-authority/
│   │   ├── task-lifecycle/
│   │   ├── fleet-routing/
│   │   └── audit-ledger/
│   ├── 02-city-node-network/
│   │   └── device-identity/
│   └── 03-capability-fabric/
│       └── capability-fabric/
├── 02-engineering/
│   └── 02-worker-gateway/
│       └── skill-intake/
├── 06-research/
│   └── 01-research-institute/
│       └── evidence-engine/
├── 09-planning-knowledge/
│   ├── 01-knowledge-service/
│   │   └── knowledge-core/
│   └── 02-document-intake/
│       ├── ingestion-core/
│       └── document-readers/
└── 11-entertainment/
    └── 01-entertainment-centre/
        └── theme-engine/
```

### Wave 1 产权表

| District | Building | Module | 来源 donor |
| --- | --- | --- | --- |
| `00-foundation` 城市地基 | `03-capability-fabric` 城市服务网 | `capability-fabric` | DS-Hns `app/core/{capability-registry,plugin-manager,health-supervisor,lockfile,contracts/capability}.cjs` + Codex-Boss `src/shared/{provider-contracts,provider-outcome,provider-state,capability-router}.ts` |
| `02-engineering` 工务区 | `02-worker-gateway` 施工队接入站 | `skill-intake` | DS-Hns `app/extensions/mega/skills/*` |
| `06-research` 研究院区 | `01-research-institute` 研究院 | `evidence-engine` | Codex-Boss `electron/evidence-engine.ts` |
| `09-planning-knowledge` 规划知识区 | `01-knowledge-service` 知识服务所 | `knowledge-core` | Codex-Boss `src/shared/knowledge.ts` |
| `09-planning-knowledge` 规划知识区 | `02-document-intake` 文档接入站 | `ingestion-core` | Codex-Boss `electron/ingestion/*` |
| `09-planning-knowledge` 规划知识区 | `02-document-intake` 文档接入站 | `document-readers` | Codex-Boss `electron/ingestion/{docx,xlsx,pdf}-reader.ts` |
| `11-entertainment` 娱乐区 | `01-entertainment-centre` 娱乐中心 | `theme-engine` | DS-Hns `app/extensions/mega/theme/*` |

### MB-001 城市核心产权表

由 `Digital-City/mission-book` 的 MB-001 从冻结 donor `zhiheng-zhang-Mera/Codex-Boss @ 8df428eaa437a409368401e95194e40266b83080` 迁移而来。每个 module 在自己的 `DONOR.json` 里记录所属 cluster、donor 源文件，以及每一处刻意差异。

| District | Building | Module | Cluster | 来源 donor |
| --- | --- | --- | --- | --- |
| `00-foundation` 城市地基 | `01-city-core` 城市核心 | `root-authority` | A — 根权限 / 根信任 / 保护面 | `src/shared/root-authority/{contracts,protected-surface}.ts`、`electron/root-authority/protected-surface-guard.ts` |
| `00-foundation` 城市地基 | `01-city-core` 城市核心 | `task-lifecycle` | B — 任务身份 / 生命周期 / 持久状态 | `src/shared/candidate-gate.ts` §35 |
| `00-foundation` 城市地基 | `01-city-core` 城市核心 | `fleet-routing` | C — 编排 / 路由 / 运行时协调 | `src/shared/{fleet,capability-router,node-capabilities,adaptive-routing}.ts` |
| `00-foundation` 城市地基 | `01-city-core` 城市核心 | `audit-ledger` | D — 续跑 / 恢复 / 持久审计 | `src/shared/decision-ledger.ts`、`src/shared/candidate-gate.ts` §36 |

---

## 4. Module 生命周期

```text
PLANNED      已登记产权，代码尚未迁入
INCUBATING   正在 Room Pack 内孵化
PROMOTED     已从孵化房间晋升，代码在本树
ACTIVE       正式在役
DEPRECATED   保留但不再发展
```

清单校验（`city/manifest.mjs`）会强制（schema v2）：

- `schemaVersion` 必须为 `2`；
- `district.id` 形如 `02-engineering`，`module.path` 必须等于 `city/<district>/<building>/<module>`；
- 每个 module 的 `lifecycle` 必须是上述之一；
- 已实现（`PROMOTED` / `ACTIVE` / `DEPRECATED`）的模块必须声明 `incubationRooms`，且至少一个、非空、去重；
- **同一个孵化房间不得被两个 module claim**；
- 已实现的模块目录必须真实存在；`PLANNED` / `INCUBATING` 的模块目录必须**尚不存在**；
- `donor` 若存在，必须带 `repository` 与合法的 git SHA。

### 为什么是列表而不是单值

Wave 2 起，同一个 city module 可以被**多次孵化**逐步增强，例如：

```json
"incubationRooms": ["skill-intake-lab", "skill-discovery-lab"]
```

每个孵化房间仍然保留自己独立的 `apps/rooms/promotions/<room>.json` 记录，Wave 1 的记录不会被覆盖。`roomId` 单值字段已废弃（校验器仍能读取旧值以兼容，但新写入必须用列表）。

这些规则由 `city/tests/manifest.test.mjs` 实际执行。

mission 孵化的 module 另有三条强制规则：

- `incubationRooms` 的每一项都必须是 mission 形式 `mb-<task>-<module>-lab`，且同一个 module 内不得与 Room Pack 房间混用；
- 该 module 必须带 `mission` 块，写明它属于哪个任务、覆盖的是哪个 cluster；
- 清单条目必须与该 module 自己的、落在磁盘上的溯源文件在 module id、city path、孵化房间列表、任务 id、cluster 上完全一致。

第三条规则对 mission-book 的两种任务形态有不同落法，因为它们不是同一类工作：

| mission-book 任务形态 | 示例 id | 溯源文件 | donor |
| --- | --- | --- | --- |
| 迁移 mission | `MB-001` | `DONOR.json` | 钉死的仓库 + commit，清单必须与两者一致 |
| 项目任务（`BA` / `RF` / `GAI` / `EM`） | `RF-001` | `PROVENANCE.json` | **没有**——属于 Owner 定义的全新施工，记为 `donor: null` |

项目任务没有 donor，是因为根本没有可移植的东西。给它写一份 `DONOR.json` 就必须编造一个 commit，而这正是迁移规则要防的伪造；所以清单要求 `donor: null` 加一份 `PROVENANCE.json`，说明该 module 是什么、占用城市地图上哪栋楼、以及它刻意不跨越哪些接缝。

### 为什么 mission 孵化不是伪造的晋升

Room Pack 路线靠"先把能力做成真实本地产品房间再晋升"来证明它。mission-book 迁移用另一种方式证明：donor 代码被移植到 `mission/<MISSION_ID>-<slug>` 分支，由**另一台不同主机**对照 donor 独立复核后才允许进入 `main`。施工报告留在 `Digital-City/mission-book/reports/<MISSION_ID>/`，过程记录留在 Utopia 自己的 evolution feed。

把 mission 迁移写成 Room Pack 晋升会更省事，但那是假话——根本没有房间跑过。所以清单写的是 mission 身份，而上文的测试不允许两者被混淆。

---

## 5. 目标结构要求

- **不得**修改 `apps/web/**`、`apps/android/**`、`services/dev-gateway/**`、`agents/reference-node/**`、`contracts/**`、`platform/**`；
- **不得**修改 City Control Protocol、Gateway API v0、Runtime Node 任务语义、Android 协议契约；
- 每个 module 自带 focused 测试；
- 统一测试入口：`node city/test-all.mjs`（纯 Node discovery，避免 Windows glob 差异，不引入新测试框架）；
- 不建立 City 语言服务、权限框架、事件总线、插件系统等超前抽象。

### 冻结，与 mission-book 的消费要求

上面的清单冻结的是产出 Wave 1 / Wave 2 的**城市建设波次**所依赖的产品面，目的是不让某个 city module 悄悄改掉 Android 与 Web 已经依赖的协议。

而 mission-book 迁移有一个更晚、且必须满足的要求：MB-001 的 Verification 门槛要求"至少一条现有 Utopia task/control 流程真实消费迁移后的 Core 边界，并保持 Web/Android 状态真值一致"。没有任何消费面的 Core 不叫迁移，只叫库。

两者的调和方式如下，且仅限于此：

- **当 mission-book 要求时，消费接线可以进入 `services/**`**：mission-book 明确把现有 Utopia Services/Tasks 消费面列为合法消费者；
- **协议与语义冻结是绝对的。** 消费必须是等价重构：City Control Protocol、Gateway API v0 的请求与响应形状、Runtime Node 任务状态名、事件名与 payload 形状、Android 协议契约都不得改变；接线之前已经持久化的数据，接线之后仍须可读；
- **行为变更需要独立 mission**，绝不能悄悄夹带进本 mission。

---

## 6. Room Pack 与 city 的关系

```text
IDEA / DONOR
    ↓
Room Pack incubator room      （apps/rooms/rooms/<lab>/）
    ↓
local product acceptance      （focused tests + 浏览器核心动作 + 单机）
    ↓
promotion decision
    ↓
city/<district>/<building>/<module>
```

晋升后：

```text
apps/rooms/rooms/<lab>/        从最终树删除
apps/rooms/promotions/<id>.json 留档
Git history + 双语文档          保留追溯
```

**禁止 Room 与 City 两份活代码长期漂移。**

---

## 7. MB-006 重启恢复站迁移

`Digital-City/mission-book` 是另一套由 Owner 定义的施工控制面：它在 `mission/<MISSION_ID>-<slug>` 分支上直接把代码落到 `city/`，并由**另一台**主机对照 donor 独立验证后才允许进入 `main`。这是 Room Pack 之外的第二套孵化身份，两者不得混淆——这些 module 根本没有跑过房间，写成 Room Pack 晋升就是伪造来源。

mission 形式的孵化 id 形如 `mb-<MISSION_ID>-<module>-lab`，并且该 module 必须同时带 `mission` 块。`city/tests/manifest.test.mjs` 会拒绝只写其一的情况，也会拒绝清单条目与该 module 自己的 `DONOR.json` 不一致的情况。

MB-006（donor `dsh-restart @ e20fb6cc`）新增了一个 Building：`04-restart-recovery-station`。

| Module | Donor 源 | 提供的能力 |
| --- | --- | --- |
| `restart-protocol` | `src/shared/{protocol,types}.ts`、`src/plugin/request-validator.ts` | 共享重启线协议与请求准入：形状与策略校验顺序、拒绝码、请求规范化与指纹 |
| `restart-lock` | `src/plugin/restart-lock.ts` | 独占重启锁：声明式迁移边、持有者规则、有界历史、强制释放 |
| `checkpoint-gate` | `src/plugin/checkpoint-gate.ts` | 检查点接缝及其有界、fail-closed 的闸门 |
| `restart-ticket` | `src/plugin/ticket-store.ts`、`src/plugin/atomic.ts` | 带版本与校验和的凭据，及其校验阶梯 |

donor 的结构被保留：`restart-protocol` 是 donor 共享契约层的移植，另外三个 module 从它导入，正如 donor 里 `src/plugin/*.ts` 导入 `src/shared/*.ts`。定义校验和的函数或状态词表只能有一个归属，不能每个 module 一份。

### `capabilityProvider`

这四个 module 属于重启基础设施：它们在 city 里真实存在，但不对外暴露任何能力，因此声明 `"capabilityProvider": false`，能力注册表会跳过它们。若没有这个标记，Web 与 Android 的能力列表会把它们当作"尚未接桥的不可用能力"——那是在断言一个并不存在的产品面。

### 冻结，与 mission-book 的消费要求

§5 冻结产品面，是为了不让某个 city module 悄悄改掉 Android 与 Web 依赖的协议。而 mission-book 迁移有一个更晚的要求：MB-006 必须被某个既有 task/control 流程真实消费。两者的调和方式仅限如下：当 mission-book 要求时消费接线可以进入 `services/**`，且必须是等价重构。因此 `services/dev-gateway/server.mjs` 判断"被重启打断的工作能否续跑"改由迁移后的 `checkpoint-gate` 作出，而 Utopia 自己的策略作为数据传入（从未开始的任务不需要检查点；已经开始的任务没有绑定检查点端口，因此按 donor 的 fail-closed 默认拒绝）。

## 8. MB-003 Worker Gateway 迁移

`Digital-City/mission-book` 是另一套由 Owner 定义的施工控制面：它在 `mission/<MISSION_ID>-<slug>` 分支上直接把代码落到 `city/`，并由**另一台**主机对照 donor 独立验证后才允许进入 `main`。这是 Room Pack 之外的第二套孵化身份，两者不得混淆——这些 module 根本没有跑过房间，写成 Room Pack 晋升就是伪造来源。

mission 形式的孵化 id 形如 `mb-<MISSION_ID>-<module>-lab`，并且该 module 必须同时带 `mission` 块。`city/tests/manifest.test.mjs` 会拒绝只写其一的情况，也会拒绝清单条目与该 module 自己的 `DONOR.json` 不一致的情况。

MB-003（donor 为 `Codex-Boss @ 8df428e` 与 `DS-Hns @ eeb57ca`）在既有的 `02-worker-gateway` Building 内新增三个 module：

| Module | Donor 源 | 提供的能力 |
| --- | --- | --- |
| `worker-task-contract` | DS-Hns `app/extensions/mega/scheduler/lifecycle.js` | 任务终态词表、持久状态兼容、终态事件身份与幂等、通知安全摘要 |
| `provider-adapter` | Codex-Boss `electron/runtimes/{runtime,unsupported-runtime,web/provider-runtime-adapter}.ts`、`src/shared/provider-state.ts` | provider/runtime 适配契约、就绪判定、不支持能力拒绝、provider 生命周期状态 |
| `provider-resilience` | Codex-Boss `electron/commander/circuit-breaker.ts`、`src/shared/provider-outcome.ts` | provider 失败/中断语义、熔断健康隔离、provider outcome 码 |

### `capabilityProvider`

这三个 module 属于适配层基础设施：它们在 city 里真实存在，但不对外暴露任何能力，因此声明 `"capabilityProvider": false`，能力注册表会跳过它们。若没有这个标记，Web 与 Android 的能力列表会把它们当作"尚未接桥的不可用能力"——那是在断言一个并不存在的产品面。

### 冻结，与 mission-book 的消费要求

§5 冻结产品面，是为了不让某个 city module 悄悄改掉 Android 与 Web 依赖的协议。而 mission-book 迁移有一个更晚的要求：MB-003 必须被某个既有 task/control 流程真实消费。两者的调和方式仅限如下：当 mission-book 要求时消费接线可以进入 `services/**`，且必须是等价重构——City Control Protocol、Gateway API v0 形状、Runtime Node 任务状态名、事件名与 payload 形状、Android 协议契约都不得改变。因此 `services/capability-bridge/bridge.mjs` 的按能力降级判定改由迁移后的 `provider-resilience` 熔断器作出，而 Utopia 自己的策略（阈值 1、两个 provider 技术性错误码）作为数据传入。

## 9. RF-001 设备身份——第一个项目任务孵化

`Digital-City/mission-book` 后来从单一的迁移队列重整为四个异步项目：Butler Assistant（`BA-`）、Remote Fabric（`RF-`）、General AI Gateway（`GAI-`）与 Engineering Manager（`EM-`），由 `CROSS_PROGRAMME_EXECUTION_CONTRACT.md` 统一调度。这些任务与当年的迁移 mission 一样把代码落到 `city/` 下，但它们是**全新施工**：没有 donor，也就没有可钉死的东西、没有 `DONOR.json` 可写。这就是 §4 描述的第三种孵化身份。

RF-001 新增了一栋楼 `00-foundation/02-city-node-network`——城市地图早已把它保留为「城市节点网 City Node Network — Device Node Fabric」，其产权声明包含「Owner/Root 权限之下的节点/设备主体身份」。楼内一个 module：

| Module | 溯源 | 提供什么 |
| --- | --- | --- |
| `device-identity` | 全新施工（`PROVENANCE.json`，`donor: null`） | 带版本的 `DeviceIdentity`/`device_id` 与安装记录、首次安装登记、重装/重绑、密钥轮换、改名、退役、凭据克隆检测与隔离，以及 MAC/元数据非权威规则 |

该 module 的孵化房间是 `mb-rf-001-device-identity-lab`，生命周期为 `PROMOTED`（代码已在本树中，分支尚未合并），且不声明任何能力：它属于身份基础设施，因此和 `01-city-core` 一样不进能力注册表。

### 为什么这不是 Room Pack 晋升

没有任何房间孵化过 `device-identity`。把它写成一个 `device-identity-lab` 的 Room Pack 房间，就需要为从未跑过的房间补一份 `apps/rooms/promotions/<room>.json` 记录，而这正是 §4 拒绝的伪造来源。项目任务形态存在的意义，就是让诚实的说法——「某个 mission-book 项目任务落了这份代码，这是它的 `PROVENANCE.json`」——可以被写出来。

### 冻结，与项目任务的消费要求

§5 冻结产品面。RF-001 是组件任务，因此不接任何消费者：天然接缝在 `services/dev-gateway` 的节点注册，它今天存的是 `{id, devicePrincipalId, displayName, metadata.platform, agentVersion, capabilities, online, lastHeartbeatAt}`，且 `devicePrincipalId === id`，没有密钥材料、没有逻辑设备与安装的分离、也没有克隆检测。`migrateDeviceIdentity` 正好接受这个行形状，所以升级路径是真实且被测试的，但本分支不改变任何运行时行为。未解决的接缝记录在该 module 的 `PROVENANCE.json` 中，并按 `CROSS_PROGRAMME_EXECUTION_CONTRACT.md` §5 推迟到 Remote Fabric 合并工程书——推迟不等于成功。
