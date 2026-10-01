/**
 * UI-000 · canonical functional / information facts.
 *
 * This module is the single source of truth for WHAT the product does. The three
 * visual-direction candidates are only allowed to differ in structure and
 * presentation — never in the set of facts they can express. Concretely:
 *
 *   - `SURFACES`          the product's information architecture (primary + advanced)
 *   - `CAPABILITIES`      every user-visible capability of the current product,
 *                         each bound to the surface that must own it
 *   - `TECHNICAL_FIELDS`  values that exist and stay reachable, but must be DEMOTED
 *                         out of the default reading path (advanced / run details)
 *   - `DEMO`              a deterministic snapshot in the real Gateway payload shapes
 *
 * `tests/ui-000-candidates.test.mjs` enforces that every candidate covers exactly
 * `CAPABILITIES` and that no candidate drops a technical field or a legacy route.
 *
 * TEMPORARY: this whole `candidates/` tree exists only for the UI-000 Owner gate.
 * The winning direction is promoted (UI-101..103) and the losing candidates are
 * removed; see ./README.md.
 */

/** Primary navigation. Everything a normal user needs, in reading order. */
export const PRIMARY_SURFACES = [
  { id: 'home', label: 'Home', zh: '首页' },
  { id: 'ask', label: 'Ask / Do', zh: '对话 · 执行' },
  { id: 'tools', label: 'Tools', zh: '工具' },
  { id: 'devices', label: 'Devices', zh: '设备' },
  { id: 'activity', label: 'Activity', zh: '动态' },
];

/**
 * Advanced surfaces. All of these already exist in the product; the UI-000 hard
 * rule is that they are reachable but NOT part of the normal reading path.
 */
export const ADVANCED_SURFACES = [
  { id: 'services', label: 'Services', zh: '能力服务' },
  { id: 'tasks', label: 'Tasks', zh: '任务' },
  { id: 'actions', label: 'Actions', zh: '操作记录' },
  { id: 'pairing', label: 'Pairing', zh: '配对' },
  { id: 'settings', label: 'Settings', zh: '设置' },
];

export const SURFACES = [...PRIMARY_SURFACES, ...ADVANCED_SURFACES];

/**
 * Every capability the current product exposes. `legacy` records where it lives
 * today so a reviewer can prove nothing disappeared; `surface` records where the
 * candidates must place it.
 */
