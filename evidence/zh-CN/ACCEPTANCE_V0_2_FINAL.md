# V0.2 最终发布验收

STATUS: ACCEPTED
PAIR_STATUS: SYNCHRONIZED
FACT: UTOPIA_V0_2=ACCEPTED
CODE-SHA: 25f1ec019296a8f4f06dc06ee591d99647fcdc4f
FACT: PRODUCT_APK_SHA256=ec30b0829a242aac05e604d3ade1aa5e91da2bbe45d22d4d9b5bcef222a5c9a7
FACT: EVIDENCE_MANIFEST=158_FILES_VERIFIED
FACT: RESEARCH_CLAIMS=PILOT

本报告替代源码包中的发布前检查点。ACCEPTED 指一台 Windows 主机与一台 Android 实机上的 V0.2 有界工程验收，交付物与本报告一同发布；不代表普遍可靠性，也不代表另行提出的上下文压缩设置已完成。

| 门禁 | 核验结果 |
|---|---|
| A | 合入后 Android 实机任务由真实 Node 完成；Android/Web 任务与结果一致。网关重启后城市身份及此前六项任务保留。 |
| B | CPU、内存、磁盘、运行时长、版本、最近在线与能力可见；Android/主机时间戳及 Web 精确采样核验通过，两张截图已目视检查。 |
| C | 当前 APK 五次扫码成功，另一次恢复成功；真实等待五分钟后两次拒绝过期码，两次拒绝已替换但未到期的旧码。两次过期扫描共用一个会话；API 单次使用拒绝另有验证。 |
| D | 历史真实网络 mDNS 配对5/5、消失恢复2/2，后续错误码界面2/2，均保留各自源码与 APK 归属。 |
| E | 真实 BLE 配对5/5、蓝牙开关2/2、后续定向配对1/1；未使用硬件不支持豁免。 |
| F | 手动基线5/5及当前 APK 恢复通过。 |
| G | Wi-Fi、网关、Node 恢复各3/3，九次确认断线观察；缓存与实时状态及重连快照核验通过。采样不能证明瞬时过期状态持续时间绝对为零。 |
| H | 交付脱敏原始试验、环境、每次来源、失败记录、双语论断账本及158文件哈希清单。研究论断仍为 PILOT。 |
| I | 发布资产包括精确源码、实机验证 debug APK、双语文档、本报告、脱敏数据、证据清单和 SHA256SUMS。 |

Android 文件树等于2607912；合入后的实机回归绑定937e1dc，后续 main 改动仅涉及 Rooms/City，另行测试。摄像头实际读回1倍/1.45倍/2倍及 continuous-picture 对焦。屏幕二维码放大与摄像头变更存在重叠，不能据此单独归因自动变焦的改善。历史机制测试不冒充当前 APK 的五次测试。

未发布活动二维码、预览画面或永久凭据。394文件已知值与路径有限审计问题为零，不是通用秘密检测。Computer Use 使用次数为零。最终 CI 及 GitHub 集成来源见 RELEASE_PROVENANCE.json。
