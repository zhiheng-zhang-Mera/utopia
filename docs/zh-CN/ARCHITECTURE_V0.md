# 架构

Gateway 提供版本化 HTTP 快照和认证 WebSocket 事件流。SQLite 保存任务、事件、节点与 schema 版本。独立 City Node Reference Agent 显式声明能力、轮询领取任务并通过文件适配器执行。Android Compose 与浏览器使用相同公共 API。平台 metadata 不授予能力。

Gateway 是开发参考实现，不是 City Core、Boss 或 Hns。Utopia 是实现事实来源。Digital-City 仅作参考，本轮不修改；实现和验收均不依赖写入该仓库。

运行器仅接受 WAIT、CREATE_TEMP_ARTIFACT、HASH_TEMP_ARTIFACT、DELETE_TEMP_ARTIFACT、CHECKPOINT_DEMO。每个文件任务使用生成的、受限的独立工作区，正常完成/取消会清理；HASH 和 DELETE 先创建自己的样本文件。不接受 shell 或用户路径。突然终止进程可能留下受限工作区文件；网关重启把中断任务标为 FAILED，不自动重放。

控制端持有私有 control token；节点使用独立 token。HTTP 与 WebSocket 仅用于 LAN 开发，不具备公网安全能力。节点为单个可信本地参考代理，不是多租户运行环境。

FACT: apiVersion=0; schemaVersion=0; runtimeNodes=1
PAIR_STATUS: SYNCHRONIZED
