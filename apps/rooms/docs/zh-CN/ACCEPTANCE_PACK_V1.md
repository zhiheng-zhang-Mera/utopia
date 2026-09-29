# MECH ROOM PACK V1 验收记录

**任务：** `MECH-ROOM-PACK-V1`
**主机：** Mech / 一号主机（单机完成）
**基线：** `main` @ `3e0bfb09b94b2d58c36948feb5e2f4b60676e4a9`
**分支：** `mech/room-pack-v1`
**唯一施工面：** `apps/rooms/**`
**运行版本：** Node.js `v24.14.0`（Windows）
**启动方式：** `apps\rooms\Start-Rooms.cmd`（等价 `node hub\server.mjs`）
**绑定地址：** `127.0.0.1`（验收使用 `ROOMS_PORT=4321`；产品默认 `4320`）

本文件只记录真实执行过的验收，不把样例运行写成验收。

---

## 1. 结论

```text
MECH_ROOM_PACK_V1_READY_TO_ATTACH
```

Gate P1–P7 全部通过。

---

## 2. Focused 测试（真实运行）

```cmd
cd apps\rooms
node --test tests/*.test.mjs
```

```text
tests 60 | pass 60 | fail 0
```

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `tests/hub.test.mjs` | 9 | store 原子性与 schemaVersion、损坏文件报错、并发写入不丢失、共享工具、health/房间清单/静态资源、未知房间与目录穿越、房间数据隔离、端口配置 |
| `tests/knowledge.test.mjs` | 6 | 创建/编辑/删除、重启保持、三类搜索、导出结构、导入 replace 与非法包整体拒绝、排序 |
| `tests/bookmarks.test.mjs` | 5 | CRUD、仅 http(s)、标题回退与搜索、导出导入、重启保持 |
| `tests/checklist.test.mjs` | 5 | 清单与条目/进度、移动与删除、清除已完成、重启保持、不使用 City Control 任务词汇 |
| `tests/prompts.test.mjs` | 5 | 变量识别、渲染与 missing、变量值持久、搜索、导出导入与无 AI 依赖 |
| `tests/text-workshop.test.mjs` | 6 | 统计、空白与去空行、排序与去重、大小写、行 diff、HTTP 与零持久化 |
| `tests/hash.test.mjs` | 3 | 与 Node crypto 对照、期望值比对、非法算法与零持久化 |
| `tests/data-lab.test.mjs` | 6 | CSV 解析与摘要、JSON 错误位置、美化/压缩、非法 JSON、CSV 预览与零持久化 |
| `tests/focus.test.mjs` | 5 | 预设与会话完成、刷新后 interrupted、输入校验、删除、汇总与重启保持 |
| `tests/calendar.test.mjs` | 5 | 事件 CRUD、日期时间校验、分组排序、scope 过滤、导出导入与重启保持 |
| `tests/decisions.test.mjs` | 5 | 新建 OPEN、选项 id 稳定、decide/revisit、搜索与状态筛选、导出导入与重启保持 |

测试只使用系统临时目录，绝不读写 `.runtime-rooms/`。

---

## 3. 浏览器 canonical 走查（真实产品 UI）

方式：真实启动 `hub/server.mjs`，headless Chrome 打开 Hub，依次切到 10 个房间，每个房间至少执行一个核心动作，断言全部取自运行中的 DOM。

```text
pass 26 | fail 0
```

| 检查 | 结果 |
| --- | --- |
| 走查从干净 runtime 开始（清理上一次残留） | PASS |
| Hub 外壳加载，导航显示 10 个房间 | PASS |
| Hub 报告本地后端可用 | PASS |
| R1 知识室：新建条目并搜索命中；无结果时 UI 正常 | PASS |
| R2 书签室：新建带标签与备注的 URL 并显示 | PASS |
| R3 清单室：新增条目并勾选，进度 1 of 1 | PASS |
| R4 提示词库：识别 2 个变量、填写并渲染 | PASS |
| R5 文本工坊：实时统计（4 行 / 6 词）、去重生效 | PASS |
| R6 哈希室：文件摘要与独立 Web Crypto 计算一致；MATCH / MISMATCH 均正确 | PASS |
| R7 数据实验室：美化输出、非法 JSON 报出位置、CSV 引号逗号正确 | PASS |
| R8 专注室：暂停后计时确实停止、会话进入历史（interrupted）、今日统计显示 | PASS |
| R9 日程室：今天视图显示新事件与时间 | PASS |
| R10 决策室：DECIDED 记录选项与理由，revisit 变为 REVISIT | PASS |
| 420px 窄窗口导航与布局不崩坏 | PASS |
| 页面重载后持久房间数据仍在 | PASS |
| 房间导出 bundle 结构完整 | PASS |
| 整个走查未记录到任何页面错误 | PASS |

