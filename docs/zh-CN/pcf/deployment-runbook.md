# PCF-716 部署候选

[English](../../en/pcf/deployment-runbook.md)

现有 Windows launcher 与 Utopia.cmd 继续拥有 City 启动权。此显式 opt-in 候选不安装操作系统服务、不申请管理员权限、不注册开机自启、不替换驻留 City。manifest 只保存 enrollment 引用，禁止传入 token 或密码。选择独立、用户可写的候选目录，禁止使用 D:/utopia 的驻留 runtime。

`scripts/pcf-service.ps1 -Action INSTALL -CandidateDirectory <独立目录> -ConfigFile <仅引用配置JSON> -OptIn` 默认 dry run。`-Apply` 只允许候选元数据 INSTALL、STANDARD_DEVICES、UNINSTALL；实际 runtime 操作返回 RUNTIME_ADAPTER_REQUIRED。卸载只删除带归属标记的 manifest，保留配置与日志。配置包含 version、整数 schemaVersion、1024..65535 范围的 port 与 credentialReference。凭据仍留在原有受保护文件。

createDeploymentController 接收 start、stop、drain、checkpoint、canary、switchVersion、verify、rollback adapter。各方法只有实际完成后才返回 true。升级先完成 drain 与 checkpoint；preflight 必须提供实际 writable、portAvailable、freeBytes（至少 1 MiB）、versionsCompatible 观测，缺失则拒绝。调用方应提供当前主机的新鲜检查，不猜测。兼容 schema 才允许 UPDATE；切换或验证失败通过 rollback 恢复旧 manifest/config。回退失败保留 ATTENTION；schema 变更需要独立 gate。已安装候选可手动恢复 STANDARD_DEVICES，不创建月度计划任务。

健康探测限制为 100..10000 ms，仅接受无凭据 HTTP(S) URL。appendBoundedLog 只输出 action/state/reason，并限制条数与字节。实际 adapter 必须对持久日志采用该有界接口，并另行限制子进程 stdout；候选不安装无限日志写入器。

验证命令：node --test tests/pcf716-deployment.test.mjs。独立、由测试拥有的子进程证明无浏览器情况下的 opt-in start/drain/stop/uninstall。这不能证明真实 Windows 服务安装、无交互登录、配置笔记本断开、重启恢复、生产日志滚动或真实 City 回退；这些验收仍为 NOT_RUN，需要获授权的实际服务 adapter 与后续对端完整流程复核。保留驻留 City，禁止广泛杀进程与递归删除。

恢复中的 running manifest 必须带 opaque runtimeIdentity，并由 adapter.reconcileOwnedRuntime(identity) 返回 true，才能修改 runtime 或卸载；归属未知时拒绝。重复 START 拒绝，不启动第二个子进程。ROLLBACK 在调用 adapter 前验证完整、仅引用的目标配置。候选写入拒绝所有已有祖先与 manifest 自身的 reparse point。
