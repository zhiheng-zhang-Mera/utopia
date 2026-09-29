# Capability Bridge V0.3 验收

PAIR_STATUS: SYNCHRONIZED
FACT: WAVE2_REPAIR=PASS
FACT: ALIEN_CAPABILITY_BRIDGE_V0_3=ACCEPTED
FACT: WINDOWS_UI_CASES=26
FACT: ANDROID_UI_CASES=25
FACT: CANONICAL_DIGEST_MATCHES=18
FACT: WIFI_RECOVERY=PASS
FACT: GATEWAY_RESTART=PASS
FACT: RUNNING_TO_INTERRUPTED=PASS
FACT: STALE_GREEN=NO
FACT: ROOT_TESTS=36_PASS
FACT: ROOM_TESTS=67_PASS
FACT: CITY_TESTS=114_PASS
FACT: PROMOTION_HISTORY=9_PASS
FACT: ANDROID_TESTS=17_PASS
FACT: APK_SHA256=5cf75592f74f62da7745dff18caf68a5fd2064b2aeeaef2e98447c60146144a3
FACT: PROMOTED_LIFECYCLE_PRESERVED=YES
FACT: D6B=DEFERRED_SCOPE_ALLOCATION
FACT: THEME_OWNERSHIP=REVIEW_PENDING
FACT: MECH_FUTURE_MIGRATION_BLOCKED_BY_ALIEN=NO

五项服务已通过可见 Edge 界面和连接的 Android 实机使用同一个 City 权威服务。Android 六种生成文档均从 ACTION_OPEN_DOCUMENT 系统选择器选择。Windows 最终 26 项通过；Android 最终 25 种用例通过，包括不创建调用的本地超大文件拒绝。18 项成功结果的 canonical 摘要全部一致。预期失败输入保持 FAILED，不伪装成功。

| 能力 | Windows | Android | 实际边界 |
| --- | --- | --- | --- |
| 文档读取 | PASS | PASS | TXT/JSON/YAML/DOCX/XLSX/PDF；损坏 JSON、截断 PDF、超大文件拒绝 |
| 知识查询 | PASS | PASS | 临时条目及真实文档章节映射；canonical 结果一致 |
| 技能检查 | PASS | PASS | 六种引用或拒绝、有效/损坏 SKILL.md、安全/不安全归档；Windows 离线目录 |
| 证据审查 | PASS | PASS | 完整性根、论断状态、判定和摘要一致；篡改返回 ARTIFACT_HASH_MISMATCH |
| 主题实验室 | PASS | PASS | 相同参数和 PNG 结果；可见预览与校验；不全局应用 |

断开 Wi-Fi 后 Android 明确显示离线并禁止调用；重连不重复历史。网关重启保留 City 身份及已完成调用的 ID/摘要。真实 Windows 界面调用在终止进程前被观察为 RUNNING，重启后为 INTERRUPTED/GATEWAY_RESTARTED，两端均可见；这与预置 RUNNING 的单元测试分开记录。

修复 [PR #2](https://github.com/zhiheng-zhang-Mera/utopia/pull/2) 从原始 4ac287b5dd6cd7214c0129b23bb1cad09aab0e97 基线推进并合入 374fad597387278f981c21f8897e772adc5922e8。最终 Windows 源码为 65ae358809e997f2a644716ca2c0d601fb919492。Android 源码为 fdb48c3；之后 Bridge/Web 修改未改变已安装 APK。[完整云端回归](https://github.com/zhiheng-zhang-Mera/utopia/actions/runs/36538170564) 在 05307163ab8a43425f58b7d686d221d0db408742 通过。后续交付提交与合并由各自 CI 独立检查。

未来模块门禁在克隆 manifest 中追加未桥接模块，并实际调用既有五个适配器；浏览器回归在请求执行中切换到待接入描述符。这些测试不冒充真实未来迁移的观测。既有生命周期均保留 PROMOTED。

早期不安全归档误接受、文件选择器提供方查找失败、引用清除错误、视口漏读均保留在原始证据中。修复或复核后的成功不改写成首次成功；当前产品门禁采用每个用例的最终观测。

限制：仅一台实机与生成的公开样例；文件 1 MiB、并发两个 worker、执行 20 秒、结果 3 MiB。服务端耗时不是用户端到端性能。临时知识不创建永久知识库，但明确保留调用结果。证据只验证完整性与声明引用，不证明外部事实。技能安装、外部 provider 自动化、主题全局应用与 D6b 不在范围内；主题所有权待审查。

参见[原始清单](../raw/v0.3/manifest.json)、[运行账本](../../data-records/zh-CN/BRIDGE_RUNS_V0_3.md)、[激活审查](../../docs/zh-CN/BRIDGE_ACTIVATION_REVIEW_V0_3.md)及[修复验收](WAVE2_REPAIR_ACCEPTANCE.md)。截图已目视检查；交付审计检查已知凭据、连接设备标识、选定私人路径及两份原始清单，不构成全面安全认证。
