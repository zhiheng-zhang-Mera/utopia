# 控制协议

所有 JSON 响应包含 apiVersion 与 schemaVersion。客户端发送 X-City-Api-Version、X-City-Schema-Version 两个零值请求头，以及 Authorization: Bearer token。版本不匹配返回 409 和可读错误；认证错误返回 401。Health 无需认证，只展示版本和健康状态。

公开端点：GET /api/v0/health、/city、/nodes、/tasks、/tasks/{id}、/events；POST /api/v0/tasks 仅接受支持的 type；POST /api/v0/tasks/{id}/cancel。缩写路径共用 /api/v0 前缀。WS /api/v0/events/stream 需要版本查询参数和认证。浏览器通过 base64url token 子协议认证，不在 URL 放 token；Android 使用 Authorization。

节点端点：POST /api/v0/node/register、/heartbeat、/claim、/report（共用节点前缀），必须使用独立节点 token。注册声明身份、metadata 与能力；心跳更新在线状态。领取操作原子分配队列任务给有能力的空闲节点。报告推进 ASSIGNED → RUNNING → COMPLETED/FAILED，RUNNING 期间可写检查点。用户取消为终态，其他终态也不能覆盖。

事件包含递增 seq 和稳定 UUID id。两个客户端在流更新及重连后重新读取权威快照，避免本地重复追加，并恢复丢失事件。失联期间，缓存节点状态不代表当前健康。

机器定义：contracts/city-control-v0/schema.json 与 protocol.mjs。DevicePrincipal 由参考节点稳定的 devicePrincipalId 表示；控制 token 授予 control.observe/control.command 权限。完整身份注册为 POST_V0。

FACT: apiVersion=0; schemaVersion=0; mismatch=409; unauthorized=401
PAIR_STATUS: SYNCHRONIZED
