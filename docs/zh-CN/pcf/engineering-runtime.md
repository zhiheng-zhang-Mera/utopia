# 工程运行候选（PCF-727/728）

本候选一次整流交 Mech 组合验证，不解锁 parked 工作书，也不向任意运行中的 Codex 会话安装工具。复用 `bindEngineeringExecutor` 和 ConnectorPort 方法清单。`createEngineeringTools` 注入 canonical service 的 submit、inspect、cancel、collect、acknowledge；当前归属、单一终态、幂等及输出摘要由 canonical service 校验。每次调用重新检查 caller 授权，结果 collect 与实际 acknowledge 分离。

已安装 CLI 的帮助证据保留在 `.runtime/pcf-stagec-engineering-cli-help.log`。exec 帮助确认 JSONL、stdin prompt、指定目录、workspace-write sandbox、ignore-user-config；resume 帮助确认显式 session ID 以及 latest 选择。本候选没有持久归属台账和重启协调，因此 resume 明确 UNSUPPORTED，不用 `--last`，不接管环境中的会话。backend session 只绑定自己启动进程输出的 thread.started。

生产提交要求显式批准、外部 auth-ready 声明及隔离 CODEX_HOME，不读取凭据，不继承环境中的 provider key。默认验证器要求干净 linked Git worktree 和准确 base SHA。dirty snapshot、内容 staging、输出 digest、canonical epoch/lease fencing 由获准的上层执行流水线提供，本模块不是 scheduler，也不自动 merge 或覆盖 Alien 工作区。

submit 在第一次 await 前同步复制并冻结 caller 输入。验证器返回 canonical realpath 与已验证 SHA，argv、spawn cwd 和 evidence 统一使用该不可变结果。自定义 validator 和 fixture argv 仅允许显式组件测试且 executable 必须是当前 Node。进程成功退出仍保留 unknownSideEffects=true，不能凭 child close 推断全树停止或工程副作用已协调。并发修改反例的 RED/GREEN 在 `.runtime/pcf-stagec-engineering-mutation-{red,green}.log`。

持久化反例证据在 `.runtime/pcf-stagec-engineering-durable-{red,green}.log`；最终 14 测试日志是 `.runtime/pcf-stagec-engineering-canonical-final.log`。`pcf728-canonical-flow.test.mjs` 使用真实 canonical SQLite Store、admission、attempt、capsule 校验、进程归属持久化、输出工件、commit receipt 和 caller collect/ack。真实 Node subprocess 产出 42，同一获准 caller 实际读取并将 43 作为下一步显式输入。这是 COMPONENT_FIXTURE 证据，不能替代真实 Codex 或跨机 caller 验收。

Owner callbacks 使用独立 callbackTimeoutMs deadline（默认 5 秒，上限 60 秒）。超时为 ATTENTION，结果拒收。callback 第二参数提供 AbortSignal、fenceId、归属 refs 和 isCurrent()；可信 canonical owner 必须在每次原子归属/回执写入前检查 fence，尤其 await 之后。runtime 无法取消任意注入 promise 或撤销其写入；忽略 fence 的 callback 仍可能在模块外迟到写入，这是 owner 接线错误，不能声称已取消。迟到 promise settle 不会翻转 runtime 终态或允许收集。永不 settle / 迟到反例 RED/GREEN 保留 `.runtime/pcf-stagec-engineering-owner-timeout-{red,green}.log`。

运行器固定 argv、shell=false，限制 stdout/stderr 总字节、事件数、会话数和运行时间。回执保留 PID、由获准 host adapter 注入的 host/boot、task/attempt/base/worktree、exit/signal/close。取消只向自己的 child 请求终止，只有 close 才形成终态；Windows 后代进程可能仍活着，故 processTreeTermination=NOT_PROVEN，未知副作用不得消除。组件成功同时要求 completed JSONL turn、零退出和自己观测到的 session；坏 JSONL、截断、溢出、超时、非零退出均不成功。句柄仅在内存中，restart recovery=UNSUPPORTED，生产需注入可信异步 onStart/persistReceipt，将 PID/task/attempt/host 归属先写入外部 canonical owner 再提供 stdin；start 持久化失败则 kill 并等待 close。bounded 退出回执持久化后才允许收集，写盘失败为 ATTENTION，不创建第二任务数据库。

RED/GREEN 在 `.runtime/pcf-stagec-engineering-red.log`、`.runtime/pcf-stagec-engineering-green.log`。测试是实际 Node subprocess conformance fixture，显式注入组件 worktree validator，不是真实 Codex 推理。CODEX_LOCAL/REMOTE、DEEPSEEK_LOCAL/REMOTE、provider cancel/restart、同一 parent-session 实际消费、异机 Formal Review 均为 NOT_RUN。Mech 需一次验证整个候选，补 canonical refs、获准 staging、host/boot/attempt、版本、digest、正式 caller 工具和取消/副作用协调证据后才可作产品结论。
