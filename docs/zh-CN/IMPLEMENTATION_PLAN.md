# 产品 V0 实施计划

目标：可用的 Android + Web 控制端，驱动参考节点真实执行安全任务。产品优先，仅收集验收所需证据。

规格：用户提供的 `utopia_digital_city_product_v0_codex_engineering_book_v2.md`。执行方式：当前会话原生执行 A 至 G 阶段。架构：Node.js HTTP/WebSocket 网关、SQLite 持久化注册表、独立的能力驱动节点代理与文件适配器、Compose Android 和仅访问 API 的 Web。apiVersion = 0；schemaVersion = 0。

- [x] A：`contracts/city-control-v0/protocol.mjs`、`services/dev-gateway/server.mjs`；先测试健康、认证、版本不兼容和未知任务拒绝。
- [x] B：`agents/reference-node/main.mjs`；版本化 HTTP 注册和心跳；验证在线/离线与显式能力。
- [x] C：`services/dev-gateway/store.mjs`、`agents/reference-node/runner.mjs`、`platform/windows/filesystem.mjs`；集成测试真实文件哈希、取消和重启持久化。禁止任意路径或 shell 命令。
- [x] D：`apps/web/`；首页、节点、任务/详情、活动与设置。验证浏览器创建任务和 WebSocket 刷新；明确展示连接过期。
- [x] E：`apps/android/`；Kotlin Compose、私有设置、HTTP 快照和认证 WebSocket。构建、安装并通过 LAN 操作实机。
- [x] F：对照 Android 创建任务的 ID、状态、事件和结果与 Web 一致。
- [x] G：重启网关并中断实机 Wi-Fi，验证历史保留和重连。完成双语验收记录、轻量 CI 与 GitHub 交付。

评审重点：错误 token/版本可读失败；不可用节点不分配任务；终态不能被覆盖；重连刷新快照；重启将中断任务标记失败，不静默重做副作用。

范围：单运行节点，仅 LAN，固定五种任务白名单。Digital-City 和 Boss/Hns 不修改。实机证据观察前为 NOT_RUN。交付完整源码和最小双语运行手册。
