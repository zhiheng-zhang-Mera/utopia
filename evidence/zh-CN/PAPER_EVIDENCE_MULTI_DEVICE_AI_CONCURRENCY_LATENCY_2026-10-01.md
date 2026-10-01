# 论文证据——多设备并发 AI 请求的响应延迟与背压

PAIR_STATUS: SYNCHRONIZED
FACT: INCIDENT_ID=MULTI-DEVICE-AI-CONCURRENCY-LATENCY-2026-10-01
FACT: OBSERVATION_DATE=2026-10-01
FACT: EVIDENCE_LEVEL=USER_FIELD_OBSERVATION
FACT: ROOT_CAUSE_CONFIRMED=false
FACT: IMPLEMENTATION_STATUS=NOT_IMPLEMENTED
FACT: CITY_PLAN_STATUS=NOT_COMMITTED
FACT: PRETREATMENT_CLASS=OBSERVABILITY_AND_BACKPRESSURE
FACT: MULTI_DEVICE_PARALLEL_INPUT_EXPECTED=true

## 证据摘要

用户在真实多设备使用中报告：不同设备同时向同一 AI 服务/逻辑助理发出请求时，响应速度体感下降。

当前证据仅能证明“存在可重复关注的现场体感”，不能证明具体 provider 的内部后端调度方式。尤其不能把该现象直接写成“同账号多设备抢同一计算 worker”。缺少的数据包括：

- 每个请求的 Utopia queue wait；
- provider TTFT 与 provider total time；
- 本地执行器等待/运行时间；
- provider 限流或并发拒绝原因；
- 同设备串行、跨设备并发的对照样本。

机器可读的事件摘要位于：
`evidence/raw/multi-device-ai-concurrency-2026-10-01/incident-summary.json`。

## 对 Utopia 的直接风险

如果未来多个 embodiment 都可以直接把工作推给外部 AI 或本地执行器，而没有统一 admission：

1. provider 的正常排队可能被 Utopia 误判为失败；
2. 超时后重复提交会制造 retry storm；
3. 相同 action 可能被多个设备重复执行；
4. 同一资源的写任务可能竞争；
5. 低优先级重任务可能挤占交互请求；
6. 用户只能看到“变慢”，无法知道等待发生在 Utopia、本机还是 provider。

## 学到的设计规则

候选预处理方向：

- admission control / queue / backpressure；
- per-provider / per-channel concurrency budget；
- action identity + idempotency + execution lease；
- bounded retry + backoff，禁止无界复制请求；
- 区分 queue wait、local execution、provider TTFT、provider total；
- 向用户暴露 typed waiting state；
- provider/API/设备切换继续遵守既有用户确认策略。

这些内容目前是**设计启示，不是已经实现的能力**。默认并发阈值、优先级算法和具体模块边界仍需通过后续方案与实验决定。

## 可验证假设

后续可以用 Utopia 自身遥测验证：

> 加入显式 admission/backpressure 后，多设备并发下的重复执行、重试次数与尾延迟应下降；同时可将“Utopia 自己慢”与“provider 慢”区分开。

本记录故意保留不确定性，避免把用户体感包装成已验证的 provider 行为。
