# Room Pack 晋升历史（PROMOTION HISTORY）

本文件记录每个 donor 房间从孵化到迁入 `city/` 的完整过程。机器可读记录在 `../promotions/<room-id>.json`，完整代码留档在 Git 历史中。

**两条 SHAs 的定义固定如下，不得相互混淆：**

```text
acceptedRoomCommit = 孵化房间最后一个已验收 commit
promotedAtCommit   = 第一个正式 city module 已落位的 commit（可达、可在 <sha>:<path> 上检出）
```

两者都必须真实存在于 Git 历史中，并满足 `acceptedRoomCommit` 是 `promotedAtCommit` 的祖先。校验脚本：`node scripts/verify-promotion-history.mjs`。

## 总览

| Room | acceptedRoomCommit | promotedAtCommit | 目标城市路径 |
| --- | --- | --- | --- |
| `skill-intake-lab` (D1) | `1ba5b4809f05a155ed76fecdbb9479f900686fa1` | `140287250ef1440441df4eaf0dfefc14528eeee4` | `city/02-engineering/02-worker-gateway/skill-intake` |
| `theme-engine-lab` (D2) | `9819ed7a4a212b8c8480d91c3812ce7f7a760ab9` | `a18b1e80b7405137ac3c56ef1bc1805677b6a93f` | `city/11-entertainment/01-entertainment-centre/theme-engine` |
| `knowledge-core-lab` (D3) | `01f932bd2aad2403bec61961410ca19ca0cf28ad` | `b82fcfd0f153a63b8424051affd86bf7df0a41d0` | `city/09-planning-knowledge/01-knowledge-service/knowledge-core` |
| `document-intake-lab` (D4) | `165e2664ad4e2d777889d8dec47893144e8c81dd` | `e3d6bbd9dd9196ce0991e095fb91993df3ec3dd1` | `city/09-planning-knowledge/02-document-intake/ingestion-core` |
| `skill-discovery-lab` (D5) | `b4dff81503128ae0d2ad163732171eb6dd887f4b` | `48494263d75532eaaba3490bc6c4223d5ff44ead` | `city/02-engineering/02-worker-gateway/skill-intake` |
| `theme-package-lab` (D6) | `95d958ddacc6071fc6c2b0ee4c2be8b132c9dd4d` | `5d1abecdc38ace5f5cf02aafbf097026d3427eec` | `city/11-entertainment/01-entertainment-centre/theme-engine` |

> **D1 说明：** 最初写入 `city/02-engineering/02-worker-gateway/skill-intake` 的那次提交在 Wave 1 期间的一次历史整理中被改写，已不可达；本记录因此指向当前历史中**第一个包含该 module 且可达**的提交 `1402872`。Wave 1 曾预填的旧值（形如 `6b29e84…`）是提交 amend 之前的 SHA，已作废。
>
> **禁止预猜当前 commit 自己的 SHA**：记录只能在目标提交已经存在之后回填，并由 `scripts/verify-promotion-history.mjs` 用本地 Git 历史核验。

---

## D6 · theme-package-lab → city/11-entertainment/01-entertainment-centre/theme-engine

| 项 | 值 |
| --- | --- |
| Donor 仓库 | `zhiheng-zhang-Mera/DS-Hns` |
| Donor SHA | `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b` |
| Donor 源文件 | `app/extensions/mega/theme/contract.js`、`surface.js`、`validator.js`、`asset-factory.js` |
| 孵化房间 | `apps/rooms/rooms/theme-package-lab/`（已从活跃树移除） |
| 孵化验收 commit | `95d958ddacc6071fc6c2b0ee4c2be8b132c9dd4d` |
| 晋升 commit | `5d1abecdc38ace5f5cf02aafbf097026d3427eec` |
| 最终城市路径 | `city/11-entertainment/01-entertainment-centre/theme-engine` |
| Lifecycle | `PROMOTED`（Wave 2 期间） |
| 共用 module | 是：D2 已把颜色与栅格内核晋升到同一 module，因此它现在记录 `incubationRooms: ["theme-engine-lab", "theme-package-lab"]` |
| D6a 范围 | Theme Package API 版本、带权限的 slot 词表、token schema、worker 状态词表、四个所有权 surface 与唯一的写入门、包校验器、确定性过程化资产生成器 |
| D6b 状态 | `DEFERRED_SCOPE_ALLOCATION` |

