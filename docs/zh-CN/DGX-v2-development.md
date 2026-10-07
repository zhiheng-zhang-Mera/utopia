# DGX v2 开发候选

分支：Alien-GPT-DGX；禁止合并 main。
基线：cc799234e7daa3d8ccfde5673b9d07ccb2376742。

已实现 DGX 自有治理合同、能力归属审计、独立性分配、领域适配、结构化冲突发现、可重启的双阶段仲裁、终审发布门、申诉/少数意见与 Owner 专属 Web 过程查看入口。Engineering 不同实体主机 Formal Review 门槛保持现行规则。

## 使用
启动已有 Gateway，作为 City Owner 连接 Web，打开“审议治理”。导入案例文档；格式见 tests/fixtures/dgx-case.mjs 的 draft() 返回值。选择案例后，L0 显示范围、拆分、参与者、结果、冲突、验证、不确定性与发布状态；L1 展开主张、辩护和少数意见，L2 查看候选 SHA 与证据引用。未观察到的结果显示 NOT_RUN。文档存储有界、原子写入并支持重启。

## API 与权限
GET /api/v0/governance 列表；POST 创建案例；GET /api/v0/governance/:id 查看；POST /api/v0/governance/:id/actions 提交带 expected_revision 的动作。使用 Owner 凭据以及现有 API/schema version 0 请求头。
动作包括 EXTEND_GRAPH、ASSIGN、RESULT、CLAIM、CONFLICT、START_ADJUDICATION、PASS_A、DEFENCE、PASS_B、FINAL_REVIEW、DISSENT、APPEAL、RESOLVE_APPEAL、EVALUATE_RELEASE。过程修改要求重新验证发布门。问题图不会领取、调度或完成 canonical task。

## 可信端口与尚未接入的依赖
readCandidates 消费 canonical 能力/历史/资源事实；readParticipantFacts、readTaskAuthorship、readConflictParties 解析真实身份、实体主机、原作者与争议参与者。verifyParticipantReceipt 必须验证完整案例、候选 SHA、阶段与提交内容，不能只核对 ID。PCF 端口独占通用胶囊编译及结果关联、传输、有界性检验。发布端口解析 exact case/head/participant/scope 绑定的可信 Review、Domain、Independence、Integration 和 Owner 收据。申诉解决需要独立验证。
Gateway 当前仅接入 canonical task 的只读观察。在冻结基线上，PCF-726 accepted 实现、实时参与者事实、认证贡献收据以及正式发布收据 reader 尚不可用。默认产品支持计划登记、检查及手动声明冲突；执行与正式发布门诚实报告 unavailable。测试注入的受控端口不是线上验收事实。

## 验证与未收口边界
13 项场景映射位于 contracts/deliberative-governance-v2/acceptance-matrix.json。运行 node --test tests/dgx*.test.mjs，可检查合同、反例、阶段隔离、重启、Web 可发现性/XSS 和任务真相隔离。测试不代表真实 PCF transport、异机 Formal Review、临床模拟或最终 freeze。DGX-990 terminal marker 未写入。重大异议、不确定性与少数意见保持可见。

## 执行裁决
按 Owner 指令在单分支按序开发；内部提交只是开发依赖证据，不是 accepted Review SHA。通用执行底层保留 PCF 归属；Health 未实现临床能力按 unavailable 处理。main 与原有 worktree 保留。诊断 Review 未报告待延后的 minor。
