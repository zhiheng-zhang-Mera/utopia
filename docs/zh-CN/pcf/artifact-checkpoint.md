# 工件与检查点组件证据

Stage B 仅扩展已有授权文件适配器。pin/lease 在索引持久化，驱逐跳过受保护项。撤销先记录 DELETE_PENDING，再删除文件；失败保留 DELETE_FAILED，读取拒绝已撤销工件。opaque transfer ID 允许适配器重启后续传；append 校验 offset、digest 和 source version，完整校验之前 partial 不进入可读工件索引。孤儿 blob 使配额准入保守拒绝；陈旧 writer lock 需操作者恢复，不自动删锁。

repositorySnapshotManifest 记录显式 repo/commit 与选定 dirty 文件摘要，拒绝路径穿越及常见凭据文件名，不执行复制或 git pull。任意文件名仍可能含秘密，调用方必须选择获准内容。

restoreCheckpoint 保留同 attempt 行为；显式 approved、sourceAttemptId、targetFence 可允许新 attempt 恢复，原始绑定不改写。task/input/provider/stage 及提供的 executor/runtime/model/platform/dependency 必须一致；副作用必须 NONE，已提交结果拒绝恢复。权威 fence 与批准验证由调用方负责，本组件不签发 fence，不替代 checkpoint-gate。

测试使用真实临时文件及分块整数 CPU 求和；恢复 cursor=500 后的最终摘要与连续 1000 步一致。证据为 .runtime/pcf-stageb-artifacts-{red,manifest-red,green}.log。仅为本地组件证据。双机网络传输、两个真实 worker、集成/UI、磁盘满注入、删除失败注入、最终 CI 和跨主机复核均 NOT_RUN。

## 复核修复

cancelTransfer 与 cleanupExpiredTransfers 在 DELETE 授权后清理 partial 并释放 bytes/items 配额；失败保留 cancelled DELETE_FAILED journal，transferStatus 可查询并重试。过期不代表获得删除权限，清理跳过已发布工件。已撤销传输需显式授权取消。PUBLISHING journal 覆盖 rename 到 index 发布间隙，重试校验实际字节/摘要并只发布一个引用。descriptor 清理失败返回已发布引用并记录 PUBLISHED_CLEANUP_FAILED，重试清理且不双算配额；未知孤儿 blob 仍保守拒绝。storageIo 是显式可信适配器接口，测试注入 ENOSPC/EACCES；这不是实际磁盘已满的证据。

新 attempt 恢复缺少 executor/runtime/model/platform/dependency 绑定时拒绝；只有 workloadKind CPU 可使用 modelVersion NOT_APPLICABLE_CPU。必须提供 approval.validateFence(targetBinding, {sourceBinding,artifact,targetFence})，由调用方核验 canonical 源允许状态及目标 attempt/epoch/holder；组件不签发 fence。持久化、授权恢复 claim 使每个目标 task/attempt 仅释放一次恢复状态；重试（含适配器重启）拒绝 CHECKPOINT_RESTORE_ALREADY_CLAIMED。最终结果提交及 fence 有效性仍归 canonical owner。缺少完整兼容性字段的旧同 attempt 恢复仍支持，但明确较弱，不能作为已验证的新 attempt 恢复证据。

修复证据：.runtime/pcf-stageb-artifacts-{repair-red,fence-red,publication-red,repair-green,repair-regression}.log。修复测试 10/10，现有范围回归 21/21；观察到本地故障注入、损坏和撤销发布拒绝。实际磁盘满、双机验收、最终 CI、复核主机验收仍 NOT_RUN。

再次复核配额修复：journal 所有的 DELETE_PENDING/DELETE_FAILED blob 仍不可读取，但按实际 bytes/items 计入配额，允许余量内的其他准入；未知 blob 仍拒绝。连续注入 index ENOSPC 与删除 EACCES，观察清理重试和配额释放；.runtime/pcf-stageb-artifacts-journal-quota-{red,green}.log 记录 RED 及 22/22 范围 GREEN。物理验收标签仍 NOT_RUN。
