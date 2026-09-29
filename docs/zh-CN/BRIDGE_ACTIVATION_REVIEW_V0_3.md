# V0.3 产品消费激活审查

PAIR_STATUS: SYNCHRONIZED
FACT: CITY_LIFECYCLE=PROMOTED_PRESERVED
FACT: AUTOMATIC_ACTIVE=NO
FACT: THEME_OWNERSHIP=REVIEW_PENDING
FACT: D6B=DEFERRED_SCOPE_ALLOCATION
FACT: MECH_FUTURE_MIGRATION_BLOCKED_BY_ALIEN=NO

| 所属模块 | 显式产品消费者 | 保留边界 |
| --- | --- | --- |
| ingestion-core | Services 文档读取及文档转知识映射 | 在本地 City 执行；不保留原文件字节 |
| document-readers | Services DOCX/XLSX/PDF 读取 | 限制文件、页数、行数和解压大小；不承诺通用文档保真 |
| knowledge-core | Services 临时条目及文档映射查询 | 不创建隐藏永久知识库；匹配结果保留在调用历史 |
| skill-intake | Services 引用、SKILL.md、归档和目录检查 | 无安装器、远程代码执行及包生命周期界面 |
| evidence-engine | 可选 Services 审查及篡改消费者 | 完整性及引用检查不证明事实真实；不是强制业务中介 |
| theme-engine | Services 生成、预览和校验 | 所有权待审查；无全局应用或 D6b 构建器 |

产品消费证据与 City 生命周期分别记录。本审查不修改 manifest 或重写 promotion 历史。后续已晋升模块可以保持 BRIDGE_PENDING，不阻塞这些消费者。运行状态 AVAILABLE/DEGRADED 不等于生命周期晋升。
