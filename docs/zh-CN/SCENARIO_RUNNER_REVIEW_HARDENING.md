# 实验重复执行复检加固

Alien独立复检先在原目标观察到5项失败，再采纳作者提案。新增探针发现损坏恢复记录、恢复scenario/context漂移、readiness拒绝覆盖原记录、延迟cleanup跨run串扰、测量记录自相矛盾和冻结研究时钟破坏关闭期限。恢复先验证不变量，再验证保存上下文；拒绝时保留中断campaign，每个run拥有独立cleanup，关闭采用单调时钟。相关62项测试通过。Alien + Mech + Android实体campaign门槛尚未观测，未声明验收完成。

Original target a695bb9; adopted proposals07e8c3c/42acdc6; raw evidence: evidence/raw/mission-book/REX-803/alien-review.
