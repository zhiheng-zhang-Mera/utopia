# UI-000 · 候选视觉方向（TEMPORARY candidate surface）

> **常驻施工规则：** `mission-book/CONSTRUCTION_RULES.md`
> 本目录是 **UI-000 Owner 审美门禁** 的临时候选面，不是产品架构的一部分。

本目录同时承载 UI-000 的三项交付：

1. **功能 / 信息地图** — 见下方 §2 与机器可读的 [`shared/facts.js`](./shared/facts.js)；
2. **三套可运行、可截图、结构明显不同的视觉候选** — `a/` `b/` `c/`；
3. **机器可验证的"功能事实相同"契约** — [`shared/parity-probes.js`](./shared/parity-probes.js) + `scripts/ui-000/parity.mjs`；
4. **共享本地运行时** — [`shared/runtime.js`](./shared/runtime.js)，三套候选的每个控件都作用在同一个模型上，
   因此同一个点击在三套里产生同一个事实。

## 1. 怎么运行 / How to run

```powershell
# 候选 Web 面（ES module，必须走 http，不能直接 file:// 打开）
node scripts/ui-000/serve.mjs 4330
# 打开 http://127.0.0.1:4330/apps/web/candidates/

# Rooms 代表页（真实 Room Hub，?theme=a|b|c 选择候选皮肤）
node apps/rooms/hub/server.mjs
# 打开 http://127.0.0.1:4320/?theme=a#/knowledge

# 功能事实一致性校验（真实浏览器，285 个探针）
node scripts/ui-000/parity.mjs

# 截图证据
$env:CITY_TOKEN = (Get-Content .runtime/local-config.json | ConvertFrom-Json).token
node scripts/ui-000/screenshot.mjs
```

## 2. 功能 / 信息地图（UI-000 步骤 1 的产出）

### 2.1 当前产品的真实一级导航（9 项）

来源：`apps/web/index.html`（`data-page`）、`apps/web/app.js`、`apps/android/.../MainActivity.kt`。

```text
未分组： Home · Rooms("Tools / Rooms") · Devices · Activity
Advanced：Services · Tasks · Actions · Pairing · Settings
```

现状的结构问题不是配色，而是**工程内部结构直接投影成了导航与内容**：

- `WORKSPACE / ALIEN`、`CONTROL SURFACE`、`DIGITAL CITY / 01` 出现在正常产品表面；
- 一级导航 9 项（Android 同样 9 项），Advanced 只是视觉分组，没有真正降级；
- Home 由 4 个统计卡 + 面板堆叠构成，本质是监控大盘；
- task id、event `#seq`、room `id`/`number`、capabilityId、invocationId、`resultDigest`、
  `backendRef` / `resultRef` / `provenance`、`apiVersion` / `schemaVersion`、hubUrl、
  `lastCheckpoint` 的原始 JSON 直接印在主路径上；
- 图标使用 Unicode 几何字符（`◈ ▦ ◇ ≋ ◉ ▤ ≣ ⊞ ⚙ ▣`），没有真正的 icon system；
- Rooms Hub 是 `#0c1016` 近黑底 + `#5ec8f2` 青色的开发工具视觉，且没有任何主题机制
  （`apps/rooms/hub/public/hub.css` 的 `:root` 变量是现成的唯一接缝）。

### 2.2 三套候选共同的信息架构目标

```text
一级（产品面）： Home · Ask/Do · Tools · Devices · Activity
降级（可访问、默认不占主路径）： Services · Tasks · Actions · Pairing · Settings
```

### 2.3 能力清单 = 三套必须共同表达的“功能事实”

完整机器可读版本：`shared/facts.js` 的 `CAPABILITIES`（29 项）。摘要：

| 归宿 surface | 能力 |
|---|---|
| Home | 连接状态、快照与更新时间、需要关注/正在进行、连接令牌 |
| Ask/Do | 统一自然语言路由、副作用确认、歧义候选、未匹配手动选择、执行结果 |
| Tools | 10 个已接受房间目录、房间服务可用性、打开房间 |
| Devices | 设备列表、遥测与实时/缓存、设备详情、选择设备并定向作业 |
| Activity | 事件时间线（类型/时间/顺序） |
| Services（降级） | 能力目录、按 inputKind 调用、调用历史与保留的结果详情 |
| Tasks（降级） | 任务列表、检查点/结果/取消、演示任务 |
| Actions（降级） | 操作历史（limit/状态/路由/目标）、操作详情 |
| Pairing（降级） | 配对会话（码/倒计时/QR）、发现与协议诊断 |
| Settings（降级） | 界面语言、更换令牌/断开 |

