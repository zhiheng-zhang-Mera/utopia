# Alternate-device user decision / 另一设备执行选择

Web Devices and Android Devices expose an explicit “Keep this service and use another device” choice when canonical Gateway userChoices version 1 reports a real switch decision. Provider selection, local keep-waiting acknowledgement and cancellation remain distinct. Generic CONFIRM stays unavailable.

Gateway uses the existing RS202 planner to assess an alternative without executing the read. POST tasks/:id/switch-declined with decision ALTERNATE_DEVICE and expectedUpdatedAt revalidates revision, strict target and current eligible devices before mutation. Legacy empty-body decline is unchanged. Only an already accepted explicit revision receives replay success; a legacy decline cannot authorize a later explicit replay. Sharing-disabled devices are unavailable candidates.

Web pending requests survive rerender/navigation and callbacks are fenced by credential and City. Android pending state lives above page navigation and is fenced by client/City disposal. Full task identifiers remain in Technical detail; ordinary service labels use canonical display names. Native UI uses the baseline English-only scheduler architecture; Web supports English/Chinese.

后端决定是否有替代设备，客户端只展示选择，不自行计算路由。指定设备、过期决策、无可用替代设备会被拒绝；关闭资源共享的设备不会成为候选。重复已接受的明确请求不会产生第二次意图或交接。选择执行设备不会指定或迁移 City 主城代理，加入城市仍只能降级本机。

Validation: four controlled Gateway/browser/worker scenarios; 53 focused regressions; Android 82 unit tests and APK build. One actual local worker completed a WAIT task and its result appeared on the initiating Web surface. Android online interaction and multi-physical-host execution NOT_RUN. Measured waitedMs is task output, not a performance benchmark. Opposite-host Formal Review and accepted-main integration remain pending. Source-bound receipt: evidence/raw/mission-book/CEX-702/development-receipt.json; all red and correction logs remain indexed.
