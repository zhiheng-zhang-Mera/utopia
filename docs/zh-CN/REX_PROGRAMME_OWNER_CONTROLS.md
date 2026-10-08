# REX programme：远程执行与 Agent 作业

连接正在运行的 City，并使用 City Owner 凭据。Web 从 Advanced 打开 Remote operation / Agent jobs；Android 从顶部「更多」打开「远程执行」/「Agent 作业」。普通成员无法派发、撤回或查看 Owner 私有任务。

两条能力默认关闭。City 启动时需明确配置 `CITY_REMOTE_OPERATION=1`、`CITY_REMOTE_OPERATION_ALLOWLIST`、`CITY_REMOTE_OPERATION_WORKSPACES`，以及 `CITY_AGENT_JOB=1`。允许程序与工作区列表使用逗号分隔。只声明确实需要的程序和工作区。Node 必须在线并声明对应能力；严格指定的离线设备会等待，不会换机器。

远程执行：选择设备，填写程序、参数 JSON 字符串数组（例如 `["--version"]`）、工作目录和目的；检查超时与输出上限；输入程序名确认，再派发。Web 也接受每行一个参数。参数作为数组传递，不经过 shell。任务页显示真实状态、stdout、stderr、退出码、超时、截断和回执；运行期间可停止。

Agent 作业：选择有 Agent 应答的设备，填写标题、请求内容、目的，可选输入引用 `name=ref` 和期限；输入标题确认，再派发。远端 Agent 使用现有 claim/report 协议领取并报告。City 不会自动启动某个模型或验证报告内容；收到报告后「确认收取」记录阅读方的确认，不代表验收。过期是期限投影，canonical task 状态仍保留。

Ask / Do 支持固定规则下的中英文请求，例如「在 Alien 上运行 git 查看版本」、`run git on Alien`、「让 Alien 的 Agent 检查项目测试」。第一轮仅生成草稿，点击「检查操作草稿 / Review draft」后补齐必填项，再在控制页确认。设备名称重名时需手动选择；cwd、目的和作业标题不会猜测。已有手动能力选择优先于文本推断；未匹配请求保留原有工具选择流程。此入口不是任意自然语言或 LLM 控制。

修改字段、切换凭据或断线后需重新确认。网络失败后的同内容重试保留请求键以避免重复执行；成功后新的明确派发会创建新任务。程序不在允许列表、目录越界、成员权限、能力关闭等拒绝应按界面实际代码处理。

Android 安装应使用同一签名证书升级现有包。不同开发机的 debug 证书无法覆盖安装；保留原应用数据时可另装独立验证包，不应卸载或清除原包来规避签名检查。
