# 执行后端契约与 STANDARD_DEVICES 基线

DATE: 2026-10-04
STATUS: WBC-601 EXECUTION_BACKEND_STANDARD_COMPAT_ACCEPTED (development complete; opposite-host formal review pending)

原则上 Utopia 可以在多种执行资源上跑任务，但在此之前它实际只能跑在自己 City 里注册过的设备上，而且这件事
只存在于节点路由的代码里，并不是一份契约。本次改动先把执行后端的形状冻结成
`contracts/execution-backend-v1`，并把今天的行为绑定为其上的 `STANDARD_DEVICES`。未来出现 Workbench 节点池时，
它是同一形状的第二次注册，而不是对派发路径的重写。

后端只回答六个问题，别的一概不管：它是否可用、不可用时为什么（`readiness`）、有哪些执行端点以及各自的真实
可用性（`endpoints`），以及 `dispatch`、`claim`、`report`、`control` 四个操作。后端不拥有任务状态：canonical
task 记录、lease 语义与 idempotency 仍属于 Shared Task Core，后端不得长出第二套调度器或第二个任务库。

`STANDARD_DEVICES` 无条件注册，并且是默认 profile。它不是“缺少 Workbench 时的兜底”，而是产品本来就在跑的
基线：没有任何配置能把它关掉；同样，给未来 profile 起个名字并不能把它启用——`CITY_EXECUTION_PROFILE` 只接受
本版本真正随包发布的 profile，dormant 后端会以 typed refusal 拒绝普通工作，而不是被静默忽略。

落点规则没有变。strict target 先于通用可用性生效，因此指向离线设备的任务被 withheld，绝不会被改派；已经持有
未完成工作的设备不会被再分配，因此两个任务不会落到同一台设备上；Owner 关闭共享后，设备仍在线可见但不再接
活。withheld 集合仍以数据形式返回，所以设备能区分“没有活”和“有活但不是你的”。

这里没有任何启动依赖。没有 Workbench、也没有 Linux server 的 City 启动、服务、派发、执行、回传全部与之前
一致；执行后端在 health 与 City status 上作为独立组件报告自己的 readiness 用词，且“此刻没有设备在线”不被当作
Gateway 降级。

该能力不面向最终用户，也不需要控制面：它是内部派发 seam。当前由哪个 profile 服务这座 City，在 City status
载荷上可观察——这正是让未来“是池子干的”这类说法可被核查的前提。

真实双机结果在不可用时仍保持 NOT_RUN；隔离测试不能证明硬件性能，也不能证明未来的 Workbench 路径，
后者属于 WBC-603/604 的范围，本次未启用。
