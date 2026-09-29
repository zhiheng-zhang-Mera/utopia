# V0.3 加固契约

PAIR_STATUS: SYNCHRONIZED
FACT: SUMMARY_LIMIT=500
FACT: DETAIL_LIMIT=50
FACT: SNAPSHOT_LIMIT=50
FACT: LIST_MAX=200
FACT: THEME_OPERATIONS=generate
FACT: LIFECYCLE_AUTOMATION=NONE

调用存储将摘要元数据与结果详情分离。`/city` 最多携带最近 50 条摘要，不包含调用结果。`GET /api/v0/capability-invocations?limit=N` 默认 50，正整数请求最多返回 200 条，非法参数返回 `INVALID_LIMIT`。选中的最近记录按最近状态变化时间从旧到新排列。

`GET /api/v0/capability-invocations/:id` 返回摘要及尚保留的结果，详情清理后为 `result:null`。`resultAvailable=false` 不表示执行失败：已完成记录仍为 `COMPLETED`，摘要存在期间保留其哈希。摘要超出 500 条上限被清理后，详情端点返回 `INVOCATION_NOT_FOUND`（404）。已发布证据不受运行时清理影响。

SQLite 启动时在事务中将旧内嵌结果迁入 `invocation_details`，保持 ID、状态、时间戳、错误码和哈希。损坏旧记录使整次迁移回滚并拒绝启动 Bridge。保存和清理同属一个事务；运行中任务不被摘要清理淘汰，完成时更新最近顺序。最多保留最近 50 份结果详情，每份仍受 3 MiB 上限约束。SQLite 可复用空闲页；这是逻辑保留策略，不构成安全擦除声明。无需删除或重建真实数据库。

两端只在选中历史条目时请求详情，快照更新元数据，不重复下载载荷。旧 RUNNING 摘要不能覆盖新终态结果。真正被清理的已完成详情显示“结果详情已过期或清理，摘要哈希仍保留”。详情读取或网络失败单独显示，不改写调用已保存状态。客户端进程可暂存已加载结果；保留上限指 Gateway 持久化，不表示强制擦除客户端内存。

模块身份为 `{districtId,buildingId,moduleId}`，标准键为 `districtId/buildingId/moduleId`。Descriptor 列出每个 `moduleRef` 及其 lifecycle。混合状态为 `cityLifecycle:MIXED`；应读取 `moduleLifecycles`，不能把 MIXED 当作晋升。无适配器 ID 为 `city.` 加完整标准键；放入 API 路径时须编码整个 ID。

可用性综合全部依赖：存在 DEPRECATED 则 UNAVAILABLE；存在 PLANNED/INCUBATING 则 BRIDGE_PENDING；缺失或未知依赖则 DEGRADED；只有全部 PROMOTED/ACTIVE 且有适配器才 AVAILABLE。完整身份重复会拒绝构建 Registry；不同 Building 内的同名模块互不替代。Bridge 不修改 lifecycle。

Theme 只暴露 `generate`，返回预览、tokens、可读性、overlay、受保护表面检查及校验。此前没有独立实现的 `validate` 会被拒绝。Android 通过 `CapabilityRequestException` 保留 HTTP 错误码、状态和说明；传输 IO 失败显示 OFFLINE，即使 WebSocket 标志滞后。

有界载荷声明仅针对调用历史，不涵盖既有任务和事件集合。既有 V0.3 实机验收仍是历史证据；新验收独立记录源码、APK 和检查。加固合并且主线 CI 通过后才进入 Wave3。
