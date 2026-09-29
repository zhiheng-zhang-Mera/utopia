# Wave3 验收

PAIR_STATUS: SYNCHRONIZED
STATUS: WAVE3=ACCEPTED
CODE-SHA: c31035f9fd7e40a63033dcd1d63fde1629a8f31b
FACT: HARDENING=PASS
FACT: ROAD_ACTIVATION=PASS
FACT: D9=CITY_PROMOTED
FACT: ROOT_ROOM_CITY_ANDROID_TESTS=56_67_129_21
FACT: PROMOTION_HISTORY=PASS_10
FACT: GLOBAL_THEME_APPLY=NO
FACT: THEME_LIFECYCLE=PROMOTED
FACT: PAPER_CLAIMS=PILOT
FACT: WINDOWS_ANDROID_BUILD_CASES=3_3
FACT: CANONICAL_DIGEST_MATCHES=3
FACT: RUNTIME_RESTART_REFUSALS=PASS

Hardening 已在 main `393f3b89a9c4fae61be1e431c4bcd47fee945e88` 以 annotated tag `utopia-v0.3-hardening` 冻结，main CI 36549170404 成功。保留 500 条调用摘要／50 份详情；City 快照最多包含 50 条摘要且不带完整结果。真实 98 行迁移及两次重启通过。qualified identity、遵守生命周期的可用性和 Android typed error 持续受回归覆盖。

Road 实现 `762d677` 将已有映射提炼为纯 `document-knowledge-v1` SDK、schema 和 validator。六种文档格式的冻结 digest 不变；稀疏数组校验在合并前修复。独立 activation `bddf448` 将 ingestion-core、document-readers、knowledge-core、skill-intake、evidence-engine 改为 ACTIVE。Wave3-A 合并至 `7e97a4b6402f5828a4928e8194051a5cf2634e19`，main CI 36551626680 成功。

| D9 gate | 证据 |
| --- | --- |
| 固定 donor／最小闭包 | DS-Hns `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b`；七个新增文件及六个复用 City 依赖；[审计](../../docs/zh-CN/D9_DONOR_CLOSURE_AUDIT.md) |
| Parity／回退／几何／沙箱 | City theme-engine 的 12 项 core＋3 项冻结 oracle 测试；真实字节／像素、最终缩放后重试、保护面及原子输出校验 |
| Room 产品 | `28673e1` 上三项持久浏览器案例；[Room 验收](D9_ROOM_ACCEPTANCE.md) |
| 已验收 Room | `3ff7d805f0432d39499bee10741f54d3ec98f3de` |
| City promotion | `74c277cbc2a44fc045b8c81e8e401df3729fbf28` |
| 退役 | `b16df6335a9ee459a5792f99fbb838cbb2a2600a`；删除 active incubator，十条真实祖先记录校验通过 |
| 主线集成 | PR #7 → `c7281da185b21e330cd02bbae044702ed2c3e77c`；main CI 36555381764 成功 |

Alien 实现 `3da5ed2` 加入真实 build adapter 及 Windows／Android 控件。Gateway 管理输出路径，独立于调用历史保留最近八个成功包，重启清理未完成任务。完整结果不进入 `/city`，按需加载有界预览和 digest。存储失败回归确保返回终态 typed error，而非遗留 RUNNING。审查复现并修复了 500 次无关调用后重启删除主题包的问题，独立复验确认产物保留。

Windows 原有能力实测 26 项 PASS；Android 实机回归 7 项 PASS，包含五项 canonical digest 匹配及重开 Windows 主题／证据历史。Windows 构建实测三项 PASS，预览／包 digest 可见，刷新后可恢复详情。Android 实机通过原生控件完成同样三项，canonical 结果及意图／计划／包／内容／校验 digest、判定全部与 Windows 一致。有观测离线、无观测离线和无观测注入失败均通过，最后一项报告七个程序化回退资源。APK 0.3.2 SHA-256：`f3b2bcc6115e7cc0cefe1b12ad6c5454e001005bc2065db3497a27a40306e043`。

真实运行时拒绝／重启实测：路径逃逸、受保护外部表面和无效观测返回明确 typed code，没有删除成功产物。六个成功包及其详情／digest 经真实 Gateway 重启后保留，快照仍只带摘要。四张新增公开输入截图已逐张检查。[Raw manifest](../raw/wave3/manifest.json) 绑定脱敏运行记录、保留的失败尝试和截图。未使用桌面 Computer Use；原生操作来自 adb 界面树控件。

[实现版本云端 CI 36556676840](https://github.com/zhiheng-zhang-Mera/utopia/actions/runs/36556676840) 成功。最终集成／冻结须在 annotated `utopia-wave3` tag 中记录真实合并 SHA 和成功的 main CI；本文不伪造自引用 SHA。

范围限制：仅生成／公开输入，一个 Windows 主机和一台 Android 12 实机。桌面观测是生成样例，不是屏幕感知。没有真实图像 provider、全局 Apply、registry／lifecycle／recovery 产权或 official renderer 集成。Theme 保持 PROMOTED、产权审查待完成；未来未桥接模块保持 BRIDGE_PENDING，不阻塞 Mech 或已有服务。V0.4 与 Boss／Hns runtime 不在本工作书范围。
