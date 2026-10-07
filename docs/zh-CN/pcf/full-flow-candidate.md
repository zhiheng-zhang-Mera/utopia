# PCF 本机完整流候选

[English](../../en/pcf/full-flow-candidate.md)

分支 `pcf/full-flow-alien-pending-verification-20261007` 基于本机 PCF-700/701 和 Windows CPU 修复，再合入当时的 main。这是持续施工候选，**不是已完成的 PCF 全系列，也不是可以合并 main 的验收包**。

交接协议：`SINGLE_BATCH_OPPOSITE_HOST_VERIFICATION`。整条完整流将在本机施工和组合检查后一次性交给 Mech 验证，不分拆逐任务异机验收。本机组件测试不修改历史任务书的 review/acceptance 事实；原 PCF-701 单项验证请求由本次整体交接方式替代。

当前实际本机路径：两个固定 CPU 应用通过既有 City Store 中的 task/action → 策略 → 工作负载 → 放置提案 → 原子预留 → 带 epoch 的 attempt → 摘要工件 → 真正的 Node 子进程 → canonical 结果 → 发起会话取回并明确确认已读取；真实 Codex Agent 消费仍为 NOT_RUN。模型推理、真实工程 Agent 和远端执行不使用 CPU 测试代替。

复现：安装根目录及 city 的冻结依赖后，运行 `node --test tests/pcf-full-*.test.mjs tests/pcf70*.test.mjs`。在已提交且干净的源码树运行 `node scripts/pcf-full-local-pilot.mjs`，它保留 `.runtime/pcf-full-local-pilot-*/report.json`、SQLite 和工件；读取源码 SHA，不读取任何连接凭据。

仍待验证的任务书证据包括真实跨机传输/grant、OS 强隔离、完整重启故障矩阵、原生 PCF 专用控制，以及真实 Codex/DeepSeek 会话闭环。Settings 默认仅 Owner 只读；显式获批本机服务配置启用本机应用、取消与结果读取。浏览器读取或 Caller acknowledge 不等于观察到 Agent 消费。原 STANDARD_DEVICES 由既有 launcher 管理。

可选任务前提单独记录：GPU 驱动观测不能当作 GPU 执行完成；Android control client 不能当作 worker；Windows 上存在 wsl.exe 不能当作 Linux runtime；缺少已授权模型和独立持久化/fencing 基础时不宣称模型或 HA 完成。所有这些条目继续保留未验证状态。

日志和逐任务覆盖矩阵保存在 Digital-City 的 `mission-book/reports/PCF-FULL-FLOW/` 独立文档分支中。报告明确区分代码候选、实际本机运行、历史验收、未实现内容和对侧待验证。

本机候选新增：显式 opt-in Gateway 接口调用不依赖 UI 的既有 canonical CPU 服务。Task 成功状态为 COMPLETED，Action/capsule 成功仍为 SUCCEEDED。提供 stdin 前记录子进程身份；身份落盘失败就终止自己的子进程。第二个 supervisor 遇到归属未知会拒绝，不因超时接管。恢复在精确归属停止证明前后均检查当前授权，只允许 PURE 负载以原 Task/Action、新 generation 排队。drain/stop 阻止迟到准入，结果工件有 24 小时保留上限。

阶段 A 勘误：历史 15b1e61 pilot 证明真实 CPU 工作和会话消费，但其中 Task 的 SUCCEEDED 状态不符合既有 canonical Task 终态词汇；后续源码已修正为 COMPLETED。原日志保留，不能提升历史契约证据。

当前本机整合包括可恢复且可 pin 的工件、checkpoint 恢复 fencing、显式 Android 前台 worker 组件、可逆部署控制、canonical Gateway 接口、本机 Web 控制、远程 canonical/headless port，以及带持久回执的工程运行器/工具组件流。既有 Task.result 字段保存原会话获权的结果引用，供普通 Web/Android 任务视图显示 canonical 结果。原生 PCF 专用控制、真实跨机传输/provider grant 仍未验证。显式队列保护、GPU 约束、冻结的本机 REX study 及隔离 Linux CI 区分开发能力与实体主机验收。
