# DGX 全系列开发与第二机统一验收

STATUS: DEVELOPMENT_CANDIDATE
FACT: Per-workbook second-host gates are suspended for development by the Owner's 2026-10-07 ruling; independent verification is performed once for the whole series.
FACT: No main merge and no fabricated accepted dependency, clinical, identity or release evidence.

PCF 所有的 `contracts/personal-compute-fabric-v1/execution-capsule.mjs` 提供 DGX 所需底层子集。胶囊保留 canonical task/action/parent/stage、attempt/epoch、来源及执行身份、exact SHA、批准的写入范围、权限、预算和期限。结果需要有界结构化输出、验证证据与工件摘要核验。调用方拥有可序列化去重账本；Governance 同时持久保存每节点唯一结果。

`createGateway({governancePorts})` 是主机组合接缝。默认连接 PCF adapter，但批准的 spec、参与者签据/事实、canonical 执行引用、工件字节及 release 签据必须由可信主机 adapter 提供。HTTP JSON 不能安装 reader 或授予批准。缺失时明确拒绝，不把接缝存在当作已观察到生产身份或工件验证。

`readApprovedExecutionSpec(refs)` 返回真实 task/user/attempt/epoch 批准，以及 `input_refs`、`output_contract`、`stop_condition`、`independence_floor_ref`、`write_scope`、`permission_ref`、`budget_ref`、`expires_at`、`fact_version`。`readExecutionRefs(node, case, receipt)` 返回 canonical 执行引用；接入后忽略 action 提供的身份。`readArtifact(ref, capsule)` 返回本地已核验字节，并执行 caller 所有权/权限边界。DGX 不解析任意 receipt 路径。执行者进入联合终审；结构化结果通过不等于 release 权限。

第二机按 Digital-City 系列报告列出的 full SHA 获取 `Alien-GPT-DGX`，按 CI 安装锁定依赖，执行一次：

```powershell
node scripts/verify-dgx-series.mjs --expected-sha <full-40-character-SHA> --second-host --out D:/DGX-series-evidence/<new-directory>
```

命令一次跑完十三场景受控验证包，包含本地真实 Gateway/Web 与真实 PCF 底层集成；记录物理 hostname、exact SHA、Node 版本、运行前后干净状态、日志及 checksum。输出目录必须为源码外新目录。开发机不能使用 `--second-host`。受控运行 PASS 是供复检人使用的证据，不自动生成正式验收 marker；第二机操作人统一审查整个系列、全套 CI 和剩余生产/领域接缝后，在 Digital-City 记录一份系列 verdict，八本工作书共同引用，无需逐本停顿。

结果 receipt 必须匹配 case/node/snapshot，`readExecutionRefs` 必填。最终复核需携带当前 `content_revision`。集成内容变化会归档旧复核、要求重新复核，保留初始判断与修正历史。Release 选择必须引用已收集 claims/evidence/assumptions，声明不确定性与 unresolved questions 继续可见。

临床模拟、自主执行/晋升、生产 release 不属于本次开发声明。unknown、dissent 与 fail-closed 门槛继续可见。没有新建 scheduler、reputation store、device identity 或 canonical task 生命周期。
