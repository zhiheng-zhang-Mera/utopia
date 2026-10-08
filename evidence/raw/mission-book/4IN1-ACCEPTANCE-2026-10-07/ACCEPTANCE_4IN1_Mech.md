# 4-in-1-REX+PCF+CHK+DGX 整合验收 — 缺陷台账与修复记录

```text
验收对象 / object      utopia 分支 4-in-1-REX+PCF+CHK+DGX
验收起点 / start head  c0034329343bcdbf8daac5972d0bae1673d9c5a3（= origin/4-in-1-REX+PCF+CHK+DGX）
验收方 / host          Mech-DS（COMPUTERNAME MEGA-REP）
对侧 / peer            Alien 节点在线于本机 City（dev-1428bce5297146df88720f270af71bc3，hostname Mera-Alianware）
工作树 / worktree      D:\utopia-4in1-verify（新建的独立验收树，不动常驻 City 的 D:\utopia-rex-pcf-merge）
依据 / criteria        dc/mission-book/mission-group/{city-self-health-check,personal-compute-fabric,
                       research-strengthening,deliberative-governance-expansion-migration} 四系列工作书
```

## 0. 起点拓扑实测（不是推断）

```text
origin/main            db6b6f9   与其父 17271f0 的 tree SHA 完全相同（f903f9c1…）
17271f0               是 origin/4-in-1 的祖先 ⇒ 4-in-1 = main 的内容 + PCF 全系列 + 两处修复
main..4in1             35 commits（PCF 系列 + c003432/6be230b）
4in1..main             1 commit（db6b6f9，纯合并提交，tree 与 17271f0 相同）
git merge-tree         exit 0，无冲突 ⇒ 该分支本身可合并
起点 exact-head CI     V0.2 checks push 37607606099 completed/success（c003432）
```

## 1. 起点本机全量套件与失败分类

```text
node --test tests/*.test.mjs   → 1966 tests / 1955 pass / 8 fail / 3 skipped
逐个单跑复验：
  tests/host-city-launcher.test.mjs       1 pass / 3 fail  → 环境性：本机常驻 City 占用协调端口，
                                                            测试按设计拒绝运行（非产品缺陷）
  tests/bridge-artifact-store-guard.test.mjs   5/5 pass   → 满载 flake
  tests/rex803-campaign-web.test.mjs           2/2 pass   → 满载 flake
  tests/rex803-two-worker-rehearsal.test.mjs   通过       → Windows rm() 竞争 flake
  tests/rex804-web.test.mjs                    1/1 pass   → 满载 flake
  tests/rex805-web.test.mjs                    1/1 pass   → 满载 flake
⇒ 8 项失败中 0 项是确定性产品缺陷；权威判据是托管 CI（干净环境）。
```

## 2. 缺陷台账（四条独立审计线 + 本机）

四系列各由一条独立只读审计线核对（CHK / PCF / REX / DGX），逐条要求给出文件+行号+可复现命令。
下列为**本轮直接修复**的项；修复一律附**可证伪守卫**（先在未修复代码上跑红，再在修复后跑绿）。

