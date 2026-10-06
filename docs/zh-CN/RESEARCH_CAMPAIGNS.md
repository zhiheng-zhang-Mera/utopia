# 受控研究实验

打开 Research 并登记清单，在受控重复实验中填写已登记 ID，选择安全任务场景、测量重复次数、预热次数和单次超时。开始后立即返回，进度列表和所选回执每秒刷新。停止只取消当前实验任务，并阻止后续重复运行。

清单必须引用在线 canonical worker 和控制面身份。种子确定性选择清单内 worker，canonical 严格目标确保任务不逸出声明拓扑。API 显式指定目标时不应用种子选择，回执会说明。预热、失败、超时和排除记录全部保留。完成只表示有界实验运行结束，不代表研究假设或独立复现已经验收。

`GET/POST /api/v0/research/campaigns`、`GET /api/v0/research/campaigns/:id` 和 `POST /api/v0/research/campaigns/:id/stop` 需要 City Owner 身份。Worker 和已加入成员均被拒绝。清单登记仍不执行任务。

重启策略为 `INTERRUPT`，活动实验不会偷偷续跑。Canonical task 原子保存 research run 归属，因此启动时能找回在回执指针写入前已创建的任务。回执时间使用宿主墙钟，不作为跨机延迟。软件引用是声明的完整身份，仍需独立核对运行态。Android 控制入口对齐和 Alien/Mech/Android 实体实验仍属于验收工作；本组件的控制入口位于 Web Research。

运行 `node --test tests/rex803-*.test.mjs` 和 `pnpm test`。证据位于 `evidence/raw/mission-book/REX-803/`。
