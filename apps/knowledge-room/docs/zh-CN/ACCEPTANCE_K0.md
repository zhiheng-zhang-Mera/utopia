# MECH-K0 验收记录（Knowledge Room）

**任务：** `MECH-K0-KNOWLEDGE-ROOM`
**主机：** Mech / 一号主机（单机完成）
**仓库基线：** `main` @ `3e0bfb09b94b2d58c36948feb5e2f4b60676e4a9`
**施工分支：** `mech/knowledge-room-k0`
**验收范围：** `apps/knowledge-room/**`
**运行版本：** Node.js `v24.14.0`（Windows）
**启动方式：** `apps\knowledge-room\Start-Knowledge-Room.cmd`（等价于 `node src\server.mjs`）
**绑定地址：** `127.0.0.1:4318`（验收使用 `KNOWLEDGE_ROOM_PORT=4318`；产品默认 `4317`）

本文件只记录**真实执行过**的验收，不把样例运行写成验收。

---

## 1. 结论

```text
MECH_KNOWLEDGE_ROOM_READY_TO_ATTACH
```

Gate K1–K7 全部通过。changed files outside `apps/knowledge-room/**` = 0。

---

## 2. 自动化测试（真实运行）

```cmd
cd apps\knowledge-room
node --test tests/*.test.mjs
```

```text
tests 18 | pass 18 | fail 0
```

| 文件 | 数量 | 覆盖 |
| --- | --- | --- |
| `tests/store.test.mjs` | 6 | 创建/校验、schemaVersion 与重载、更新、删除、三建一改一删后重启、损坏文件必须报错 |
| `tests/search.test.mjs` | 4 | 标题命中、仅正文命中、标签精确归一化匹配、搜索与标签组合 |
| `tests/import-export.test.mjs` | 4 | bundle 结构与 SHA-256、非法 payload 拒绝、导出→清空→导入全字段还原、导入为替换而非合并 |
| `tests/http.test.mjs` | 4 | `/health` 与 loopback 绑定、HTTP CRUD 与 404/400、搜索与静态 UI（含目录穿越防护）、导出导入 round-trip |

测试使用系统临时目录，不读写 `runtime-data/`。

---

## 3. 浏览器验收（真实产品 UI，headless Chrome over CDP）

驱动方式：真实启动 `src/server.mjs`，用 headless Chrome 打开产品页面，通过真实 DOM 交互（点击、输入、提交、确认框）完成，断言全部取自运行中的 DOM。共两轮：

**第 1 轮（21 项全通过）**

| 检查 | 结果 |
| --- | --- |
| 产品页面加载，`document.title` = `Utopia · Knowledge Room` | PASS |
| UI 显示 `local · ready`（后端可达） | PASS |
| 空库显示 empty state | PASS |
| 通过 UI 新建 3 条知识，每条显示 `saved` | PASS |
| 列表显示 3 条，标签筛选器由真实数据生成（5 个标签） | PASS |
| 通过 UI 编辑正文与标签，列表立即反映 | PASS |
| 搜索 `gateway` 收敛为 1 条并显示 match 状态 | PASS |
| 无结果搜索时 UI 正常（`No entry matches…`） | PASS |
| 标签筛选选中对应集合，清除后恢复 3 条 | PASS |
| 删除前出现确认框（`Delete "…"? This cannot be undone.`） | PASS |
| 删除后列表与计数变为 2 | PASS |
| 导出得到完整 bundle（format / schemaVersion / 2 entries） | PASS |
| 导出按钮在 UI 报告 sha256 | PASS |
| 420px 窄窗口两栏仍可用且无横向溢出 | PASS |
| 页面重载后保留 2 条数据 | PASS |

**第 2 轮（导入替换，5 项全通过）**

| 检查 | 结果 |
| --- | --- |
| 以真实导出 bundle 为样本（2 条） | PASS |
| 清空后产品显示 fresh empty state | PASS |
| 通过真实文件选择控件导入 bundle，UI 报告 `imported 2 entr(ies) · current data replaced` | PASS |
| 导入后每条的 id / title / body / tags / createdAt / updatedAt 与导出前完全一致 | PASS |

