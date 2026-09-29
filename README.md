# Utopia · Digital City

Android + Web 控制端，通过平台中立协议驱动真实运行节点。产品优先，证据仅服务验收。

Android + Web control surfaces driving a real runtime node through a platform-neutral protocol. Product first; evidence supports acceptance.

THIS REPOSITORY IS A PRODUCT/REFERENCE IMPLEMENTATION BOUNDARY,
NOT THE FUTURE CITY CORE OWNERSHIP MODEL.

本仓库是产品/参考实现边界，不代表未来 City Core 的永久所有权边界。

| 中文 | English |
|---|---|
| [中文文档入口](docs/zh-CN/) | [English docs](docs/en/) |
| [中文证据入口](evidence/zh-CN/) | [English evidence](evidence/en/) |
| [中文数据记录](data-records/zh-CN/) | [English data records](data-records/en/) |
| [主机运行手册](docs/zh-CN/RUNBOOK_ALIEN_WINDOWS.md) | [Host runbook](docs/en/RUNBOOK_ALIEN_WINDOWS.md) |
| [Android 实机](docs/zh-CN/RUNBOOK_ANDROID_REAL_DEVICE.md) | [Android physical device](docs/en/RUNBOOK_ANDROID_REAL_DEVICE.md) |
| [V0.2 设备中心与配对指南](docs/zh-CN/V0_2_OPERATOR_GUIDE.md) | [V0.2 device center and pairing guide](docs/en/V0_2_OPERATOR_GUIDE.md) |
| [V0.2 验收状态与缺口](evidence/zh-CN/ACCEPTANCE_V0_2.md) | [V0.2 acceptance status and gaps](evidence/en/ACCEPTANCE_V0_2.md) |

V0.2 当前为 `NOT_ACCEPTED` 候选版本；真实摄像头扫码验收尚未完成。各批实机记录分别绑定其代码与 APK 哈希。

V0.2 is a `NOT_ACCEPTED` candidate; real-camera QR acceptance is incomplete. Each device trial series retains its own code and APK hashes.

## 本地运行 / Run locally

Node.js 24+, pnpm, Java 17+ and Android SDK 36.

```powershell
pnpm install --frozen-lockfile
.\scripts\start-city.ps1 -BindAddress <your-LAN-IPv4>
```

浏览器访问输出的 URL，使用 `.runtime/local-config.json` 的 `token` 登录 Web，然后在 Pairing 页面生成临时二维码或短码。Android 支持扫码、局域网发现、蓝牙发现及手动连接。不得分享该文件或永久 token。局域网开发用途，禁止公网暴露。

Open the printed URL and sign into Web using `token` in `.runtime/local-config.json`, then generate a temporary QR or short code on Pairing. Android supports QR, LAN discovery, Bluetooth discovery, and manual connection. Never share this file or permanent token. LAN development only; do not expose publicly.

```powershell
pnpm test
pnpm check:docs
cd apps/android
.\gradlew.bat :app:testDebugUnitTest :app:assembleDebug
```

Web test uses installed Microsoft Edge. 原始运行数据和临时文件位于被 Git 忽略的 `.runtime/`；raw runtime data and temporary files remain under git-ignored `.runtime/`.
