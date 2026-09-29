# UTOPIA · City — 城市实现层架构

**状态：** 生效
**清单：** [`city/CITY_IMPLEMENTATION_MANIFEST.json`](../CITY_IMPLEMENTATION_MANIFEST.json)
**孵化入口：** [`apps/rooms/docs/zh-CN/INCUBATION_POLICY.md`](../../apps/rooms/docs/zh-CN/INCUBATION_POLICY.md)

---

## 1. 两个东西，别混

```text
Digital-City 仓库 = 地图 / 规划 / 同步参考
Utopia/city/      = 当前实际的城市模块实现层
```

`city/` 只登记**已经实际存在**的实现。清单不是愿望列表：只有从 Room Pack 孵化并通过验收、正式晋升进来的模块才会写进 `ACTIVE` / `PROMOTED`，`DEFERRED` 的内容绝不写成 `ACTIVE`。

---

## 2. 层次与产权

```text
City
  ↓
District
  ↓
Building
  ↓
Module / Capability
```

三个概念各有明确边界：

| 概念 | 含义 |
| --- | --- |
| Room（`apps/rooms/**`） | 孵化场 / 本地产品 / 面向用户的实验 |
| Building（`city/<district>/<building>/`） | 产权 + 生命周期 + 服务边界 |
| Module（`city/<district>/<building>/<module>/`） | Building 内部的实现单元 |

**Room 不是 Building。** 一个 Module 不得为了好听被提升成独立 Building。

---

## 3. 当前实际存在的区

只建立当前真正需要的区，不预建 00–11 的空目录。

```text
city/
├── CITY_IMPLEMENTATION_MANIFEST.json
├── manifest.mjs
├── test-all.mjs
├── docs/{zh-CN,en}/ARCHITECTURE.md
├── 02-engineering/
│   └── 02-worker-gateway/
│       └── skill-intake/
├── 09-planning-knowledge/
│   ├── 01-knowledge-service/
│   │   └── knowledge-core/
│   └── 02-document-intake/
│       └── ingestion-core/
└── 11-entertainment/
    └── 01-entertainment-centre/
        └── theme-engine/
```

### Wave 1 产权表

| District | Building | Module | 来源 donor |
| --- | --- | --- | --- |
| `02-engineering` 工务区 | `02-worker-gateway` 施工队接入站 | `skill-intake` | DS-Hns `app/extensions/mega/skills/*` |
| `09-planning-knowledge` 规划知识区 | `01-knowledge-service` 知识服务所 | `knowledge-core` | Codex-Boss `src/shared/knowledge.ts` |
| `09-planning-knowledge` 规划知识区 | `02-document-intake` 文档接入站 | `ingestion-core` | Codex-Boss `electron/ingestion/*` |
| `11-entertainment` 娱乐区 | `01-entertainment-centre` 娱乐中心 | `theme-engine` | DS-Hns `app/extensions/mega/theme/*` |

---

## 4. Module 生命周期

```text
PLANNED      已登记产权，代码尚未迁入
INCUBATING   正在 Room Pack 内孵化
PROMOTED     已从孵化房间晋升，代码在本树
ACTIVE       正式在役
DEPRECATED   保留但不再发展
```

清单校验（`city/manifest.mjs`）会强制：

- `district.id` 形如 `02-engineering`，`module.path` 必须等于 `city/<district>/<building>/<module>`；
- 每个 module 的 `lifecycle` 必须是上述之一；
- 已实现（`PROMOTED` / `ACTIVE` / `DEPRECATED`）的模块必须声明它来自哪个孵化房间 `roomId`；
- 已实现的模块目录必须真实存在；`PLANNED` / `INCUBATING` 的模块目录必须**尚不存在**；
- `donor` 若存在，必须带 `repository` 与合法的 git SHA。

这些规则由 `city/tests/manifest.test.mjs` 实际执行。

---

## 5. 目标结构要求

- **不得**修改 `apps/web/**`、`apps/android/**`、`services/dev-gateway/**`、`agents/reference-node/**`、`contracts/**`、`platform/**`；
- **不得**修改 City Control Protocol、Gateway API v0、Runtime Node 任务语义、Android 协议契约；
- 每个 module 自带 focused 测试；
- 统一测试入口：`node city/test-all.mjs`（纯 Node discovery，避免 Windows glob 差异，不引入新测试框架）；
- 不建立 City 语言服务、权限框架、事件总线、插件系统等超前抽象。

---

## 6. Room Pack 与 city 的关系

```text
IDEA / DONOR
    ↓
Room Pack incubator room      （apps/rooms/rooms/<lab>/）
    ↓
local product acceptance      （focused tests + 浏览器核心动作 + 单机）
    ↓
promotion decision
    ↓
city/<district>/<building>/<module>
```

晋升后：

```text
apps/rooms/rooms/<lab>/        从最终树删除
apps/rooms/promotions/<id>.json 留档
Git history + 双语文档          保留追溯
```

**禁止 Room 与 City 两份活代码长期漂移。**
