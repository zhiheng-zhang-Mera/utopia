/**
 * UI-000 · capability parity probes.
 *
 * The workbook requires the three candidates to "share the same functional
 * facts" — differences may be structural and visual only. A promise is not
 * evidence, so each capability gets probes.
 *
 * Two probe classes, because the product has two kinds of fact:
 *
 *   SURFACE_PROBES   — product facts. Must be readable on the named surface
 *                      WITHOUT any extra interaction, because that is the whole
 *                      point of an information architecture.
 *
 *   TECHNICAL_PROBES — technical values. UI-000 forbids them on the default
 *                      reading path, so they must NOT be required on the primary
 *                      surface; they only have to stay REACHABLE. A candidate
 *                      passes by exposing the value anywhere in its DOM, either
 *                      plainly or through its own demotion mechanism (opened
 *                      <details>, or the inspector after `revealAll()`).
 *
 * `document.body.textContent` is used, not `innerText`, so collapsed <details>
 * content counts: a demoted value is still reachable, and a DELETED value fails.
 */

/** Product facts. Surface + tokens that must be present in that surface's text. */
export const SURFACE_PROBES = [
  { surface: 'home', cap: 'connection-state', expect: ['Alien-PC'] },
  { surface: 'home', cap: 'city-snapshot', expect: ['20:24'] },
  { surface: 'home', cap: 'attention-summary', expect: ['10'] },
  { surface: 'home', cap: 'device-telemetry', expect: ['12.4'] },
  { surface: 'home', cap: 'event-timeline', expect: ['task.completed'] },

  { surface: 'tools', cap: 'room-catalog', expect: [
    'Knowledge Room', '本地知识室', 'Bookmark Room', '收藏室', 'Checklist Room', '清单室',
    'Prompt Library', '提示词库', 'Text Workshop', '文本工坊', 'Hash Room', '哈希室',
    'Data Lab', '数据实验室', 'Focus Room', '专注室', 'Calendar Room', '日程室',
    'Decision Room', '决策室',
  ] },
  { surface: 'tools', cap: 'room-launch', expect: ['打开'] },
  { surface: 'tools', cap: 'room-availability', expect: ['运行'] },

  { surface: 'devices', cap: 'device-list', expect: ['Alien-PC'] },
  { surface: 'devices', cap: 'device-telemetry', expect: ['12.4'] },
  { surface: 'devices', cap: 'device-detail', expect: ['磁盘'] },
  { surface: 'devices', cap: 'device-select', expect: ['Alien-PC'] },

  { surface: 'activity', cap: 'event-timeline', expect: ['task.completed', 'node.heartbeat'] },

  { surface: 'services', cap: 'capability-catalog', expect: [
    'planning.document.intake', 'planning.knowledge.query', 'engineering.skill.inspect',
    'research.evidence.review', 'presentation.theme.lab',
  ] },
  { surface: 'services', cap: 'capability-history', expect: ['inv-2f10'] },
  { surface: 'services', cap: 'capability-invoke', expect: ['调用'] },

  { surface: 'tasks', cap: 'task-list', expect: ['CHECKPOINT_DEMO', 'COMPLETED', 'RUNNING'] },
  { surface: 'tasks', cap: 'task-detail', expect: ['取消'] },
  { surface: 'tasks', cap: 'task-create-demo', expect: ['演示'] },

  { surface: 'actions', cap: 'action-history', expect: ['25', '50', '100'] },

  { surface: 'pairing', cap: 'pairing-session', expect: ['配对码'] },
  { surface: 'pairing', cap: 'pairing-diagnostics', expect: ['mDNS', 'DISABLED', '蓝牙'] },

  { surface: 'settings', cap: 'locale-switch', expect: ['English', '简体中文'] },
  { surface: 'settings', cap: 'session-disconnect', expect: ['令牌'] },
];

/**
 * Technical values that must stay reachable but are FORBIDDEN on the default
 * reading path. Checked against the whole candidate after `revealAll()`.
 */
export const TECHNICAL_PROBES = [
  { field: 'task-id', cap: 'task-detail', expect: ['tsk-9c41', 'tsk-8b20'] },
  { field: 'event-seq', cap: 'event-timeline', expect: ['41'] },
  { field: 'room-id', cap: 'room-catalog', expect: ['knowledge', 'text-workshop', 'data-lab'] },
  { field: 'room-number', cap: 'room-catalog', expect: ['01', '10'] },
  { field: 'room-lifecycle', cap: 'room-catalog', expect: ['LOCAL_PRODUCT'] },
  { field: 'node-id', cap: 'device-detail', expect: ['node-3f7a91c2'] },
  { field: 'device-agent-version', cap: 'device-list', expect: ['0.2.0'] },
  { field: 'capability-id', cap: 'capability-catalog', expect: ['planning.knowledge.query'] },
  { field: 'invocation-id', cap: 'capability-history', expect: ['inv-2f10'] },
  { field: 'result-digest', cap: 'capability-history', expect: ['sha256:6a1f'] },
  { field: 'api-version', cap: 'session-disconnect', expect: ['apiVersion'] },
  { field: 'schema-version', cap: 'pairing-diagnostics', expect: ['schemaVersion'] },
  { field: 'hub-url', cap: 'room-availability', expect: ['127.0.0.1:4320'] },
  { field: 'action-id', cap: 'action-detail', expect: ['act-77c1'] },
  { field: 'action-backend-ref', cap: 'action-detail', expect: ['backendRef'] },
  { field: 'action-result-ref', cap: 'action-detail', expect: ['resultRef'] },
  { field: 'action-provenance', cap: 'action-detail', expect: ['provenance'] },
  { field: 'task-checkpoint', cap: 'task-detail', expect: ['lastCheckpoint', 'step'] },
  { field: 'discovery-reason', cap: 'pairing-diagnostics', expect: ['no Bluetooth adapter'] },
  { field: 'gateway-endpoint', cap: 'connect-token', expect: ['127.0.0.1'] },
];

/** Ask/Do states, probed by driving the candidate's ask state selector. */
export const ASK_PROBES = [
  { state: 'confirmed', expect: ['hash C:\\tmp\\a.txt', 'Hash Room', 'SHA-256'] },
  { state: 'needsChoice', expect: ['clean up my downloads folder', 'Document intake', '确认'] },
  { state: 'ambiguous', expect: ['open my notes', 'Knowledge Room', 'Checklist Room', 'Bookmark Room'] },
  { state: 'unmatched', expect: ['reticulate the splines', 'Focus Room', 'Data Lab'] },
  { state: 'working', expect: ['hash C:\\tmp\\a.txt', '执行'] },
];

/** Text/Unicode geometry the hard rules forbid as an icon system. */
export const FORBIDDEN_GLYPHS = ['◈', '▦', '◇', '≋', '◉', '▤', '≣', '⊞', '⚙', '▣', '✦', '❖', '◆', '■', '▲'];

export default { SURFACE_PROBES, TECHNICAL_PROBES, ASK_PROBES, FORBIDDEN_GLYPHS };
