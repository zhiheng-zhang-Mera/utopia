# Utopia「万能个人终端」快速路线

> 本文用于重新排序 V0.3 Hardening 之后的施工优先级。历史 Wave 工程书和验收记录继续作为有效证据；这里改变的是**下一步先做什么**，不是推翻已经通过的内容。

## 1. 产品目标

Utopia 接下来应该先变成**一个个人终端**，而不是三套工程控制台。

用户在 Windows/Web 或 Android 打开 Utopia 时，理想心智应该是：

> “我告诉 Utopia 我想做什么，它自己找到合适的本地工具、City capability、设备节点或外部 runtime，然后用同一套进度/结果/历史告诉我发生了什么。”

目标体验：

```text
一个 Utopia Shell
  ↓
一个 Ask / Do 命令入口
  ↓
一个 Action 用户模型
  ↓
自动路由
  ├─ 本地 Room
  ├─ City Capability Bridge
  ├─ Runtime Node
  ├─ Boss connector
  ├─ Hns connector
  └─ 后续领域 connector
  ↓
Web + Android 共用一套结果 / 进度 / 历史体验
```

Utopia 仍然只是产品/参考实现，不取得永久 City Core 所有权。

---

## 2. 现在已经有的东西

当前 main `393f3b89a9c4fae61be1e431c4bcd47fee945e88` 已经具备：

### 产品/控制面
- Web 控制端；
- Android 控制端；
- QR / mDNS / BLE / 手动配对；
- Node 状态和 telemetry；
- Task / Activity 页面。

### Capability 面
五个已经通过实机/跨客户端验收的服务：

- Document Intake；
- Knowledge Query；
- Skill Inspect；
- Evidence Review；
- Theme Generate。

同时已经有：

- qualified identity；
- lifecycle-aware availability；
- 有界 invocation summary/detail；
- typed failure；
- Web/Android digest parity；
- restart/recovery truth。

### 本地个人工具
Room Pack V1 已经有十个通过验收的 Room：

- Knowledge；
- Bookmarks；
- Checklist；
- Prompt Library；
- Text Workshop；
- Hash；
- Data Lab；
- Focus；
- Calendar；
- Decisions。

Room Pack 已经进入 main，但还没挂到 Utopia 主导航。

所以现在的瓶颈不是“能力太少”，而是**用户体验被分成了几套系统**。

---

## 3. 当前真正的冲突：三套用户入口

现在用户需要理解三个概念：

```text
Tasks
  City Control v0
  运行任务

Services
  Capability Bridge
  模块调用

Rooms
  本地个人工具
  独立 Room Hub
```

后台可以继续分开，但产品层不应该再要求用户先判断“这件事属于哪一套”。

也不能为了统一而破坏语义：

- Checklist item 不是 City Task；
- Room 不是自动等于 City module；
- Capability invocation 也不应该被伪装成 Engineering task。

正确方法是在上面增加一层**用户级 Action facade**。

---

# 4. 最快施工顺序

## T1 — 先把已经能用的东西接进来

目标：**不增加领域能力，先立刻扩大 Utopia 的可用体感。**

1. 正常 Utopia Host 启动流程同时启动 Room Hub；
2. Web 主导航增加 **Rooms / Tools**；
3. Home 直接显示十个已验收 Room；
4. Room Hub 继续只绑定 loopback，不为了手机访问破坏原有隔离；
5. Android 第一阶段只显示 Room 可用性；之后再通过认证 bridge 消费，不直接把 4320 暴露到 LAN。

主界面应逐步变成：

```text
Utopia
├─ Home
├─ Ask / Do        （T2）
├─ Tools / Rooms
├─ Devices
├─ Activity
└─ Advanced
   ├─ Services
   └─ Tasks
```

**在这一步完成前，不新增第 11 个 Room。**

---

## T2 — 建立统一 Action facade

目标：统一用户看到的历史和结果，但不强行合并底层所有权。

产品层 Action 可以记录：

```text
Action
├─ actionId
├─ requestedIntent
├─ route
│  ├─ ROOM
│  ├─ CAPABILITY
│  ├─ CITY_TASK
│  ├─ BOSS
│  └─ HNS
├─ backendRef
├─ target
├─ status
├─ progress
├─ resultRef
├─ error
└─ timestamps
```

它只是适配已有 backend ID/status，不替换：

- City Task；
- capability invocation；
- Room 自己的数据模型。

Web/Android 读同一份 Action truth。

完成后，现有 **Tasks / Services** 可以退到 Advanced/诊断页面，而不是用户的主要入口。

---

## T3 — 做一个 Ask / Do 命令栏

目标：用户不需要先选系统。

先做确定性路由；LLM router 可以以后再加。

例如：

```text
“读这个 PDF”
→ Document Intake

“查刚才文档里 X 说了什么”
→ Knowledge Query

“清单里记一下买牛奶”
→ Checklist Room

“收藏这个链接”
→ Bookmark Room

“算一下这个文件哈希”
→ Hash Room

“在 Alien 上跑这个安全任务”
→ City Task / Node

“检查这份 evidence”
→ Evidence Review
```

规则：

