# Room Pack 晋升历史（PROMOTION HISTORY）

本文件记录每个 donor 房间从孵化到迁入 `city/` 的完整过程。机器可读记录在 `../promotions/<room-id>.json`，完整代码留档在 Git 历史中。

---

## D2 · theme-engine-lab → city/11-entertainment/01-entertainment-centre/theme-engine

| 项 | 值 |
| --- | --- |
| Donor 仓库 | `zhiheng-zhang-Mera/DS-Hns` |
| Donor SHA | `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b` |
| Donor 源文件 | `app/extensions/mega/theme/color.js`、`app/extensions/mega/theme/png.js` |
| 孵化房间 | `apps/rooms/rooms/theme-engine-lab/`（已从活跃树移除） |
| 孵化验收 commit | `9819ed7a4a212b8c8480d91c3812ce7f7a760ab9` |
| 晋升 commit | `d71b9946f249ed49eae6185791cdd9be4fd76e07` |
| 最终城市路径 | `city/11-entertainment/01-entertainment-centre/theme-engine` |
| Lifecycle | `PROMOTED`（Wave 1 期间） |
| 晋升记录 | `../promotions/theme-engine-lab.json` |

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
- 只复制 `color.js` 与 `png.js`：donor theme 目录里的 contract / builder / asset-factory / designer / orchestrator 属于后续 wave。

### 已知差异

- 没有 theme contract、validator、builder、asset factory、preview（Wave 2）；
- 不作用于 Alien Web UI，只产出颜色与图像；
- 不包含 theme registry / lifecycle / recovery 等编排层。

### Parity 测试

覆盖：hex / rgb() / rgba() / 百分比语法与拒绝分支、通道 clamp、hex 往返、alpha 合成、HSL 往返、WCAG 对比度（21:1 极值）与 readability 等级、shade / mix / distance / isLight / bestOn、PNG 编码→独立解码往返（RGB 与 RGBA）、PNG 头读取与非 PNG 拒绝、swatch 确定性、列布局与 alpha 保留。

### 晋升后处理

```text
apps/rooms/rooms/theme-engine-lab/     已删除（保留 Git 历史）
apps/rooms/tests/theme-engine.test.mjs 已删除（parity 测试随内核进入城市模块）
apps/rooms/promotions/theme-engine-lab.json  保留
city/.../theme-engine/tests/           城市模块自带 focused 测试
```

---

## D1 · skill-intake-lab → city/02-engineering/02-worker-gateway/skill-intake

| 项 | 值 |
| --- | --- |
| Donor 仓库 | `zhiheng-zhang-Mera/DS-Hns` |
| Donor SHA | `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b` |
| Donor 源文件 | `app/extensions/mega/skills/skill-format.js`、`app/extensions/mega/skills/tar.js` |
| 孵化房间 | `apps/rooms/rooms/skill-intake-lab/`（已从活跃树移除） |
| 孵化验收 commit | `1ba5b4809f05a155ed76fecdbb9479f900686fa1` |
| 晋升 commit | `6b29e84430ba888b6bc1d5bcde344e16f23b64c2` |
| 最终城市路径 | `city/02-engineering/02-worker-gateway/skill-intake` |
| Lifecycle | `ACTIVE` |
| 晋升记录 | `../promotions/skill-intake-lab.json` |

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
- 不包含 GitHub 下载与来源解析（`skill-source.js`、`skill-service.js` 属于后续 wave）。

### Parity 测试

测试向量复制自 donor 测试套件 `tests/unit/skills-service.test.js`，覆盖：名称语法、frontmatter 子集（whenToUse / metadata / invocation 布尔全部写法）、畸形 frontmatter 拒绝理由、`renderSkillDocument` 往返、tar 列举与 `stripComponents`、路径穿越与绝对路径拒绝、symlink/hardlink/device 拒绝、字节与条目上限、gzip 透明解压、损坏校验和拒绝。

### 晋升后处理

```text
apps/rooms/rooms/skill-intake-lab/     已删除（保留 Git 历史）
apps/rooms/tests/skill-intake.test.mjs 已删除（parity 测试随内核进入城市模块）
apps/rooms/promotions/skill-intake-lab.json  保留
city/.../skill-intake/tests/           城市模块自带 focused 测试
```
