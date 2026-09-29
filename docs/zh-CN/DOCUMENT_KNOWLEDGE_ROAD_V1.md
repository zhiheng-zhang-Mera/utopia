# Document → Knowledge Road v1

PAIR_STATUS: SYNCHRONIZED
FACT: ROAD=document-knowledge-v1
FACT: TRUST=UNVERIFIED
FACT: SHELF=temporary
FACT: DOMAIN=document
FACT: PERSISTENCE=NONE
FACT: MAX_SECTIONS=200

`contracts/city-roads/document-knowledge-v1/` 拥有文档接入站到知识服务所的语义契约，包含 JSON Schema、纯 ESM 映射 SDK、校验器和一致性测试。它不启动进程、读取文件、访问网络、时钟或数据库。Bridge 的 `fromDocument` 通过 SDK 调用 `knowledge-core`，不再拥有重复映射。

`documentSectionsToKnowledgeEntries(sections)` 接收解析器产生的 `{kind, heading?, text, start, end}`。正文和可选标题必须为字符串；来源边界为非负安全整数且 `end >= start`。边界保留原解析器单位，例如 PDF 页位置，不冒充统一字符偏移。允许并忽略 heading level 等解析器附加元数据。

输出保持数组顺序，ID 为 `document-0`、`document-1` 等，标题取 heading 或 `Section N`，正文不变，固定 `tags:["document"]`、UNVERIFIED/temporary/document 标签及 epoch `updatedAt`。ID 在一次临时文档查询内确定，不宣称跨永久多文档库全局唯一。每次调用返回独立对象，调用方传入的 trust、shelf、domain、ID 不会提高输出权限。

`validateDocumentSections` 与 `validateTemporaryKnowledgeEntries` 返回 `{ok,errors}`，错误只描述字段，不回显文档正文。输出校验器还检查 ID 与数组顺序。非法章节映射抛出带 `INVALID_DOCUMENT_SECTIONS` 的 `RoadContractError`；Bridge 对缺少文档保留 `DOCUMENT_REQUIRED`，对超过 200 章节保留 `INVALID_ENTRIES`。严格非法输入校验是新增契约边界；有效解析器输出维持原映射行为。

`node --test tests/city-roads.test.mjs` 执行 Road 一致性及 Bridge 等价测试。六份确切公开 TXT/JSON/YAML/DOCX/XLSX/PDF 样例的检索哈希，与提炼前加固主线 `393f3b89a9c4fae61be1e431c4bcd47fee945e88` 观测一致。根 CI 包含这些测试。本次提炼不改模块 promotion 来源或 lifecycle。
