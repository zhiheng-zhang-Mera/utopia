# D9 Room 验收

状态：ROOM_PRODUCT_ACCEPTED / PROMOTION_CANDIDATE。本记录仅证明本地孵化验收，不代表 City 晋升或 Alien build 验收。

实现：`28673e158594a1cc2df07f6ea8225cbae2e150c4`。Donor：DS-Hns `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b`，仅七个文件，复用 City 已有六项依赖。正式 accepted Room 提交将在晋升记录中填入，不能虚构自引用 SHA。

| 门禁 | 已观察结果 |
| --- | --- |
| 核心行为测试 | 12 PASS：确定性意图、边界／关键区布局、无观测降级、像素、重试／超时／回退／禁用、输出限制、原子清理和稳定包 digest |
| 固定 donor oracle | 3 PASS：四组意图／token／slot、四组资源／surface、三组 PNG 精确 SHA-256／alpha／内容边界 |
| 真实浏览器回归 | PASS：输入 → 意图 → 有观测计划 → 构建 → 可见预览；无观测＋注入失败 → 真实回退报告 |
| 持久化浏览器 pilot | 实现 SHA 上 3 PASS：意图、有观测离线包、无观测注入失败包 |
| 完整 Room 回归 | 83 PASS |
| 现有产品／City 基线 | 根测试 52 PASS；未修改的 City 114 PASS |
| 独立复核 | 三项 P2 问题均复现并修复；针对修复的复查未发现遗留实质问题 |

复核回归覆盖禁用头像残留引用、旧 token 补回已禁用资源、错误／越界观测，以及最终缩放拒绝进入重试／回退链。可选资源失败后保持禁用，其余资源仍可编译。Builder 在本次创建的 staging 目录内验证实际文件，失败时清理 staging，且不覆盖已有目标。

原始 pilot 与公共样例截图位于 `evidence/raw/wave3/room-*`，字节由 `manifest.json` 绑定。有观测和无观测两张截图均已目视检查。仅使用生成／公共提示，没有 live Gateway 或手机数据；未调用真实图像 provider。展示的是构建包预览，不是已安装主题。

分类：donor 语义决策／渲染为 PARITY；ESM／命名／确定性元数据／调用方沙箱为 PORT_ADAPTATION；关键区排除、硬预算和加强后的回退／禁用为 UTOPIA_EXTENSION。模型 API、运行时安装和外部 renderer 集成保持 DEFERRED。GLOBAL_THEME_APPLY=NO。论文主张强度仍为 PILOT。

在 accepted Room 提交复现：`node --test apps/rooms/tests/theme-builder-lab.test.mjs` 和 `node scripts/d9-room-pilot.mjs`。晋升后按规定删除 active Room，focused tests 随 City 模块保留。
