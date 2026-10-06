# 故障回执修复

对机复检发现：不可读故障回执会阻止City启动，缺少身份的回执会被静默接纳。已独立复现原提交失败并采纳已发布读取守卫；损坏记录明确披露，普通请求保持可用。未声明外部provider或实体主机恢复、Android故障控制或复检通过。

Original head f76ccf53; adopted proposal19a420c; receipt guards2 RED then focused12 PASS. Raw logs: evidence/raw/mission-book/REX-804/alien-repair.

## Current-main directory degradation / 当前main目录降级

与current main集成后发现第二个启动阻断：research/faults目录不可用时，回执守卫执行前已抛错。目录检查现降级为UNAVAILABLE，注入typed503拒绝，Web披露并禁用注入，规范观察和普通任务创建继续。19项相关测试通过，包括2项新增独立探针。初版新任务探针误传不受支持payload且误认响应封装；400属于仪器缺陷，改为实际WAIT契约并保留断言。
