# 可选主机前提

[English](../../en/pcf/optional-host-gates.md)

PCF-717 没有已绑定且获准的模型/runtime/许可，也没有冷暖推理测量；模型驻留保持 NOT_RUN，不自动下载模型或 provider。PCF-722 明确要求具备获准的独立存储和 fencing 基础后才启动 HA 实现；当前缺少该基础，因此不增加 HA 提升机制。PCF-723 在冻结基线证明短板并具备留出集证据前，仅保持影子检查。

PCF-718 复用同一固定、可移植 Node CPU worker 和既有 headless/canonical port，保留独立 host/boot/principal/fence 身份。隔离 Linux CI job 运行真实 POSIX 子进程生命周期测试。Alien 未安装 WSL runtime，Windows 上跳过表示 Linux NOT_RUN。云端 Linux CI 是组件运行，不是实体 Mech worker、安装或验收。

PCF-720 记录稳定 GPU UUID、driver 身份、VRAM 字节、利用率比例、摄氏温度、瓦特及新鲜度。缺少可执行程序为 UNSUPPORTED，驱动读取失败为 UNKNOWN。runtime 版本、焦耳和已预留 VRAM 在真实所有者提供证据前保持未知。可选 701 adapter 不聚合不同设备；显式加速器约束检查当前 canonical 预留、安全阈值、过期观测和硬件变化，仅产生约束，不产生授权或调度权。未执行热压力、超频、模型或 GPU 工作负载。

本机施工后，完整流一次性交给对侧主机，不分拆逐任务实机验证。缺少前提的可选实体证据继续展示在覆盖矩阵中。
