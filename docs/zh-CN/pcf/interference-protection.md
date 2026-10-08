# 已批准的本机队列保护

[English](../../en/pcf/interference-protection.md)

createFabricService 接受显式 protection 配置，包括设置、有界 observer 和同步当前授权检查；默认关闭。新鲜测量显示目标未达时，仅减少该服务后续并行度，或拒绝其 batch/background 启动。不终止任意进程、不购买云端执行、不改变质量、不假装可抢占不可抢占负载。已启动的自有子进程继续遵守有界取消和退出流程。

未知或过期观测要求重测；撤权阻止后续保护队列调度。采样上限 250 毫秒，cooldown/dwell 与 generation fence 防止振荡和禁用后的迟到操作。用户禁用恢复此前获批的本机队列上限及后台准入。这是可逆队列控制，不是硬实时保证。observer 必须说明真实来源；注入组件 fixture 不证明前台应用响应。

真实前台 SLO 的保护开关对照、资源争用与实体用户设备证据保持 NOT_RUN，纳入一次完整流异机交接，不另拆组件验收。
