# Digital City 拓扑增量 — Wave3

PAIR_STATUS: SYNCHRONIZED
STATUS: WAVE3=IN_PROGRESS
FACT: ROAD=document-knowledge-v1
FACT: ACTIVE_COUNT=5
FACT: D9=NOT_YET_PROMOTED
FACT: THEME_OWNERSHIP=REVIEW_PENDING
FACT: GLOBAL_THEME_APPLY=NO
FACT: MECH_FUTURE_MIGRATION_BLOCKED_BY_ALIEN=NO

文档接入站 → 知识服务所现有版本化纯 Road 契约，位于 `contracts/city-roads/document-knowledge-v1/`，不是 daemon。

五个既有模块经独立审查晋升 ACTIVE：ingestion-core、document-readers、knowledge-core、skill-intake、evidence-engine。Activation 不新增 District、Building 或 Module。

Theme Engine 保持 PROMOTED。D9 计划在 donor 闭包审计、Room 等价及产品验收、明确 promotion 后，以第三个 Room `theme-builder-lab` 强化该模块；本增量不将这些步骤写成已完成。全局主题应用和运行时归属继续延期。

这是 Utopia 侧增量，不修改独立 Digital-City 仓库，不以地图同步作为 Mech 或运行时施工门禁。
