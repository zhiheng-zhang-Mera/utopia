/**
 * UTOPIA · Web Control Surface — 简体中文语言包。
 *
 * 只翻译显示层文案。协议 token（apiVersion、schemaVersion、Task.type、Event.type、
 * 节点 id，以及 QUEUED / RUNNING / COMPLETED 状态族）一律保持原样，本地化不得改变
 * City Control 语义。
 */

export const meta = { locale: 'zh-CN', label: '简体中文' };

export const messages = {
  "nav.services": "服务",
  "heading.services": "城市服务，触手可及。",
  "nav.devices": "设备",
  "nav.pairing": "配对",
  "heading.devices": "专注查看你的设备。",
  "heading.pairing": "将设备接入你的城市。",
  "device.unknown": "未知",
  "device.live": "实时遥测",
  "device.cached": "缓存 / UNKNOWN 遥测",
  "device.observed": "采样时间",
  "device.memory": "内存",
  "device.disk": "磁盘",
  "device.free": "可用",
  "device.uptime": "运行时长",
  "device.agent": "Agent",
  "device.lastSeen": "最近在线",
  "device.cachedPrefix": "缓存 · ",
  "device.capabilities": "能力",
  "device.currentTasks": "当前任务",
  "device.recentEvents": "最近设备事件",
  "device.noEvents": "暂无设备事件。",
  "device.noTasks": "暂无活动任务。",
  "device.ago": "{seconds} 秒前",
  "pairing.title": "配对设备到",
  "pairing.yourCity": "你的城市",
  "pairing.cityId": "City ID",
  "pairing.session": "当前会话",
  "pairing.none": "无",
  "pairing.qr": "临时配对二维码",
  "pairing.code": "短期配对码",
  "pairing.countdown": "{seconds} 秒后到期",
  "pairing.single": "仅可使用一次。请用 Android Utopia 扫描。",
  "pairing.refresh": "撤销并刷新会话",
  "pairing.generate": "生成配对会话",
  "pairing.explanation": "生成会话将撤销旧短码和二维码。离开本页时会清除显示的临时配对材料。",
  "pairing.choose": "选择连接方式",
  "pairing.qrHelp": "在 Android 应用中扫描临时二维码。",
  "pairing.lan": "附近城市（局域网）",
  "pairing.lanHelp": "通过 mDNS 发现此 City，然后输入短码。",
  "pairing.ble": "通过蓝牙发现附近城市",
  "pairing.bleHelp": "发现附近 City 后输入短码。仍需要 Wi-Fi/局域网访问。",
  "pairing.manual": "手工连接",
  "pairing.manualHelp": "在 Android 中输入 City URL 和已有控制 token。",
  "pairing.plane": "所有方式使用同一认证 HTTP 与 WebSocket 控制连接。",
  "pairing.reconnect": "重新连接后可生成配对会话。",
  "pairing.unavailable": "会话已使用、过期或被替换，请生成新会话。",
  "pairing.expired": "会话已过期，请生成新会话。",
  'app.title': 'Utopia · 数字城市',
  'app.workspace': '工作区 / ALIEN',
  'app.subtitle': '数字城市 / 01',
  'app.tagline': '你的设备，一座城市。',
  'app.reference': '参考实现 · V0.2',
  'app.eyebrow': '控制面板',

  'nav.home': '首页',
  'nav.nodes': '节点',
  'nav.tasks': '任务',
  'nav.activity': '动态',
  'nav.settings': '设置',

  'pair.title': '连接你的城市。',
  'pair.hint': '请输入本地 Gateway 提供的配对令牌。',
  'pair.token': '配对令牌',
  'pair.connect': '连接',

  'action.runTestTask': '运行测试任务',

  'heading.home': '一眼看清你的城市。',
  'heading.nodes': '工作发生的地方。',
  'heading.tasks': '从意图到完成。',
  'heading.activity': '城市里的日常。',
  'heading.settings': '由你掌控的连接。',

  'status.lastSnapshot': '最近快照 · {time}',
  'status.waitingSnapshot': '等待快照',
  'status.waitingNode': '等待节点',

  'stat.connectedNodes': '已连接节点',
  'stat.runningTasks': '运行中任务',
  'stat.completedTasks': '已完成任务',
  'stat.needsAttention': '需要处理',

  'section.runtimeNodes': '运行时节点',
  'section.recentActivity': '最近动态',
  'section.recentTasks': '最近任务',
  'section.taskRegistry': '任务登记表',
  'section.eventTimeline': '事件时间线 · {count} 条事件',
  'section.connectionDiagnostics': '连接诊断',
  'section.checkpoint': '检查点',
  'section.result': '结果',
  'section.taskEvents': '任务事件',

  'empty.noTasks': '还没有任务。运行第一个测试任务。',
  'empty.waitingRuntimeNode': '正在等待运行时节点。',

  'task.cancel': '取消任务',
  'task.heartbeat': '心跳 {time}',

  'settings.interface': '界面',
  'settings.language': 'Language / 语言',
  'settings.languageHint': '切换语言只改变本页显示文案。你的城市、节点与任务数据完全不变。',
  'settings.cityUrl': '城市地址',
  'settings.protocol': 'apiVersion = {api} · schemaVersion = {schema}',
  'settings.tokenNote': '配对令牌只在本次浏览器会话中保留。',
  'settings.changeToken': '更换配对令牌',

  'connection.offline': '离线',
  'connection.reconnecting': '重新连接中',
  'connection.online': '在线',

  'node.unknown': '未知',
  'node.online': '在线',
  'node.offline': '离线',
};

export default { meta, messages };
