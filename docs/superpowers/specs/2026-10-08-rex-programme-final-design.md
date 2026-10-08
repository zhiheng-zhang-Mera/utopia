# REX programme final：Android、自然语言入口与最终集成

日期：2026-10-08。状态：设计待审阅，尚未开始产品代码实施。

## 用户目标与验收

Owner 要求在云端新分支完成 Android、自然语言入口和 programme integration；确认功能正常且用户能够操作后合并 main。新分支为 `feat/rex-programme-final-android-intent-20261008`。沿用 Web、Android、Gateway、CLI 与共享 City task/action truth，最终交付可安装 APK、操作说明、原始运行证据和云端提交/CI/合并记录。

本次补齐的是两条现有能力：远程程序执行与远程 Agent 作业。Android 必须有可发现、可操作的入口，Ask/Do 必须能从自然语言进入同样的功能流程。已有 REX-890 的 Web Advanced + CLI 通过记录保留，不把旧批准扩写为新 Android 或新意图实现的验收证据。

## 已核对基线与集成范围

- Utopia main：`db6b6f9dbba1266d6783774d659d4eef912929ff`。
- 已复现的 REX-890 实现：`0e63c2a0ca723f7d8d0b6ad41abff33bee2ea744`，位于 `feat/city-owner-remote-operation`。
- 四系列集成分支：`4cd4d09988ae7a3f4a425854db07a4131e5921d5`，已测得是上述 REX-890 实现的 merge-base，即 REX-890 分支已包含它；不重复合并或丢失已验收的 PCF/CHK/DGX 内容。
- Digital-City 已完成 REX-890，终标已释放，工作书允许随后创建 programme final integration workbook。
- 本机 Android SDK：`D:/Tools/UtopiaAndroidSdk`。ADB 已观察到实体 OPPO PERM00，serial `BICIPVNB5HS85H9T`。

从最新 main 建立独立工作区，把上述已验证实现合入新开发分支，再补齐功能。提交前及合并前重新 fetch、确认完整祖先集合；main 如变化则更新集成并重新验证。既有冻结工作区及设备身份保留。

## 方案选择

推荐复用现有 Gateway 固定规则 Ask/Do 和现有能力契约，增加自然语言到操作草稿的路径，再由 Web/Android 完成参数和明确确认。它与当前产品语义一致，可在没有外部模型凭据时验证。

另一方案是让语言模型生成并执行指令，但会引入模型服务、预算、生成参数及权限的新契约；本任务并未要求这些依赖。仅用 Android WebView 嵌入 Web 则不能补齐现有原生产品的错误处理、离线状态和用户操作流程。采用推荐方案，不以 WebView 作为原生验收替代。

## Android 用户流程

在现有 Advanced 导航下加入远程执行、Agent 作业原生 Compose 页面，复用 `CityClient`、连接状态、CallbackFence 与统一错误呈现，避免把新界面继续堆进 MainActivity。

远程执行流程：读取实际 enabled/allowlist/workspace 和 eligible nodes；选择目标设备，填写 executable、独立 argv 项、cwd、purpose、超时和输出边界；展示完整预览，输入 executable 明确确认后发送；轮询实际任务状态，展示 stdout/stderr、exit code、timeout/truncation、City receipt 和 acceptanceAuthority；提供已有后端支持的停止操作。

Agent 作业流程：选择目标设备，填写 title、instruction、purpose、input refs 和 deadline；输入 title 明确确认后发送；显示实际 claim/report/terminal/collection 状态，允许后端所支持的取消与收集。作业答复始终标注 agent observation，收集始终标注 acknowledgement，不显示成 City 对答复真实性的验证。

默认关闭、成员拒绝、离线、不可用节点、过期、非法参数与服务错误都必须呈现可理解的原因。使用 member credential 不扩大 owner 权限，后端 owner gate 必须重新验证。连接或 City/credential 上下文变化后废弃过期回调及旧确认。

## 自然语言入口与数据流

使用 Gateway 的现有 deterministic router，覆盖中文、英文的远程执行、Agent 作业及相关查看请求。Web 与 Android Ask/Do 同时接入。

例如“在 Alien 上运行 git 查看版本”和“让 Alien 的 Agent 检查项目测试”先进入对应草稿，映射可识别的目标和意图；缺少 cwd、purpose、executable、instruction 等契约要求的信息时显式要求补齐，不猜测参数。自然语言中的 argv 作为数据，不拼接 shell 命令。

明确参数、目标匹配和用户确认后才允许执行。模糊设备名、多候选、未知 executable、缺失字段、未确认、篡改输入、非 Owner、switch OFF 均有明确出口，不创建隐式工作。草稿被编辑后旧确认作废，重复请求使用幂等键避免双重执行。

在既有 Action adapter 中接入两条后端能力及真实 task/job reference；Action 仅投影 canonical 后端状态，不新建第二套任务事实。Agent claim/report 状态与 City task 状态使用已有映射；后端失败或尚未完成不能映射成成功。保留已有 Ask/Do 本地规则、manual picker、General AI 路由和预算/确认语义。

## Programme final integration 与记录

在 Digital-City 创建 programme final integration 工作书及英文读本，依赖已释放的 REX-801 至 REX-890 标记，记录 immutable full SHA、真实 branch/head/CI、能力验收和集成结果。工作书不预先标 COMPLETE。

更新两条 capability registry 的 Android/Web/CLI surface、intent evidence、backend wiring、最后验证 SHA 与 review refs；同步表面索引、导航、依赖和看板。Android 和自然语言的旧 NOT_IMPLEMENTED/NOT_TESTED 项仅在对应新证据成立后替换为已验证。旧测试失败、负对照和未测量研究指标原样保留。

## 验证与合并门槛

1. Gateway/契约回归：真实 HTTP owner/member、switch OFF、invalid bounds/workspace、缺字段、设备不可达、幂等、确认失效、取消/停止、任务状态映射，确认失败时没有额外任务。
2. Intent 回归：中文/英文示例、设备歧义、参数缺失、手工编辑与重新确认、未知请求、不执行第一轮、既有 deterministic/General AI 路由兼容。
3. Web E2E：从 Ask 进入草稿、参数补齐、确认、执行/取消、状态/结果一致、刷新保留填写和焦点、离线与成员拒绝。
4. Android：DTO/参数/状态 unit tests，`testDebugUnitTest` 和 APK build；实体 OPPO 上通过真实 UI 完成导航、填表、确认、远程执行、作业提交、查看结果/收集、断线恢复和权限拒绝。保留 UI tree、截图、logcat 与对应 City task/action IDs；不把 HTTP 探针替代 UI 操作证据。
5. Programme：全量测试和必要 city/contract 回归、REX 独立复现、既有四系列关键回归；集成工作书/registry/docs gates。重复或失败原始输出保留；本地全量失败必须处理并复验，不能只凭 isolated retry 宣称全绿。
6. 云端：每个已完成切片提交并推送新分支，最终 exact-head CI terminal success；依据适用记录完成独立技术复核和 exposure evidence。取得通过证据后按本次 Owner 已授予的合并授权合入 main，再核对 merge SHA、main CI 和合并后产品流程。若门槛未通过，不把授权解释为跳过验证。

验收结论只覆盖实际测试的环境和操作。不会声称支持任意自然语言、任意 Android 设备、未知工具、shell sandbox 或所有未来环境。最终报告列出交付位置、可操作步骤、准确 CI/merge 链接和剩余限制。
