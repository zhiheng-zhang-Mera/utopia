# UTOPIA · Rooms (MECH ROOM PACK V1)

**任务编号：** `MECH-ROOM-PACK-V1`
**状态：** `MECH_ROOM_PACK_V1_READY_TO_ATTACH`
**唯一施工面：** `apps/rooms/**`

Room Pack 是 Utopia 的**单机本地产品区**：一个只监听 `127.0.0.1` 的 Room Hub，加上 10 个互相低耦合、单机即可完整使用与验收的功能房间。

它不注册 Node / Task / Event / Capability，不使用 `/api/v0/*`、Gateway token、WebSocket 事件流，也不与 Boss / Hns / Android / Reference Node 发生任何关系。

```text
Utopia
└── Rooms
    ├── Room Hub
    ├── 01 Knowledge Room
    ├── 02 Bookmark Room
    ├── 03 Checklist Room
    ├── 04 Prompt Library
    ├── 05 Text Workshop
    ├── 06 Hash Room
    ├── 07 Data Lab
    ├── 08 Focus Room
    ├── 09 Calendar Room
    └── 10 Decision Room
```

---

## 启动

要求 Node.js 24 或更新版本，只使用 Node 内置模块：无第三方依赖、无构建步骤、无 `install`。

```cmd
apps\rooms\Start-Rooms.cmd
```

等价方式：

```cmd
cd apps\rooms
node hub\server.mjs
```

浏览器打开：

```text
http://127.0.0.1:4320/
```

环境变量（可选）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ROOMS_PORT` | `4320` | 本地端口 |
| `ROOMS_RUNTIME_DIR` | `apps/rooms/.runtime` | 本地数据目录 |

绑定地址固定为 `127.0.0.1`，无法改为 `0.0.0.0`；不支持局域网与公网暴露。

---

## 测试

```cmd
cd apps\rooms
node --test tests/*.test.mjs
```

测试只使用系统临时目录，绝不读写 `.runtime/`。

---

## 房间一览

| # | 房间 | 持久化 | 核心能力 |
| --- | --- | --- | --- |
| 01 | Knowledge | `knowledge.json` | 知识条目 CRUD、标题/正文搜索、标签筛选、导出导入（replace） |
| 02 | Bookmarks | `bookmarks.json` | 网址收藏 CRUD、标签、备注、搜索、仅点击打开链接 |
| 03 | Checklist | `checklist.json` | 清单与条目、勾选、上下移动、清除已完成 |
| 04 | Prompts | `prompts.json` | Prompt 模板、`{{变量}}` 识别与填充、渲染、复制 |
| 05 | Text Workshop | 无 | 字符/词/行统计、trim、空白归一、去空行、排序、去重、大小写、行 diff |
| 06 | Hash | 无 | 本地文件 SHA-256、大小、文件名、期望值比对 |
| 07 | Data Lab | 无 | JSON 解析/美化/压缩/校验（含错误位置）、轻量 CSV 预览 |
| 08 | Focus | `focus.json` | 倒计时、暂停/继续/重置、预设、会话历史、今日分钟数 |
| 09 | Calendar | `calendar.json` | 本地事件 CRUD、今天/未来列表、排序 |
| 10 | Decisions | `decisions.json` | 决策记录（OPEN / DECIDED / REVISIT）、选项、理由、搜索标签 |

---

## 本地接口

```text
GET  /health
GET  /local-rooms/v1/rooms                      房间清单
     /local-rooms/v1/<room-id>/...               各房间自己的本地接口
```

`/local-rooms/v1/*` 是 Room Pack 自己的本地实现细节，**不是** `City Control Protocol`，不得写入 `contracts/`。

---

## 数据

```text
apps/rooms/.runtime/
├── knowledge.json
├── bookmarks.json
├── checklist.json
├── prompts.json
├── focus.json
├── calendar.json
└── decisions.json
```

每个持久文件形如：

```json
{ "schemaVersion": 1, "updatedAt": "ISO-8601", "data": {} }
```

写入使用「临时文件 + rename」，同进程写入串行化。房间只能访问自己的文件；一个房间数据损坏或清空不会影响其他房间。

---

## 文档

- 中文：[docs/zh-CN/README.md](docs/zh-CN/README.md) · [docs/zh-CN/ROOM_CATALOG.md](docs/zh-CN/ROOM_CATALOG.md) · [docs/zh-CN/ACCEPTANCE_PACK_V1.md](docs/zh-CN/ACCEPTANCE_PACK_V1.md) · [docs/zh-CN/POST_V1_BACKLOG.md](docs/zh-CN/POST_V1_BACKLOG.md)
- English: [docs/en/README.md](docs/en/README.md) · [docs/en/ROOM_CATALOG.md](docs/en/ROOM_CATALOG.md) · [docs/en/ACCEPTANCE_PACK_V1.md](docs/en/ACCEPTANCE_PACK_V1.md) · [docs/en/POST_V1_BACKLOG.md](docs/en/POST_V1_BACKLOG.md)

---

## 与 Alien 的边界

Mech 只新增 `apps/rooms/**`。Alien 的 `apps/web`、`apps/android`、`services/dev-gateway`、`agents/reference-node`、`contracts`、`platform`、根 `tests`、`evidence`、根 CI、根 `package.json` / `pnpm-lock.yaml` 全部不改动，因此本包在 Git 层可直接拼接：

```text
Alien tree
+
apps/rooms/**
=
combined Utopia tree
```
