# UI-000 capability parity report

- generated: 2026-10-01T11:45:07.633Z
- candidates: a, b, c
- probes: 396/396 passed
- result: PASS

| candidate | probe | where | capability | token | ok |
|---|---|---|---|---|---|
| a | leak | home | demotion | tsk- | yes |
| a | leak | home | demotion | inv- | yes |
| a | leak | home | demotion | act- | yes |
| a | leak | home | demotion | apiVersion | yes |
| a | leak | home | demotion | schemaVersion | yes |
| a | leak | home | demotion | backendRef | yes |
| a | leak | home | demotion | provenance | yes |
| a | leak | home | demotion | #41 | yes |
| a | leak | ask | demotion | apiVersion | yes |
| a | leak | ask | demotion | schemaVersion | yes |
| a | leak | ask | demotion | idempotencyKey | yes |
| a | leak | ask | demotion | backendRef | yes |
| a | leak | tools | demotion | LOCAL_PRODUCT | yes |
| a | leak | tools | demotion | 127.0.0.1:4320 | yes |
| a | leak | tools | demotion | text-workshop | yes |
| a | leak | tools | demotion | data-lab | yes |
| a | leak | devices | demotion | node-3f7a91c2 | yes |
| a | leak | devices | demotion | agentVersion | yes |
| a | leak | devices | demotion | lastHeartbeatAt | yes |
| a | leak | activity | demotion | #41 | yes |
| a | leak | activity | demotion | "seq" | yes |
| a | leak | activity | demotion | tsk- | yes |
| a | surface | home | connection-state | Alien-PC | yes |
| a | surface | home | city-snapshot | 20:24 | yes |
| a | surface | home | attention-summary | 10 | yes |
| a | surface | home | device-telemetry | 12.4 | yes |
| a | surface | home | event-timeline | 20:19 | yes |
| a | surface | tools | room-catalog | Knowledge Room | yes |
| a | surface | tools | room-catalog | 本地知识室 | yes |
| a | surface | tools | room-catalog | Bookmark Room | yes |
| a | surface | tools | room-catalog | 收藏室 | yes |
| a | surface | tools | room-catalog | Checklist Room | yes |
| a | surface | tools | room-catalog | 清单室 | yes |
| a | surface | tools | room-catalog | Prompt Library | yes |
| a | surface | tools | room-catalog | 提示词库 | yes |
| a | surface | tools | room-catalog | Text Workshop | yes |
| a | surface | tools | room-catalog | 文本工坊 | yes |
| a | surface | tools | room-catalog | Hash Room | yes |
| a | surface | tools | room-catalog | 哈希室 | yes |
| a | surface | tools | room-catalog | Data Lab | yes |
| a | surface | tools | room-catalog | 数据实验室 | yes |
| a | surface | tools | room-catalog | Focus Room | yes |
| a | surface | tools | room-catalog | 专注室 | yes |
| a | surface | tools | room-catalog | Calendar Room | yes |
| a | surface | tools | room-catalog | 日程室 | yes |
| a | surface | tools | room-catalog | Decision Room | yes |
| a | surface | tools | room-catalog | 决策室 | yes |
| a | surface | tools | room-launch | 打开 | yes |
| a | surface | tools | room-availability | 运行 | yes |
| a | surface | devices | device-list | Alien-PC | yes |
| a | surface | devices | device-telemetry | 12.4 | yes |
| a | surface | devices | device-detail | 磁盘 | yes |
| a | surface | devices | device-select | Alien-PC | yes |
| a | surface | activity | event-timeline | 20:19 | yes |
| a | surface | activity | event-timeline | 20:23 | yes |
| a | surface | services | capability-catalog | planning.document.intake | yes |
| a | surface | services | capability-catalog | planning.knowledge.query | yes |
| a | surface | services | capability-catalog | engineering.skill.inspect | yes |
| a | surface | services | capability-catalog | research.evidence.review | yes |
| a | surface | services | capability-catalog | presentation.theme.lab | yes |
| a | surface | services | capability-history | COMPLETED | yes |
| a | surface | services | capability-invoke | 调用 | yes |
| a | surface | tasks | task-list | CHECKPOINT_DEMO | yes |
| a | surface | tasks | task-list | COMPLETED | yes |
| a | surface | tasks | task-list | RUNNING | yes |
| a | surface | tasks | task-detail | 取消 | yes |
| a | surface | tasks | task-create-demo | 演示 | yes |
| a | surface | actions | action-history | 25 | yes |
| a | surface | actions | action-history | 50 | yes |
| a | surface | actions | action-history | 100 | yes |
| a | surface | pairing | pairing-session | 配对码 | yes |
| a | surface | pairing | pairing-diagnostics | mDNS | yes |
| a | surface | pairing | pairing-diagnostics | DISABLED | yes |
| a | surface | pairing | pairing-diagnostics | 蓝牙 | yes |
| a | surface | settings | locale-switch | English | yes |
| a | surface | settings | locale-switch | 简体中文 | yes |
| a | surface | settings | session-disconnect | 令牌 | yes |
| a | technical | revealed | task-detail | tsk-9c41 | yes |
| a | technical | revealed | task-detail | tsk-8b20 | yes |
| a | technical | revealed | event-timeline | 41 | yes |
| a | technical | revealed | event-timeline | task.completed | yes |
| a | technical | revealed | event-timeline | node.heartbeat | yes |
| a | technical | revealed | room-catalog | knowledge | yes |
| a | technical | revealed | room-catalog | text-workshop | yes |
| a | technical | revealed | room-catalog | data-lab | yes |
| a | technical | revealed | room-catalog | 01 | yes |
| a | technical | revealed | room-catalog | 10 | yes |
| a | technical | revealed | room-catalog | LOCAL_PRODUCT | yes |
| a | technical | revealed | device-detail | node-3f7a91c2 | yes |
| a | technical | revealed | device-list | 0.2.0 | yes |
| a | technical | revealed | capability-catalog | planning.knowledge.query | yes |
| a | technical | revealed | capability-history | inv-2f10 | yes |
| a | technical | revealed | capability-history | sha256:6a1f | yes |
| a | technical | revealed | session-disconnect | apiVersion | yes |
| a | technical | revealed | pairing-diagnostics | schemaVersion | yes |
| a | technical | revealed | room-availability | 127.0.0.1:4320 | yes |
| a | technical | revealed | action-detail | act-77c1 | yes |
| a | technical | revealed | action-detail | backendRef | yes |
| a | technical | revealed | action-detail | resultRef | yes |
| a | technical | revealed | action-detail | provenance | yes |
| a | technical | revealed | task-detail | lastCheckpoint | yes |
| a | technical | revealed | task-detail | step | yes |
| a | technical | revealed | pairing-diagnostics | no Bluetooth adapter | yes |
| a | technical | revealed | connect-token | 127.0.0.1 | yes |
| a | ask | ask:confirmed | ask-states | hash C:\tmp\a.txt | yes |
| a | ask | ask:confirmed | ask-states | Hash Room | yes |
| a | ask | ask:confirmed | ask-states | SHA-256 | yes |
| a | ask | ask:needsChoice | ask-states | clean up my downloads folder | yes |
| a | ask | ask:needsChoice | ask-states | Document intake | yes |
| a | ask | ask:needsChoice | ask-states | 确认 | yes |
| a | ask | ask:ambiguous | ask-states | open my notes | yes |
| a | ask | ask:ambiguous | ask-states | Knowledge Room | yes |
| a | ask | ask:ambiguous | ask-states | Checklist Room | yes |
| a | ask | ask:ambiguous | ask-states | Bookmark Room | yes |
| a | ask | ask:unmatched | ask-states | reticulate the splines | yes |
| a | ask | ask:unmatched | ask-states | Focus Room | yes |
| a | ask | ask:unmatched | ask-states | Data Lab | yes |
| a | ask | ask:working | ask-states | hash C:\tmp\a.txt | yes |
| a | ask | ask:working | ask-states | 执行 | yes |
| a | action | tools:打开 | openRoom | click:打开 | yes |
| a | action | tools:打开 | openRoom | 127.0.0.1:4320 | yes |
| a | action | tools:打开房间服务 | openHub | click:打开房间服务 | yes |
| a | action | services:调用 | invoke | click:调用 | yes |
| a | action | services:调用 | invoke | inv-11 | yes |
| a | action | tasks:运行一个演示任务 | createDemoTask | click:运行一个演示任务 | yes |
| a | action | tasks:运行一个演示任务 | createDemoTask | tsk-101 | yes |
| a | action | tasks:取消 | cancelTask | click:取消 | yes |
| a | action | tasks:取消 | cancelTask | CANCELLED | yes |
| a | action | pairing:生成配对码 | startPairing | click:生成配对码 | yes |
| a | action | pairing:生成配对码 | startPairing | 4821 | yes |
| a | action | settings:更换令牌 | disconnect | click:更换令牌 | yes |
| a | action | settings:更换令牌 | disconnect | 已断开 | yes |
| b | leak | home | demotion | tsk- | yes |
| b | leak | home | demotion | inv- | yes |
| b | leak | home | demotion | act- | yes |
| b | leak | home | demotion | apiVersion | yes |
| b | leak | home | demotion | schemaVersion | yes |
| b | leak | home | demotion | backendRef | yes |
| b | leak | home | demotion | provenance | yes |
| b | leak | home | demotion | #41 | yes |
| b | leak | ask | demotion | apiVersion | yes |
| b | leak | ask | demotion | schemaVersion | yes |
| b | leak | ask | demotion | idempotencyKey | yes |
| b | leak | ask | demotion | backendRef | yes |
| b | leak | tools | demotion | LOCAL_PRODUCT | yes |
| b | leak | tools | demotion | 127.0.0.1:4320 | yes |
| b | leak | tools | demotion | text-workshop | yes |
| b | leak | tools | demotion | data-lab | yes |
| b | leak | devices | demotion | node-3f7a91c2 | yes |
| b | leak | devices | demotion | agentVersion | yes |
| b | leak | devices | demotion | lastHeartbeatAt | yes |
| b | leak | activity | demotion | #41 | yes |
| b | leak | activity | demotion | "seq" | yes |
| b | leak | activity | demotion | tsk- | yes |
| b | surface | home | connection-state | Alien-PC | yes |
| b | surface | home | city-snapshot | 20:24 | yes |
| b | surface | home | attention-summary | 10 | yes |
| b | surface | home | device-telemetry | 12.4 | yes |
| b | surface | home | event-timeline | 20:19 | yes |
| b | surface | tools | room-catalog | Knowledge Room | yes |
| b | surface | tools | room-catalog | 本地知识室 | yes |
| b | surface | tools | room-catalog | Bookmark Room | yes |
| b | surface | tools | room-catalog | 收藏室 | yes |
| b | surface | tools | room-catalog | Checklist Room | yes |
| b | surface | tools | room-catalog | 清单室 | yes |
| b | surface | tools | room-catalog | Prompt Library | yes |
| b | surface | tools | room-catalog | 提示词库 | yes |
| b | surface | tools | room-catalog | Text Workshop | yes |
| b | surface | tools | room-catalog | 文本工坊 | yes |
| b | surface | tools | room-catalog | Hash Room | yes |
| b | surface | tools | room-catalog | 哈希室 | yes |
| b | surface | tools | room-catalog | Data Lab | yes |
| b | surface | tools | room-catalog | 数据实验室 | yes |
| b | surface | tools | room-catalog | Focus Room | yes |
| b | surface | tools | room-catalog | 专注室 | yes |
| b | surface | tools | room-catalog | Calendar Room | yes |
| b | surface | tools | room-catalog | 日程室 | yes |
| b | surface | tools | room-catalog | Decision Room | yes |
| b | surface | tools | room-catalog | 决策室 | yes |
| b | surface | tools | room-launch | 打开 | yes |
| b | surface | tools | room-availability | 运行 | yes |
| b | surface | devices | device-list | Alien-PC | yes |
| b | surface | devices | device-telemetry | 12.4 | yes |
| b | surface | devices | device-detail | 磁盘 | yes |
| b | surface | devices | device-select | Alien-PC | yes |
| b | surface | activity | event-timeline | 20:19 | yes |
| b | surface | activity | event-timeline | 20:23 | yes |
| b | surface | services | capability-catalog | planning.document.intake | yes |
| b | surface | services | capability-catalog | planning.knowledge.query | yes |
| b | surface | services | capability-catalog | engineering.skill.inspect | yes |
| b | surface | services | capability-catalog | research.evidence.review | yes |
| b | surface | services | capability-catalog | presentation.theme.lab | yes |
| b | surface | services | capability-history | COMPLETED | yes |
| b | surface | services | capability-invoke | 调用 | yes |
| b | surface | tasks | task-list | CHECKPOINT_DEMO | yes |
| b | surface | tasks | task-list | COMPLETED | yes |
| b | surface | tasks | task-list | RUNNING | yes |
| b | surface | tasks | task-detail | 取消 | yes |
| b | surface | tasks | task-create-demo | 演示 | yes |
| b | surface | actions | action-history | 25 | yes |
| b | surface | actions | action-history | 50 | yes |
| b | surface | actions | action-history | 100 | yes |
| b | surface | pairing | pairing-session | 配对码 | yes |
| b | surface | pairing | pairing-diagnostics | mDNS | yes |
| b | surface | pairing | pairing-diagnostics | DISABLED | yes |
| b | surface | pairing | pairing-diagnostics | 蓝牙 | yes |
| b | surface | settings | locale-switch | English | yes |
| b | surface | settings | locale-switch | 简体中文 | yes |
| b | surface | settings | session-disconnect | 令牌 | yes |
| b | technical | revealed | task-detail | tsk-9c41 | yes |
| b | technical | revealed | task-detail | tsk-8b20 | yes |
| b | technical | revealed | event-timeline | 41 | yes |
| b | technical | revealed | event-timeline | task.completed | yes |
| b | technical | revealed | event-timeline | node.heartbeat | yes |
| b | technical | revealed | room-catalog | knowledge | yes |
| b | technical | revealed | room-catalog | text-workshop | yes |
| b | technical | revealed | room-catalog | data-lab | yes |
| b | technical | revealed | room-catalog | 01 | yes |
| b | technical | revealed | room-catalog | 10 | yes |
| b | technical | revealed | room-catalog | LOCAL_PRODUCT | yes |
| b | technical | revealed | device-detail | node-3f7a91c2 | yes |
| b | technical | revealed | device-list | 0.2.0 | yes |
| b | technical | revealed | capability-catalog | planning.knowledge.query | yes |
| b | technical | revealed | capability-history | inv-2f10 | yes |
| b | technical | revealed | capability-history | sha256:6a1f | yes |
| b | technical | revealed | session-disconnect | apiVersion | yes |
| b | technical | revealed | pairing-diagnostics | schemaVersion | yes |
| b | technical | revealed | room-availability | 127.0.0.1:4320 | yes |
| b | technical | revealed | action-detail | act-77c1 | yes |
| b | technical | revealed | action-detail | backendRef | yes |
| b | technical | revealed | action-detail | resultRef | yes |
| b | technical | revealed | action-detail | provenance | yes |
| b | technical | revealed | task-detail | lastCheckpoint | yes |
| b | technical | revealed | task-detail | step | yes |
| b | technical | revealed | pairing-diagnostics | no Bluetooth adapter | yes |
| b | technical | revealed | connect-token | 127.0.0.1 | yes |
| b | ask | ask:confirmed | ask-states | hash C:\tmp\a.txt | yes |
| b | ask | ask:confirmed | ask-states | Hash Room | yes |
| b | ask | ask:confirmed | ask-states | SHA-256 | yes |
| b | ask | ask:needsChoice | ask-states | clean up my downloads folder | yes |
| b | ask | ask:needsChoice | ask-states | Document intake | yes |
| b | ask | ask:needsChoice | ask-states | 确认 | yes |
| b | ask | ask:ambiguous | ask-states | open my notes | yes |
| b | ask | ask:ambiguous | ask-states | Knowledge Room | yes |
| b | ask | ask:ambiguous | ask-states | Checklist Room | yes |
| b | ask | ask:ambiguous | ask-states | Bookmark Room | yes |
| b | ask | ask:unmatched | ask-states | reticulate the splines | yes |
| b | ask | ask:unmatched | ask-states | Focus Room | yes |
| b | ask | ask:unmatched | ask-states | Data Lab | yes |
| b | ask | ask:working | ask-states | hash C:\tmp\a.txt | yes |
| b | ask | ask:working | ask-states | 执行 | yes |
| b | action | tools:打开 | openRoom | click:打开 | yes |
| b | action | tools:打开 | openRoom | 127.0.0.1:4320 | yes |
| b | action | tools:打开房间服务 | openHub | click:打开房间服务 | yes |
| b | action | services:调用 | invoke | click:调用 | yes |
| b | action | services:调用 | invoke | inv-11 | yes |
| b | action | tasks:运行演示作业 | createDemoTask | click:运行演示作业 | yes |
| b | action | tasks:运行演示作业 | createDemoTask | tsk-101 | yes |
| b | action | tasks:取消 | cancelTask | click:取消 | yes |
| b | action | tasks:取消 | cancelTask | CANCELLED | yes |
| b | action | pairing:生成配对码 | startPairing | click:生成配对码 | yes |
| b | action | pairing:生成配对码 | startPairing | 4821 | yes |
| b | action | settings:更换令牌 | disconnect | click:更换令牌 | yes |
| b | action | settings:更换令牌 | disconnect | 已断开 | yes |
| c | leak | home | demotion | tsk- | yes |
| c | leak | home | demotion | inv- | yes |
| c | leak | home | demotion | act- | yes |
| c | leak | home | demotion | apiVersion | yes |
| c | leak | home | demotion | schemaVersion | yes |
| c | leak | home | demotion | backendRef | yes |
| c | leak | home | demotion | provenance | yes |
| c | leak | home | demotion | #41 | yes |
| c | leak | ask | demotion | apiVersion | yes |
| c | leak | ask | demotion | schemaVersion | yes |
| c | leak | ask | demotion | idempotencyKey | yes |
| c | leak | ask | demotion | backendRef | yes |
| c | leak | tools | demotion | LOCAL_PRODUCT | yes |
| c | leak | tools | demotion | 127.0.0.1:4320 | yes |
| c | leak | tools | demotion | text-workshop | yes |
| c | leak | tools | demotion | data-lab | yes |
| c | leak | devices | demotion | node-3f7a91c2 | yes |
| c | leak | devices | demotion | agentVersion | yes |
| c | leak | devices | demotion | lastHeartbeatAt | yes |
| c | leak | activity | demotion | #41 | yes |
| c | leak | activity | demotion | "seq" | yes |
| c | leak | activity | demotion | tsk- | yes |
| c | surface | home | connection-state | Alien-PC | yes |
| c | surface | home | city-snapshot | 20:24 | yes |
| c | surface | home | attention-summary | 10 | yes |
| c | surface | home | device-telemetry | 12.4 | yes |
| c | surface | home | event-timeline | 20:19 | yes |
| c | surface | tools | room-catalog | Knowledge Room | yes |
| c | surface | tools | room-catalog | 本地知识室 | yes |
| c | surface | tools | room-catalog | Bookmark Room | yes |
| c | surface | tools | room-catalog | 收藏室 | yes |
| c | surface | tools | room-catalog | Checklist Room | yes |
| c | surface | tools | room-catalog | 清单室 | yes |
| c | surface | tools | room-catalog | Prompt Library | yes |
| c | surface | tools | room-catalog | 提示词库 | yes |
| c | surface | tools | room-catalog | Text Workshop | yes |
| c | surface | tools | room-catalog | 文本工坊 | yes |
| c | surface | tools | room-catalog | Hash Room | yes |
| c | surface | tools | room-catalog | 哈希室 | yes |
| c | surface | tools | room-catalog | Data Lab | yes |
| c | surface | tools | room-catalog | 数据实验室 | yes |
| c | surface | tools | room-catalog | Focus Room | yes |
| c | surface | tools | room-catalog | 专注室 | yes |
| c | surface | tools | room-catalog | Calendar Room | yes |
| c | surface | tools | room-catalog | 日程室 | yes |
| c | surface | tools | room-catalog | Decision Room | yes |
| c | surface | tools | room-catalog | 决策室 | yes |
| c | surface | tools | room-launch | 打开 | yes |
| c | surface | tools | room-availability | 运行 | yes |
| c | surface | devices | device-list | Alien-PC | yes |
| c | surface | devices | device-telemetry | 12.4 | yes |
| c | surface | devices | device-detail | 磁盘 | yes |
| c | surface | devices | device-select | Alien-PC | yes |
| c | surface | activity | event-timeline | 20:19 | yes |
| c | surface | activity | event-timeline | 20:23 | yes |
| c | surface | services | capability-catalog | planning.document.intake | yes |
| c | surface | services | capability-catalog | planning.knowledge.query | yes |
| c | surface | services | capability-catalog | engineering.skill.inspect | yes |
| c | surface | services | capability-catalog | research.evidence.review | yes |
| c | surface | services | capability-catalog | presentation.theme.lab | yes |
| c | surface | services | capability-history | COMPLETED | yes |
| c | surface | services | capability-invoke | 调用 | yes |
| c | surface | tasks | task-list | CHECKPOINT_DEMO | yes |
| c | surface | tasks | task-list | COMPLETED | yes |
| c | surface | tasks | task-list | RUNNING | yes |
| c | surface | tasks | task-detail | 取消 | yes |
| c | surface | tasks | task-create-demo | 演示 | yes |
| c | surface | actions | action-history | 25 | yes |
| c | surface | actions | action-history | 50 | yes |
| c | surface | actions | action-history | 100 | yes |
| c | surface | pairing | pairing-session | 配对码 | yes |
| c | surface | pairing | pairing-diagnostics | mDNS | yes |
| c | surface | pairing | pairing-diagnostics | DISABLED | yes |
| c | surface | pairing | pairing-diagnostics | 蓝牙 | yes |
| c | surface | settings | locale-switch | English | yes |
| c | surface | settings | locale-switch | 简体中文 | yes |
| c | surface | settings | session-disconnect | 令牌 | yes |
| c | technical | revealed | task-detail | tsk-9c41 | yes |
| c | technical | revealed | task-detail | tsk-8b20 | yes |
| c | technical | revealed | event-timeline | 41 | yes |
| c | technical | revealed | event-timeline | task.completed | yes |
| c | technical | revealed | event-timeline | node.heartbeat | yes |
| c | technical | revealed | room-catalog | knowledge | yes |
| c | technical | revealed | room-catalog | text-workshop | yes |
| c | technical | revealed | room-catalog | data-lab | yes |
| c | technical | revealed | room-catalog | 01 | yes |
| c | technical | revealed | room-catalog | 10 | yes |
| c | technical | revealed | room-catalog | LOCAL_PRODUCT | yes |
| c | technical | revealed | device-detail | node-3f7a91c2 | yes |
| c | technical | revealed | device-list | 0.2.0 | yes |
| c | technical | revealed | capability-catalog | planning.knowledge.query | yes |
| c | technical | revealed | capability-history | inv-2f10 | yes |
| c | technical | revealed | capability-history | sha256:6a1f | yes |
| c | technical | revealed | session-disconnect | apiVersion | yes |
| c | technical | revealed | pairing-diagnostics | schemaVersion | yes |
| c | technical | revealed | room-availability | 127.0.0.1:4320 | yes |
| c | technical | revealed | action-detail | act-77c1 | yes |
| c | technical | revealed | action-detail | backendRef | yes |
| c | technical | revealed | action-detail | resultRef | yes |
| c | technical | revealed | action-detail | provenance | yes |
| c | technical | revealed | task-detail | lastCheckpoint | yes |
| c | technical | revealed | task-detail | step | yes |
| c | technical | revealed | pairing-diagnostics | no Bluetooth adapter | yes |
| c | technical | revealed | connect-token | 127.0.0.1 | yes |
| c | ask | ask:confirmed | ask-states | hash C:\tmp\a.txt | yes |
| c | ask | ask:confirmed | ask-states | Hash Room | yes |
| c | ask | ask:confirmed | ask-states | SHA-256 | yes |
| c | ask | ask:needsChoice | ask-states | clean up my downloads folder | yes |
| c | ask | ask:needsChoice | ask-states | Document intake | yes |
| c | ask | ask:needsChoice | ask-states | 确认 | yes |
| c | ask | ask:ambiguous | ask-states | open my notes | yes |
| c | ask | ask:ambiguous | ask-states | Knowledge Room | yes |
| c | ask | ask:ambiguous | ask-states | Checklist Room | yes |
| c | ask | ask:ambiguous | ask-states | Bookmark Room | yes |
| c | ask | ask:unmatched | ask-states | reticulate the splines | yes |
| c | ask | ask:unmatched | ask-states | Focus Room | yes |
| c | ask | ask:unmatched | ask-states | Data Lab | yes |
| c | ask | ask:working | ask-states | hash C:\tmp\a.txt | yes |
| c | ask | ask:working | ask-states | 执行 | yes |
| c | action | tools:打开 | openRoom | click:打开 | yes |
| c | action | tools:打开 | openRoom | 127.0.0.1:4320 | yes |
| c | action | tools:打开房间服务 | openHub | click:打开房间服务 | yes |
| c | action | services:调用 | invoke | click:调用 | yes |
| c | action | services:调用 | invoke | inv-11 | yes |
| c | action | tasks:运行演示任务 | createDemoTask | click:运行演示任务 | yes |
| c | action | tasks:运行演示任务 | createDemoTask | tsk-101 | yes |
| c | action | tasks:取消 | cancelTask | click:取消 | yes |
| c | action | tasks:取消 | cancelTask | CANCELLED | yes |
| c | action | pairing:生成配对码 | startPairing | click:生成配对码 | yes |
| c | action | pairing:生成配对码 | startPairing | 4821 | yes |
| c | action | settings:更换令牌 | disconnect | click:更换令牌 | yes |
| c | action | settings:更换令牌 | disconnect | 已断开 | yes |