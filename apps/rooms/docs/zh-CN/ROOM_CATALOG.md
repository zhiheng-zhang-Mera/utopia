# Room Pack V1 · 房间目录

本文件逐个说明 10 个房间的用户价值、数据形态、本地接口与验收点。构造顺序与 Hub 导航顺序一致。

---

## Hub（R0）

**职责（全部）**：`listen 127.0.0.1`、提供房间静态资源、本地导航、最薄本地存储、导出下载、基础本地路由、health 页面。

**禁止职责**：City Control 路由、Gateway 代理、Node 发现、任务调度、认证框架、权限引擎、多用户、LAN 暴露、远程/云同步、Boss/Hns 桥接。

**入口文件**：`hub/server.mjs`、`hub/manifest.mjs`、`hub/registry.mjs`、`hub/public/*`。

**验收**：Hub 独立启动；浏览器可用；`/health` 返回 10 个房间；绑定地址为 loopback。

---

## 01 Knowledge Room（持久：`knowledge.json`）

- **用户价值**：本地纯文本知识条目。
- **数据**：`{ id, title, body, tags[], createdAt, updatedAt }`。
- **接口**：`GET/POST /entries`、`GET/PATCH/DELETE /entries/:id`、`GET /export`、`POST /import`。
- **验收**：创建 3 条 → 改 1 条 → 删 1 条 → 重启后剩余内容完整保留；标题/正文/标签三类搜索正确；export → 空库 → import 后条目 id/title/body/tags 全一致。
- **不做**：embedding、语义搜索、LLM、PDF/OCR、知识图谱。

---

## 02 Bookmark Room（持久：`bookmarks.json`）

- **用户价值**：本地网址与资料入口。
- **数据**：`{ id, title, url, tags[], note, createdAt, updatedAt }`。
- **接口**：`GET/POST /bookmarks`、`PATCH/DELETE /bookmarks/:id`、`GET /export`、`POST /import`。
- **安全边界**：只接受绝对 `http(s)` URL；服务端不抓取、不爬取、不预览、不下载远程内容；链接只在用户显式点击后由浏览器新窗口打开。
- **验收**：创建多个真实 URL、标签筛选、搜索、重启、导出恢复。

---

## 03 Checklist Room（持久：`checklist.json`）

- **用户价值**：清单与勾选。
- **数据**：`{ id, title, note, items[{ id, text, done, note, dueDate }], createdAt, updatedAt }`，接口返回 `progress`。
- **模型约束**：内部只用 `Checklist` / `ChecklistItem`，**不复用** City Control 的 `Task`、`QUEUED`、`RUNNING`、`COMPLETED` 语义（测试会校验实现代码中不出现这些词）。
- **接口**：清单 CRUD、`POST /checklists/:id/items`、`PATCH/DELETE /checklists/:id/items/:itemId`、`POST /checklists/:id/items/:itemId/move`、`POST /checklists/:id/clear-completed`。
- **验收**：新增条目、勾选、上下移动（首项上移为无操作而非报错）、删除、清除已完成，重启后状态保留。
- **不做**：运行时分配、节点分配、自动化、通知。

---

## 04 Prompt Library（持久：`prompts.json`）

- **用户价值**：管理可复用 prompt 模板，本轮**不连接任何 AI**。
- **数据**：`{ id, title, template, tags[], note, values{}, createdAt, updatedAt }`；`variables` 由 `{{name}}` 实时推导。
- **接口**：`GET/POST /prompts`、`PATCH/DELETE /prompts/:id`、`POST /prompts/:id/render`、`GET /export`、`POST /import`。
- **渲染规则**：已知变量被替换；未填变量保留 `{{name}}` 原样返回并列入 `missing`，便于用户看到还缺什么。
- **验收**：识别变量、填写并渲染、复制最终 prompt、保存的变量值在重启后仍作为默认值。
- **不做**：任何模型 API、模型路由、会话历史。

---

## 05 Text Workshop（无持久化）

