# Android 实机运行手册

使用 Java 17+ 与 Android SDK 36。在未跟踪的 `apps/android/local.properties` 或 ANDROID_HOME 配置 SDK。在 apps/android 运行 `gradlew.bat :app:testDebugUnitTest :app:assembleDebug`。通过 `adb install -r` 安装 `app/build/outputs/apk/debug/app-debug.apk`；必要时确认手机安装弹窗。启动包名 city.utopia.control。

Settings 包含 City URL、配对 token 和诊断。输入 Gateway 局域网 URL 和主机私有配置中的控制 token，保存并连接。token 保存在 app-private preferences，已禁用备份。不得将其放入截图、日志或 GitHub。

Home 展示连接、节点、统计和 Run Test Task。Tasks 展示状态、进度、节点、检查点、结果和取消。Activity 展示权威事件序列。在手机创建 CHECKPOINT_DEMO，对照其 ID、状态、事件顺序和 SHA-256 结果与浏览器一致。

已有历史任务时重启 Gateway，验证双端恢复相同历史。应用可见时关闭再开启 Wi-Fi；OFFLINE 和 RECONNECTING 不得展示为实时健康节点。重连后验证新快照和事件流。移动数据若可用可以保持开启；蜂窝网络无法访问私有 LAN 主机。

本参考实现面向前台，使用开发期明文 LAN 传输，不是后台守护程序或应用商店版本。scripts/device.mjs 辅助脚本通过 ADB 操作，截图/UI dump 保存在本地 `.runtime/evidence/`。

FACT: minSdk=26; compileSdk=36; targetSdk=35; versionName=0.1.0
PAIR_STATUS: SYNCHRONIZED
