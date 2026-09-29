# Wave3 运行台账

PAIR_STATUS: SYNCHRONIZED
STATUS: SERIES=PASS
CODE-SHA: c31035f9fd7e40a63033dcd1d63fde1629a8f31b

仅使用生成／公开 fixture。历史 hardening 运行保留为独立系列。D9 Room 运行绑定 `28673e1`；City promotion 和 Alien 运行分别绑定后续 SHA。不发布原始私人 SQLite、配对材料、credential、设备标识或本地绝对路径。

本地最终回归：root 56、Room 67、City 129、Android unit 21 全部 PASS；assembleDebug PASS；十条 promotion 记录 PASS。Windows 原有能力回归 26 项 PASS；原生重试 7 项 PASS。D9 Windows／Android 各三项 PASS，三组完整跨端 digest 匹配。真实 Gateway 三项 typed refusal PASS；六个成功包及结果详情重启后保留。首轮原生验收因启动器处于前台、Services 不可见，在任何调用前结束；保留这次失败，不计为产品成功。

[Raw manifest](../../evidence/raw/wave3/manifest.json) 包含已有 Room／activation／freeze 材料、Windows 构建／回归记录、所有已保存报告的原生尝试、真实重启／拒绝记录、回归总数及四张新检查截图。脱敏 JSON 用 SHA-256 表示结果 PNG 字节，截图展示真实预览。实测期间产品实现保持在记录的 SHA；证据文档及显式启动应用的 driver 修正在独立整理中。实现前旧 APK 控件探测按预期失败，不作为产品验收。

复现：`node --test tests/*.test.mjs`；`node --test apps/rooms/tests/*.test.mjs`；`node city/test-all.mjs`；`node scripts/verify-promotion-history.mjs`；`pnpm check:docs`；Android `gradlew testDebugUnitTest assembleDebug`。本地已配对实机先运行 `scripts/d9-windows-pilot.mjs`，再运行 `scripts/d9-android-pilot.mjs`，私有 runtime 配置由本地提供。它们不创建云端 credential，也不以纯 API 调用替代原生 UI 验收。
