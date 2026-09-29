# V0 验收

STATUS: DIGITAL_CITY_PRODUCT_V0 = ACCEPTED
SHA: 52217fd81fe9fba672e99f7df09a24b63014e9e5
TASK_ID: Q-74be4775-1d81-46c2-8de1-3b43593cebb7
FACT: androidSource=7fa99306a16fb2a7a43107c1afbe0ea77df2edbf
FACT: apkSha256=5e41f5ca109ca7304bf42d26cb749a5f1852de76904697d83c3348f18419d26e
FACT: android=OPPO-PERM00; os=Android-12; api=31; app=0.1.0; versionCode=1
FACT: host=Windows-10.0.26200; node=v24.19.0; gateway=0.1.0
FACT: taskState=COMPLETED; taskEvents=7; artifactBytes=65; artifactSha256=25b63368c214dab2c75a4a475b89bc0f368dd700603d14a06e4275eeace31f31; cleaned=true
FACT: restart=PASS; preservedTasks=2; preservedEvents=31; wifiReconnect=PASS; staleGreen=ABSENT
FACT: nodeTests=5; androidUnitTests=2; bilingual=PASS; platformNeutrality=PASS; repositorySeparation=PASS
PAIR_STATUS: SYNCHRONIZED

工作书九项门禁在参考环境中均已通过。Android 通过真实 LAN 创建标准 CHECKPOINT_DEMO；独立 Alien 节点写入 65 字节文件、记录检查点、计算哈希并清理。Android 与可见的 Microsoft Edge Web 控制端展示相同 Task ID、终态、结果及全部七条任务事件。最终标准任务在安装连接诊断版本后执行；先前的冒烟任务也保留在历史中。

Gateway 重启保留两个任务和重启前全部 31 条事件，按稳定事件 ID 与完整 payload 逐条对比。双端均恢复连接。通过 ADB 关闭并恢复真实 Wi-Fi；UI 树记录 OFFLINE 和节点 UNKNOWN，随后 ONLINE；连接日志也记录 RECONNECTING。最终网关包含单独测试过的 ASSIGNED 到 FAILED 报告修复；Android 源码自上述 source SHA 起未变。

门禁结果：构建 PASS；LAN 连接 PASS；真实任务 PASS；共享事实 PASS；持久化 PASS；重连 PASS；平台中立 PASS；仓库职责分离 PASS；双语审计 PASS。平台审计检查协议和任务语义；Windows 代码在文件适配器后，platform 仅为 metadata。所有施工限定 Utopia，未修改 Digital-City、Boss 或 Hns。

证据：[任务界面](../raw/android-task-final.png)、[Web 界面](../raw/web-task.png)、[事件](../raw/android-events-final.png)、[离线](../raw/android-wifi-offline.png)、[恢复](../raw/android-wifi-restored.png)、[重启](../raw/android-restarted.png)、[双端一致](../raw/shared-truth.json)、[恢复结果](../raw/recovery-result.json)、[连接变化](../raw/connection-transitions.json)。配套原始 UI 树与图片并列保存。未使用 Computer Use 工具；ADB 与 Playwright 操作真实界面，并人工视觉检查截图。

已知限制：仅一台 Android 实机与一个 Windows 参考节点；仅前台 LAN HTTP/WS；共享控制 token 与可信节点 token；不支持任意 shell、公网、后台服务、多节点故障转移或 Boss/Hns 迁移。节点突然退出可能留下受限临时文件。上下文压缩配置未修改：环境未提供本聊天的原始阈值或仅压缩前半部分的控制入口。

CI 与交付引用见 RELEASE_V0.md。APK 可从 release 获取，本地位于 apps/android/app/build/outputs/apk/debug/app-debug.apk。
