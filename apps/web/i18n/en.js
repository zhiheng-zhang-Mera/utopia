/**
 * UTOPIA · Web Control Surface — English language pack.
 *
 * Display-layer copy only. Protocol tokens (apiVersion, schemaVersion, Task.type,
 * Event.type, node ids and the QUEUED/RUNNING/COMPLETED family) are never
 * translated; localization must not change City Control semantics.
 */

export const meta = { locale: 'en', label: 'English' };

export const messages = {
  'app.title': 'Utopia · Digital City',
  'app.workspace': 'WORKSPACE / ALIEN',
  'app.subtitle': 'DIGITAL CITY / 01',
  'app.tagline': 'YOUR DEVICES. ONE CITY.',
  'app.reference': 'Reference implementation · V0',
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
