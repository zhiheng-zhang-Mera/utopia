# 能力桥 v1

PAIR_STATUS: SYNCHRONIZED
FACT: API_VERSION=0
FACT: CAPABILITY_CONTRACT_VERSION=1
FACT: FILE_LIMIT_BYTES=1048576
FACT: INVOCATION_HISTORY=DURABLE
FACT: LIFECYCLE_AUTOMATION=NONE

Services 复用控制面鉴权和版本校验；显式操作通过受限工作线程调用 City 归属模块，两端均不移植业务算法。输入文件上限1MiB，同时最多2个工作线程，执行上限20秒，每项结果上限3MiB。

GET /api/v0/capabilities; GET /api/v0/capabilities/:id; POST /api/v0/capabilities/:id/invoke; GET /api/v0/capability-invocations; GET /api/v0/capability-invocations/:id.

请求为 {operationId,input}。返回 invocationId、capabilityId、operationId、startedAt、finishedAt、status、resultDigest、errorCode 和 result。规范摘要对对象键排序，并排除调用元数据。COMPLETED 指执行结束，证据 PASS/HOLD 与主题校验结论属于独立结果字段。

不保留原始输入文件字节。结果、元数据及事件显式保存在城市调用历史中，其中包含匹配到的临时知识条目；这不是永久知识数据库。网关重启保留终态记录，将未完成的 RUNNING 标记为 INTERRUPTED。客户端离线时明确显示缓存并禁用调用，直至权威服务恢复。

适配器覆盖文档读取、知识查询、技能检查、证据审查和主题实验室。无适配器的新模块保持 BRIDGE_PENDING，依赖失效标为 DEGRADED。证据样例必须显式设置 sample:true，其他缺失 task 的请求返回 TASK_REQUIRED。技能归档使用可选严格路径拒绝。主题构建器、全局应用、安装器、提供者自动化及自动 ACTIVE 晋升均不在范围内。
