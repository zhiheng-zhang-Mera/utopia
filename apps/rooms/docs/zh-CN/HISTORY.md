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
| `yaml-intake-lab` (D7a) | `b6d7733c927288c8c1246d097d509cc9caeb5fa4` | `e068d58ee890f17e1b87efb9f5d5af461d2a784b` | `city/09-planning-knowledge/02-document-intake/ingestion-core` |
| `document-readers-lab` (D7b) | `e9a4c2370544028749c5cd0c2d492389ee53d7b5` | `6a95bf4502f1e07a8036e319146e608f2a8db943` | `city/09-planning-knowledge/02-document-intake/document-readers` |
| `evidence-engine-lab` (D8) | `ec4202f774a996a1c1a7f867fac9f529abd43b00` | `e1dcfd73e9b35b44ad15112c2fc66aad41b1e099` | `city/06-research/01-research-institute/evidence-engine` |

> **D1 说明：** 最初写入 `city/02-engineering/02-worker-gateway/skill-intake` 的那次提交在 Wave 1 期间的一次历史整理中被改写，已不可达；本记录因此指向当前历史中**第一个包含该 module 且可达**的提交 `1402872`。Wave 1 曾预填的旧值（形如 `6b29e84…`）是提交 amend 之前的 SHA，已作废。
>
> **禁止预猜当前 commit 自己的 SHA**：记录只能在目标提交已经存在之后回填，并由 `scripts/verify-promotion-history.mjs` 用本地 Git 历史核验。

---

## D8 · evidence-engine-lab → city/06-research/01-research-institute/evidence-engine

| 项 | 值 |
| --- | --- |
| Donor 仓库 | `zhiheng-zhang-Mera/Codex-Boss` |
| Donor SHA | `8df428eaa437a409368401e95194e40266b83080` |
| Donor 源文件 | `electron/evidence-engine.ts`（参考类型：`src/shared/contracts.ts`、`src/shared/provider-contracts.ts`，仅作参考） |
| 孵化房间 | `apps/rooms/rooms/evidence-engine-lab/`（已从活跃树移除） |
| 孵化验收 commit | `ec4202f774a996a1c1a7f867fac9f529abd43b00` |
| 晋升 commit | `e1dcfd73e9b35b44ad15112c2fc66aad41b1e099` |
| 最终城市路径 | `city/06-research/01-research-institute/evidence-engine` |
| Lifecycle | `PROMOTED`（Wave 2 期间） |
| 新 district | 是：`06-research` 是本项目第一个研究产权，由本次晋升开启 |

### 适配说明

- donor 的运行时类型（`BossTask`、`ClaimRecord`、`CouncilSession`、`DisputeRecord`、`EvidenceBundle`、`RawArtifact`）被 `contracts.mjs` 中的普通值形状（EvidenceTask、EvidenceArtifact、EvidenceClaim、EvidenceDispute、EvidenceBundle）取代，因此得出判定不需要 task 运行时、provider 自动化、council 流程或 root trust；
- 所有非确定性输入都可注入（`idFactory`、`now`、`hash`），因此同一批 artifact 永远产出同一份 manifest、同一个 integrityRoot 与同一份 bundle；
- 已解决的争议不再把 claim 标为 DISPUTED：donor 根本没有"解决"概念，保留一个不产生任何效果的标志比两者都糟；未解决的争议仍然标记并仍然阻断 PASS；
- 新增 `reasons` 列表与 `describeBundle()`，让判定无需重新推导即可解释；
- `buildRehydrationPrompts()` 保留 donor 的 prompt 形状：它只生成文本，不联系任何人。

### 已知差异

- 不带 task 运行时、provider 自动化、council 运行时、research conductor 或 root trust（工作书要求）；
- 不持久化、不联网：本 module 是纯函数，孵化产品面只在页面内保存样本；
- 不对外部世界校验 claim：`REFERENCED_NOT_VERIFIED` 只表示声明的证据标签能解析，并不表示该 claim 为真。

### 平价测试

