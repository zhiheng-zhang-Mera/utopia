# Wave3 独立 Activation Review

PAIR_STATUS: SYNCHRONIZED
STATUS: WAVE3_A=PASS
FACT: ACTIVE_MODULES=ingestion-core,document-readers,knowledge-core,skill-intake,evidence-engine
FACT: THEME_LIFECYCLE=PROMOTED
FACT: THEME_OWNERSHIP=REVIEW_PENDING
FACT: AUTOMATIC_ACTIVE=NO
FACT: ROOT_CITY_PROMOTION_GATES=51_114_9

加固主线 `393f3b89a9c4fae61be1e431c4bcd47fee945e88` 及 CI `36549170404` 通过后才开始 Road。提炼提交 `762d677f1981` 保持六种文档检索哈希。本次审查随后批准五项明确 lifecycle 变化，放入独立 activation commit，不由 Bridge 自动修改 manifest。

每个候选均通过九项条件：真实 accepted-Room 与 promotion 提交是审查源码的祖先；所属模块 focused/parity 测试通过；存在真实运行时消费者；Windows 产品验收通过；Android 产品验收通过；完整身份 descriptor 为 AVAILABLE；manifest/DONOR 的归属一致且审阅记录无未决争议；操作语义真实；恢复保持结果身份与哈希。逐模块证据见 [activation-review.json](../../evidence/raw/wave3/activation-review.json)。

| 完整模块身份 | 支持 ACTIVE 的已验收消费 |
| --- | --- |
| 09-planning-knowledge/02-document-intake/ingestion-core | Document Intake 的 TXT/JSON/YAML 与显式 Document→Knowledge Road |
| 09-planning-knowledge/02-document-intake/document-readers | 真实 DOCX/XLSX/PDF 解析，含历史 Android 系统选择器实机案例 |
| 09-planning-knowledge/01-knowledge-service/knowledge-core | 临时条目和文档检索，不声称永久知识库 |
| 02-engineering/02-worker-gateway/skill-intake | 引用、SKILL、归档及目录检查，含危险归档拒绝，不声称安装器 |
| 06-research/01-research-institute/evidence-engine | Review 与篡改拒绝；检查完整性及引用，不验证外部事实 |

证据组合为[完整历史 V0.3 产品系列](../../evidence/zh-CN/BRIDGE_ACCEPTANCE_V0_3.md)、[本轮加固验收](../../evidence/zh-CN/V0_3_HARDENING_ACCEPTANCE.md)、六格式 Road 等价测试，以及变更后新跑的根 51、City 114、promotion-history 9 项门禁。所属模块实现文件相对加固基线未变。历史实机证据继续标注历史，不改写成新设备运行。

Theme 因产权审查和 D9 promotion 尚未完成而保持 PROMOTED。既有 Room 接受提交、promotion 记录、donor SHA 均未改写。Availability 仍是独立运行时状态；未来无桥接的 PROMOTED 模块可保持 BRIDGE_PENDING，不阻塞 Mech 或现有消费者。
