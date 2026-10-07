# 本机受控 CPU 研究流（PCF-707 / PCF-721）

运行 `node scripts/pcf-research-local-study.mjs <frozen-config.json> <output-directory>`，每轮冻结独立配置并保留唯一 manifest、City canonical SQLite、artifact、现有 REX EventRecord trace 和研究报告。重复使用输出目录建立新 run，不覆盖失败样本。

配置要求：version=1、id、repetitions（1–1000）、stopAfterMs（1–3600000）、准确的40位 softwareSha、workloads 为 cpu-sort 与 cpu-sum、非空 hypotheses、evidenceClass=ACTUAL_LOCAL_CPU；inputs 按 workload 提供 numeric values；controls 声明 hardware/cache/network；analysis=DESCRIPTIVE_ONLY、failureCounting=KEEP_ALL。未控制的硬件/缓存如实声明。执行前观测本 checkout HEAD 与 clean 状态，softwareSha 必须匹配。生产 CLI 拒绝 dirty checkout。组件调用方可显式 allowDirtySnapshot=true，此时 manifest/report 记录 DIRTY_COMPONENT_SNAPSHOT、各 dirty 文件有界 SHA256 及 frozenSource=false；REX 只记录实际 implementationSha，不填 clean softwareSha，因此不得称为冻结 clean source。结束后再次观测，source 漂移作为 infrastructure failure 保留。各 trial 保留输入/配置 digest 与 canonical task/action/process/output 身份。

实际执行复用 createFabricService 的本机 CPU 子进程、canonical Task/Action、授权检查及结果收集/消费。重复顺序执行，deadline/stopping 限制后续提交；余下计划 trial 保留 NOT_RUN。拒绝、失败及非终态不删除。描述性 latency 包括提交、执行、收集、确认，成功样本统计必须与失败计数和样本数同时读取，不输出显著性或收益结论。

comparePolicies 是纯 COUNTERFACTUAL_SIMULATION，FIXED/CAPABILITY/LOAD/COMPOSITE 全部复用 planPlacement 相同安全与授权 shield。cost-ranking 消融复用 CAPABILITY，禁止 dispatch。调用方必须提供已有 workload/candidate/policy 合同；该函数不制造物理观测，也不代表实际 baseline 基准执行。

research-adapter 将 canonical events 送入真实 REX collector。重新打开 collector 校验持久化 raw/context/normalized EventRecord；trace.replayValidated 只证明 trace 重建，不证明 REX805 campaign 执行 replay。缺失指标和实验字段保留 PARTIAL/NOT_OBSERVABLE；有界丢失、retention/storage 错误显式报告。CLI 对实际失败、trace 重建不匹配或可见 trace 丢失返回非零。没有平行 trace 规范。

验证命令：node --test tests/pcf721-study.test.mjs。RED/GREEN 日志位于 .runtime/pcf-stagec-study-red.log 与 .runtime/pcf-stagec-study-green.log。合同测试实际运行两种 CPU 软件负载，保留授权拒绝。范围是本机开发，不代表 PCF-721 研究验收完成。

Mech 整流一次验证仍需：独立重建准确 source/config/input 身份，运行并导出相同研究，比较保留失败及 replay 证据，记录硬件/缓存/网络控制与时钟偏差。Mech 独立复现、双主机、真实 REX runner/fault/campaign replay/export、工程/ML 混合负载、SLO/恢复/观测开销与统计收益均为 NOT_RUN。不声称真实 Codex 工程执行、ML 训练、双主机、物理设备或 HA PASS。

基础设施 setup 前初始化全部 planned samples。Store/setup/start/events/trace/cleanup 故障保留已完成 trial，未开始 trial 保留 NOT_RUN，并登记 infrastructureFailures；各 cleanup 独立保护。报告写入失败抛 STUDY_REPORT_WRITE_FAILED，error.report 含可恢复 ledger，CLI 输出 recoveryLedger 且非零退出。R1 反例日志保留于 .runtime/pcf-stagec-study-r1-red.log 与 .runtime/pcf-stagec-study-r1-green.log。

Source snapshot 包含相对 HEAD 全部 staged/unstaged 修改路径、untracked 路径，以及有界 staged binary diff 的 SHA256。即使 porcelain 状态或 worktree 字节相同，index 变化也改变身份。回归测试只在独立临时 Git repository 暂存，不操作本开发 checkout index。
