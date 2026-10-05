# 默认关闭的 Worker Pool 与无界面节点代理接口

Gateway 注册默认关闭的 worker-pool，不创建连接、凭据、定时器或启动探测。STANDARD_DEVICES 仍是唯一默认启用配置。显式测试配置用成员白名单及 City 规范节点描述包装已有 backend；派发、领取、报告和取消沿用规范任务状态，取消另校验任务归属。本任务不启用产品 Worker Pool 配置、不改 Windows 启动器、不增加队列。

createHeadlessAgent 接收版本化身份、角色、能力、资源和既有授权 Gateway 请求适配器，以及不含凭据值的 node/control 句柄。构造无 I/O；调用方显式调用 register、heartbeat、runOne、drain、resume、cancel、stop。心跳返回 City 规范描述；CPU、内存和磁盘使用原有 telemetry，缺失测量保持未知。此适配器尚未将 GPU 特有资源写入规范 telemetry。

Drain 需要合法本机控制权限，通过已有共享接口暂停领取；权限拒绝不冒充成功，已领取任务可完成。显式 resume 恢复本 agent 暂停的共享，重启不会自动取消所有者的暂停。取消复用现有授权路由，并绑定 task/epoch、锁住未完成控制请求和传递协作 AbortSignal；此 JavaScript 接口不能强行终止忽略取消的执行器。领取响应未落定时 stop 返回 AGENT_BUSY，保留操作，待落定重试。请求有超时，未知结果不自动重放。

重启沿用节点重新注册规则：中断任务规范状态变 FAILED，不重复执行。resume 是恢复接收新任务，不是检查点执行续跑。不宣称检查点授权续跑、真实工作台部署、HA、Linux/macOS 实机验证或主城代理迁移。

证据：产品修改前依赖 union 39 项契约/反例与4项 HTTP 测试通过；最终55/55 focused，含12项新测试。受控任务写回规范结果；重启执行次数保持1；取消屏蔽迟到结果；Drain 实际暂停共享；没有 pool 时标准设备仍可工作。仅确定性模拟和同主机本地 Gateway，异物理主机正式审查待办。
