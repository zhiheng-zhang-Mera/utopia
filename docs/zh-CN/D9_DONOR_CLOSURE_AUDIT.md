# D9 Theme Builder 闭包审计

历史审计状态：DONOR_COPIED／闭包已核验。后续 Room 验收和 City 晋升见 [Theme Builder D9](THEME_BUILDER_D9.md)；以下观察描述适配前的固定 donor。

来源：`zhiheng-zhang-Mera/DS-Hns`，固定 `eeb57ca5c2c56bdf2e58c1216c610b4b9fbc973b`。已通过 GitHub 核验提交并只读下载精确内容；未更改本地 donor 仓库，也未启动 donor runtime。原始字节保存在被忽略的 runtime 目录。

| 新增源码，位于 app/extensions/mega/theme/ | Git blob |
| --- | --- |
| builder.js | b1e9a5fad7fc5f73a282486d8fc0deb12db5ca71 |
| designer.js | 15f87f97845d9dea8a549d0135fa21aa5461a33f |
| assets/planner.js | 1d57be88d4db84cd79c54e7fc10a93da0086d210 |
| assets/generator.js | 00a41484ec760d51484f6bce99d6ff123d02975d |
| assets/processor.js | dd3bc6dadf7792b96e9455f52df9b31749c2d588 |
| assets/validator.js | 33d7b4519be9fd91021d7aadf028eeb3c994fb1b |
| assets/fallback.js | 43be1339f49be91dacd5eaa6381d1b9cc6c4b8b6 |

七个文件仅依赖彼此、Node fs/path，以及已晋升的 contract、surface、包 validator、asset-factory、PNG 与 color。另只读获取这六个原文件用于 oracle 对比；实现必须复用 City，不能重复晋升。后者仅增加 Node zlib 依赖。无需 resolver、runtime、registry、lifecycle、recovery、model-adapter、official 集成或内置主题。

## 必须明确适配的实际差异

- Designer 的本地入口名为 `interpret`，并非 `intent`；固定版本没有导出 `interpretWithModel`。语义决策确定，但 `interpreted_at` 使用实时时钟。Utopia 需提供确定性元数据与 `intent` 入口。真实模型集成保持 DEFERRED。
- Planner 记录 observation 和 safe region，但角色尺寸可能超出小 viewport，也未扣除 critical regions。必须测试并执行真实布局边界，不能仅凭 observation 存在就宣称通过。
- Generator 会重试头部无效或无法解码的模型图片，但已解码图片若在最终像素校验失败，会直接禁用。要求的链条必须覆盖像素拒绝后的重试与回退，并限制次数、超时和解码尺寸。
- 像素 validator 测量透明度、颜色和尺寸，但单资源超字节仅为软警告，bundle 没有总预算上限。Utopia 需明确执行这些预算。
- Builder 会删除传入的输出树后直接写入，并未实现文件注释声称的原子晋升。应保留编译语义，改用新建且受限的 staging 目录，验证后 rename；拒绝已有目标和路径逃逸，失败时只清理本次创建的 staging。
- Builder 写入实时时间，且可能用 legacy bundle 补回已禁用的计划资源。稳定包 digest 与单资源禁用需要明确修复，不能声称完全 parity。
- Donor 默认 overlay 和限制必须通过已晋升的 Utopia validator；包不能通过抬高自己的安全上限绕过校验。

## 实施时的行为分类

| 行为 | 分类 |
| --- | --- |
| Intent 的配色／风格／密度／角色决策、像素处理、程序化渲染 | PARITY，待迁移后对比 |
| CommonJS → ESM、已有 Utopia surface／slot／token 命名、依赖导入 | PORT_ADAPTATION |
| 固定元数据、调用方沙箱和原子输出、不安装到生产环境 | PORT_ADAPTATION |
| Critical region 排除、像素拒绝后重试、硬预算、真实单资源禁用 | UTOPIA_EXTENSION，需专门回归门禁 |
| Provider API、运行时应用、registry／lifecycle／recovery、外部 renderer 集成 | DEFERRED |

闭包检查后，已用固定源码计算四组 prompt／design／plan oracle 与三组程序化像素向量。这只是审计准备，**不是迁移 parity 证据**。尚无 Room 产品、包验收、实机消费或 D9 晋升结论。GLOBAL_THEME_APPLY=NO。

main 新合入的快速路径文档另行提出推迟 D9。续执行遵循本对话已授权的工作书，在独立功能分支推进，并保留快速路径文档。本审计不构成改变排期的指令。
