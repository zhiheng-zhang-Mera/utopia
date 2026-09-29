# UTOPIA · Room Pack V1（房间包）

**任务编号：** `MECH-ROOM-PACK-V1`
**状态：** `MECH_ROOM_PACK_V1_READY_TO_ATTACH`
**唯一施工面：** `apps/rooms/**`
**共同基线：** `main` @ `3e0bfb09b94b2d58c36948feb5e2f4b60676e4a9`

Room Pack 是 Utopia 的**单机本地产品区**：一个只监听 `127.0.0.1` 的 Room Hub，加上 10 个互相低耦合、单机即可完整使用与验收的功能房间。

```text
Utopia
└── Rooms
    ├── Room Hub（本地入口、导航、最薄存储、loopback HTTP）
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

要求 Node.js 24 或更新版本。只使用 Node 内置模块：没有第三方依赖，没有构建步骤，不需要 `install`。

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
| `ROOMS_RUNTIME_DIR` | `apps/rooms/.runtime-rooms` | 本地数据目录 |

绑定地址固定为 `127.0.0.1`，无法改成 `0.0.0.0`；不支持局域网与公网暴露。

---

## 测试

```cmd
cd apps\rooms
node --test tests/*.test.mjs
```

共 60 个 focused 测试：hub/store 9、knowledge 6、bookmarks 5、checklist 5、prompts 5、text workshop 6、hash 3、data lab 6、focus 5、calendar 5、decisions 5。测试只使用系统临时目录，绝不读写 `.runtime-rooms/`。

浏览器验收为**一次 canonical 走查**：headless Chrome 依次打开 10 个房间，每个房间至少执行一个核心动作（26 项断言）。

---

## 房间与持久化

| # | 房间 | 持久文件 | 核心能力 |
| --- | --- | --- | --- |
| 01 | Knowledge | `knowledge.json` | 知识条目 CRUD、标题/正文搜索、标签筛选、导出导入（replace） |
| 02 | Bookmarks | `bookmarks.json` | 网址收藏 CRUD、标签、备注、搜索、仅点击后打开链接 |
| 03 | Checklist | `checklist.json` | 清单与条目、勾选、上下移动、清除已完成 |
| 04 | Prompts | `prompts.json` | Prompt 模板、`{{变量}}` 识别与填充、渲染、复制、变量值保存 |
| 05 | Text Workshop | 无 | 字符/词/行统计、trim、空白归一、去空行、排序、去重、大小写、行 diff |
| 06 | Hash | 无 | 本地文件 SHA-256、大小、文件名、期望值 MATCH / MISMATCH |
| 07 | Data Lab | 无 | JSON 解析/美化/压缩/校验（含错误位置）、轻量 CSV 预览 |
| 08 | Focus | `focus.json` | 倒计时、预设、暂停/继续/重置、会话历史、今日分钟数 |
| 09 | Calendar | `calendar.json` | 本地事件 CRUD、今天/未来视图、排序 |
| 10 | Decisions | `decisions.json` | 决策记录（OPEN / DECIDED / REVISIT）、选项、理由、搜索标签 |

Stateless 房间（Text Workshop / Hash / Data Lab）默认不创建任何运行文件。

---

## 本地接口

```text
GET  /health
GET  /local-rooms/v1/rooms
     /local-rooms/v1/<room-id>/...
```

`/local-rooms/v1/*` 是 Room Pack 自己的本地实现细节，**不是** `City Control Protocol`，不得写入 `contracts/`。Room Pack 不注册 Node / Task / Event / Capability，也不使用 `/api/v0/*`、Gateway token 或 WebSocket 事件流。

---

## 存储格式

```text
apps/rooms/.runtime-rooms/
├── knowledge.json
├── bookmarks.json
├── checklist.json
├── prompts.json
├── focus.json
├── calendar.json
└── decisions.json
```

每个文件形如：

```json
{ "schemaVersion": 1, "updatedAt": "ISO-8601", "data": {} }
```

- 写入使用「临时文件 + rename」，同进程写入串行化；
- 每个房间只能访问自己的文件，一个房间清空或损坏不影响其他房间；
- 损坏的房间文件在启动时被明确报错，不会被静默重置为空；
- `.runtime-rooms/*.json` 由目录内的 `.gitignore` 排除，仓库只提交 `.gitkeep`；
- 目录取名 `.runtime-rooms` 而不是 `.runtime`，因为仓库根 `.gitignore`（属于 Alien，本包不修改）已忽略任何 `.runtime/` 路径。

---

## 目录结构

```text
apps/rooms/
├── package.json
├── Start-Rooms.cmd
├── README.md
├── hub/
│   ├── server.mjs          # Room Hub：loopback、路由、静态资源、/health
│   ├── manifest.mjs        # 房间清单（顺序 = 施工顺序）
│   ├── registry.mjs        # 房间工厂与 store 装配
│   └── public/             # Hub 外壳（index.html / app.js / hub.css）
├── shared/
│   ├── atomic-store.mjs    # 原子 JSON 持久化
│   ├── room-kit.mjs        # id / 时间戳 / 文本与标签归一 / 校验 / 集合 CRUD
│   ├── http.mjs            # 本地 HTTP 辅助（JSON、静态、路由匹配）
│   ├── text-tools.mjs      # 文本工坊变换实现
│   ├── csv.mjs             # 最小 RFC4180 CSV 解析
│   └── client-kit.js       # 房间前端公共工具（全局 RoomsKit）
├── rooms/<room-id>/{room.server.mjs,client.mjs}
├── tests/*.test.mjs
├── .runtime-rooms/               # 真实数据（不入 Git）
└── docs/{zh-CN,en}/...
```

---

## 与 Alien 的边界

Mech 只新增 `apps/rooms/**`。`apps/web`、`apps/android`、`services/dev-gateway`、`agents/reference-node`、`contracts`、`platform`、根 `tests`、`evidence`、`.github`、`scripts`、根 `package.json` / `pnpm-lock.yaml` 全部不改动。

```text
Alien tree
+
apps/rooms/**
=
combined Utopia tree
```

---

## 文档

- [ROOM_CATALOG.md](ROOM_CATALOG.md)：每个房间的功能、数据与验收点
- [ACCEPTANCE_PACK_V1.md](ACCEPTANCE_PACK_V1.md)：Gate P1–P7 真实验收记录
- [POST_V1_BACKLOG.md](POST_V1_BACKLOG.md)：第二批房间与后续增强
- 英文对应目录：[../en/](../en/)