- **工具**：字符数（含/不含空白）、词数、行数、trim、空白归一、去空行、行排序（可降序）、行去重（可忽略大小写）、大写/小写/词首大写、行 diff（LCS）。
- **接口**：`GET /operations`、`POST /analyze`、`POST /transform`、`POST /diff`。
- **验收**：对固定输入验证每个变换结果；对固定两段文本验证 added/removed/same 行数与顺序；确认不产生任何运行文件。

---

## 06 Hash Room（无持久化）

- **用户价值**：快速核对本地文件指纹。
- **接口**：`POST /digest`（字符串参考实现）、`POST /verify`（期望值比对）。
- **隐私**：文件在页面内用 Web Crypto 计算 SHA-256；服务端只提供参考实现；文件内容不上传、不写盘、不复制到 runtime。
- **验收**：固定文件在 UI 得到的 SHA-256 与独立 Web Crypto / Node crypto 结果一致；期望值给出 MATCH / MISMATCH；非法期望值给出明确错误。

---

## 07 Data Lab（无持久化）

- **JSON**：`POST /json/parse`、`POST /json/transform`（pretty / minify / validate）。
- **错误报告**：非法 JSON 返回 message、position、line、column；新版 V8 不再给出 position 时，room 会定位违规片段并推算出位置。
- **CSV**：`POST /csv/preview`，RFC4180 风格最小解析（引号、转义引号、字段内换行、CRLF），返回列名、行数、预览行与截断标记。
- **验收**：美化/压缩输出确定；非法 JSON 给出位置；带引号逗号的 CSV 正确解析；确认不产生运行文件。
- **不做**：Excel、数据库、SQL、大文件流式处理、schema registry。

---

## 08 Focus Room（持久：`focus.json`）

- **用户价值**：本地专注计时与真实会话记录。
- **数据**：`{ sessions[{ id, label, note, plannedMinutes, elapsedSeconds, startedAt, completedAt, interrupted }], active }`。
- **接口**：`GET /state`、`POST /sessions/start`、`POST /sessions/complete`、`POST /sessions/abandon`、`DELETE /sessions/:id`、`GET /export`。
- **刷新语义**：运行中的会话在开始时即写入 `active`；页面重新加载时若服务端仍有 `active`，会话被标记为 interrupted，只记录真实已过时间。
- **验收**：短倒计时真实结束并进入历史；暂停后计时确实停止；刷新后按设计终止并记录 interrupted；今日分钟数正确。
- **不做**：系统通知、后台守护进程、移动端同步、日历集成。

---

## 09 Calendar Room（持久：`calendar.json`）

- **用户价值**：本地日程记录，不发提醒、不连接系统日历。
- **数据**：`{ id, title, date(YYYY-MM-DD), startTime(HH:MM|null), endTime, label, note, createdAt, updatedAt }`。
- **接口**：`GET /events?scope=today|upcoming|all&q=`、`POST /events`、`PATCH/DELETE /events/:id`、`GET /export`、`POST /import`。
- **验收**：跨当天与未来日期的排序与分组、编辑与删除、重启后保留；非法日期/时间与 endTime < startTime 被拒绝。
- **不做**：Google Calendar、Outlook、通知、重复规则引擎、时区同步、会议邀请。

---

## 10 Decision Room（持久：`decisions.json`）

- **用户价值**：记录决策问题、候选、选择与理由，而不是 Todo。
- **数据**：`{ id, question, context, options[{ id, text }], selectedOptionId, decision, rationale, status, tags[], createdAt, updatedAt, decidedAt }`。
- **状态**：只允许 `OPEN` / `DECIDED` / `REVISIT`。
- **接口**：`GET/POST /decisions`、`PATCH/DELETE /decisions/:id`、`POST /decisions/:id/options`、`POST /decisions/:id/decide`、`POST /decisions/:id/revisit`、`GET /export`、`POST /import`。
- **验收**：新建为 OPEN；填写选项并选定后进入 DECIDED 且记录理由与 `decidedAt`；重新打开变为 REVISIT；编辑时选项 id 保持稳定；搜索与状态筛选正确；重启后保留。
- **不做**：投票、多用户、审批流、策略引擎。
