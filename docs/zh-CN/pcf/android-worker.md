# Android 可选 worker 候选（PCF-719）

当前是本地开发证据，不代表启用或完整链路验收。Android 原应用仍为 control client；未连接 worker UI、远程启用端点、凭据签发、配对或手机部署。现有实机保持 control-only。

`PcfWorkerService` 为非导出服务，默认没有执行资格。只有应用内 binder 收到明确 Owner 同意及独立配置的受限 worker binding 后才可激活。binding 复用已有 City/device 身份，引用独立 worker installation/principal 与不透明 credential handle；拒绝把 control installation 直接用作 worker installation。这些引用本身不是认证：后续接入必须先在 canonical device/installation registry 认证、授权该 grant，再调用 `activate`。候选不签发或校验服务器凭据，不建立第二套任务库，也不生成第二套物理设备身份。

激活必须由可见应用发起；转到后台继续运行还需独立后台预算批准。服务提供前台常驻通知与 Stop，使用两分钟内存租约、`shortService`、`START_NOT_STICKY`。移除应用任务、停止/撤销、OS 销毁、超时及进程死亡都会清除执行资格，不自动重启或开机启动。唯一新增权限是前台服务权限。原摄像头权限属于既有扫码控制功能；worker 不访问摄像头、麦克风、位置或蓝牙。未新增通知权限提示，平台通知可见性仍需实机验证。

可见性由 application `ActivityLifecycleCallbacks` 观察，不接受 binder 调用方设置的标志；只有已 resumed 的 Activity 计入可见，pause/stop/destroy 都清除对应状态。初始未知状态拒绝执行：后续集成必须在 Activity resume 前绑定，或等下一次真实 resume 回调后激活。分发和结果完成分别重新读取状态；没有独立后台批准时，pause 后任务和结果均被拒绝。原生 lifecycle 单元测试先观察到旧缓存行为造成的断言 RED，再修复 observer；证据为 `.runtime/pcf-stageb-android-lifecycle-red.log` 与 `pcf-stageb-android-lifecycle-green.log`。`tests/pcf719-android-edge-contract.test.mjs` 仅提供 Node 源码/seam 守卫，不能替代原生或实机运行证据。

唯一轻量 executor 为 `text.normalize.v1`：同步规范化空白字符，输入上限 16,384 个 UTF-16 code units；不执行 shell、下载代码或模型。分发前及释放结果前检查租约、worker generation 和最新 OS 条件：电量至少 20%、thermal 仅 none/light、省电关闭、已验证联网、非 metered，以及前台/后台批准。未知电量或热读数拒绝执行；Android 26–28 无此热读数，因此不可用。binder 停止/撤销清除 grant；服务器撤销传播和持续验证权威 grant 是远程调度前置条件。离线不会上传或伪造结果。

使用已有 JDK 17/SDK、本地离线验证，无安装：`gradlew.bat :app:testDebugUnitTest :app:assembleDebug --offline`。日志位于 `.runtime/pcf-stageb-android-red.log`、`pcf-stageb-android-service-red.log`、`pcf-stageb-android-green.log`、`pcf-stageb-android-build.log`。RED 记录候选类型尚不存在；原生单元测试覆盖 opt-in 拒绝、installation 分离、allowlist/输入预算、各资源拒绝、后台批准、结果 generation fence、停止/撤销/回收及租约过期。APK 编译和单元测试不能证明服务在 Android 运行时行为。

仍为 `NOT_RUN`：服务 instrumentation、实机通知/Stop 可见性、后台/OS 回收、电量/thermal 拒绝、网络切换、权限/服务器撤销传播、凭据注册与角色登记、批准 PC 计算、原手机结果回流和跨主机 review。需要明确批准特定 Android execution service/预算、安全接入 canonical 受限 worker grant，并纳入最终一次 Mech 交接。不得给现有 control-only 手机安装此候选，不得把同一手机两种 principal 算作两台物理主机，也不保证全天候后台常驻。