export const CAPABILITIES = [
  { id: 'connection-state', surface: 'home', legacy: ['Home', 'Settings', 'Pairing'], label: 'Live connection state', zh: '连接状态' },
  { id: 'city-snapshot', surface: 'home', legacy: ['Home'], label: 'City snapshot + last-updated', zh: '快照与更新时间' },
  { id: 'attention-summary', surface: 'home', legacy: ['Home'], label: 'What needs attention / is running now', zh: '需要关注与正在进行' },
  { id: 'room-catalog', surface: 'tools', legacy: ['Home', 'Rooms'], label: 'The ten accepted Rooms with label, zh, summary, persistence', zh: '十个已接受房间' },
  { id: 'room-availability', surface: 'tools', legacy: ['Home', 'Rooms'], label: 'Honest Room Hub available / unavailable + reason', zh: '房间服务可用性' },
  { id: 'room-launch', surface: 'tools', legacy: ['Rooms'], label: 'Open a Room in the Room Hub', zh: '打开房间' },
  { id: 'ask-route', surface: 'ask', legacy: ['Ask/Do'], label: 'One natural-language entry resolved deterministically to Room / capability / task', zh: '自然语言统一入口' },
  { id: 'ask-confirm', surface: 'ask', legacy: ['Ask/Do'], label: 'AWAITING_CONFIRMATION: confirm or cancel a side-effecting target', zh: '副作用确认' },
  { id: 'ask-ambiguous', surface: 'ask', legacy: ['Ask/Do'], label: 'AMBIGUOUS: choose among at most three candidates', zh: '歧义候选选择' },
  { id: 'ask-unmatched', surface: 'ask', legacy: ['Ask/Do'], label: 'UNMATCHED: manual target picker', zh: '未匹配手动选择' },
  { id: 'ask-result', surface: 'ask', legacy: ['Ask/Do'], label: 'Resolved action + result', zh: '执行结果' },
  { id: 'capability-catalog', surface: 'services', legacy: ['Services'], label: 'Bridge capabilities with bridge state and city lifecycle', zh: '能力目录' },
  { id: 'capability-invoke', surface: 'services', legacy: ['Services'], label: 'Invoke a capability with its per-kind input editor', zh: '调用能力' },
  { id: 'capability-history', surface: 'services', legacy: ['Services'], label: 'Invocation history and retained result detail', zh: '调用历史' },
  { id: 'device-list', surface: 'devices', legacy: ['Home', 'Devices'], label: 'Runtime nodes with online state, platform, agent version, last seen', zh: '设备列表' },
  { id: 'device-telemetry', surface: 'devices', legacy: ['Home', 'Devices'], label: 'Telemetry (CPU, memory, disk, uptime) and live vs cached freshness', zh: '设备遥测' },
  { id: 'device-detail', surface: 'devices', legacy: ['Devices'], label: 'Device capabilities, current tasks, recent events', zh: '设备详情' },
  { id: 'device-select', surface: 'devices', legacy: ['Devices'], label: 'Select a device and target work at it', zh: '选择设备' },
  { id: 'task-list', surface: 'tasks', legacy: ['Home', 'Tasks'], label: 'Tasks with state and progress', zh: '任务列表' },
  { id: 'task-detail', surface: 'tasks', legacy: ['Tasks'], label: 'Task checkpoint, result and cancel', zh: '任务详情' },
  { id: 'task-create-demo', surface: 'tasks', legacy: ['Home'], label: 'Run a checkpoint demo task (diagnostic affordance)', zh: '演示任务' },
  { id: 'event-timeline', surface: 'activity', legacy: ['Home', 'Activity'], label: 'Event timeline with type, time and ordering', zh: '事件时间线' },
  { id: 'action-history', surface: 'actions', legacy: ['Actions'], label: 'Action history with limit selection, status, route and target', zh: '操作历史' },
  { id: 'action-detail', surface: 'actions', legacy: ['Actions'], label: 'Action detail: outcome, error, result reference', zh: '操作详情' },
  { id: 'pairing-session', surface: 'pairing', legacy: ['Pairing'], label: 'Generate a pairing session: code, countdown, QR', zh: '配对会话' },
  { id: 'pairing-diagnostics', surface: 'pairing', legacy: ['Pairing'], label: 'Discovery diagnostics (mDNS, Bluetooth), gateway and protocol state', zh: '配对诊断' },
  { id: 'locale-switch', surface: 'settings', legacy: ['Settings'], label: 'Switch interface language (en / zh-CN)', zh: '界面语言' },
  { id: 'session-disconnect', surface: 'settings', legacy: ['Settings'], label: 'Change the pairing token / disconnect', zh: '更换令牌' },
  { id: 'connect-token', surface: 'home', legacy: ['connect gate'], label: 'Enter the pairing token to connect', zh: '连接令牌' },
];

/**
 * Values that must stay REACHABLE but leave the default reading path. UI-000 and
 * UI-101..103 forbid the normal surface from printing these directly.
 */
