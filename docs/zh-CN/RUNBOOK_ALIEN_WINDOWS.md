# Alien 主机运行手册

安装 Node.js 24 与 pnpm，在仓库运行 `pnpm install --frozen-lockfile`。通过 `./scripts/start-city.ps1 -BindAddress <LAN-IPv4>` 启动。脚本隐藏启动 Gateway 与 Reference Agent，将 PID 写入 `.runtime/processes.json`，生成的凭据保存在 `.runtime/local-config.json`。浏览器打开输出的 URL，输入控制端 `token`。不得向控制端提供 nodeToken。

使用明确的 LAN IPv4，不监听所有接口。若 Windows 防火墙阻止手机连接，仅允许局域网子网访问所选 TCP 端口，不关闭防火墙。默认端口 4310。两台设备须在同一局域网。不提供公网转发、云部署、任意 shell、后台服务或 Windows 原生包装。

重启时，只停止此工作区记录的 Gateway PID，再使用启动脚本相同的 CITY_HOST、CITY_PORT、CITY_DATA、CITY_TOKEN、CITY_NODE_TOKEN 重启 `services/dev-gateway/main.mjs`。保留 agent，它会在网关返回后重新注册。不得让两个网关同时使用同一数据库。备份时先停止网关，保留 `.runtime/city.sqlite` 及其 SQLite 辅助文件。禁止提交凭据或运行数据库。

测试：`pnpm test`（Web 测试需要 Microsoft Edge）、`pnpm check:docs`。Gateway 无需打包，Web 为静态 ES 模块。日志位于 `.runtime/`。正常完成的文件任务会清理私有产物；突然终止后，先检查 `.runtime/workspace/` 中该失败任务的生成目录，再清理。

FACT: nodeMajor=24; port=4310; apiVersion=0; schemaVersion=0
PAIR_STATUS: SYNCHRONIZED
