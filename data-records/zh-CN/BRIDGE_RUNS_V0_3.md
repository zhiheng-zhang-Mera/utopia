# V0.3 运行账本

PAIR_STATUS: SYNCHRONIZED
FACT: FINAL_WINDOWS_CASES=26
FACT: FINAL_ANDROID_CASES=25
FACT: MATCHED_CANONICAL_RESULTS=18

原始 JSON 保留全部失败和复核记录。下表按用例最后一次观测计数；记录数包含重试及同一调用的界面复核。

| Phase | Final cases | Records | Status | Evidence |
| --- | ---: | ---: | --- | --- |
| documents | 6 | 6 | PASS | [JSON](../../evidence/raw/v0.3/android-documents.json) |
| knowledge | 2 | 2 | PASS | [JSON](../../evidence/raw/v0.3/android-knowledge.json) |
| skills | 10 | 12 | PASS | [JSON](../../evidence/raw/v0.3/android-skills.json) |
| evidence-theme | 3 | 3 | PASS | [JSON](../../evidence/raw/v0.3/android-evidence-theme.json) |
| document-errors | 3 | 3 | PASS | [JSON](../../evidence/raw/v0.3/android-document-errors.json) |
| knowledge-temporary | 1 | 3 | PASS | [JSON](../../evidence/raw/v0.3/android-knowledge-temporary.json) |

Windows 26 项均通过。运行记录包含 runId、codeSha、apkSha256、client、capabilityId、operationId、inputClass、inputBytes、startedAt、finishedAt、latencyMs、status、errorCode、resultDigest。startedAt/finishedAt 对应任务书 startAt/finishAt。inputBytes 为序列化调用输入的 UTF-8 字节数；本地超大文件预检另注明文件字节数。早期未采集值保留 null；后补时间来自真实持久化调用。耗时为服务端执行时间，不含操作者与网络耗时。

证据审查另记录 integrityRoot、claimStatusCounts、decision、tamperResult。六种公开样例的精确字节与所有发布文件的 SHA-256 清单一并保存；无私人文档、凭据或设备 serial。

重放发布的 fixture-sample.* 字节时，将文件名恢复为 sample.*；canonical 文档结果包含文件名。
