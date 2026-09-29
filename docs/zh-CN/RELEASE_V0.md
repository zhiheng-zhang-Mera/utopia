# 产品 V0

Android Compose 与浏览器控制端通过平台中立协议操作相同的持久化城市状态。参考节点执行固定安全任务，产生真实文件 I/O。实机验收覆盖任务/结果/事件一致、Gateway 重启与 Wi-Fi 断开恢复。

精确测试实现与 APK 哈希记录于[验收文档](../../evidence/zh-CN/ACCEPTANCE_V0.md)。发布的 debug APK 是已安装到实机的版本；CI 使用独立 debug 签名密钥构建相同 Android 源码，因此 APK 字节可能不同。源码交付在 main，施工历史保留于 codex/product-v0。

[GitHub 检查](https://github.com/zhiheng-zhang-Mera/utopia/actions/workflows/ci.yml)执行 Windows Gateway/Web 测试、双语配对、Android 单元测试与 APK 构建。[发布下载](https://github.com/zhiheng-zhang-Mera/utopia/releases/tag/v0.1.0-product)包含实机 APK。不分发运行数据库或配对 token。

按主机与 Android 手册使用。本版本是 LAN 前台参考产品，仅含一个可信运行节点。后续范围保持 POST_V0。

STATUS: DIGITAL_CITY_PRODUCT_V0 = ACCEPTED
PAIR_STATUS: SYNCHRONIZED