截图与断言明细保存在施工环境的验收目录（不属于仓库内容）。

---

## 4. Gate 结果

### Gate P1 — Isolation ✅

```text
git status --porcelain 中 apps/rooms/** 之外的改动 = 0
apps/web、apps/android、services/dev-gateway、agents/reference-node、contracts、
platform、根 tests、evidence、.github、scripts、根 package.json / pnpm-lock.yaml 全部未改
```

### Gate P2 — Single Host ✅

在 Gateway / Reference Node / Android / Boss / Hns 全部关闭、无第二台主机的条件下：

```text
/health 返回 10 个房间，host = 127.0.0.1
10 个房间的核心功能全部可用（见第 3 节走查）
7 个持久房间各有一个 .runtime-rooms/<room>.json
Text Workshop / Hash / Data Lab 未产生任何运行文件
```

### Gate P3 — Restart ✅

关闭 Hub 进程（端口不再响应）后用新进程重启：

```text
知识条目、书签、清单与条目勾选状态、prompt 模板与变量值、
专注会话历史（active = null）、日程事件与起止时间、决策状态与选择
全部恢复
7 个持久文件均为 schemaVersion 1 + updatedAt + data 结构
```

### Gate P4 — Room Independence ✅

```text
对知识室执行 import replace 清空：书签/日程/决策房间数据完全不变
把一个房间文件写成非法 JSON：Hub 在加载期明确报错并指出该文件
（不会静默重置为空），其他房间数据未被触碰
```

### Gate P5 — Full Focused Tests ✅

```text
apps/rooms/** tests = 60 pass / 0 fail
```

### Gate P6 — Manual Product Walkthrough ✅

```text
10 个房间逐个打开并完成至少一个核心动作 = 26 项断言全通过
```

### Gate P7 — No Alien Regression by Construction Surface ✅

未修改 Alien 主体任何文件（Gate P1 已核对）。因此本包不声称运行过 Alien 全量实机回归，而是通过文件边界证明未直接修改主体。

---

## 5. 验收中发现并修复的真实缺陷

1. **两个 Hub 实例共享房间数据**：`RoomStore` 直接持有 manifest 里的默认对象引用，导致同一进程内第二个 Hub 能读到第一个 Hub 的内存数据（测试中表现为计数 1 → 2）。已改为构造与加载时都 `structuredClone` 默认数据。修复后 60 项测试中有 15 项由失败转为通过。
2. **前端公共工具被当作 ES module 加载**：`client-kit.js` 原本是 ESM（含 `export`），但 Hub 以 classic script 引入，浏览器抛 `Unexpected token 'export'`，导航完全不渲染。已重写为 IIFE 并只挂载 `globalThis.RoomsKit`。
3. **哈希室无法挂载**：`dom` 集合漏了 `verifyButton`，导致 `addEventListener` 抛错、房间显示 failed to load。已补齐。
4. **决策保存后丢选项 id**：PATCH 时按文本重建选项会生成新 id，客户端提交的 `selectedOptionId` 因此失效而报 400。已改为按文本复用既有选项 id。
5. **决策室 `decision` 字段为空时不回落到所选选项文本**：已修正 decide 流程。
6. **JSON 错误位置缺失**：Node 24 的 `Unexpected token` 报错不再带 position。数据实验室现在会定位违规片段并推算出行/列。

---

## 6. 已知限制

- 单进程单用户假定：`.runtime-rooms` 不提供跨进程写锁，同机多实例同时写同一房间不受保护；
- 房间数量固定为 10，Room Pack 不含插件机制，新增房间需要改代码（属于设计选择）；
- 无账号、无协作、无云同步、无通知；
- 专注室计时在页面内运行，关闭浏览器即按 interrupted 记录（设计如此）；
- 日程室不发提醒、不做重复规则；
- 未接入 Utopia 主 UI 导航（后续可做一个极小的 integration change，不属于本包完成条件）。

后续增强见 [POST_V1_BACKLOG.md](POST_V1_BACKLOG.md)，不升格为当前 blocker。
