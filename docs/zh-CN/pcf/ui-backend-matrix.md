# PCF-700 UI→后端依赖矩阵与单写者清单 / UI->backend matrix and single writers

本文件是 PCF-700 的交付物之一（工作书第 4 条子步骤：明确各下游 owner、**检查 UI→backend 依赖无环**）。它把「哪个用户面文件能打到哪个后端端点」逐文件列出，并证明**反向依赖不存在**。

```text
STATUS: MEASURED_AT_BASELINE_312b627
PAIR_STATUS: SYNCHRONIZED
产线测量 / instrument   scripts/pcf700-reuse-audit.mjs
机器可读记录 / record   data-records/{zh-CN,en}/pcf/reuse-wiring-audit.json
配套守卫 / guards       tests/pcf700-dependency-direction.test.mjs D1（方向）与 D2（端点存在性）
```

## 1. 方向：三段分类，不是一句感觉

```text
扫描 81 个前端源文件（apps/web/**.{js,mjs} + apps/android/**.kt）。
后端模块导入前端模块：**0 条**（D1 断言为空）——这才是「无环」的实测含义。
后端以**文件系统路径**引用前端：`services/dev-gateway/static.mjs`（它就是把 apps/web 当作静态根服务的宿主，
  方向正确）+ `tests/web-i18n.test.mjs`（测试里的路径引用）。
驱动器按需导入前端模块：4 个 `scripts/`（browser-relay-check、uxi301-* ×3）+ 13 个 `tests/`。
```

判定：**UI→backend 无环**。后端对前端的唯一接触是「把目录当静态资源服务」，不存在任何后端模块 import 前端模块。

## 2. 逐文件端点矩阵（实测：14 个文件出现 `/api/v0` 字面量）

| 用户面文件 | 端点 |
|---|---|
| `apps/web/app.js` | `/api/v0/`、`/api/v0/events/stream`、`/api/v0/join/`、`/api/v0/pairing/exchange`、`/api/v0/pairing/info` |
| `apps/web/discovery.js` | `/api/v0/join/nearby` |
| `apps/web/enrollment.js` | `/api/v0/device/session`、`/api/v0/device/installations`、`/api/v0/device/installations/${encodeURIComponent(...)}` |
| `apps/web/short-code.js` | `/api/v0/pairing/exchange`、`/api/v0/pairing/info` |
| `apps/web/scheduler.js` | `/api/v0/presentation`、`/api/v0/tasks`、`/api/v0/tasks/` |
| `apps/web/relay-dial.mjs` | `/api/v0/relay`、`/api/v0/device/session`、`/api/v0/join/{info,nearby,request,status,exchange}` |
| `apps/web/relay-join.mjs` | `/api/v0/join/{info,request,status,exchange}` |
| `apps/android/.../CityClient.kt` | `/api/v0/`、`/api/v0/ask`、`/api/v0/rooms`、`/api/v0/presentation`、`/api/v0/device/session`、`/api/v0/events/stream` |
| `apps/android/.../Actions.kt` | `/api/v0/actions` |
| `apps/android/.../PairingApi.kt` | `/api/v0/pairing/` |
| `apps/android/.../SchedulerPresentation.kt` | `/api/v0/presentation` |
| `apps/android/.../RelayDial.kt` | `/api/v0/relay`、`/api/v0/device/session`、`/api/v0/join/{info,nearby,request,status,exchange}` |
| `apps/android/.../RelayPairing.kt` | `/api/v0/join/{info,request,status,exchange}` |
| `apps/android/app/src/test/.../RoomsTest.kt`（单测驱动器，非产品面） | `/api/v0/rooms` |

后端侧实测 **49 条 `/api/v0` 路由字面量**（`services/dev-gateway/server.mjs`）。**D2 断言：所有前端字面量都能在路由表里找到匹配（静态前缀匹配、允许拼接 id），未解析数 = 0** ——「UI 调了一个 City 根本不提供的端点」会直接让测试变红。

## 3. 单写者清单（带可重算指纹）

| 文件 | 角色（唯一写入者声明） | 行数 | 字节 | SHA256 |
|---|---|---:|---:|---|
| `services/dev-gateway/server.mjs` | 路由与后端/profile 构造的唯一写入者 | 1351 | 122700 | `766f7b778bb35ac66ce5b6eeedc950c5015f3faa9d6acde66fb3d5e7d0df5a90` |
| `services/dev-gateway/store.mjs` | canonical task/action/device/event 真相的唯一写入者 | 109 | 8533 | `4a977deefb9200fe871b721f4d4aed7db6c5dc8a92e9f59f231e479d21f5fd2c` |
| `services/dev-gateway/targeting.mjs` | 严格目标分类（纯函数，不写状态） | 127 | 6408 | `09df5bf1ce3782dede4f5d381b7e63411fc01fb643c09f7acf38b53bac59cd19` |
| `services/dev-gateway/execution-profile.mjs` | profile 状态的唯一写入者 | 208 | 12043 | `cfc2f3cf4777c273cc6e52d33c2453d8ab366415369c4bb9deedc9bd2647ce1c` |
| `contracts/node-descriptor-v1/node-descriptor.mjs` | node-descriptor 字段定义的唯一处（网关与 worker-pool 共 import） | 332 | 21692 | `5c64f0020995aa4256676054ce684dce83e5f10d27d126615b916d25075caa7b` |

指纹是给异机复检用的：bytes/lines/SHA256 可被对方在自己 checkout 上**重算**，而不是采信本文件的数字。

## 4. 下游 component/exposure owner（工作书第 4 条前半）

```text
715  资源控制与 Monitor 投影：所有 PCF 用户面的唯一宿主（701/702/704 的 exposure 都收敛到它）
714  原端状态与结果连续性：原端面的 owner，接 rs-cross-device-return-v1（当前 NOT_WIRED）
790  最终组合验收：只有它能把「已接受的合同」变成「真实产品组合」
其余各书的 component owner 各自持有自己的合同目录与测试；本表不替它们增加 exposure gate 例外。
```

## 5. 本轮未完成 / 未证明（写明）

```text
· 本矩阵是**静态**依赖证据（源码字面量），不是运行期抓包；真实点击路径的跨机验证属 TWO_HOST_VERIFIED，
  必须由另一实体主机完成。
· 需要 `?query=`、header 或 WebSocket 子协议协商才能确定的端点语义不在字面量矩阵内（如 events/stream 的鉴权）。
· Android 侧只覆盖 Kotlin 源码字面量；Gradle 生成的 BuildConfig 若携带 URL 不在此矩阵，已列为下一增量。
```

## 6. 如何重跑

```bash
node scripts/pcf700-reuse-audit.mjs --out data-records/zh-CN/pcf/reuse-wiring-audit.json
node --test tests/pcf700-dependency-direction.test.mjs
```

仪器自身修过两个 bug（宽松正则的 19 条假阳性、以及被**副作用导入**绕过），详见 `reuse-tiers.md` §6；两处都已证伪后修复。