| # | 级别 | 位置 | 缺陷 | 证据 | 处置 |
|---|---|---|---|---|---|
| D1 | 高（崩溃） | `services/dev-gateway/server.mjs:182` | LAN 发现的自过滤读 `server.address().port`；City 关闭后该调用返回 `null`，于是从**公开**的 `/api/v0/join/nearby` 处理器抛出裸 TypeError，无捕获 ⇒ 进程被一次发现扫描杀掉 | 确定性复现：注入 `nearbyBrowser` 门控，先 `close()` 再放行浏览结果 ⇒ 未修复时打印 `TypeError … reading 'port' at isSelf(server.mjs:182:112)` | 已修：`selfPort()` 空值安全，未知端口="无法按地址判定自身"，身份仍可判定 |
| D2 | 高（安全底线） | `contracts/deliberative-governance-v2/assignment.mjs:26` | ENGINEERING 的审查独立性底线按**调用方传来的 role 字面量**选择，而 `DOMAIN_PROFILES.ENGINEERING.required_reviewer_roles` 全仓无人读取；`governance.mjs:58` 把 `role` 直接透传自 HTTP JSON ⇒ 同一个审查任务改叫 `REVIEW` 就能选中**同主机**审查者 | 本机独立探针：role=`DOMAIN_REVIEW` → 拒绝(host_independence)；role=`REVIEW` → **selected=same-host reviewer，floor={}** | 已修：底线改为由 domain profile 决定（ENGINEERING 下凡非 EXECUTOR 角色一律适用 profile 的 floor） |
| D3 | 高（凭据读取） | `city/…/city-self-health-check/index.mjs:14` | `sensitivePath` 未覆盖 `id_rsa`/`id_ed25519`/`.npmrc`/`.netrc`/`.pgpass`/`.ssh`/`.aws`/`.pfx/.crt/.p8/.jks` ⇒ 被点名的实现路径 `config/id_rsa` 与受跟踪的 `.npmrc` **被实际读取并写入 source-manifest.json（含 sha256）**，直接反证"敏感路径从不读取" | 受控夹具实跑：`source-manifest.json` 出现 `config/id_rsa`、`.npmrc` 两条 sha256 记录 | 已修：过滤表补齐真实凭据文件形状 |
| D4 | 中（明文凭据） | `city/…/sanitize.mjs:2-8` | 脱敏只有 GitHub token / `password=` / Bearer / JWT；AWS 风格 `AKIA…`、GCP `AIza…`、Slack `xox…`、Stripe `sk_live_…`、PEM 私钥体全部原样进入 report.json/report.md | 受控夹具实跑：`report.json:34/202` 与 `report.md:15` 出现明文 `AKIAIOSFODNN7EXAMPLE` | 已修：补齐上述形状（并在文件内写明"模式匹配而非保证"这一限制） |
| D5 | 中（静默丢弃） | `city/…/index.mjs:66` | 未被注册表引用的敏感路径在选择阶段被 `continue` **静默丢弃**，不计入 `skipped`，`static_scan_complete` 仍为 `true` | 夹具：`.env`/`.env.production`/`secrets/token.json` 受跟踪但未被引用 ⇒ `skipped: []`、`static_scan_complete: true`、报告内 grep `.env` 零命中 | 已修：丢弃现在记入 `skipped`，`static_scan_complete` 随之如实为 false |
| D6 | 中（自相矛盾） | `city/…/index.mjs:120-121` | 敏感路径同时被报成 `DEAD_CAPABILITY_RECORD`（"实现路径缺失"）与 `skipped: UNSAFE_PATH`（"故意未读"），只读 findings 的运维会判定能力缺失 | 夹具 report.json 同时含 `detail:"Implementation path unavailable: .env"` 与 `skipped … UNSAFE_PATH` | 已修：故意未读改用独立代码 `CAPABILITY_PATH_NOT_READ` |
| D10 | 低（记录不实） | `tests/pcf704-admission.test.mjs:7-9`、`tests/pcf705-recovery.test.mjs:9-10` | 文件头仍写 foreground reserve / retry budget 为 `NOT_IMPLEMENTED`，而同一文件的断言正在检验这些已实现的拒绝码；与 PCF README"没有任何 NOT_IMPLEMENTED 残留"直接矛盾 | 同文件 `:385-410` / `:296-306` 即断言 `FOREGROUND_RESERVE_*` / `RETRY_BUDGET_*` | 已修：注释改为事实 |
| D11 | 低（假守卫） | `apps/web/research.js:45`、`apps/web/research-surface.js:207` | `assertPrimarySurfacesClean` **产品代码从不调用**（只有测试调用），`researchView` 未传 `primarySurfaces` ⇒ 生产路径下该列表恒为空、守卫空转；代码注释却称"the guard is data, not a convention" | 全仓 grep：调用者仅 `tests/rex807-surface.test.mjs` | 已修：页面从**真实导航**导出主面清单并调用守卫；把 Research 提升到主导航现在会当场抛错 |
| D12 | 低（元数据不实） | `apps/web/research-surface.js:152-154` | 5 个 DIRECT_CONTROL 里只有 2 个带 `wired`/`wiredAt`，与 REX-807 报告"每条控件记录 wired/wiredAt"不符 | 同文件 `:185-186` 有、`:152-154` 无 | 已修：create/start/stop 补上真实落点 |

