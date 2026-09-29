# 设备中心与配对操作指南

## 在 Windows 启动 City

在仓库根目录使用 PowerShell，准备 Node.js 24 或更高版本并安装仓库依赖（`pnpm install --frozen-lockfile`）。显式指定本机可信局域网网卡的地址，启动 Gateway 与参考节点：

```powershell
.\scripts\start-city.ps1 -BindAddress 192.168.1.20 -Port 4310
```

将示例地址替换为本机实际的局域网 IPv4 地址。Android 必须能够通过同一可信局域网访问该地址；仅按需要在专用网络放行配置的端口。默认地址 `127.0.0.1` 仅供本机使用，手机无法访问。不要使用通配监听地址，也不要通过互联网端口转发暴露 Gateway。

脚本在后台启动 Gateway 与节点，将进程 ID 和 URL 保存到 `.runtime/processes.json`，并输出 City 与配对页面地址。首次运行时，它会在 `.runtime/local-config.json` 中创建互相独立的控制凭据和节点凭据。重启时应保留这份私有配置。`-DisableDiscovery` 与 `-DisableTelemetry` 是可选诊断开关；正常使用时保持两项功能启用。

## 打开 Web 控制端

打开输出的 City URL，或运行 `scripts/show-pairing.ps1` 打开其 `/pairing` 页面。私下读取 `.runtime/local-config.json` 的 `token` 字段，填入 Web 的 **Pairing token** 输入框。不要使用 `nodeToken`。Web 将控制 token 保存在浏览器会话存储中。**Settings → Change pairing token** 可清除该浏览器保存的 token。

**Devices** 展示 Gateway 快照中的节点。选择设备后，可查看身份、平台、Agent 版本、最近在线时间、CPU、内存、磁盘、运行时长、能力、当前任务与最近事件。**Tasks** 和 **Activity** 继续展示同一控制面的任务历史。

## 创建短期配对会话

在 **Pairing** 中检查 City URL 和发现服务诊断，然后选择 **Generate pairing session**。页面会显示二维码、六位短码、当前会话标识以及到期倒计时。默认有效期为五分钟。一次成功交换即消耗该会话，不能继续配对第二台设备。

**Revoke and refresh session** 会立即替换旧会话。材料过期、已使用或被替换后，应刷新再进行下一次配对。五次错误交换会锁定该会话，此时应在主机生成新会话。二维码仅包含短期配对材料，不包含永久控制凭据。

Web 在到期、断连或切换页面时清除显示的二维码和短码。离开页面只会隐藏材料，不会自行撤销 Gateway 会话；创建新会话才会撤销旧会话。不得将仍有效的二维码、短码或永久凭据保存到截图、UI 转储、日志、版本库或实验记录中。

## 配对 Android

未保存凭据时，Android 应用会打开 **Find your City**：

1. **Scan QR：**允许相机访问，将镜头对准 Web 上仍有效的二维码。应用交换短期 secret 并连接，无需复制 URL 或 token。
2. **Nearby Cities (LAN)：**通过 mDNS 发现并选择 City，输入主机显示的短码，再选择 **Connect**。应先在主机创建配对会话；应用会在连接时刷新会话信息。
3. **Nearby via Bluetooth：**打开蓝牙，授予请求的附近设备权限（旧版 Android 可能请求位置权限）。选择发现的 City 并输入主机短码。仍然需要可达的局域网连接，蓝牙仅提供发现信息。拒绝权限、蓝牙关闭或扫描器不可用时，应用会显示可读提示。未发现 City 时，查看 Web 的 Bluetooth 诊断。
4. **Manual connection：**输入 City URL 和私有控制 `token`，选择 **Save and connect**。此保底方式不依赖短期会话或发现服务。

认证后，**Devices** 显示共享的 Gateway 快照。在 Android **Settings** 中选择 **Clear pairing / Find your City**，即可删除已保存连接并返回首次配对界面。这只清除当前客户端保存的凭据，不会轮换主机的永久凭据。

四种入口最终都使用已有的认证 HTTP/WebSocket 控制面。发现功能不会创建第二套任务或设备数据库。同一 City 身份出现冲突地址时，应排查原因，不得静默合并。

## 读取遥测与连接状态

参考节点约每三秒采集一次遥测。采样带有观察时间戳，界面的新鲜度上限为十秒。CPU 在第二次采样形成差值前可能不可用。不可用或 `null` 字段表示 **Unknown**，不表示零。

离线节点显示 **OFFLINE**。客户端与 Gateway 失联时无法确认节点的实时状态，因此显示 **UNKNOWN**；客户端自身也可能单独显示 **RECONNECTING**。过时遥测会明确标为缓存/未知。缓存数值仍是历史观察，不应作为实时测量使用。恢复局域网、Gateway 或节点连接后，等待下一份权威快照更新显示。

## 发现机制与使用边界

mDNS 发布 `_utopia-city._tcp`，仅携带非秘密的版本、City 和会话提示。Windows BLE 使用 manufacturer ID `0xffff`，载荷共 23 字节：标准网络字节序的 16 字节 UUID `6f9a0001-6c53-4b92-a319-75746f706961`、一个协议版本字节、四个 IPv4 字节，以及两个大端端口字节。Windows WinRT 发布器保留了服务 UUID 广播字段，因此 UUID 放在制造商数据前缀中。Android 按此前缀过滤，再通过 `pairing/info` 获取完整 City/会话描述符；紧凑广播不携带身份/会话提示、配对 secret 或永久凭据。

BLE 广播能力取决于主机适配器与驱动。Web 诊断显示发布器/能力状态及可用的原因说明。广播不可用时，可使用二维码、mDNS 或手工连接。BLE 不传输任务命令或遥测。

**LAN DEVELOPMENT ONLY · NOT FOR PUBLIC INTERNET。** 此开发配置面向可信局域网，不提供公网账户或传输安全基础设施。

磁盘指标对应 Node 进程工作目录所在的文件系统卷，不是所有主机磁盘的汇总。
