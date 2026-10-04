# City members implementation plan

> **For agentic workers:** Use superpowers:executing-plans; user explicitly requested immediate native execution after archive.

**Goal:** 同一 City 多主机身份、双向通信、共享计算及仅本机降级。
**Architecture:** 一个 City Gateway 中转消息及现有调度；本机成员代理持有安装凭据并以身份限定的会话工作。本机加入成功停止自己的城市服务、保留数据库、协调器发布成员角色；不停止远程主城。
**Tech Stack:** Node.js/SQLite/HTTP/WebSocket/vanilla Web。
**Spec:** ../specs/2026-10-04-city-members-design.md

## Global Constraints
- 主城角色和名字不固定；首次本机默认自己的主城。
- 仅加入成功后降级本机；目标城市不受影响。
- 不删除本机城市数据库；不向浏览器暴露持久安装密钥。
- 每个主机最多一座活动本地 City；成员只能操作自己的计算代理。
- 实测缺失记录 NOT_RUN。

## Review Focus
- 重复标签和同名设备：身份去重、不按名字合并。
- 设备撤销和跨成员伪造：禁止冒充心跳和结果。
- 加入失败与任务在途：原城市保留，不降级。
- 远端掉线：保持成员角色，不自动新建第二座城市。
- 停止共享和离线目标：不再领取任务，不改派严格指定任务。

### Task 1: Unified identity and members
Files: enrollment.mjs, server.mjs, members.mjs, tests/city-members.test.mjs.
Interfaces: memberSnapshot({store,installations,surfaces,hostDeviceId}); authenticated sender derived from installation.
- [ ] Write real enrollment-name and member-list assertions; observe failure.
- [ ] Fix device lookup prefix; snapshot merges host nodes, installations and browser surfaces with stable refs.
- [ ] Bind member node mutations to its deviceId; keep legacy node token compatibility.
- [ ] Verify name persistence, duplicate surfaces and spoof refusals; commit.

### Task 2: Communication and shared worker
Files: server.mjs, store.mjs, agents/reference-node/agent.mjs, tests/city-members.test.mjs.
Interfaces: POST/GET /api/v0/members/messages; POST /api/v0/node/sharing; agent credentialProvider refresh.
- [ ] Write two-member bidirectional delivery and real targeted task tests; observe failure.
- [ ] Persist bounded messages; authenticated sender and recipient only, explicit receipt.
- [ ] Shared-worker switch inhibits claims; telemetry is actual host sampler.
- [ ] Verify revoke, offline, duplicate receipt and cross-member denial; commit.

### Task 3: Local host role transition
Files: host-city.mjs, main.mjs, host-join.mjs, launcher.mjs, tests/host-member-role.test.mjs.
Interfaces: native local host join broker and status; main onJoin performs local-only demotion; launcher reuses MEMBER coordinator.
- [ ] Test local primary to remote member transition preserves original DB and remote PID/identity.
- [ ] Save native enrollment, start identity-bound member agent, close only local Gateway/Rooms/agent after successful join.
- [ ] Coordinator does not overwrite original City database pointer; restart member reconnects, no local fallback.
- [ ] Verify failed join and busy local tasks leave primary running; commit.

### Task 4: Product surfaces and delivery
Files: apps/web/app.js, members.js, i18n/*.js, tests/city-members-ui.test.mjs, bilingual docs.
Interfaces: unified member rows, current-member ref, message form, sharing action and local host-join poll.
- [ ] Browser tests assert “本机” first, all named members and local join broker route.
- [ ] Integrate members view/detail, communication and actual shared capability state.
- [ ] Run focused then full suites, independent whole-branch review and CI; update real installation and Digital-City evidence.