### 2.4 必须“降级但保留”的技术字段

`shared/facts.js` 的 `TECHNICAL_FIELDS`（20 项），包括 task id、event seq、room id/number/lifecycle、
node id、agentVersion、capabilityId、invocationId、resultDigest、backendRef、resultRef、
provenance、apiVersion、schemaVersion、hubUrl、lastCheckpoint、discovery reason。

**规则：降级 ≠ 删除。** 三套候选各自用不同机制承载它们：

- 候选 A：行内 `<details>运行详情</details>`；
- 候选 B：右侧 **检查器（inspector）**，默认关闭，选中行才出现；
- 候选 C：海报内的 `运行详情` 折叠块。

`scripts/ui-000/parity.mjs` 会对每套候选调用其 `revealAll()`（= 审阅者手动展开全部细节的动作），
证明这些值仍然可达。

## 3. 三套候选

| ID | 名称 | 导航模型 | 结构 | 视觉 | 技术细节归宿 |
|---|---|---|---|---|---|
| A | Halo / 随行 | 无侧栏；底部常驻 omnibox（以意图为主） | 单栏 760px、发丝线分割、时间轴 | 暖纸浅色、衬线标题、赤陶强调色 | 行内折叠 |
| B | Atlas / 工作台 | 对象轨道（机器/工具/作业/记录）而非页面 | 轨道 + 画布 + 检查器三区 | 冷灰浅色、1px 网格、近直角、等宽数字 | 右侧检查器 |
| C | Prism / 剧场 | 顶部大字幕（act）+ 后台抽屉 | 不等宽海报 deck、全屏 spotlight 输入 | 深色高饱和、紫/柠檬双色、层叠表面 | 海报内折叠 |

三者共享同一份 `shared/facts.js` 与同一套 `shared/icons.js` SVG 图标；
`tests/ui-000-candidates.test.mjs` 会断言三者背景色、强调色、圆角**两两不同**，
防止“只换配色”。**候选 C 的 Ask/Do 是 spotlight 覆盖层，另设一个可寻址的 `ask` scene 以满足信息架构一致性。**

**行为一致性（Development 后修正的真实缺陷）：** 首轮候选里有 17 个控件渲染出来却什么都不做——
这是假可供性，等于把"功能事实相同"变成一句声明。修正方式是引入 `shared/runtime.js`：
三套候选的每个控件都调用同一个本地模型，同一个点击在三套里产生同一个事实。
`parity.mjs` 的 `ACTION_PROBES` 现在会**真的点击**每个控件并断言产生的事实；
`openRoom`/`openHub` 还会断言确实发生了真实跳转（`window.open` 的目标 URL）。
契约测试同时禁止 `=> {}` 空处理器再次出现。这次修正确实找出了两处真实缺口：
候选 B 完全没有"打开房间"控件、候选 A 没有"打开房间服务"控件。

## 4. Rooms 代表页

真实 Room Hub 通过 `apps/rooms/hub/public/themes/{a,b,c}.css` 获得三套皮肤。
主题**只覆盖 `hub.css` 已有的 CSS 变量**（以及少量 hub.css 里硬编码的颜色），
不改 Room 行为、不改 markup、不改 API，Room 模块完全不知道主题存在。
代表页取 `knowledge`（真实两栏 UI + 有种子数据）与 `focus`。

## 5. 清理契约（重要）

UI-000 明确要求“不把候选三套全部长期留在生产代码”。选定方向后：

- `apps/web/candidates/**`（含本 README、`scripts/ui-000/`、`tests/ui-000-candidates.test.mjs`）**整树删除**；
- `apps/rooms/hub/public/themes/**` 与 `apps/rooms/hub/public/index.html` 中的主题加载块删除，
  胜出方向折叠进 `hub.css`；
- 胜出方向由 UI-101/102/103 按各自的允许修改边界重新实现，**不是**把候选目录改名保留。

`tests/ui-000-candidates.test.mjs` 在候选目录不存在且生产 shell 干净时会 **skip**，
因此半途清理不会留下永久红灯；但“目录已删、生产 shell 仍引用 candidates”会失败。