覆盖：对 UTF-8 内容计算 artifact SHA-256；capture 时的哈希不再匹配时抛 `ARTIFACT_HASH_MISMATCH` 而不是重新哈希；按 artifact id 排序的 manifest（含 provider、kind、hash、bytes、capture 时间）；integrityRoot 为排序后 `id:hash` 行的 SHA-256 且与输入顺序无关；其他 task 的 artifact 被排除；读取 `{"claims"` 结构化块，缺失或无法解析时不产生 claims；`Proposal A/B/C` 标签按 artifact id 顺序映射；四种 claim 状态中 DISPUTED 优先于已解析引用、缺标签即 INSUFFICIENT；无结构化块的 synthesis 成为一条 INSUFFICIENT claim；没有 synthesis 时 proposal/response 成为 UNVERIFIED claim 且绝不当作证据；PASS 规则（无缺失 provider、无未解决争议、无阻断性 claim）以及"任务完成不等于证据"；rehydration 只引用未解决的 claim；注入 id 与时钟后的确定性；以及本 module 不携带任何 Boss 运行时依赖。

---

## D7b · document-readers-lab → city/09-planning-knowledge/02-document-intake/document-readers

| 项 | 值 |
| --- | --- |
| Donor 仓库 | `zhiheng-zhang-Mera/Codex-Boss` |
| Donor SHA | `8df428eaa437a409368401e95194e40266b83080` |
| Donor 源文件 | `electron/ingestion/docx-reader.ts`、`xlsx-reader.ts`、`pdf-reader.ts`、`tests/fixtures/workbook-fixtures.ts` |
| 孵化房间 | `apps/rooms/rooms/document-readers-lab/`（已从活跃树移除） |
| 孵化验收 commit | `e9a4c2370544028749c5cd0c2d492389ee53d7b5` |
| 晋升 commit | `6a95bf4502f1e07a8036e319146e608f2a8db943` |
| 最终城市路径 | `city/09-planning-knowledge/02-document-intake/document-readers` |
| Lifecycle | `PROMOTED`（Wave 2 期间） |
| 新 module | 是：读取器成为同一 Building 内的独立 module，ingestion core 继续只负责文本与结构化接入 |
| 引擎 | fflate 0.8.3、mammoth 1.12.2、pdfjs-dist 6.3.289（legacy build），全部隔离在该 module 的 `engines.mjs` |

### 适配说明

- 三个引擎只在 `engines.mjs` 中被点名、按需延迟加载，所有消费者都经由这一个 seam；缺少安装上报为 `ENGINE_UNAVAILABLE`（安装问题），与"文档损坏"是不同的答案；
- XLSX：donor 的静态 fflate import 改为 `await loadFflate()`，因此 `readArchiveEntries` 变为异步；字节级守卫在引擎加载之前执行，明显错误的输入不依赖引擎可用性即可 fail closed；donor 的 `decodeUtf8` 映射到 ingestion core 的 `decodeText`，编码告警被转发而不是丢弃；
- DOCX：donor 的可注入 converter seam 原样保留，因此标题/列表映射与段落预算既能用真实引擎证明，也能不依赖引擎证明；
- PDF：seam 加载的是 legacy build（无 worker、无 DOM），donor 的 `getDocument` 选项一个都不需要删；
- donor 仅用于测试的 fixture 逻辑成为产品代码 `samples.mjs`：真实 OOXML 包与真实 PDF 都在内存中组装，因此测试与产品面都不需要提交二进制 fixture；
- 错误码按读取器加命名空间，调用方按 code 分支而不是解析 message。

### 已知差异

- 不持久化：读取器只接收字节、返回 sections，本 module 从不写文件；
- `ENCRYPTED_*` 码沿用 donor，但这里没有引擎路径会触发（fflate 0.8.x 忽略 ZIP 加密标志，且没有密码处理可被测）；
- 不做 OCR、不做页面渲染：PDF 只抽取文本；
- DOCX 适配器输出段落，而不是完整 OOXML 文档模型。

### 平价测试

覆盖：XLSX 共享字符串、sheet 名与 part、used range 与 markdown 表格输出；无缓存值的公式只告警、绝不被计算；archive 字节/条目/单条目/总解压/sheet/行/列上限一律 fail closed；DOCX 段落切分、标题层级（含中文标题）与列表映射、段落与字符预算、两个可注入 converter seam 与真实引擎；PDF %PDF 预检、逐页文本与文档信息、字节/页/字符上限，以及截断文档 fail closed；三者对相同字节的确定性；以及隔离本身（每个读取器只 import 引擎 seam、ingestion core 与 `node:` 内建）。

---