export const TECHNICAL_FIELDS = [
  { id: 'task-id', field: 'task.id', owners: ['task-list', 'task-detail', 'action-history', 'event-timeline'] },
  { id: 'event-seq', field: 'event.seq', owners: ['event-timeline'] },
  { id: 'room-id', field: 'room.id', owners: ['room-catalog', 'room-launch'] },
  { id: 'room-number', field: 'room.number', owners: ['room-catalog'] },
  { id: 'room-lifecycle', field: 'room.lifecycle', owners: ['room-catalog'] },
  { id: 'node-id', field: 'node.id', owners: ['device-list', 'device-detail'] },
  { id: 'capability-id', field: 'capability.capabilityId', owners: ['capability-catalog', 'capability-invoke'] },
  { id: 'invocation-id', field: 'invocation.invocationId', owners: ['capability-history'] },
  { id: 'result-digest', field: 'invocation.resultDigest', owners: ['capability-history'] },
  { id: 'api-version', field: 'apiVersion', owners: ['pairing-diagnostics', 'session-disconnect'] },
  { id: 'schema-version', field: 'schemaVersion', owners: ['pairing-diagnostics', 'session-disconnect'] },
  { id: 'hub-url', field: 'rooms.hubUrl', owners: ['room-availability', 'room-launch'] },
  { id: 'device-agent-version', field: 'node.agentVersion', owners: ['device-list'] },
  { id: 'action-backend-ref', field: 'action.backendRef', owners: ['action-detail'] },
  { id: 'action-result-ref', field: 'action.resultRef', owners: ['action-detail'] },
  { id: 'action-provenance', field: 'action.provenance', owners: ['action-detail'] },
  { id: 'ask-idempotency-key', field: 'ask.idempotencyKey', owners: ['ask-route'] },
  { id: 'task-checkpoint', field: 'task.lastCheckpoint', owners: ['task-detail'] },
  { id: 'discovery-reason', field: 'discovery.*.reason', owners: ['pairing-diagnostics'] },
];

/** Every surface that a candidate must be able to render. */
export const REQUIRED_SURFACES = SURFACES.map((s) => s.id);

/** Every capability id a candidate must express. */
export const REQUIRED_CAPABILITIES = CAPABILITIES.map((c) => c.id);

/** Helper: capabilities owned by one surface. */
export const capabilitiesFor = (surface) => CAPABILITIES.filter((c) => c.surface === surface);

/** Helper: technical fields that must remain reachable somewhere. */
export const technicalFieldsFor = (capabilityId) =>
  TECHNICAL_FIELDS.filter((f) => f.owners.includes(capabilityId));

export const CANDIDATE_IDS = ['a', 'b', 'c'];

export const CANDIDATE_NAMES = {
  a: { name: 'Halo', zh: '随行', idea: 'Ambient companion — one column, intent-first, no permanent chrome' },
  b: { name: 'Atlas', zh: '工作台', idea: 'Spatial workbench — object rail, canvas, demoted inspector' },
  c: { name: 'Prism', zh: '剧场', idea: 'Expressive deck — dark stage, colour blocking, spotlight input' },
};

/**
 * Deterministic demo snapshot in the REAL Gateway payload shapes.
 *
 * The candidates are prototypes, so they must not depend on a live host to render.
 * The values below are shaped exactly like `/api/v0/city` and `/api/v0/rooms` so a
 * candidate can be swapped onto the live client without changing anything but the
 * data source. Timestamps are fixed so screenshots are reproducible.
 */
