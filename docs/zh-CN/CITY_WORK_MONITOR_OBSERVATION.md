# 全城工作监视器观察基础

MON-901 新增 GET `/api/v0/monitor`，复用既有控制令牌／入网会话授权，返回 schemaVersion1 的 monitor：Node、Edge、Event、Evidence 与空 Decision 接缝。Worker 令牌无法读取，POST 没有写入路由。

JEV 旁路按需读取已持久化、同一 SQLite 读事务内的有界事实，不创建任务／设备表、调度决定、订阅或计时器。任务执行不调用或等待观察器。端点为受信消费者提供投影；总图／检查器 UI 属于 MON-902。观察器断开、异常、挂起不影响任务创建、领取、上报和取消。

每类数据默认最多128条，内部读取允许1..256；优先 FAILED/RUNNING/QUEUED。省略数量、历史缺失和序号断档明确呈现。health=COMPLETE 只说明采样窗口完整，不表示全城安全；safeSummaryAvailable=false、continuous=false。尚无权威来源的 review、CI、模型切换、升级信息和任务 owner 标为未知。主机绑定读取 assignedNodeId；缺失主机记录以 targetPresent=false 呈现。原始事件 payload、任务结果／错误、凭据及隐含推理不复制。事件 ID／seq／City／来源和 `/api/v0/events` 指针用于对账。延迟只测采样至投影，不是事件产生至采集的完整延迟。

复用观察器读取失败时标为 UNAVAILABLE／stale；断开隔离晚到结果，single-flight 避免内部排队。Gateway 复用一个观察器：同时请求共享读取，失败保留上次视图并标为过期，关闭时断开。SQLite 事件自增水位和序号范围暴露删除前缀／尾部的历史缺失；水位未知仍标为部分视图。不宣称跨设备验收、持续遥测、模型决定、主城代理迁移或性能提升。

验证：`node --test tests/mon901-observation.test.mjs tests/gateway.test.mjs`。受控 API 任务生命周期、故意挂起监视请求和读取异常证明权威执行独立；不推断实体 worker 性能。
