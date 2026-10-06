# 有界研究故障

打开 Research → 高级 / 危险区，选择当前在线 worker、故障类型和最长 30000 毫秒的时长。阅读影响，输入 `FAULT:<kind>:<nodeId>` 后确认注入。点击历史回执可查看或停止。状态刷新未完成时，紧急停止仍可使用。

- HEARTBEAT_LOSS 拒绝目标心跳请求。Canonical 超时可能使节点离线并使任务失败。Agent 重新登记降级路径不被拦截；该模式仅表示心跳丢失，不代表全网络断开。
- PROVIDER_UNAVAILABLE 拒绝目标执行领取，不针对外部模型或 provider API。
- DELAY_RESULT 暂缓目标回报，直到有界到期或紧急停止；释放后是否过期或可接受，仍由 canonical 校验决定。
- DUPLICATE_EVENT 只把目标发布的 canonical 事件重复送入研究观察，绝不重复 canonical 任务或事件执行。

所选 worker 的全部任务都可能受影响，其他 worker 继续工作。这些模式不会杀进程、修改宿主资源、变更凭据、删除数据或攻击网络。停止解除注入，但不会复活已失败任务。重启记录中断，不自动恢复故障。控制需要 Owner 凭据，node 凭据和已加入成员均无故障控制权限。

回执保存于 runtime research 目录。只有实际生效的活动心跳故障伴随 canonical NODE_OFFLINE 时才记录 detection。Recovery 从解除注入到实际受影响目标操作成功恢复计时。未观测值保留 null 与原因，不证明外部 provider 或实体主机恢复。摘要最多返回最近 128 条并说明截断，完整回执仍在磁盘。

API：`GET/POST /api/v0/research/faults`、`GET /api/v0/research/faults/:id`、`POST /api/v0/research/faults/:id/stop`。运行 `node --test tests/rex804-*.test.mjs`。当前控制入口为 Web，Android 对齐作为 REX-807 的明确暴露接缝保留。正式 Mech 复检必须增加一个作者未使用的故障 probe。