### 2.1 每条修复的可证伪守卫（先红后绿）

```text
D1  tests/join502-gateway.test.mjs                「a discovery scan that outlives its City …」
    未修复：✖（子进程打印 TypeError）   修复后：✔
D2  tests/dgx-assignment.test.mjs                 「DGX990 scenario 13: the ENGINEERING review floor follows the DOMAIN …」
    未修复：✖ 4/5                         修复后：✔ 5/5
D3/D5/D6 city/…/tests/boundaries.test.mjs         「credential paths a real machine carries are refused by name …」
    未修复：✖                            修复后：✔
D4  city/…/tests/boundaries.test.mjs              「redaction covers AWS-style key ids and PEM bodies …」
    未修复：✖                            修复后：✔
D11 tests/rex807-wiring.test.mjs                  「the primary-surface guard runs on the shipped page …」
    未修复：✖（页面不拒绝提升）            修复后：✔
```

## 3. 记录在案但**未**在本轮修复的缺口（不隐藏、不夸大）

这些是工作书点名的**能力/范围缺口**，不是交付物中的错误行为；实现它们等于新增功能或有待记录持有人裁决，因此照实列出：

```text
G-REX-801  工作书 L82-97/L112-122 点名的最低 manifest 字段（metrics、research_signal_ids、
           research_grade_snapshot、control_plane_rule_version、authority_surfaces_if_applicable）
           在 contracts/experiment-manifest-v1/manifest.mjs 的冻结输出中一个都不存在；全仓 grep
           这五个字段名（含 camelCase）零命中。REX-801 已是 COMPLETE 且 marker 已释放。
G-REX-807  RESEARCH_CONTROL_SURFACE.md 把 `pause` 列为 DIRECT_CONTROL，但 server.mjs 没有对应路由；
           campaign 页的 seed/warmup/abandon 渲染在开放区块内，不经 research-surface 的
           ADVANCED_CONTROL 确认路径；暴露等级词汇在代码（4 值）与工作书（OBSERVABLE_ADVANCED）
           之间不一致；Technical details 会渲染却被标为 INTERNAL_ONLY。
G-PCF      702/703/709/710/711 的"双机/双 worker 实跑"半边既未做也未标 typed NOT_RUN；
           719 无 androidTest instrumentation 源集；718 点名的 platform/linux/pcf-worker/ 落点不存在；
           715 的 Android 验收半边无对应面。
G-DGX      validateDomainGate 是导出的契约函数，release 路径只信任 host port 提供的 receipt
           （缺 port 即 fail-closed）——这是文档化的 host 接缝，不是缺陷，但同一 receipt 会被
           floor 判 BLOCKED、被 release 判 PASS，因此该底线在集成 release 意义上**没有执行点**；
           acceptance-matrix 漏引 3 个 dgx 测试文件、行 7 证据指向另一份 capsule 实现；
           verify-dgx-series.mjs 硬校验分支名，在集成分支上无法运行。
G-REX-890  REX-890（可复现性研究 + 冻结）**未开始**：无 dev/review 头、无报告目录、无
           RESEARCH_MATERIAL_SYNTHESIS.md；8 项最低 study 中 fault/recovery 与 handoff 在本代
           能力内缺证据，且必须由对侧实体主机执行。程序终标
           RESEARCH_EVALUATION_FABRIC_V1_REPRODUCIBLE 未释放——树与工作书一致。
G-CHK      CHK-990 freeze_outcome 仍为 NOT_ACCEPTED_PENDING_WHOLE_SERIES_REVIEW（**没有人静默升级**）；
           docs/superpowers/plans/2026-10-07-chk-series.md:3 仍写 "no main merge"，但该系列已并入 main。
```

## 4. 本机环境事实（用于读懂本机数字）

```text
常驻 City      pid 29680，绑定 172.31.12.151:4310（+4320 rooms、4389 协调端口），
               代码树 D:\utopia-rex-pcf-merge @ 6be230b，为联机 Alien 而保持运行。
               它占用协调端口 ⇒ tests/host-city-launcher.test.mjs 的 3 项按设计拒跑。
Alien 节点     ONLINE / HEALTHY，已实测可被本机 City 严格定向执行 canonical 任务（见 §5）。
```

