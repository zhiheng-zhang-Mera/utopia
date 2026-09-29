# Wave2 维修验收

PAIR_STATUS: SYNCHRONIZED
FACT: WAVE2_REPAIR=PASS
FACT: REPAIR_SOURCE_SHA=bd59fadda788594ec7eb6d95d6d9a4c5bd3ff5cb
FACT: POST_REPAIR_MAIN_SHA=374fad597387278f981c21f8897e772adc5922e8
FACT: REPAIR_MAIN_CI=36530886378_PASS
FACT: D5_LIVE_GITHUB=PASS
FACT: MECH_FUTURE_MIGRATION_BLOCKED_BY_ALIEN=NO

短维修分支经 PR2 合并后，才建立能力桥分支。维修后基线：主测试27、Rooms67、City114、晋升历史9、Android16项单元测试与构建、双语文档均通过。Alien 真实网络 GitHub Code Search 返回 HTTP200 和五项结果；真实在线及受控在线失败时六项离线条目均保留，技能检查可用。最终在线记录绑定干净源码 bd59fad。

目录字段只承诺解析来源与预览，不承诺安装。Evidence 来源区分一致规则、移植适配与 Utopia 扩展。D6b 继续延期，地图只读核验，City 生命周期均保持 PROMOTED。未修改 donor 仓库。

后续能力桥在真实网页验收中发现 donor 默认行为静默跳过不安全归档路径，因此增加可选的严格读取模式；保留原默认行为并记录桥接拒绝边界。原始失败 Windows 试验将在 V0.3 证据包保留。
