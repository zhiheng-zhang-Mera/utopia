# 能力入口审计集成

CEX-790 将已验收的 CEX-701..705 入口工作与当前 main 集成，保留设备注册、研究和执行行为。原生类型化拒绝集合取并集，Web 重复渲染已移除。

当前审计工具要求 `CEX790_REGISTRY_ROOT` 指向 Digital-City checkout；安装根目录及 City 依赖后运行 `node scripts/cex790-inventory.mjs`。输出 `evidence/raw/mission-book/CEX-790/current/capability-inventory.json`，绑定完整代码身份、输入哈希及 Registry 状态。分类是发现候选。历史证据及 `cex790-matrix.mjs` 继续明确属于历史审计。

独立目录重建、逐项差异分类、后续所属系列的已知缺口及失败/通过探针见 `evidence/raw/mission-book/CEX-790/current/RECONCILIATION.md`。

主题或实验存储不可用时仅降级对应能力，不阻止 City 启动。健康接口披露产物存储状态。研究页展示存储不可用，保留 `persisted:false` 与原因，不把验证当成已持久保存。未声称实体设备或外部服务验收。
