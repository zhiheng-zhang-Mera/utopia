# 实验 Manifest 与实验注册表

DATE: 2026-10-05
STATUS: REX-801 EXPERIMENT_MANIFEST_REGISTRY_ACCEPTED (development complete; opposite-host formal review pending)

研究结论只有在实验**先被描述、后被执行**时才可复现。`REX-801` 增加了机器可读的实验 manifest 与对应的注册表，
使一个研究问题绑定它的拓扑、变量、度量、重复次数、种子策略、所需能力、停止条件、产物策略、验收标准与精确软件
身份，而不是绑定在报告里的散文描述上。

注册表只回答四件事：列出已登记实验、查看某个 manifest、在不登记的前提下校验 manifest、创建或导入 manifest。
这里没有 run / pause / stop / export —— 期待这些的调用方会得到 typed 404，而不是意外行为：本契约描述实验，
执行实验属于 scenario runner。

manifest 从不凭空造值。任何缺失的必填字段都会产生带字段路径的 typed issue，因此 manifest 不可能因为被悄悄“修好”
而变得合法。不可能的拓扑会按它所有可能出错的方式被拒绝——主机数不足、没有真实 worker、没有控制面、worker 不在
声明的 host 列表里、拓扑要求 Android 控制面却没写。所需能力会对**本 City 真实提供**的能力词表做校验，而空词表
会拒绝一切而不是接受一切。软件身份必须精确：短 SHA 或截断粘贴会被指名拒绝，因为软件身份可移动的 manifest 不是
可复现实验。

同一个 manifest 永远产生同一组种子。种子推导是纯函数，只依赖实验身份、种子策略与重复/变体序号，绝不依赖时钟或
随机源；因此五次重复就是五条确定性的不同 run，而固定种子实验是真的固定。

manifest 不是任务数据库。携带 tasks / assignments / leases / results 这类任务域字段的登记会被指名拒绝；存储使用
git-ignored 运行目录下的文件，而不是以任务为主键的 City store；已登记的描述不可修改：内容变化必须换新的实验
标识，相同内容重复登记则幂等。被拒绝的 manifest 会带着 issue 列表被存为 rejection，使负面结果作为证据保留下来，
而不是被丢弃。

读取与描述实验需要控制凭据。worker 不得登记它将要被评判的那个实验——否则验收标准就成了自我认证。

研究路由位于 research 命名空间下，任何已持有 owner 凭据的 surface 都可访问；把它们呈现给用户的分层 Research
界面属于后续的研究控制面任务，因此本次发布只暴露契约，不新增顶级导航入口。

真实双机结果在不可用时仍保持 NOT_RUN；本任务不执行任何实验，因此不给出任何测量、硬件或性能结论。