## D7a · yaml-intake-lab → city/09-planning-knowledge/02-document-intake/ingestion-core

| 项 | 值 |
| --- | --- |
| Donor 仓库 | `zhiheng-zhang-Mera/Codex-Boss` |
| Donor SHA | `8df428eaa437a409368401e95194e40266b83080` |
| Donor 源文件 | `electron/ingestion/text-parsers.ts`（`parseStructuredText` 的 YAML 分支） |
| 孵化房间 | `apps/rooms/rooms/yaml-intake-lab/`（已从活跃树移除） |
| 孵化验收 commit | `b6d7733c927288c8c1246d097d509cc9caeb5fa4` |
| 晋升 commit | `e068d58ee890f17e1b87efb9f5d5af461d2a784b` |
| 最终城市路径 | `city/09-planning-knowledge/02-document-intake/ingestion-core` |
| Lifecycle | `PROMOTED`（Wave 2 期间） |
| 共用 module | 是：D4 已把编码、分节、结构化与 XML 内核晋升到同一 module，因此它现在记录 `incubationRooms: ["document-intake-lab", "yaml-intake-lab"]` |
| City 依赖层 | `city/package.json` + `city/pnpm-lock.yaml`（yaml 2.9.0、fflate 0.8.3、mammoth 1.12.2、pdfjs-dist 6.3.289），由 Hosted job 在 city 测试前安装 |

### 适配说明

- donor 的顺序被**补齐**而不是重新解释：`.yaml`/`.yml` 一律先且只按 YAML 解析；其他扩展名依次尝试 JSON、JSON Lines，最后才是 YAML，并且回退会被明确上报（`JSON parsing failed (...); parsed as YAML`）；
- 外部 `yaml` 包被隔离在本 Building 的单个文件（`yaml-parser.mjs`）：它延迟加载该包，执行 donor 的 `maxAliasCount: 100` 以及 4 MiB 文档上限，并把 `YAML_INVALID`（文档有问题）与 `YAML_PARSER_UNAVAILABLE`（安装不完整）区分开；
- `parseStructuredText()` 变为异步，因为 YAML 分支延迟加载解析器；新增的 `ingestStructured()` 一次返回解析结果、sections、渲染与统计，产品面无需重写顺序；
- `detectFormat()` 不再把 yaml/yml 标为 deferred，它现在是正式格式；
- 拒绝信息会带上解析器自己的原因、行号与列号。

### 已知差异

- 不持久化、不写入知识库：本 module 是纯函数；
- 多文档 YAML 流会被拒绝并给出解析器原因，而不是静默截断为第一个文档；
- 这里没有 Excel/PDF/DOCX 读取器：那些属于 D7b，落在同一 Building 的另一个 module。

### 平价测试

覆盖：扩展名规则（`.yaml`/`.yml` 先且只按 YAML，且本身是合法 JSON 的 YAML 文件仍上报为 YAML）、JSON 与 JSON Lines 保持各自格式、非 YAML 扩展名的回退 warning 文案、嵌套 map/sequence、标量与日期、畸形输入/空文档/多文档流/别名炸弹的一律 fail closed、解析器行号列号、渲染与 sections 的确定性（含偏移）、section 上限与字节上限，以及隔离本身（内核只经由 seam，绝不直接依赖该包）。

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

## V0.3 消费边界维修

技能目录字段改为 resolvable/source 与 previewable，替代 installable/install；检索与解析算法不变，不具备安装功能。Evidence Engine 来源现明确区分 PARITY、PORT_ADAPTATION、UTOPIA_EXTENSION。已解决争议的处理属于显式适配，reasons/describeBundle 属于扩展。历史提交保留。

## D9 — 主题构建实验室

Accepted Room：`3ff7d805f0432d39499bee10741f54d3ec98f3de`。晋升内核：`74c277cbc2a44fc045b8c81e8e401df3729fbf28`。固定 DS-Hns 七文件闭包成为现有 theme-engine 的第三个孵化来源。Room 浏览器与 16 项专项／parity 门禁通过；退役前完整 Rooms 83 项通过，提炼后 City 129 项通过。已删除 active Room 及 API factory，源码、界面和浏览器测试可从 accepted commit 恢复；保留晋升记录、City 测试和 DONOR。Alien build 消费属于后续产品门禁；GLOBAL_THEME_APPLY=NO。