1. 高置信确定路由 → 显示目标然后执行；
2. 多个合理目标 → 显示 2–3 个候选；
3. 有副作用/破坏性操作 → 必须再次确认；
4. 找不到 → 进入 capability search / 手动选择。

基础本地命令**不需要依赖 LLM 才能路由**。

---

## T4 — 直接接 Boss / Hns，不要先迁它们

这是从“个人工具箱”变成**万能个人终端**的关键一步。

### Boss connector

用薄 connector 暴露现有 Boss 能力，例如：

- 普通 Chat / Work；
- provider routing；
- Research workflow；
- 适合由 Boss 保留的全局工作。

Utopia 负责入口和展示，Boss 继续拥有自己的 runtime。

### Hns connector

把 Hns 当 Engineering provider：

- 项目/仓库施工；
- coding-agent dispatch；
- 工程进度/结果。

Utopia 只发送有界 Engineering request 并显示 Action，不复制 Hns 主体。

最终用户看到的是：

```text
问 Utopia
  ├─ 普通问题 → Boss / general provider
  ├─ 工程施工 → Hns
  ├─ 本地个人工具 → Room
  ├─ 文档/知识/evidence → City service
  └─ 设备操作 → Node / Automation
```

这一步带来的“万能感”远大于先迁 Health、Quant 或 Digital-Me。

---

## T5 — Personal Workspace / Inbox

目标：让多个命令之间有连续性。

最小范围：

- 用户主动交给 Utopia 的最近文件；
- 最近文本/片段；
- 最近 Actions；
- pinned Rooms / capabilities；
- 明确保存的 notes / bookmarks；
- result reference / digest。

这属于**用户自己的工作区数据**，不是 Digital-Me 的人格/记忆。

可以复用但不要混为一谈：

- Room Knowledge：简单个人内容；
- 09 Knowledge Core：retrieval / trust / provenance；
- Document Intake：解析文件；
- Action history：引用结果。

这一阶段不要造“自动人格记忆大脑”。

---

## T6 — 跨设备接续

Action + Workspace 成为 canonical 后再做：

- Web 发起，Android 查看；
- Android 选择文件，Windows 继续；
- 必要时选择目标 Node；
- 两端共用 Action ID / result truth；
- offline/cached 状态明确；
- 重连不重复执行。

Android 不必为了这个目标立刻变成完整计算 Node；它可以先继续作为控制端。

---

## T7 — 把 Host 变成真正“常驻终端”

日常个人终端不能每次都像开发环境一样启动。

将现有进程包装为一个支持的 Host 生命周期：

```text
Utopia Host
├─ Gateway
├─ Runtime/Reference Agent
├─ Room Hub
└─ Health / Restart supervision
```

优先做：

- 一个启动入口；
- 可选 Windows tray / 开机启动；
- 可见 health/restart 状态；
- 自动 reconnect；
- graceful stop/restart；
- 需要时通过 adapter 复用 dsh-health-scheduler / dsh-restart；
- 仍然不要求公网部署。

这是产品化，不是 City Core 重写。

---

## T8 — 最后再挂领域建筑

终端主链稳定后，再独立接：

- Digital-Me；
- Health / Drug Simulator；
- Quant；
- Automation / Computer Use；
- VR/AR / devices；
- 更完整 Research；
- voice/avatar/presentation。

每个领域最终都只需要满足：

```text
capability + route + Action result
```

就能进入终端，不需要改变整个 UI 心智。

---

# 5. 现在应该后置的内容

为了最快达成“万能终端感”，以下内容**不能作为前置 blocker**：

- Theme Engine 从 `city/11` 物理搬到新的 00/05 ownership；
- D9 Theme Builder 扩张；
- General Logic Engine；
- Customs / Runtime Compliance 独立抽取；
- Health / Quant / Digital-Me 迁移；
- 公网/cloud；
- 3D City；
- iOS/HarmonyOS/Linux；
- 自动人格记忆；
- arbitrary shell。

当前 Theme Generate 已经足够通过这个产品里程碑。

---

# 6. “万能个人终端感”最小验收

一台 Windows 主机 + 一台 Android 实机，满足以下场景即可认为第一阶段目标达成：

1. 一个 Utopia Host 启动入口带起需要的本地服务；
2. Web Home 直接能进入已验收 Rooms，不需要把 Room Pack 当另一个产品启动；
3. Web/Android 都有同一个 **Ask / Do** 入口；
4. “读文档”可以自动走 Document Intake，并继续 Knowledge；
5. “记清单/收藏链接”等请求可以进入对应 Room；
6. 普通 AI 请求可以通过 Boss/general-provider connector；
7. 工程请求可以通过 Hns；
8. 设备/runtime 请求可以定位到正确 Node；
9. 上述不同 backend 都以统一 Action/history 展示，同时保留真实 provenance；
10. 一个客户端发起的 Action 可以在另一个客户端查看，且不会重复执行；
11. offline/restart 必须真实显示，不能把 stale RUNNING 伪造成成功；
12. 不需要先完成 Health、Quant、Digital-Me、VR 或 Theme Builder 才能通过。

做到这里，Utopia 就已经具备真正的：

> **“一个入口，很多能力；设备只是不同终端，背后能力自动接入”**

的个人万能终端体感。后续 City 建筑只是增加“它还能做什么”，不再决定“它像不像一个终端”。
