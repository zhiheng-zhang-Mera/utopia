/**
 * UTOPIA · Web Control Surface — English language pack.
 *
 * Display-layer copy only. Protocol tokens (apiVersion, schemaVersion, Task.type,
 * Event.type, node ids and the QUEUED/RUNNING/COMPLETED family) are never
 * translated; localization must not change City Control semantics.
 */

export const meta = { locale: 'en', label: 'English' };

export const messages = {
  "nav.devices": "Devices",
  "nav.pairing": "Pairing",
  "heading.devices": "Your devices, in focus.",
  "heading.pairing": "Bring a device into your city.",
  "device.unknown": "Unknown",
  "device.live": "Live telemetry",
  "device.cached": "Cached / UNKNOWN telemetry",
  "device.observed": "observed",
  "device.memory": "Memory",
  "device.disk": "Disk",
  "device.free": "Free",
  "device.uptime": "Uptime",
  "device.agent": "Agent",
  "device.lastSeen": "Last seen",
  "device.cachedPrefix": "Cached · ",
  "device.capabilities": "Capabilities",
  "device.currentTasks": "Current tasks",
  "device.recentEvents": "Recent device events",
  "device.noEvents": "No recent device events.",
  "device.noTasks": "No active tasks.",
  "device.ago": "{seconds}s ago",
  "pairing.title": "Pair a device with",
  "pairing.yourCity": "your City",
  "pairing.cityId": "City ID",
  "pairing.session": "Current session",
  "pairing.none": "None",
  "pairing.qr": "Temporary pairing QR",
  "pairing.code": "Short pairing code",
  "pairing.countdown": "Expires in {seconds}s",
  "pairing.single": "Single use. Scan with Utopia on Android.",
  "pairing.refresh": "Revoke and refresh session",
  "pairing.generate": "Generate pairing session",
  "pairing.explanation": "Generating a session revokes the previous code and QR. Temporary pairing material is cleared when you leave this page.",
  "pairing.choose": "Choose a connection method",
  "pairing.qrHelp": "scan this temporary QR in the Android app.",
  "pairing.lan": "Nearby Cities (LAN)",
  "pairing.lanHelp": "discover this City with mDNS, then enter the short code.",
  "pairing.ble": "Nearby via Bluetooth",
  "pairing.bleHelp": "find the nearby City, then enter the short code. Wi-Fi/LAN access is still required.",
  "pairing.manual": "Manual connection",
  "pairing.manualHelp": "enter the City URL and your existing control token in Android.",
  "pairing.plane": "Every method uses the same authenticated HTTP and WebSocket control connection.",
  "pairing.reconnect": "Reconnect to generate a pairing session.",
  "pairing.unavailable": "Session used, expired, or replaced. Generate a new session.",
  "pairing.expired": "Session expired. Generate a new session.",
  'app.title': 'Utopia · Digital City',
  'app.workspace': 'WORKSPACE / ALIEN',
  'app.subtitle': 'DIGITAL CITY / 01',
  'app.tagline': 'YOUR DEVICES. ONE CITY.',
  'app.reference': 'Reference implementation · V0.2',
  'app.eyebrow': 'CONTROL SURFACE',

  'nav.home': 'Home',
  'nav.nodes': 'Nodes',
  'nav.tasks': 'Tasks',
  'nav.activity': 'Activity',
  'nav.settings': 'Settings',

  'pair.title': 'Connect to your city.',
  'pair.hint': 'Enter the pairing token from your local Gateway to begin.',
  'pair.token': 'Pairing token',
  'pair.connect': 'Connect',

  'action.runTestTask': 'Run Test Task',

  'heading.home': 'Your city, at a glance.',
  'heading.nodes': 'The places work happens.',
  'heading.tasks': 'From intent to done.',
  'heading.activity': 'Life in your city.',
  'heading.settings': 'A connection you control.',

  'status.lastSnapshot': 'Last snapshot · {time}',
  'status.waitingSnapshot': 'Waiting for snapshot',
  'status.waitingNode': 'Waiting for node',

  'stat.connectedNodes': 'Connected nodes',
  'stat.runningTasks': 'Running tasks',
  'stat.completedTasks': 'Completed tasks',
  'stat.needsAttention': 'Needs attention',

  'section.runtimeNodes': 'Runtime nodes',
  'section.recentActivity': 'Recent activity',
  'section.recentTasks': 'Recent tasks',
  'section.taskRegistry': 'Task registry',
  'section.eventTimeline': 'Event timeline · {count} events',
  'section.connectionDiagnostics': 'Connection diagnostics',
  'section.checkpoint': 'Checkpoint',
  'section.result': 'Result',
  'section.taskEvents': 'Task events',

  'empty.noTasks': 'No tasks yet. Run your first test task.',
  'empty.waitingRuntimeNode': 'Waiting for a runtime node.',

  'task.cancel': 'Cancel task',
  'task.heartbeat': 'Heartbeat {time}',

  'settings.interface': 'Interface',
  'settings.language': 'Language / 语言',
  'settings.languageHint': 'Switching the language only changes what this page displays. Your city, its nodes and its tasks are untouched.',
  'settings.cityUrl': 'City URL',
  'settings.protocol': 'apiVersion = {api} · schemaVersion = {schema}',
  'settings.tokenNote': 'Pairing token is kept for this browser session.',
  'settings.changeToken': 'Change pairing token',

  'connection.offline': 'OFFLINE',
  'connection.reconnecting': 'RECONNECTING',
  'connection.online': 'ONLINE',

  'node.unknown': 'UNKNOWN',
  'node.online': 'online',
  'node.offline': 'offline',
};

export default { meta, messages };
