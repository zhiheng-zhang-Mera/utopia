# 显式启用的本地 PCF Gateway 服务

默认 Gateway 的 `GET /api/v0/pcf` 仍然只读。只有调用 `createGateway` 时显式传入 `pcf: {enabled: true, approvedLocalContext: {deviceId: 'candidate-host'}}`，同时设置 `hostDeviceId: 'candidate-host'`，才启动本地服务。这是隔离候选配置，测试不得改动或启动现有 Alien、Mech、手机常驻 City。

接口每次请求都核验现有 City owner control bearer。已入网 member session 与 node credential 不能提交或查看 owner fabric 作业。适配器将身份绑定为 `owner:<cityId>` 与明确批准的本机设备；GET 返回的 `parentSessionId` 只是标识，不是凭据。请求 body 不能伪造身份或授权。浏览器 Origin 必须等于 Gateway endpoint；CLI 可不发送 Origin。仍须提供现有 API/schema 版本头。

- `POST /api/v0/pcf/submit`：`{appId: 'cpu-sort' | 'cpu-sum', idempotencyKey, input: {values: [...]}}`；最多1024个有限数值，可附本机严格目标与有界deadline。
- `GET /api/v0/pcf/tasks/:id`：查看已认证 owner 的作业。
- `POST /api/v0/pcf/tasks/:id/cancel`：`{}`；由 PCF 服务执行停止并保留停止证据。
- `POST /api/v0/pcf/tasks/:id/collect`：`{}`；返回真实 CPU 输出及digest。
- `POST /api/v0/pcf/tasks/:id/acknowledge`：`{digest}`；单独记录 owner 消费，与完成、交付分开。

服务仅在显式启用后启动，复用 Gateway canonical Store，关闭 Store 前先 await 服务停止。Supervisor 排他ownership；崩溃后的停止证据未解决时拒绝接管，不用超时猜测。旧 Gateway mutation 拒绝修改 PCF task，旧重启恢复跳过 `pcf-v1`；现有worker backend不能claim/report这些任务。只支持PUBLIC scope、零费用、本机固定CPU应用；这是显式配置owner授权，并非member共享授权。远程WBC执行尚未接通。

在隔离候选checkout运行 `node --test tests/pcf-stagec-gateway.test.mjs`。测试使用一次性目录和动态loopback端口。RED/GREEN记录位于 `.runtime/pcf-stagec-gateway-*`。候选一次整流后交 Mech，由操作者另行批准物理验证；不包含安装、合并、现有设备运行或物理PASS。物理验收保持NOT_RUN。