## 5. 与 Alien 机的联合验证（真实两机，同一 City）

```text
1) 节点面      GET /api/v0/nodes 同时列出 Mega-rep 与 Alien，两者 nodeDescriptor
               contractVersion=1、roles=[EXECUTION_NODE]、availability=ONLINE、health=HEALTHY。
2) 执行面      本机创建 route=CITY_TASK / operation=CHECKPOINT_DEMO / targetDeviceRef=<Alien> 的
               canonical action：City 在创建时判定 targetStateAtCreation=ELIGIBLE 并声明
               "may be claimed by that device only"；随后 **Alien 节点真的领取并跑完**：
               state=COMPLETED、progress=100、assignedNodeId=dev-1428bce5…、
               result={bytes:65, sha256:32de4032…, cleaned:true}。
⇒ 跨实体主机的严格定向执行在整合包上成立，且结果带回真实校验和。
```

## 6. 验收结论（exact head，实测）

```text
验收对象 / accepted head   185d043e11ae8516a1e7a492d09d031610be576b
                            基于 origin/4-in-1-REX+PCF+CHK+DGX c003432，其父链包含 17271f0（= main 内容）
托管 CI（全部 completed / success，读自 Actions API）：
  push        V0.2 checks 37613355839        gateway-web SUCCESS · android SUCCESS
  pull_request V0.2 checks 37613438305       gateway-web SUCCESS · android SUCCESS
  pull_request City linkage check 37613438289  reciprocal-contract SUCCESS
  pull_request PCF Linux component candidate 37613438369  linux-components SUCCESS
PR                          https://github.com/zhiheng-zhang-Mera/utopia/pull/46
                            mergeable=MERGEABLE · mergeStateStatus=CLEAN
本机复跑（同 head）          tests 1969 / 1961 pass / 5 fail / 3 skip
                            5 项 = 3 项 host-city-launcher（常驻 City 占协调端口，按设计拒跑）
                                 + 2 项满载 flake（theme-packages、rex803-campaign-web，单跑均通过）
                            node city/test-all.mjs → 2013 / 2006 pass / 0 fail / 7 skip
                            node scripts/verify-promotion-history.mjs → exit 0
                            pnpm check:docs → exit 0（三个根 PAIR_STATUS 同步）
```

## 7. 联合验证（在**验证绿版**上重跑，非起点树）

City 已按验证头重启（`D:\utopia-rex-pcf-merge` fast-forward 到 `185d043`，pid 44920，绑定 172.31.12.151:4310），
随后重取两机证据，产物 `crosshost-evidence/crosshost-evidence.json`：

```text
两机节点面    Mega-rep 与 Alien 均 ONLINE / HEALTHY，nodeDescriptor contractVersion=1、
              roles=[EXECUTION_NODE]、trustRef.authority=CITY_NODE_REGISTRY。
执行面        Alien 严格定向任务 Q-ae583be6…：targetStateAtCreation=ELIGIBLE → state=COMPLETED、
              progress=100、assignedNodeId=dev-1428bce5…（= 请求目标）、
              result={bytes:65, sha256:248dbb67…, cleaned:true}
              本机严格定向任务 Q-cff22088…：同样 COMPLETED 且 assignedNodeId = 请求目标。
LAN 发现面    GET /api/v0/join/nearby → bounded=true、discovered=1、**excludedSelf=1**、rows=0
              ⇒ 修复后的自过滤在真实 City 上确实把本城自己的广播排除掉，而不是抛错。
健康面        status=healthy（gateway/rooms/execution/artifacts 全 READY）；
              /api/v0/pcf → completeness=COMPLETE；/api/v0/governance → AVAILABLE。
```

## 8. 尚未完成 / 需要记录持有人裁决的事项

```text
· 合并进 main 本身是 Owner 的合并权；本轮做到「可合并且全绿」，未自行合并。
· §3 的 G-REX-801 / G-REX-807 / G-PCF / G-DGX 缺口不因本轮修复而关闭。
· REX-890 未开始，程序终标未释放（见 §3）。
```

