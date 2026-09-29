# Room Pack V1 后续待办（POST_V1_BACKLOG）

本文件只记录 Room Pack 自己的后续想法。任何一条都**不是**当前 blocker，不阻塞 `MECH_ROOM_PACK_V1_READY_TO_ATTACH`。

## 第二批候选房间（需用户明确立项后再做）

| 房间 | 为什么暂缓 |
| --- | --- |
| Hospital / 健康记录 | 涉及敏感数据与更强的隐私边界 |
| Quant / 数据处理 | 容易演变成大型独立领域 |
| Digital-Me | 需要长期画像与跨房间整合 |
| Wearables | 需要外部设备与协议 |
| File manager | 与操作系统文件边界冲突 |
| Password vault | 高安全要求，需要专门的密码学设计 |
| Cloud sync | 违反单机本地产品的定位 |
| AI chat | 需要外部 Provider，会碰到 Boss/Hns 边界 |
| Automation | 会演变成调度器，与 City Control 职责重叠 |

## 当前 10 个房间的后续增强

| 编号 | 房间 | 内容 |
| --- | --- | --- |
| RP-B01 | Hub | 房间内搜索（跨房间全文搜索） |
| RP-B02 | Hub | 房间顺序/收藏自定义 |
| RP-B03 | Knowledge | Markdown 渲染、条目历史版本 |
| RP-B04 | Bookmarks | 批量导入浏览器书签 HTML |
| RP-B05 | Checklist | 模板清单、跨清单复制 |
| RP-B06 | Prompts | 变量集合预设、模板片段复用 |
| RP-B07 | Text Workshop | 正则查找替换、字数目标提示 |
| RP-B08 | Hash | 多算法（SHA-1 / MD5 仅作校验展示）、批量文件 |
| RP-B09 | Data Lab | JSON 路径查询、CSV 列筛选与导出 |
| RP-B10 | Focus | 自定义预设、日/周统计视图 |
| RP-B11 | Calendar | 周视图、简单重复规则 |
| RP-B12 | Decisions | 决策复审到期提醒（本地、非通知） |
| RP-B13 | 全局 | 统一导出/导入所有房间的打包 bundle |
| RP-B14 | 全局 | 接入 Utopia 主 UI 导航（极小 integration change） |

## 已知技术债

- 房间实现之间仍有少量重复（列表 + 编辑器布局、导出/导入交互）。按设计约定，只有被 **3 个以上房间**实际重复使用的抽象才会抽到 `shared/`；目前已抽取的只有 store、room-kit、http、text-tools、csv、client-kit。
- 前端无框架、无构建步骤：房间数量继续增长时需要重新评估渲染与拆分策略。
- 每个房间的 client.mjs 直接操作 DOM，没有组件测试；浏览器验收只做一次 canonical 走查（符合测试预算约定）。
- `.runtime-rooms` 无跨进程写锁（见验收记录第 6 节）。
- 房间前端错误通过 hub 外壳统一展示为 failed to load；后续可加入更细的错误码。