### 适配说明

- CommonJS → ESM，算法不变；
- donor 的永久产品名词不进入 Utopia 公共 API：`hns_native` → `owned_surface`，`official_shell` → `external_shell`，`official_overlay` → `owned_overlay`，`official_renderer` → `protected_external_surface`；slot 家族 `hns.*` / `official.*` → `surface.*` / `shell.*` / `overlay.*` / `external.*`；CSS 自定义属性 `--hns-*` → `--utopia-*`；
- 校验器新增 `validateDocuments()`：同一套检查既能跑内存文档，也能跑落盘 package 目录，只保留一份实现。孵化房间因此**不需要写文件**也能成为真实产品面；
- overlay 强度上限并入校验器：package 声明的 overlay plan 直接按工程上限校验，而不再只依赖 builder 自己的降级阶梯；
- 颜色与栅格辅助函数继续留在已晋升的 `color/` 与 `raster/`，不复制任何算法。

### 已知差异

- 不向任何 UI 应用主题：本 module 只产出并校验 package；
- 不带 registry / lifecycle / recovery：donor 的编排层不在范围内；
- 不带 builder 与 designer：D6b 闭包（`builder.js`、`designer.js` 以及 `assets/` 下的 planner、generator、processor、validator、fallback）不在本 wave；
- 不带图像模型：过程化生成是确定性且离线的。

### D6b 延后说明

决定之前已检查 D6b 的 donor 闭包，结论是它很干净：`builder.js`、`designer.js` 与五个 `assets/*` 只依赖 `node:fs`、`node:path` 和本 module 自己的文件，没有 Electron、没有外部运行时、没有 session 依赖、没有强制网络，且所有写入都限制在调用方提供的 `outDir`。因此它**不是**按 `DEFERRED_RUNTIME_COUPLING` 延后，而是按 `DEFERRED_SCOPE_ALLOCATION` 延后：本 wave 不可延后项（D7a YAML、D7b 文档读取器、D8 证据内核）先落地，且没有交付半成品 builder，所以这里不假装完成。闭包清单已记录在上，下一 wave 可直接从证据出发。

### 平价测试

覆盖：四个 surface 及其权限与输入/访问契约；写入门拒绝受保护 surface、并拒绝 surface 不接受的资产类型；plan 可以如实声明受保护 surface 但不得声称写入（含嵌套 target 引用）；slot 白名单（未知 slot、结构性 slot、未声明属性）；token schema（未知 token、非法颜色/长度/数字、空资产值）；manifest 必填字段、slug id、禁止的 parent/extends 字段、supported apps 与 API 版本兼容；仅声明式（package 内任何可执行文件都被拒绝）；资产封闭性（声明的资产必须存在于包内且不得越出包外）；可读性与 worker 状态可分性一律 fail closed；overlay 单层与叠加不透明度上限以及输入必须穿透；过程化确定性（同 palette/style/seed 字节一致，换 palette 或 style 即不同）；角色资产保留真实 alpha 而不是画一个矩形。

---

## D5 · skill-discovery-lab → city/02-engineering/02-worker-gateway/skill-intake

| 项 | 值 |
| --- | --- |
| Donor 仓库 | `zhiheng-zhang-Mera/DS-Hns` |
| Donor SHA | `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b` |
| Donor 源文件 | `app/extensions/mega/skills/skill-source.js`、`app/extensions/mega/skills/skill-catalog.js` |
| 孵化房间 | `apps/rooms/rooms/skill-discovery-lab/`（已从活跃树移除） |
| 孵化验收 commit | `b4dff81503128ae0d2ad163732171eb6dd887f4b` |
| 晋升 commit | `48494263d75532eaaba3490bc6c4223d5ff44ead` |
| 最终城市路径 | `city/02-engineering/02-worker-gateway/skill-intake` |
| Lifecycle | `PROMOTED`（Wave 2 期间） |
| 共用 module | 是：D1 已把 format 与 archive 内核晋升到同一 module，因此它现在记录 `incubationRooms: ["skill-intake-lab", "skill-discovery-lab"]` |

### 适配说明

