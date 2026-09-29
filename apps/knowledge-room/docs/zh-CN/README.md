# UTOPIA · 本地知识室（Knowledge Room）

**任务编号：** `MECH-K0-KNOWLEDGE-ROOM`
**状态：** `MECH_KNOWLEDGE_ROOM_READY_TO_ATTACH`
**归属目录：** `apps/knowledge-room/**`（单机 / 本地 / 零 Alien 依赖）

本地知识室是 Utopia `Planning & Knowledge` 区的第一块真实产品功能区：一个只在本机 `127.0.0.1` 上运行的纯文本知识库。它不依赖 Utopia Gateway、不依赖 Runtime Node、不依赖 Android、不依赖第二台主机、不依赖任何云服务。

---

## 功能范围

| 功能 | 说明 |
| --- | --- |
| 新建 / 编辑 | 标题、正文、标签；保存后立即持久化 |
| 浏览 | 列表按 `updatedAt` 倒序，展示标题、标签、更新时间和正文摘要 |
| 搜索 | 标题 / 正文子串匹配，标签匹配，大小写统一 |
| 标签筛选 | 精确匹配（大小写与空白归一化），可多选 |
| 删除 | 删除前确认一次；V0 为永久删除 |
| 导出 | 完整 JSON bundle（`format` / `schemaVersion` / `exportedAt` / `entries`） |
| 导入 | `IMPORT_MODE = replace`，整包替换当前数据 |

---

## 启动方式

```cmd
apps\knowledge-room\Start-Knowledge-Room.cmd
```

等价的直接启动方式：

```cmd
cd apps\knowledge-room
node src\server.mjs
```

浏览器打开 `http://127.0.0.1:4317/`。

可选环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `KNOWLEDGE_ROOM_PORT` | `4317` | 本地端口 |
| `KNOWLEDGE_ROOM_DATA_DIR` | `apps/knowledge-room/runtime-data` | 数据目录 |

绑定地址固定为 `127.0.0.1`。

---

## 数据与存储

条目结构：

```json
{
  "id": "uuid",
  "title": "标题",
  "body": "纯文本或类 Markdown 源文本",
  "tags": ["research", "utopia"],
  "createdAt": "ISO-8601",
  "updatedAt": "ISO-8601"
}
```

数据文件：`apps/knowledge-room/runtime-data/knowledge-v0.json`，根对象为 `{ "schemaVersion": 0, "entries": [...] }`。

保存时先写同目录临时文件再 `rename` 覆盖，写入串行化；只读写自己的数据目录；`runtime-data/*.json` 不入 Git。

---

## 测试

```cmd
cd apps\knowledge-room
node --test tests/*.test.mjs
```

18 个测试：store/model 6 个、搜索 4 个、导入导出 4 个、HTTP 4 个。

---

## 归档文档

- [ACCEPTANCE_K0.md](ACCEPTANCE_K0.md)：K1–K7 真实验收记录
- [POST_K0_BACKLOG.md](POST_K0_BACKLOG.md)：后续增强与已知技术债

英文对应文档：[../en/README.md](../en/README.md)。仓库根目录的 `apps/knowledge-room/README.md` 为中英双语合一版本。
