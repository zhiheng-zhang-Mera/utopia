# UTOPIA · Knowledge Room（本地知识室）

**任务编号：** `MECH-K0-KNOWLEDGE-ROOM`
**状态：** `MECH_KNOWLEDGE_ROOM_READY_TO_ATTACH`
**归属：** `apps/knowledge-room/**`（单机、本地、零 Alien 依赖）

Knowledge Room 是 Utopia `Planning & Knowledge` 区的第一块真实产品功能区：一个只跑在本机 `127.0.0.1` 上的纯文本知识库。它不依赖 Utopia Gateway、不依赖 Runtime Node、不依赖 Android、不依赖第二台主机、不依赖任何云服务。

```
Utopia
└── Planning & Knowledge
    └── Knowledge Room / 本地知识室
```

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 新建 / 编辑 | 标题、正文、标签，保存后立即持久化 |
| 浏览 | 列表按 `updatedAt` 倒序，显示标题、标签、更新时间与正文摘要 |
| 搜索 | 标题 / 正文子串匹配 + 标签匹配，大小写统一 |
| 标签筛选 | 标签精确匹配（大小写与空白归一化），可多选 |
| 删除 | 删除前有一次确认，V0 永久删除 |
| 导出 | 完整 JSON bundle（`format` / `schemaVersion` / `exportedAt` / `entries`） |
| 导入 | `IMPORT_MODE = replace`，整包替换当前数据 |

不在本轮范围内：附件、图片、PDF/OCR、向量库、embedding、语义搜索、LLM 摘要、知识图谱、协作、账号、云同步。

---

## 启动

要求：Node.js 24 或更新版本（只使用 Node 内置模块，无第三方依赖，无构建步骤）。

```cmd
apps\knowledge-room\Start-Knowledge-Room.cmd
```

或：

```cmd
cd apps\knowledge-room
node src\server.mjs
```

启动后打开：

```
http://127.0.0.1:4317/
```

环境变量（都可选）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `KNOWLEDGE_ROOM_PORT` | `4317` | 本地端口 |
| `KNOWLEDGE_ROOM_DATA_DIR` | `apps/knowledge-room/runtime-data` | 数据目录 |

绑定地址固定为 `127.0.0.1`，不可通过环境变量改成 `0.0.0.0`。公网访问不在支持范围内。

---

## 目录结构

```text
apps/knowledge-room/
├── package.json
├── Start-Knowledge-Room.cmd
├── README.md
├── src/
│   ├── server.mjs            # 本地 HTTP 服务 + 静态产品 UI
│   ├── store.mjs             # JSON 持久化 store + 确定性搜索
│   ├── model.mjs             # KnowledgeEntry 模型与校验
│   ├── import-export.mjs     # bundle 导出 / 导入（replace）
│   └── public/
│       ├── index.html
│       ├── app.js
│       └── app.css
├── tests/
│   ├── store.test.mjs        # 6 个 model/store 测试
│   ├── search.test.mjs       # 4 个搜索测试
│   ├── import-export.test.mjs# 4 个导入导出测试
│   ├── http.test.mjs         # 4 个 HTTP/API 测试
│   └── helpers.mjs
├── runtime-data/             # 真实用户数据（不入 Git）
│   ├── .gitkeep
│   └── .gitignore
├── samples/
│   └── knowledge-sample-v0.json
└── docs/
    ├── zh-CN/{README.md,ACCEPTANCE_K0.md,POST_K0_BACKLOG.md}
    └── en/{README.md,ACCEPTANCE_K0.md,POST_K0_BACKLOG.md}
```

---

## 数据模型

```json
{
  "id": "uuid",
  "title": "Example title",
  "body": "Plain text or Markdown-like source text",
  "tags": ["research", "utopia"],
  "createdAt": "ISO-8601 timestamp",
  "updatedAt": "ISO-8601 timestamp"
}
```

标签在写入前统一为 `trim + 折叠内部空白 + 小写`，并去重。

---

## 本地存储

数据文件：

```text
apps/knowledge-room/runtime-data/knowledge-v0.json
```

```json
{ "schemaVersion": 0, "entries": [] }
```

- 每次保存先写同目录临时文件，再 `rename` 覆盖目标文件，避免半写文件；
- 同一进程内的写入串行化，不会互相覆盖；
- 只读写自己的数据目录，不扫描其他目录，不读取 Gateway / Boss / Hns 的状态文件；
- `runtime-data/*.json` 由目录内的 `.gitignore` 排除，仓库只提交 `.gitkeep` 与样例数据。

---

## 本地接口

这些 endpoint 是 Knowledge Room 自己的实现细节，**不是** `City Control Protocol v0`，也不得写入 `contracts/city-control-v0/`。

```text
GET    /health
GET    /local-kb/v0/entries            支持 ?q= 与 ?tag=
POST   /local-kb/v0/entries
GET    /local-kb/v0/entries/:id
PATCH  /local-kb/v0/entries/:id
DELETE /local-kb/v0/entries/:id
GET    /local-kb/v0/search?q=&tag=
GET    /local-kb/v0/export
POST   /local-kb/v0/import
```

导入校验：必须匹配 `format = "utopia-knowledge-room"`、`schemaVersion = 0`、`entries` 为数组且每条结构合法。任一条件不满足则整包拒绝，现有数据不变。

---

## 测试

```cmd
cd apps\knowledge-room
node --test tests/*.test.mjs
```

共 18 个测试：store/model 6、搜索 4、导入导出 4、HTTP 4。测试只使用系统临时目录，不触碰 `runtime-data/`。

---

## 与 Alien 的边界

Mech 只写 `apps/knowledge-room/**`。Mech 不修改、不补充、不等待 Alien 的 Web、Android、Gateway、Runtime Node、协议契约、CI 与 V0 验收材料。拼接方式：

```text
Alien final tree
+
apps/knowledge-room/**
=
combined Utopia tree
```

合入后，Knowledge Room 仍可仅凭 `Start-Knowledge-Room.cmd` 独立启动使用。

---

## 文档

- 中文：[docs/zh-CN/README.md](docs/zh-CN/README.md) · [docs/zh-CN/ACCEPTANCE_K0.md](docs/zh-CN/ACCEPTANCE_K0.md) · [docs/zh-CN/POST_K0_BACKLOG.md](docs/zh-CN/POST_K0_BACKLOG.md)
- English: [docs/en/README.md](docs/en/README.md) · [docs/en/ACCEPTANCE_K0.md](docs/en/ACCEPTANCE_K0.md) · [docs/en/POST_K0_BACKLOG.md](docs/en/POST_K0_BACKLOG.md)