- CommonJS → ESM，算法不变：引用解析器、候选顺序、archive URL 规划与分层扫描器行为与 donor 一致；
- 文件系统访问改为可注入的 read adapter（`isDirectory` / `isFile` / `list`），同一套扫描既能跑真实磁盘，也能在测试里跑内存树；
- SKILL.md 解析器使用本 module 自己的 `format.mjs`，不再存在第二份拷贝；
- GitHub 解析结果只是计划：`resolutionPlan()` 以数据形式返回 archive URL 形式、ref 拆分与 subpath，本 module 完全没有 fetch / request / 下载入口；
- catalog 的实时 GitHub 搜索通过可注入的 `fetchJson` 实现；未配置时回答 `unavailable`，策展与内置条目照常返回；
- `describeRef()` 从孵化房间的接线层移入 `source.mjs`，因为它只描述一个已解析的引用。

### 已知差异

- 不安装：本 module 只做校验、检查与发现，从不把技能写入磁盘；
- 不下载：`resolutionPlan()` 描述调用方**可以**发起的尝试，真正发起不在本 module 范围内；
- 不携带 donor 的 `skill-service.js`，因此这里没有安装、更新或删除技能的能力；
- `readEntries` 仍按 donor 行为把不安全路径从条目列表中过滤掉，而不是作为 refused 条目上报。

### 平价测试

覆盖：全部引用形式（owner/repo、`@ref`、subpath、`/tree/`、`/blob/`、raw 与普通 URL）、向上穿越拒绝与 subpath 规范化、最长 ref 优先的候选顺序、archive URL 顺序与去重、repository/tree/raw 三种解析计划、分层扫描顺序（subpath、自身 bundle、`skills/` 集合、同级 bundle、最后才是平铺文件）、脚手架目录永不作为技能提供、扫描器同时跑内存树与 fixtures、解析器拒绝无法解析的平铺文件、catalog 排序（命中 name 高于命中 summary；tags 为 AND 过滤），以及实时搜索失败或未配置时离线答案永不消失。

---

## D4 · document-intake-lab → city/09-planning-knowledge/02-document-intake/ingestion-core

| 项 | 值 |
| --- | --- |
| Donor 仓库 | `zhiheng-zhang-Mera/Codex-Boss` |
| Donor SHA | `8df428eaa437a409368401e95194e40266b83080` |
| Donor 源文件 | `electron/ingestion/xml-text.ts`、`electron/ingestion/text-parsers.ts` |
| 孵化房间 | `apps/rooms/rooms/document-intake-lab/`（已从活跃树移除） |
| 孵化验收 commit | `165e2664ad4e2d777889d8dec47893144e8c81dd` |
| 晋升 commit | `e3d6bbd9dd9196ce0991e095fb91993df3ec3dd1` |
| 最终城市路径 | `city/09-planning-knowledge/02-document-intake/ingestion-core` |
| Lifecycle | `PROMOTED`（Wave 1 期间） |
| D4a 范围 | UTF-8/UTF-16 解码、TXT/Markdown、JSON/JSON Lines、CSV/TSV、XML 文本、分节与输入上限 |
| D4b 延后 | YAML/yml：donor 的 YAML 分支依赖外部 `yaml` 包，必须先把该依赖隔离在本 Building 内（Wave 2 D7a 处理） |

### 适配说明

- TypeScript → ESM JavaScript，算法不变；
- donor 的 GBK 回退改为显式 warning：运行时 TextDecoder 不保证提供 GBK 码表，**不允许静默猜测**；
- 不携带 YAML 分支，`detectFormat()` 把 yaml/yml 明确标记为 deferred，而不是落到“未知格式”后乱解析；
- 解析守卫（`maxSections` / `maxBytes` / `maxContentLength` / `maxCsvRows`）与 donor 默认值一致，并可按请求覆盖；
- `docx-reader.ts` / `xlsx-reader.ts` / `pdf-reader.ts` 未触碰，属于同一 Building 的后续 wave。

### 已知差异

- 无持久化、不写入 Knowledge Room：模块是纯函数，孵化房间只在页面内处理文档；
- 无 OCR、无 PDF 文本抽取、无工作簿模型；
- 输出的是带 offset 的分节，不包含 donor 下游的身份/哈希/脱敏流水线。

### Parity 测试

