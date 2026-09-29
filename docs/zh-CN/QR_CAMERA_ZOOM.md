# QR 相机缩放

PAIR_STATUS: SYNCHRONIZED
FACT: QR_ZOOM=BOUNDED_AUTOMATIC_SWEEP
FACT: QR_ZOOM_MAX=2X

离线扫码器等待解码时，在硬件支持的档位内循环尝试 1x、1.5x、2x，再回到广角。请求连续对焦，并使用扫码库的硬件回退。这是有限范围的自动缩放循环，不是二维码位置追踪；仍需将完整二维码放入视野。不支持缩放时，相机保持正常倍率。离开扫码界面后取消后续调节。

应用私有 `scan-camera-events.jsonl` 只记录时间、缩放支持、请求倍率、此前读取的倍率及对焦模式。请求成功不等于硬件已应用。日志不含图像或解码内容，扫码界面恢复时重置。负向相机测试逐次按白名单收集这些诊断，最多等待 120 秒观察拒绝事件。新实机记录必须绑定新 APK；旧 APK 证据保留原身份。

实现使用 [ZXing Android Embedded 4.3.0](https://github.com/journeyapps/zxing-android-embedded/tree/v4.3.0) 的相机参数回调。单元测试覆盖硬件上限、2x 限制、回到广角和能力缺失；真实缩放及过期码结果另存验收证据。