---

## 4. Gate 结果

### Gate K1 — Independent Start ✅

- 未运行 Gateway、Reference Node、Android、Boss、Hns 中任何一项；
- `GET /health` → `200`，`{"status":"ok","product":"utopia-knowledge-room","host":"127.0.0.1","schemaVersion":0}`；
- 浏览器可加载产品页面；
- 绑定地址为 loopback。

### Gate K2 — CRUD ✅

通过产品 UI 新建 3 条、编辑 1 条、删除 1 条；HTTP 层另有独立 CRUD 测试（含 400 / 404 分支）。

### Gate K3 — Durability ✅

删除并关闭 Knowledge Room 进程（确认端口不再响应）后，用新进程重启：

```text
两个幸存条目的 id / title / body / tags 全部保留
被删除的条目保持删除
重启后仍可读到 `schemaVersion = 0`
```

### Gate K4 — Search ✅

对真实数据完成三类查询：

```text
q=utopia        → 标题命中 1 条
q=gateway       → 仅正文命中 1 条（标题不含该词）
tag=SEARCH      → 标签命中 1 条（大小写归一化后精确匹配）
tag=sear        → 0 条（标签不是子串匹配）
q=zzzz-nothing  → 0 条
```

### Gate K5 — Export / Import ✅

```text
export（2 条真实数据，记录 SHA-256 43e43f8c5a81949f6594e8a0721a09fad66d8cb04aa1b12561d636ee0beee303）
→ 清空为 fresh/empty 数据状态
→ 非法 payload（format 不匹配）被拒绝且现有数据不变
→ import bundle
→ 条目 id / title / body / tags / createdAt / updatedAt 全部还原
→ 再次 export，语义内容一致
```

两次导出的原始字节不同，仅因为 `exportedAt` 重新生成（`43e43f8c…` vs `f5a7ec25…`），符合验收要求。

### Gate K6 — Isolation ✅

```text
git status --porcelain 中，apps/knowledge-room/** 之外的改动 = 0
```

未触碰 `apps/web/**`、`apps/android/**`、`services/dev-gateway/**`、`agents/reference-node/**`、`contracts/city-control-v0/**`、`platform/**`、`tests/**`、`evidence/**`、`data-records/**`、`scripts/**`、`.github/**`、根 `package.json` / `pnpm-lock.yaml`。

### Gate K7 — No Hidden Alien Dependency ✅

K1–K5 全部在上述服务关闭、Android 缺席、无第二台主机的条件下完成。Knowledge Room 只读写自身 `runtime-data/`。

---

## 5. 验收过程中发现并修复的真实问题

1. **标签筛选只改状态不生效**：点击标签后 chip 变高亮，但列表仍显示全部条目。原因是列表渲染依赖上一次 `refresh()` 留下的 `state.visible`，标签点击后没有重新计算。已改为在渲染时统一由 `visibleEntries()` 依据当前 `activeTags` 推导列表。浏览器验收复测通过。
2. **保存成功的反馈被刷新清空**：`saved` 提示在 `refresh()` / `openEditor()` 之前写入，随后被清空，用户看不到保存反馈。已调整顺序，使 `saved` 在编辑器重绘之后写入。浏览器验收复测通过。
3. **首尾空白未完全归一化**：`normalizeText` 只裁剪尾部空白，标题前导空格会留存。已改为整体 `trim()`。

---

## 6. 已知限制

- V0 只处理纯文本，无附件、图片、OCR、向量检索；
- 导入策略固定为 replace，无 merge 与冲突解决；
- 无账号、无协作、无云同步、无通知；
- 单进程单用户假定：数据文件不提供跨进程并发写保护；
- UI 为暗色单主题，无主题系统、无动画系统；
- 未接入 Utopia 主导航（属于后续极小 integration commit，不属于 MECH-K0 完成条件）。

后续增强记录在 [POST_K0_BACKLOG.md](POST_K0_BACKLOG.md)，不升格为当前 blocker。