覆盖：UTF-8/UTF-16 BOM 与严格 UTF-8 校验（含 lossy 警告）、markdown 分节（ATX/setext 标题、项目符号、编号、围栏代码、key/value）、纯文本中文编号标题、JSON 解析与 JSON Lines 识别、空与损坏输入拒绝、YAML 延后提示、结构化展开与确定性渲染、CSV 引号/转义/内嵌换行/CRLF/行数上限/未闭合引号警告、分隔符检测、按首列分组与列数上限、XML 实体（命名/十进制/十六进制/非法保留/只解一次）、XML 文本串抽取与块匹配、解析守卫触发 TOO_LARGE。

---

## D3 · knowledge-core-lab → city/09-planning-knowledge/01-knowledge-service/knowledge-core

| 项 | 值 |
| --- | --- |
| Donor 仓库 | `zhiheng-zhang-Mera/Codex-Boss` |
| Donor SHA | `8df428eaa437a409368401e95194e40266b83080` |
| Donor 源文件 | `src/shared/knowledge.ts` |
| 明确不复制 | `electron/knowledge/knowledge-store.ts`（依赖 Boss commander durable-json） |
| 孵化房间 | `apps/rooms/rooms/knowledge-core-lab/`（已从活跃树移除） |
| 孵化验收 commit | `01f932bd2aad2403bec61961410ca19ca0cf28ad` |
| 晋升 commit | `b82fcfd0f153a63b8424051affd86bf7df0a41d0` |
| 最终城市路径 | `city/09-planning-knowledge/01-knowledge-service/knowledge-core` |
| Lifecycle | `PROMOTED` |

### 城市模块结构

```text
knowledge-core/
├── index.mjs              公共出口
├── contracts/             值形态、必填/可选字段、查询字段
├── retrieval/knowledge-core.mjs   匹配、预算检索、goal rerank、planRetrieval
├── taxonomy/              分类派生与确定性 domain 路由
├── trust/                 信任序与信任下限
├── conflict/              supersedes / conflict 元数据
├── tests/                 城市模块 focused 测试（含 parity）
└── DONOR.json             来源与适配记录
```

### 适配说明

- TypeScript → ESM JavaScript，算法不变（信任排序、全标签匹配、有效期窗口、字符预算、分词权重）；
- 新增 `conflictReport()` 与 `planRetrieval()`；
- `entryMatches()` 支持显式 `now`，便于确定性测试；
- 完全不复制 `knowledge-store.ts`，因此模块无存储、无 durable-json 依赖、不需要 Boss runtime；
- 拆成 contracts / retrieval / taxonomy / trust / conflict 五个 facade，共用同一份 core 实现，避免重复算法。

### 已知差异

- 无持久化：模块是纯函数，孵化房间只在页面内保存目录；
- 无 embedding、无向量库、无 LLM 摘要；
- domain route / rerank 仅使用确定性分词（donor 同样没有 embedding）。

### Parity 测试

覆盖：信任序与未知信任计 0、domain/shelf/全标签过滤、trustAtLeast、过期与未生效排除、字符预算截断与更大预算行为、信任序 + 最近更新破平、分类派生、确定性 domain 路由（域名匹配 + 最多 3 个共享标签，不匹配则不猜）、相关度权重（title 3x / tags 2x / domain 2x / content 1x）与 rerank 顺序、supersedes/conflict 元数据（含悬空指针）。

---

## D2 · theme-engine-lab → city/11-entertainment/01-entertainment-centre/theme-engine

| 项 | 值 |
| --- | --- |
| Donor 仓库 | `zhiheng-zhang-Mera/DS-Hns` |
| Donor SHA | `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b` |
| Donor 源文件 | `app/extensions/mega/theme/color.js`、`app/extensions/mega/theme/png.js` |
| 孵化房间 | `apps/rooms/rooms/theme-engine-lab/`（已从活跃树移除） |
| 孵化验收 commit | `9819ed7a4a212b8c8480d91c3812ce7f7a760ab9` |
| 晋升 commit | `a18b1e80b7405137ac3c56ef1bc1805677b6a93f` |
| 最终城市路径 | `city/11-entertainment/01-entertainment-centre/theme-engine` |
| Lifecycle | `PROMOTED`（Wave 1 期间） |

### 移植范围