export const DEMO = {
  city: {
    cityId: 'demo-city-0001',
    displayName: 'Home City',
    updatedAt: '2026-10-01T20:24:00.000Z',
    descriptor: {
      pairingSessionId: null,
      endpoint: { scheme: 'http', host: '127.0.0.1', port: 4310 },
    },
    discovery: {
      mdns: { state: 'DISABLED', reason: 'discovery disabled for this session' },
      ble: { state: 'UNAVAILABLE', reason: 'no Bluetooth adapter on this host' },
    },
    nodes: [
      {
        id: 'node-3f7a91c2',
        displayName: 'Alien-PC',
        online: true,
        agentVersion: '0.2.0',
        lastHeartbeatAt: '2026-10-01T20:23:58.000Z',
        metadata: { platform: 'win32', hostname: 'Alien-PC' },
        capabilities: ['task.execute.safe', 'filesystem.temp'],
        telemetry: {
          observedAt: '2026-10-01T20:23:59.000Z',
          cpu: { usagePercent: 12.4 },
          memory: { usedBytes: 12884901888, totalBytes: 34359738368 },
          disk: { usedBytes: 412316860416, totalBytes: 1024209543168, freeBytes: 611892682752 },
          uptimeSeconds: 192960,
        },
      },
    ],
    tasks: [
      { id: 'tsk-9c41', type: 'CHECKPOINT_DEMO', state: 'COMPLETED', progress: 100, assignedNodeId: 'node-3f7a91c2', lastCheckpoint: { step: 'done', at: '2026-10-01T20:19:12.000Z' }, result: { ok: true, artifacts: 1 }, error: null },
      { id: 'tsk-8b20', type: 'CHECKPOINT_DEMO', state: 'RUNNING', progress: 45, assignedNodeId: 'node-3f7a91c2', lastCheckpoint: { step: 'hash', at: '2026-10-01T20:23:40.000Z' }, result: null, error: null },
    ],
    events: [
      { seq: 41, type: 'task.completed', taskId: 'tsk-9c41', timestamp: '2026-10-01T20:19:12.000Z', payload: { nodeId: 'node-3f7a91c2' } },
      { seq: 40, type: 'task.progress', taskId: 'tsk-8b20', timestamp: '2026-10-01T20:23:40.000Z', payload: { nodeId: 'node-3f7a91c2' } },
      { seq: 39, type: 'node.heartbeat', taskId: null, timestamp: '2026-10-01T20:23:58.000Z', payload: { nodeId: 'node-3f7a91c2' } },
    ],
    capabilities: [
      { capabilityId: 'planning.document.intake', bridgeState: 'READY', cityLifecycle: 'ACCEPTED' },
      { capabilityId: 'planning.knowledge.query', bridgeState: 'READY', cityLifecycle: 'ACCEPTED' },
      { capabilityId: 'engineering.skill.inspect', bridgeState: 'READY', cityLifecycle: 'ACCEPTED' },
      { capabilityId: 'research.evidence.review', bridgeState: 'READY', cityLifecycle: 'ACCEPTED' },
      { capabilityId: 'presentation.theme.lab', bridgeState: 'READY', cityLifecycle: 'ACCEPTED' },
    ],
    invocations: [
      { invocationId: 'inv-2f10', capabilityId: 'planning.knowledge.query', status: 'COMPLETED', resultDigest: 'sha256:6a1f…c93d', errorCode: null },
    ],
  },
  rooms: {
    available: true,
    hubUrl: 'http://127.0.0.1:4320/',
    reason: null,
    checkedAt: '2026-10-01T20:24:00.000Z',
    count: 10,
    loaded: ['knowledge', 'bookmarks', 'checklist', 'prompts', 'text-workshop', 'hash', 'data-lab', 'focus', 'calendar', 'decisions'],
    product: 'utopia-room-pack',
    version: 'v1',
    /* Verbatim from apps/rooms/hub/manifest.mjs — the real catalog. */
    rooms: [
      { id: 'knowledge', number: '01', label: 'Knowledge Room', zh: '本地知识室', summary: 'Plain-text knowledge entries with search, tags and replace import.', persistent: true, tags: ['notes', 'search'], lifecycle: 'LOCAL_PRODUCT' },
      { id: 'bookmarks', number: '02', label: 'Bookmark Room', zh: '收藏室', summary: 'Local URL collection with tags, notes and explicit open only.', persistent: true, tags: ['links', 'search'], lifecycle: 'LOCAL_PRODUCT' },
      { id: 'checklist', number: '03', label: 'Checklist Room', zh: '清单室', summary: 'Checklists and items with toggle, reorder and clear completed.', persistent: true, tags: ['lists'], lifecycle: 'LOCAL_PRODUCT' },
      { id: 'prompts', number: '04', label: 'Prompt Library', zh: '提示词库', summary: 'Reusable prompt templates with {{variable}} detection and fill-in.', persistent: true, tags: ['templates'], lifecycle: 'LOCAL_PRODUCT' },
      { id: 'text-workshop', number: '05', label: 'Text Workshop', zh: '文本工坊', summary: 'Counts, cleanup, sorting, dedupe, case changes and a line diff. No storage.', persistent: false, tags: ['tools'], lifecycle: 'LOCAL_PRODUCT' },
      { id: 'hash', number: '06', label: 'Hash Room', zh: '哈希室', summary: 'SHA-256 of a local file with size, name and expected-value comparison.', persistent: false, tags: ['tools'], lifecycle: 'LOCAL_PRODUCT' },
      { id: 'data-lab', number: '07', label: 'Data Lab', zh: '数据实验室', summary: 'JSON parse / pretty / minify / validate and a light CSV preview. No storage.', persistent: false, tags: ['tools'], lifecycle: 'LOCAL_PRODUCT' },
      { id: 'focus', number: '08', label: 'Focus Room', zh: '专注室', summary: 'Countdown timer with presets, pause/resume, session history and today total.', persistent: true, tags: ['time'], lifecycle: 'LOCAL_PRODUCT' },
      { id: 'calendar', number: '09', label: 'Calendar Room', zh: '日程室', summary: 'Local events with date, times, label and notes; today and upcoming views.', persistent: true, tags: ['time', 'search'], lifecycle: 'LOCAL_PRODUCT' },
      { id: 'decisions', number: '10', label: 'Decision Room', zh: '决策室', summary: 'Decision records with options, rationale and OPEN / DECIDED / REVISIT status.', persistent: true, tags: ['records', 'search'], lifecycle: 'LOCAL_PRODUCT' },
    ],
  },
  /* The four Ask/Do states the product really has, shaped like the real results. */
  ask: {
    working: { status: 'WORKING', text: 'hash C:\\tmp\\a.txt' },
    confirmed: {
      status: 'COMPLETED',
      requestedIntent: 'hash C:\\tmp\\a.txt',
      actionId: 'act-77c1',
      route: 'ROOM',
      target: { label: 'Hash Room', id: 'hash' },
      operation: 'hash.file',
      summary: 'SHA-256 computed for a.txt',
    },
    needsChoice: {
      status: 'AWAITING_CONFIRMATION',
      requestedIntent: 'clean up my downloads folder',
      route: 'CAPABILITY',
      target: { label: 'Document intake', id: 'planning.document.intake' },
      operation: 'intake.replace',
      reason: 'This target has a meaningful external side effect, so nothing runs until you confirm.',
    },
    ambiguous: {
      status: 'AMBIGUOUS',
      requestedIntent: 'open my notes',
      candidates: [
        { label: 'Knowledge Room', id: 'knowledge', kind: 'ROOM' },
        { label: 'Checklist Room', id: 'checklist', kind: 'ROOM' },
        { label: 'Bookmark Room', id: 'bookmarks', kind: 'ROOM' },
      ],
    },
    unmatched: {
      status: 'UNMATCHED',
      requestedIntent: 'reticulate the splines',
      reason: 'No rule matched this text. Choose a target manually.',
      targets: [
        { label: 'Knowledge Room', id: 'knowledge', kind: 'ROOM' },
        { label: 'Focus Room', id: 'focus', kind: 'ROOM' },
        { label: 'Data Lab', id: 'data-lab', kind: 'ROOM' },
      ],
    },
  },
};

export default {
  PRIMARY_SURFACES,
  ADVANCED_SURFACES,
  SURFACES,
  CAPABILITIES,
  TECHNICAL_FIELDS,
  REQUIRED_SURFACES,
  REQUIRED_CAPABILITIES,
  CANDIDATE_IDS,
  CANDIDATE_NAMES,
  DEMO,
};
