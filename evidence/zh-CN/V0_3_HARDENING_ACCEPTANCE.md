# V0.3 加固验收

PAIR_STATUS: SYNCHRONIZED
STATUS: V0_3_HARDENING=PASS
FACT: BASE_MAIN=a6745686b4a85da9c6327546b8a20a55d023a2fd
FACT: BASE_CI=36539843220
CODE-SHA: 8c1106e3b6685a123dd5e75ef98ee52e8c9bba43
FACT: IMPLEMENTATION_CI=36548239748_SUCCESS
FACT: SUMMARY_DETAIL_SNAPSHOT_LIST_LIMITS=500_50_50_200
FACT: OLD_DB_MIGRATION=PASS_98_ROWS
FACT: ROOT_ROOM_CITY_ANDROID_TESTS=46_67_114_21
FACT: PROMOTION_HISTORY=PASS_9
FACT: WINDOWS_PHYSICAL_ANDROID_CASES=26_7
FACT: CROSS_CLIENT_DIGEST_MATCHES=5
FACT: APK_SHA256=521610d1f44add13a2cdbd1832b38ccc4e692d122d0d4197d2e9c8a602f52c0f
FACT: GLOBAL_THEME_APPLY=NO
FACT: PAPER_CLAIMS=PILOT

加固保留既有五项服务，分离有界摘要与结果详情，落实完整模块身份、生命周期可用性、真实 Theme 操作及 Android typed error。全部 City 模块仍保留原 lifecycle；Road、Activation、D9 属于后续阶段。

| 门禁 | 证据 |
| --- | --- |
| 旧库迁移、幂等、损坏记录回滚 | `tests/capability-history.test.mjs`；[真实迁移记录](../raw/v0.3-hardening/runtime-migration.json) |
| 560 条大型生成记录收敛为 500 摘要、50 详情 | history 测试，含有界 HTTP 列表、仅摘要快照 |
| 运行中任务不被清理，晚完成任务更新最近顺序 | history 测试，中间穿插 505 次任务 |
| 同名冲突、混合及 deprecated/planned lifecycle | `tests/capability-registry.test.mjs` |
| 拒绝假的 Theme validate，保留原适配器行为 | registry、adapter、Bridge 测试 |
| 按需详情、过期仍为 COMPLETED、延迟响应隔离 | `tests/web-services.test.mjs`；下列实机历史选择 |
| Android 错误码/状态/说明及旧 RUNNING 防覆盖 | `CapabilityRequestExceptionTest.kt`，总计 21 项 Android 单测及构建通过 |
| Windows 与 Android 实机产品操作 | [Windows 26 项](../raw/v0.3-hardening/windows-runs.json)、[Android 7 项](../raw/v0.3-hardening/android-attempt-1.json) |
| Room、City、promotion history 与回归总数 | [回归摘要](../raw/v0.3-hardening/regression-summary.json) |
| 云端干净运行器 | [实现 CI](https://github.com/zhiheng-zhang-Mera/utopia/actions/runs/36548239748)，两个 job 均成功 |

真实旧库含 98 条内嵌结果记录，迁移前创建本地私有备份。98 条摘要的身份、状态、时间戳、哈希完全保留；保留的 50 份详情哈希全部匹配。连续两次 Gateway 重启通过。观测到的城市快照调用片段为 18,519 字节且不含结果载荷；这不约束独立任务/事件历史，也不表示 SQLite 页已安全擦除。

实机 Android 0.3.1 APK 与本地构建哈希一致。文档读取、文档转知识、技能检查、证据审查、主题生成通过原生控件执行，结果哈希与 Windows 一致。手机另外选中 Windows 创建的主题和证据历史，加载预览与详情。已视觉检查四张公开输入截图，未捕获相机或活动配对材料。原 V0.3 验收保留为历史证据，未被本轮覆盖。

独立审查发现旧 RUNNING 快照可能抹掉刚完成的结果；已修复两端，并观察回归测试先失败、修复后通过。Android 切换操作、加载样例及打开文件选择器也会使旧详情回调失效。该审查未留下未解决的严重或重要问题。

[Manifest](../raw/v0.3-hardening/manifest.json) 覆盖八份脱敏材料。已通过已知凭据、设备标识及指定私人路径检查；不宣称通用秘密扫描覆盖。私有数据库备份和原始本地构建日志不发布。

加固分支为 `alien/v0.3-hardening-repair`。集成阶段须确认最终分支 CI、合入 main、确认 main CI，再创建 annotated tag `utopia-v0.3-hardening`。Tag 注释记录实际合并后的 main SHA 和 CI run，避免文档提交 SHA 自引用；完成该基线冻结后才进入 Wave3。

论文论断 C-HARDEN-01（有界调用可见性）、C-HARDEN-02（同名冲突下的完整身份）、C-HARDEN-03（生命周期可用性）均保持 PILOT，由专项测试及本轮有限运行支持；不外推一般性能或长期现场效果。
