# Room Pack 孵化与晋升政策（INCUBATION POLICY）

**状态：** 生效
**适用：** `apps/rooms/**`（Room Pack 是所有新功能房间的孵化场，不是城市最终产权地）
**相关记录：** `apps/rooms/promotions/*.json`、`city/CITY_IMPLEMENTATION_MANIFEST.json`

---

## 1. 为什么存在这份政策

Room Pack 起初是“十个本地产品房间”。从本轮起，它的定位进一步明确为：

```text
ROOM PACK
= local utility product
+ incubation / proving ground for every future new room
```

任何新功能，如果最终归属是正式城市模块，必须先在这里成为**可操作、可测试、单机可验收**的临时房间，再决定是否晋升。**禁止跳过孵化，直接把低成熟度 donor 代码塞进 `city/`。**

例外只有三类：

1. 已经有独立仓库和成熟验收的现存城市基础设施；
2. 纯 schema / contract，本身没有用户产品行为；
3. 用户明确要求直接进入 `city/`。

---

## 2. 生命周期

房间必须声明以下之一（见 `hub/manifest.mjs` 的 `ROOM_LIFECYCLES`）：

| Lifecycle | 含义 |
| --- | --- |
| `LOCAL_PRODUCT` | 已完成的本地产品房间；**不会**因为新政策被强行迁入 `city/` |
| `INCUBATING` | donor 房间正在 Room Pack 内被验证 |
| `ACCEPTED_LOCAL` | 孵化房间通过了本地验收 |
| `PROMOTION_CANDIDATE` | 已接受，排队等待晋升 |
| `PROMOTED` | 活跃孵化实现已删除，核心已在 `city/<district>/<building>/<module>` |
| `REJECTED` | 放弃，只保留 Git 历史 |

现有十个房间默认为 `LOCAL_PRODUCT`。新 donor 房间默认 `INCUBATING`。

`PROMOTED` 与 `REJECTED` 的房间不再出现在活跃目录中（`hub/manifest.mjs` 的 `ROOMS`），只保留在 `ALL_ROOMS`、Git 历史与 promotion 记录里。

---

## 3. Room metadata 合同

每个孵化房间至少携带（`apps/rooms/hub/manifest.mjs`）：

```text
id
label
lifecycle
targetCityPath        # 目标城市路径，例如 city/02-engineering/02-worker-gateway/skill-intake
donorRepository       # 例如 zhiheng-zhang-Mera/DS-Hns
donorCommit           # 固定 donor SHA
donorSourcePaths[]    # 复制自 donor 的具体文件
```

普通本地房间：

```text
donorRepository = null
targetCityPath  = null
```

---

## 4. 晋升记录

每个成功迁出的房间在 `apps/rooms/promotions/<room-id>.json` 留档：

```json
{
  "roomId": "skill-intake-lab",
  "acceptedRoomCommit": "<孵化验收时的 commit>",
  "promotedAtCommit": "<晋升提交>",
  "targetCityPath": "city/02-engineering/02-worker-gateway/skill-intake",
  "donor": {
    "repository": "zhiheng-zhang-Mera/DS-Hns",
    "commit": "eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b",
    "sourcePaths": ["app/extensions/mega/skills/skill-format.js"]
  },
  "status": "PROMOTED"
}
```

`hub/promotions.mjs` 会校验记录结构，并交叉检查：

- 记录里的房间不能再出现在活跃目录里；
- 房间的 `lifecycle` 必须是 `PROMOTED`；
- 记录的 `targetCityPath` 必须与 manifest 中声明的一致。

`tests/incubation.test.mjs` 会执行这些检查。

---

## 5. 晋升后不保留第二份实现

成功晋升后：

```text
apps/rooms/rooms/<lab>/
```

从最终树中移除。保留：

```text
Git history
promotions/<room-id>.json
双语 catalog / history 文档
```

**禁止 Room 与 City 两份活代码长期漂移。**

---

## 6. 一次晋升的完整顺序

```text
1. 从最新 main 建分支
2. 固定 donor SHA，记录源文件（DONOR_COPIED）
3. 只移植最小语义闭包，不引入 donor runtime / 数据目录
4. parity 测试对齐 donor 的等价 test vector（DONOR_PARITY_PROVED）
5. 在 apps/rooms/rooms/<lab>/ 建孵化房间
6. focused 测试 + 浏览器核心动作（ROOM_PRODUCT_ACCEPTED）
7. 提交验收态，记录 accepted room commit
8. 把 core 提炼到 city/<district>/<building>/<module>（CITY_PROMOTED）
9. 从最终树删除活跃孵化实现
10. 写 promotions/<room-id>.json
11. 更新 city manifest
12. 跑 city 模块测试 + 受影响的 Room Pack 测试
13. 确认 donor 仓库未被修改
14. PR → merge → 在合并结果上复核
```

---

## 7. 失败与停工

某个 donor 如果出现以下情况：

```text
复制最小闭包后仍需要 donor runtime
必须复制巨大的调度/权限系统
无法在单机 Room 中形成可验证产品
parity 不清楚
行为强依赖隐藏状态
```

则：

```text
DONOR_STATUS = DEFERRED
```

记录原因，继续下一个 donor，**不让一个 donor 失败阻塞整个 wave**。`DEFERRED` 项不得在 city manifest 中伪造为 `ACTIVE`。

只有以下情况才全局停工：

```text
Utopia 仓库不可用
Room Pack 基线损坏
迁移必须重写历史
需要暴露凭据
```

---

## 8. Donor 来源纪律

旧项目 `Codex-Boss` 与 `DS-Hns` 保持：

```text
READ ONLY
NO PR
NO source cleanup
NO migration marker written back
NO deprecation
NO redirect to Utopia
NO shared runtime data
```

Utopia 适配后的代码由 Utopia 拥有后续变更，**不建立双向同步义务**。