| Donor 文件 | 城市模块文件 |
| --- | --- |
| `app/extensions/mega/theme/color.js` | `color/color.mjs` |
| `app/extensions/mega/theme/png.js` | `raster/png.mjs` |

### 适配说明

- CommonJS → ESM（具名导出）；
- 新增 `readability()` 与 WCAG 阈值常量，把对比度判定收在一处；
- 新增 `ramp()`：确定性明度阶梯从房间处理器搬进城市内核；
- 新增 `buildSwatch()`：在 donor 的 canvas 辅助之上提供确定性调色板出图；
- 只复制 `color.js` 与 `png.js`：donor theme 目录里的 contract / builder / asset-factory / designer / orchestrator 属于 Wave 2（D6）。

### 已知差异

- 没有 theme contract、validator、builder、asset factory、preview（Wave 2 D6 处理）；
- 不作用于 Alien Web UI，只产出颜色与图像；
- 不包含 theme registry / lifecycle / recovery 等编排层。

### Parity 测试

覆盖：hex / rgb() / rgba() / 百分比语法与拒绝分支、通道 clamp、hex 往返、alpha 合成、HSL 往返、WCAG 对比度（21:1 极值）与 readability 等级、shade / mix / distance / isLight / bestOn、PNG 编码→独立解码往返（RGB 与 RGBA）、PNG 头读取与非 PNG 拒绝、swatch 确定性、列布局与 alpha 保留。

---

## D1 · skill-intake-lab → city/02-engineering/02-worker-gateway/skill-intake

| 项 | 值 |
| --- | --- |
| Donor 仓库 | `zhiheng-zhang-Mera/DS-Hns` |
| Donor SHA | `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b` |
| Donor 源文件 | `app/extensions/mega/skills/skill-format.js`、`app/extensions/mega/skills/tar.js` |
| 孵化房间 | `apps/rooms/rooms/skill-intake-lab/`（已从活跃树移除） |
| 孵化验收 commit | `1ba5b4809f05a155ed76fecdbb9479f900686fa1` |
| 晋升 commit | `140287250ef1440441df4eaf0dfefc14528eeee4` |
| 最终城市路径 | `city/02-engineering/02-worker-gateway/skill-intake` |
| Lifecycle | Wave 1 曾为 `ACTIVE`；Wave 1 closeout（R3）改为 `PROMOTED`，直到出现真实的 City runtime consumer |

### 移植范围

| Donor 文件 | 城市模块文件 |
| --- | --- |
| `app/extensions/mega/skills/skill-format.js` | `format.mjs` |
| `app/extensions/mega/skills/tar.js` | `archive.mjs` |

### 适配说明

- CommonJS → ESM（具名导出）；
- 去掉 `readSkillFile` / `scanSkillRoot` / `resolveInstalled`：城市内核不访问磁盘，也不依赖 HNS 安装目录；
- 不移植 `extractTar`：本模块只在内存中检查归档，不写文件，因此不存在可写错的解压路径；
- `readSkillFile` 的大小上限并入 `parseSkillText`，粘贴进来的文档受同一条 `MAX_SKILL_BYTES` 约束；
- 归档检查输出 accepted / refused 条目列表，而不是“已写入文件”列表。

### 已知差异

- 本轮不安装 skill，只做校验与检查；
- `readEntries` 会直接把不安全路径过滤掉（donor 行为），不会作为 refused 条目上报；
- 不包含 GitHub 下载与来源解析（Wave 2 D5 处理）。

### Parity 测试

测试向量复制自 donor 测试套件 `tests/unit/skills-service.test.js`，覆盖：名称语法、frontmatter 子集（whenToUse / metadata / invocation 布尔全部写法）、畸形 frontmatter 拒绝理由、`renderSkillDocument` 往返、tar 列举与 `stripComponents`、路径穿越与绝对路径拒绝、symlink/hardlink/device 拒绝、字节与条目上限、gzip 透明解压、损坏校验和拒绝。

### 晋升后处理

```text
apps/rooms/rooms/skill-intake-lab/     已删除（保留 Git 历史）
apps/rooms/tests/skill-intake.test.mjs 已删除（parity 测试随内核进入城市模块）
apps/rooms/promotions/skill-intake-lab.json  保留
city/.../skill-intake/tests/           城市模块自带 focused 测试
```
