# 三设备互联 + 运行任务 Demo 录制 Runbook

> 适用基线：MESH-301 已接受的功能基线 `9f3e20e8ec99d591812430bee71d27e68c4ad498` 及其后仅包含文档 / linkage 的提交。
>
> 录制前仍必须确认当前 `main` 的 GitHub Actions 为绿色。

## Demo 拓扑

当前“三设备”应准确描述为：

1. **Alien Windows** — worker node `Alien-Win` + Web control surface；
2. **Mech Windows** — worker node `Mech-Win` + Web control surface；
3. **Android 实机** — control surface（不是 worker node）。

三端连接到**同一个 canonical City**。Android 可以看到状态、创建任务和 strict-target 到真实 Windows worker，但当前不能被宣传为第三个执行 worker。

## 推荐录制主线

### 0. 预检

- 两台 Windows 与 Android 在当前可达网络中；
- canonical City 已启动，并输出本次实际地址；
- `Alien-Win` / `Mech-Win` 均在线；
- Android 已通过临时 pairing 接入；
- Web 与 Android 都显示同一个 City；
- 当前 Utopia `main` CI 绿色；
- 关闭/隐藏任何包含永久 token、`.runtime/local-config.json`、私密路径或个人信息的窗口。

不要在视频中展示永久 bearer token。若展示临时二维码/短码，录制后立即失效/轮换。

### 1. 证明三端已经进入同一个 City

建议同屏或快速切镜：

- Alien Web：设备/节点页面显示 `Alien-Win`、`Mech-Win`；
- Mech Web：看到相同两个 worker；
- Android：设备页保持 ONLINE，并看到相同 City 的节点状态。

目标不是展示“三份 UI 长得一样”，而是展示**三端读到同一份 canonical truth**。

### 2. Android → Alien-Win 运行任务

在 Android 的现有 Run / target-device 入口：

- 选择 `Alien-Win`；
- 发起任务；
- 保留任务 id / 状态变化；
- 切到 Alien Web/Activity，展示任务确实由 Alien worker 接手；
- 等待 COMPLETED；
- 回 Android 展示同一任务最终结果/状态。

这是最能证明“手机控制真实 PC worker”的一段。

### 3. Alien Web → Mech-Win 运行任务

在 Alien Web：

- target 选择 `Mech-Win`；
- 发起任务；
- 在 Mech 侧展示该任务被 Mech worker 接手；
- 回 Alien Web 展示结果返回原 control surface。

这段证明 strict target-device routing 不是 Android 特例。

### 4. 可选：Mech Web → Alien-Win

如果希望形成视觉上的闭环，再录一轮：

`Mech Web → Alien-Win → COMPLETED → Mech Web result`

不是必须项。前两轮已经足以证明三设备互联 + 双 worker 定向执行。

### 5. 用 Activity/事件页收尾

最后展示：

- 三个 control surfaces/客户端在线事实；
- 两个 worker node；
- 刚才两个任务的目标节点、状态和 completion；
- 不出现 UNKNOWN target、错误 fallback 或重复 terminal completion。

## 录制时不要做的事

- 不要宣称“3 个 worker”——当前是 **2 worker + 3 control endpoints**；
- 不要为了镜头效果关闭网络制造故障；offline/reconnect 属于验收/故障 Demo，不是本次基础 Demo 必需；
- 不要把 remote handoff 与 strict-target 混成一件事；
- 不要展示永久 token、local-config、私有 pairing secret；
- 不要用历史固定 IP 作为产品能力的一部分；每次以实际启动输出为准。

## 建议视频标题/口径

推荐：

**Utopia 三设备互联 Demo：Windows 双 Worker + Android 控制端的定向任务执行**

或者更短：

**Utopia 3-End Mesh Demo — Android 控制双 Windows Worker**

避免：

**三台设备都作为 AI Worker 互相执行任务**

因为这与当前实际架构不符。
