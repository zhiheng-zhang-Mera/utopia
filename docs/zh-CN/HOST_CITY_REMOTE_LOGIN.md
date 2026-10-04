# 单主机城市与远程登录

所有新版安装目录的启动器及 Gateway 生产入口共用固定的 `127.0.0.1:4389` 主机保留端口。重复启动或请求不同城市端口时，复用现有城市；不会终止它或新建另一座城市。协调端口被其他程序占用时拒绝启动。仍在监听的旧版 Gateway 必须先明确停止，启动器不会自动杀进程。

城市目录指针默认保存于 `%ProgramData%/Utopia/host/city.json`。首次启动保留当前安装已有的 `city.sqlite`；没有旧数据库时使用公共目录 `city`。其他安装与崩溃后的启动沿用这个目录和城市身份。数据库丢失时拒绝静默创建新城市。已有多个历史城市的安装包不会自动合并数据库，首次注册的城市为本机城市。

Gateway、参考节点与房间服务由同一个进程持有。关闭启动器窗口不会结束后台城市。`scripts/start-city.ps1` 启动或复用本机城市；`scripts/stop-city.ps1` 明确停止当前城市；`scripts/restart-gateway.ps1` 明确重启并保留端口、房间、发现及遥测设置。重复启动不覆盖已运行城市的选项。

设备注册记录在 `%LOCALAPPDATA%/Utopia/client/device-enrollment.json`，可迁移当前安装旧记录。普通启动器自动重连记录中的远程目标，失败时提示错误并停止；不会回退创建本机城市。主机脚本使用 `--host-only`，避免远程注册改变主机启动行为。

远程邀请保留目标地址。短码命令为：

```powershell
node scripts/utopia-client-launcher.mjs --enroll-code 123456 --enroll-host https://your-city.example --no-open
```

六位短码只对指定城市的当前配对会话有效，单次使用、有效期和错误尝试锁定沿用原有协议。它不是全球城市查找码。跨地区登录要求目标地址可达；本地 IP、mDNS 和蓝牙不能跨互联网寻找城市。当前代码没有部署公共中继、全球短码目录或自动 NAT 穿透。生产公网访问还需要实际部署的 HTTPS 与网络路由；代码修复和本机 HTTP 回归不代表真实跨地区验收。

开发测试可指定 `UTOPIA_HOST_STATE_DIR` 和 `UTOPIA_CLIENT_STATE_DIR` 保存临时数据，但主机协调端口保持固定。低层 `createGateway()` 保留多城市测试能力，不作为生产启动入口。
