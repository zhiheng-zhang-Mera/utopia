# 显式启用的 PCF remote-worker 候选桥

`remote-worker-port.mjs` 是明确 opt-in 的 canonical WBC worker-pool port。它不启动server、不发现主机、不新建task或credential数据库、不入网worker，也不激活Mech。现有canonical Store持有task、reservation、attempt、epoch、capsule和claim nonce。

API：

- `createRemoteWorkerPort({enabled, owner, taskFor, readAuthority, authorizeWorker, observations, artifacts, verifyClosed, validateAuthorityBoundary, requestStop?, now?})`：提供canonical `endpoints/dispatch/claim/report/control`，以及受认证约束的 `workerStatus/input/processStarted/collect`。
- `dispatch({endpointRef, taskId, workload, idempotencyKey})`：必须已有 `pcf-v1` canonical task；校验真实输入artifact bytes，调用placement/admission/epochclaim，在task持久化capsule、精确device/boot/instance、inputbinding与holder。origin、action、session必须匹配canonical ownership。policy来自注入的既有owner授权事实，须明确批准trusted-fabric共享；适配器不能增加device或consent。每app reservation上限为CPU 8、memory 512 MiB，还受注入观测容量约束。
- `claim({nodeId, principal})`：重新核验当前workergrant与ownerpolicy，持久标记一次delivery nonce。重建adapter仍不能重复投递。丢失claim响应须进入attention，不自动重放。
- `report({nodeId, taskId, principal, state, result})`：RUNNING只是信息。terminal必须携带 `result: {claimNonce, receipt, outputBase64}`；核验capsulebinding、epoch、policyversion、ownedPID及独立注入的可信close证据。实际解码bytes必须匹配digest；发布artifact后，再复核当前grant与policy才canonicalcommit。仅旧COMPLETED不算成功。停止未知时失败report保留RUNNING reservation。
- `control({nodeId, taskId, principal})`：持久stopRequested并调用注入stoptransport；返回stopped=false，保持RUNNING。transport timeout或ack不代表停止。
- `createRemoteWorkerRequest({port, canonical=port, authenticate})`：把现有 `createHeadlessAgent.runOne` node路由转到canonicalpool。`authenticate(context)`每次解析既有authenticated transport handle，给出device/boot/instanceprincipal；不签发凭据，不信任bodyid。register/heartbeat/descriptor只展示注入当前观测；sharingmutation保持NOT_WIRED。
- `createRemoteCpuExecutor({port, principal, onClosed})`：固定本机CPU子进程候选。`executeCpu.onStart`在stdin前记录ownership；真实close返回后才产生receiptbytes。`onClosed`连接 `verifyClosed` 使用的可信停止证据。真实远程transport必须提供等价独立可信观测，worker自报closed布尔不足以证明停止。

`createWorkerPoolBackend({enabled:true,canonical:port,...})`复用现有memberrefs/descriptor缩小endpoint范围。它不启用生产Gateway、不安装workergrant。跨主机真实workergrant认证、remoteartifacttransport、stopobservation与Mech激活保持NOT_WIRED / NOT_RUN。headlesscancel会fence回调并跳过最终report，已停止attempt可能需显式canonicalreconciliation；port保留不确定性，不虚报CANCELLED。

在隔离候选checkout运行 `node --test tests/pcf-stagec-remote-worker.test.mjs`。测试用一次性canonical Store、注入transport/authority及两个真实本机CPU进程。证据类别为 `SIMULATED_TOPOLOGY+ACTUAL_LOCAL_PROCESSES`，逻辑worker名称不证明两个物理主机。RED/GREEN位于 `.runtime/pcf-stagec-remote-*`。候选review后一次整流交Mech，另行批准物理验证；组件测试不包含安装、合并或现有City运行。

enabled配置必须注入 `validateAuthorityBoundary({workload, capsule, principal, policyVersion, grantVersion, phase})`。它必须同步从现有authority一起读取当前owner与workergrant，只有两者仍获授权且版本匹配才返回严格 `true`。Promise、缺失callback、旧版本或撤权都拒绝。`authorizeWorker`须返回当前整数 `version` 及精确authorized device/boot/instance绑定。callback在canonical owner事务内核验admission/epochclaim、capsule持久化、deliverynonce、ownedPID、最终resultcommit和stoprequest；在异步读取结束后的input、RUNNINGstatus及result交付前即时核验。不得另建approvalDB或自动扩权。真实部署只有在现有真实authority支持同事务boundary后才可接通，当前仍NOT_WIRED。
