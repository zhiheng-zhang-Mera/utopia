# Research trace / 研究记录

REX-802 adds a read-only view in Web **Advanced → Research trace** and Android **更多 → 研究记录**. The City owner can read `GET /api/v0/research/trace` through the existing version-0 authentication. Enrolled members receive owner-required guidance; recording grants no new execution or membership permissions.

REX-802 在 Web“高级 → 研究记录”和 Android“更多 → 研究记录”提供只读观察。接口沿用版本 0 认证，仅城市所有者可查看；成员收到所有者权限提示。记录不会授予新的执行或入网权限。

The collector observes canonical event references **after a successful database commit**, plus newly supplied validated worker CPU/memory observations. It cannot create, transition or replay tasks/actions. Rollbacks discard staged observations. An omitted heartbeat sample does not repeat cached measurements. Credentials, fingerprints, arbitrary event payloads and user task inputs are excluded by the canonical-event whitelist.

采集器仅引用成功提交后的规范事件，并记录新提供且通过验证的 CPU/内存观察。它不创建、改变或重放任务；事务回滚会丢弃待采集事件。无采样心跳不复制缓存测量，规范事件白名单排除凭据、指纹、任意载荷和任务输入。

## Provenance and unknowns / 来源与未知值

- A `trace-*` recording run is distinct from an experiment execution run. Missing experiment/provider/model/channel bindings remain `NOT_OBSERVABLE`.
- Source event time declares `CANONICAL_EVENT_WALL_UTC`; worker samples declare `EXTERNAL_DECLARED_WALL_UTC`. Capture uses host wall UTC plus process monotonic nanoseconds and a new restart epoch. A stale source timestamp is an age observation, not proof of clock skew.
- Software/config/implementation/review/CI/evidence references supplied to `createGateway({researchTraceSoftwareRefs})` are declared identities requiring external verification. Omitted identities remain null; branch names are not resolved or guessed at runtime.
- Every missing metric has `value:null` and a reason. A measured zero stays zero. Autonomous-span and task-transition metrics can be supplied by an authoritative producer; this foundation does not fabricate an autonomous campaign from ordinary product events.
- Versioned normalization is deterministic from the retained whitelisted raw row plus capture context. Rows include the raw-source SHA-256 digest and transform reference; normalized views do not duplicate canonical task/action state.
- Schema supports optional task/action/device/node/route/handoff references, retry/backoff/failure/recovery, intervention taxonomy, eligibility/wake/rescan, authority/watchlist/capability state, exact continuation and rule lifecycle/supervision/semantic integration observations. Unobserved external governance events are not automatically inferred from product activity.

记录运行不等同于实验运行。源时间与采集时间分开，重启产生新的单调时钟 epoch。软件身份是外部提供的声明，不是采集器自行验证的运行源码。缺失测量为 null 并带原因，实际 0 保留为 0；治理和自主运行数据不能从普通产品事件臆造。

## Bounds and failure behavior / 边界与故障

Defaults retain at most 256 memory records, 64 queued writes and two JSONL files of at most 2 MiB each. Limits are validated and capped. Rotation restores bounded previous/current references after restart and retains `retentionTruncated:true`; discarded history is never presented as a complete run. Queues, retention loss, sequence gaps, duplicates, reordering, stale timestamps, load/write/schema failures and unavailable metrics produce an explicitly partial view. Failure reports expose typed codes, not private exception messages.

默认最多保留 256 条内存记录、64 条待写记录以及两个各不超过 2 MiB 的文件。重启恢复有界历史并保留截断标记；丢失历史不会被显示为完整运行。队列丢弃、时序缺口和采集故障会明确标记 PARTIAL，仅显示故障代码，不暴露私有异常消息。

Capture never awaits storage on task execution paths. Shutdown waits at most 100 ms for the collector; a hung or failed writer must not stop City task/health operation. UI responses are fenced to the current credential, City, page and connectivity; technical identifiers are initially folded.

任务路径不会等待采集器存储；关闭最多等待 100 ms。写入挂起或失败不能阻止任务与健康接口。界面响应受当前凭据、城市、页面和连接状态约束，技术标识默认折叠。

Validation: `node --test tests/rex802-trace.test.mjs tests/rex802-gateway.test.mjs`; Android `:app:testDebugUnitTest :app:assembleDebug`. Controlled browser/Gateway fixtures and an OPPO offline entry check are engineering evidence. Native online rendering and different-physical-host Formal Review remain separate acceptance gates.

验证涵盖受控浏览器/Gateway 测试与 OPPO 离线入口；原生在线展示和异机正式 Review 尚需独立完成。
