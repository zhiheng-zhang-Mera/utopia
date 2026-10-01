/**
 * UI-000 · Candidate B — "Atlas / 工作台"
 *
 * Spatial workbench. Structure: an OBJECT rail (devices / tools / work / records —
 * not pages), a canvas, and a contextual inspector that is closed by default.
 * The inspector is where technical detail lives, which is a different demotion
 * mechanism from Candidate A's inline <details>.
 *
 * Sharp corners, a real hairline grid, mono numerals, no rounded card stacks.
 * Every fact from ../../shared/facts.js is expressed.
 *
 * TEMPORARY candidate surface — see ../README.md.
 */
import { DEMO, SURFACES, PRIMARY_SURFACES, ADVANCED_SURFACES } from '../shared/facts.js';
import { icon } from '../shared/icons.js';
import { createRuntime } from '../shared/runtime.js';

const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    node.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return node;
};

const gb = (b) => (Number.isFinite(b) ? (b / 1024 ** 3).toFixed(1) : '—');
const pct = (v) => (Number.isFinite(v) ? v.toFixed(1) + '%' : '—');
const hhmm = (iso) => new Date(iso).toISOString().slice(11, 16);

const city = DEMO.city;
const rooms = DEMO.rooms;
const node = city.nodes[0];
/* Every control in this direction acts on the shared local runtime, so the same
   click produces the same fact here as in the other two directions. */
const rt = createRuntime();

/* Objects, not pages. Each object opens one or more canvas views. */
const OBJECTS = [
  { id: 'now', label: '现在', zh: 'Now', icon: 'home', views: ['home'] },
  { id: 'ask', label: '意图', zh: 'Intent', icon: 'ask', views: ['ask'] },
  { id: 'tools', label: '工具', zh: 'Tools', icon: 'tools', views: ['tools'] },
  { id: 'machines', label: '机器', zh: 'Machines', icon: 'devices', views: ['devices'] },
  { id: 'work', label: '作业', zh: 'Work', icon: 'tasks', views: ['tasks'] },
  { id: 'records', label: '记录', zh: 'Records', icon: 'actions', views: ['activity', 'actions'] },
];
const ADVANCED_OBJECTS = [
  { id: 'services', label: '能力服务', icon: 'services', views: ['services'] },
  { id: 'pairing', label: '配对', icon: 'pairing', views: ['pairing'] },
  { id: 'settings', label: '设置', icon: 'settings', views: ['settings'] },
];

const state = { view: 'home', object: 'now', inspector: null, ask: 'confirmed', advanced: false };

/* ------------------------------------------------------------- inspector */

function openInspector(title, payload) {
  state.inspector = { title, payload };
  document.getElementById('inspector-title').textContent = title;
  document.getElementById('inspector-body').replaceChildren(
    el('pre', { class: 'json', text: JSON.stringify(payload, null, 2) }),
  );
  document.body.dataset.inspector = 'open';
}
function closeInspector() {
  state.inspector = null;
  document.body.dataset.inspector = 'closed';
  document.getElementById('inspector-body').replaceChildren(
    el('p', { class: 'empty-note', text: '选中任意一行，这里显示对应的运行细节。' }),
  );
}

/* ------------------------------------------------------------- primitives */

const label = (t) => el('p', { class: 'label', text: t });

function grid(headers, rows) {
  return el('table', { class: 'data' }, [
    el('thead', {}, el('tr', {}, headers.map((h) => el('th', { text: h })))),
    el('tbody', {}, rows),
  ]);
}

function row(cells, onOpen, title) {
  return el('tr', {
    class: onOpen ? 'row is-openable' : 'row',
    onclick: onOpen ? () => openInspector(title, onOpen) : undefined,
  }, cells.map((c) => (c instanceof Node ? el('td', {}, c) : el('td', { text: String(c) }))));
}

function bar(value, max, kind = '') {
  const w = Math.max(0, Math.min(100, (value / max) * 100));
  return el('span', { class: `bar ${kind}` }, el('span', { class: 'bar-fill', style: `width:${w}%` }));
}

function stateTag(s) {
  const map = { COMPLETED: 'ok', RUNNING: 'run', FAILED: 'bad', CANCELLED: 'idle' };
  return el('span', { class: `tag tag-${map[s] ?? 'idle'}`, text: s });
}

/* ---------------------------------------------------------------- canvas */

function viewHome() {
  const open = rt.state.tasks.filter((t) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.state));
  return el('div', { class: 'view', dataset: { view: 'home' } }, [
    el('header', { class: 'view-head' }, [
      el('h1', { class: 'view-title', text: '现在' }),
      el('p', { class: 'view-sub', text: `${hhmm(city.updatedAt)} 快照 · 1 台机器在线 · ${rooms.count} 个工具就绪` }),
    ]),
    el('div', { class: 'zones' }, [
      el('section', { class: 'zone' }, [
        label('机器'),
        grid(['名称', '状态', '负载'], [row([
          node.displayName, stateTag(node.online ? 'RUNNING' : 'CANCELLED'),
          el('span', { class: 'load-cell' }, [bar(node.telemetry.cpu.usagePercent, 100), el('span', { class: 'num', text: `${node.telemetry.cpu.usagePercent}%` })]),
        ], { nodeId: node.id, platform: node.metadata.platform, agentVersion: node.agentVersion, telemetry: node.telemetry }, '机器 · 运行细节')]),
      ]),
      el('section', { class: 'zone' }, [
        label('进行中'),
        open.length
          ? grid(['作业', '进度'], open.map((t) => row([t.type, bar(t.progress, 100, 'run')], t, '作业 · 检查点')))
          : el('p', { class: 'none', text: '没有正在运行的作业。' }),
      ]),
      el('section', { class: 'zone' }, [
        label('可以做的事'),
        el('ul', { class: 'suggest' }, [
          el('li', {}, el('button', { class: 'link', text: '用一句话交代一件事', onclick: () => go('ask') })),
          el('li', {}, el('button', { class: 'link', text: `打开 ${rooms.count} 个工具`, onclick: () => go('tools') })),
          el('li', {}, el('button', { class: 'link', text: '查看机器遥测', onclick: () => go('devices') })),
        ]),
      ]),
    ]),
    el('section', { class: 'zone wide' }, [
      label('最近记录'),
      grid(['时间', '事件', '详情'], rt.state.events.slice(0, 4).map((e) => row([
        el('span', { class: 'num', text: hhmm(e.timestamp) }),
        e.type,
        el('button', { class: 'link tiny', text: '检查器', onclick: (ev) => { ev.stopPropagation(); openInspector('事件 · 运行细节', e); } }),
      ], e, '事件 · 运行细节'))),
    ]),
    el('p', { class: 'foot-note', text: '协议与端点信息在「设置 · 检查器」中。' }),
  ]);
}

function viewAsk() {
  const a = DEMO.ask;
  const s = state.ask;
  const blocks = {
    confirmed: () => [
      el('div', { class: 'plan' }, [
        planRow('输入', a.confirmed.requestedIntent),
        planRow('路由', `${a.confirmed.route} → ${a.confirmed.target.label}`),
        planRow('操作', a.confirmed.operation),
        planRow('结果', a.confirmed.summary),
      ]),
    ],
    needsChoice: () => [
      el('div', { class: 'plan' }, [
        planRow('输入', a.needsChoice.requestedIntent),
        planRow('目标', `${a.needsChoice.target.label} · ${a.needsChoice.operation}`),
        planRow('状态', '等待确认'),
      ]),
      el('p', { class: 'warn-note', text: a.needsChoice.reason }),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'btn primary', text: '确认执行', onclick: () => setAsk('confirmed') }),
        el('button', { class: 'btn', text: '取消', onclick: () => setAsk('confirmed') }),
      ]),
    ],
    ambiguous: () => [
      el('div', { class: 'plan' }, [planRow('输入', a.ambiguous.requestedIntent), planRow('状态', '需要你选一个')]),
      el('div', { class: 'btn-row wrap' }, a.ambiguous.candidates.map((c) =>
        el('button', { class: 'btn', onclick: () => setAsk('confirmed') }, [el('span', { html: icon('room') }), el('span', { text: c.label })])
      )),
    ],
    unmatched: () => [
      el('div', { class: 'plan' }, [planRow('输入', a.unmatched.requestedIntent), planRow('状态', '没有规则匹配')]),
      el('p', { class: 'warn-note', text: a.unmatched.reason }),
      el('div', { class: 'btn-row wrap' }, a.unmatched.targets.map((c) =>
        el('button', { class: 'btn', onclick: () => setAsk('confirmed') }, [el('span', { html: icon('room') }), el('span', { text: c.label })])
      )),
    ],
    working: () => [el('div', { class: 'plan' }, [planRow('输入', a.working.text), planRow('状态', '执行中…')])],
  };

  return el('div', { class: 'view', dataset: { view: 'ask' } }, [
    el('header', { class: 'view-head' }, [
      el('h1', { class: 'view-title', text: '意图' }),
      el('p', { class: 'view-sub', text: '固定规则路由，不由模型决定去向。' }),
    ]),
    el('form', { class: 'cmd', onsubmit: (e) => { e.preventDefault(); setAsk('confirmed'); } }, [
      el('span', { class: 'cmd-prompt', text: '›' }),
      el('input', { class: 'cmd-input', type: 'text', placeholder: '交代一件事…', 'aria-label': '交代一件事' }),
      el('button', { class: 'btn primary', type: 'submit', text: '执行' }),
    ]),
    el('div', { class: 'plan-wrap' }, blocks[s]()),
    el('div', { class: 'btn-row' }, ['confirmed', 'needsChoice', 'ambiguous', 'unmatched', 'working'].map((k) =>
      el('button', { class: k === s ? 'btn tiny is-on' : 'btn tiny', text: { confirmed: '已完成', needsChoice: '需确认', ambiguous: '有歧义', unmatched: '未匹配', working: '进行中' }[k], onclick: () => setAsk(k) })
    )),
    el('p', { class: 'foot-note' }, [
      '幂等键与原始响应：',
      el('button', { class: 'link tiny', text: '检查器', onclick: () => openInspector('意图 · 路由细节', a[s] ?? a.confirmed) }),
    ]),
  ]);
}

const planRow = (k, v) => el('div', { class: 'plan-row' }, [el('span', { class: 'plan-key', text: k }), el('span', { class: 'plan-val', text: v })]);

function viewTools() {
  const [q, setQ] = [state.q ?? '', (v) => { state.q = v; }];
  const list = rooms.rooms.filter((r) => !q || `${r.label} ${r.zh} ${r.summary} ${r.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  const tags = [...new Set(rooms.rooms.flatMap((r) => r.tags))];
  return el('div', { class: 'view', dataset: { view: 'tools' } }, [
    el('header', { class: 'view-head' }, [
      el('h1', { class: 'view-title', text: '工具' }),
      el('p', { class: 'view-sub', text: rooms.available ? `${rooms.count} 个本地房间 · 服务运行中` : `房间服务不可用：${rooms.reason}` }),
    ]),
    el('div', { class: 'filters' }, [
      el('input', { class: 'filter-input', type: 'search', placeholder: '搜索工具…', value: q, oninput: (e) => { setQ(e.target.value); render(); } }),
      el('div', { class: 'facet' }, tags.map((t) => el('button', { class: 'btn tiny', text: t, onclick: () => { setQ(t); render(); } }))),
      el('button', { class: 'link tiny inspect', text: '房间服务详情', onclick: () => openInspector('工具 · 房间服务', { hubUrl: rooms.hubUrl, checkedAt: rooms.checkedAt, product: rooms.product, version: rooms.version, count: rooms.count }) }),
    ]),
    grid(['#', '工具', '说明', '保存', ''], list.map((r) =>
      row([
        el('span', { class: 'num', text: r.number }),
        el('span', { class: 'cell-strong' }, [el('span', { text: r.label }), el('span', { class: 'cell-zh', text: r.zh })]),
        el('span', { class: 'cell-note', text: r.summary }),
        r.persistent ? el('span', { class: 'tag tag-ok', text: '保存' }) : el('span', { class: 'tag tag-idle', text: '不留痕' }),
        el('button', { class: 'link tiny', text: '打开', onclick: (e) => { e.stopPropagation(); rt.openRoom(r.id); render(); } }),
      ], { id: r.id, number: r.number, lifecycle: r.lifecycle, tags: r.tags, persistent: r.persistent }, '工具 · 房间细节')
    )),
    rt.state.openedRoom
      ? el('p', { class: 'foot-note', text: `已打开 ${rt.state.openedRoom.id} · ${rt.state.openedRoom.url}` })
      : null,
    el('button', { class: 'btn', text: '打开房间服务', onclick: () => { rt.openHub(); render(); } }),
    rt.state.openedHub
      ? el('p', { class: 'foot-note', text: `已在房间服务中打开 · ${rooms.hubUrl}` })
      : null,
  ]);
}

function viewDevices() {
  const t = node.telemetry;
  return el('div', { class: 'view', dataset: { view: 'devices' } }, [
    el('header', { class: 'view-head' }, [
      el('h1', { class: 'view-title', text: '机器' }),
      el('p', { class: 'view-sub', text: '遥测 10 秒内视为实时，超时标注缓存。' }),
    ]),
    grid(['机器', '状态', '处理器', '内存', '磁盘', '开机'], [
      row([
        el('span', { class: 'cell-strong' }, [el('span', { text: node.displayName }), el('span', { class: 'cell-zh', text: node.metadata.platform })]),
        stateTag(node.online ? 'RUNNING' : 'CANCELLED'),
        el('span', { class: 'num' }, `${pct(t.cpu.usagePercent)} ${''}`),
        el('span', { class: 'num' }, `${gb(t.memory.usedBytes)} / ${gb(t.memory.totalBytes)}`),
        el('span', { class: 'num' }, `${gb(t.disk.usedBytes)} / ${gb(t.disk.totalBytes)}`),
        el('span', { class: 'num' }, `${Math.floor(t.uptimeSeconds / 3600)} h`),
      ], { nodeId: node.id, agentVersion: node.agentVersion, lastHeartbeatAt: node.lastHeartbeatAt, telemetry: t, capabilities: node.capabilities }, '机器 · 运行细节'),
    ]),
    el('section', { class: 'zone wide' }, [
      label('这台机器能做什么'),
      el('ul', { class: 'kv' }, node.capabilities.map((c) => el('li', {}, [el('span', { class: 'kv-k', text: c }), el('span', { class: 'kv-v', text: '可用' })]))),
    ]),
    el('section', { class: 'zone wide' }, [
      label('这台机器上的作业'),
      grid(['作业', '状态', '进度'], rt.state.tasks.map((x) => row([x.type, stateTag(x.state), bar(x.progress, 100)],
        { taskId: x.id, lastCheckpoint: x.lastCheckpoint, result: x.result, error: x.error }, '作业 · 检查点'))),
    ]),
  ]);
}

function viewActivity() {
  return el('div', { class: 'view', dataset: { view: 'activity' } }, [
    el('header', { class: 'view-head' }, [
      el('h1', { class: 'view-title', text: '记录' }),
      el('p', { class: 'view-sub', text: `${rt.state.events.length} 条事件，按时间倒序。` }),
    ]),
    grid(['序号', '时间', '事件', '相关作业'], rt.state.events.map((e) =>
      row([
        el('span', { class: 'num', text: '#' + e.seq }),
        el('span', { class: 'num', text: hhmm(e.timestamp) }),
        e.type,
        e.taskId ? el('span', { class: 'num', text: e.taskId }) : el('span', { class: 'num dim', text: 'City' }),
      ], e, '事件 · 运行细节'))),
  ]);
}

function viewTasks() {
  return el('div', { class: 'view', dataset: { view: 'tasks' } }, [
    el('header', { class: 'view-head' }, [
      el('h1', { class: 'view-title', text: '作业' }),
      el('p', { class: 'view-sub', text: '作业注册表。检查点与结果在检查器中。' }),
      el('button', { class: 'btn', text: '运行演示作业', onclick: () => { rt.createDemoTask(); render(); } }),
    ]),
    grid(['作业', '状态', '进度', ''], rt.state.tasks.map((t) => row([
      el('span', { class: 'cell-strong' }, [
        el('span', { text: t.type }),
        el('span', { class: 'cell-zh', text: `${t.id} · ${t.assignedNodeId}` }),
      ]),
      stateTag(t.state),
      bar(t.progress, 100),
      el('button', {
        class: 'link tiny',
        text: '取消',
        disabled: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.state),
        onclick: (e) => { e.stopPropagation(); rt.cancelTask(t.id); render(); },
      }),
    ], { taskId: t.id, type: t.type, lastCheckpoint: t.lastCheckpoint, result: t.result, error: t.error, assignedNodeId: t.assignedNodeId }, '作业 · 检查点'))),
  ]);
}

function viewActions() {
  return el('div', { class: 'view', dataset: { view: 'actions' } }, [
    el('header', { class: 'view-head' }, [
      el('h1', { class: 'view-title', text: '操作' }),
      el('p', { class: 'view-sub', text: '所有执行过的动作，含后端引用与来源。' }),
      el('div', { class: 'facet' }, [25, 50, 100].map((n) => el('button', { class: 'btn tiny', text: `${n} 条` }))),
    ]),
    grid(['意图', '状态', '路由', '目标', '细节'], [row([
      DEMO.ask.confirmed.requestedIntent,
      stateTag(DEMO.ask.confirmed.status),
      DEMO.ask.confirmed.route,
      DEMO.ask.confirmed.target.label,
      el('button', { class: 'link tiny', text: '检查器', onclick: (e) => { e.stopPropagation(); openInspector('操作 · 详情', { actionId: 'act-77c1', route: DEMO.ask.confirmed.route, operation: DEMO.ask.confirmed.operation, backendRef: null, resultRef: null, provenance: [] }); } }),
    ], { actionId: 'act-77c1', backendRef: null, resultRef: null, provenance: [] }, '操作 · 详情')]),
  ]);
}

function viewServices() {
  return el('div', { class: 'view', dataset: { view: 'services' } }, [
    el('header', { class: 'view-head' }, [
      el('h1', { class: 'view-title', text: '能力服务' }),
      el('p', { class: 'view-sub', text: '桥接能力与 City 生命周期。' }),
    ]),
    grid(['能力', '桥接', '生命周期', ''], city.capabilities.map((c) => row([
      el('span', { class: 'num', text: c.capabilityId }),
      el('span', { class: `tag tag-${c.bridgeState === 'READY' ? 'ok' : 'idle'}`, text: c.bridgeState }),
      c.cityLifecycle,
      el('button', { class: 'link tiny', text: '调用', onclick: (e) => { e.stopPropagation(); rt.invoke(c.capabilityId); render(); } }),
    ], c, '能力 · 调用细节'))),
    el('section', { class: 'zone wide' }, [
      label('调用历史'),
      grid(['调用', '能力', '状态', '摘要'], rt.state.invocations.map((i) => row([
        el('span', { class: 'num', text: i.invocationId }),
        el('span', { class: 'num', text: i.capabilityId }),
        stateTag(i.status),
        el('span', { class: 'num', text: i.resultDigest ?? '—' }),
      ], i, '调用 · 结果细节'))),
    ]),
  ]);
}

function viewPairing() {
  return el('div', { class: 'view', dataset: { view: 'pairing' } }, [
    el('header', { class: 'view-head' }, [
      el('h1', { class: 'view-title', text: '配对' }),
      el('p', { class: 'view-sub', text: '把一台新设备接入你的城市。' }),
    ]),
    el('div', { class: 'zones' }, [
      el('section', { class: 'zone' }, [
        label('配对码'),
        el('p', { class: 'big-num', text: rt.state.pairing ? rt.state.pairing.shortCode : '— — — —' }),
        el('button', { class: 'btn primary', text: '生成配对码', onclick: () => { rt.startPairing(); render(); } }),
        rt.state.pairing
          ? el('p', { class: 'foot-note', text: `有效期 ${rt.state.pairing.expiresInSeconds} 秒 · 城市 ${rt.state.pairing.cityId}` })
          : null,
      ]),
      el('section', { class: 'zone' }, [
        label('发现与协议'),
        el('ul', { class: 'kv' }, [
          el('li', {}, [el('span', { class: 'kv-k', text: 'mDNS' }), el('span', { class: 'kv-v', text: city.discovery.mdns.state })]),
          el('li', {}, [el('span', { class: 'kv-k', text: '蓝牙' }), el('span', { class: 'kv-v', text: city.discovery.ble.state })]),
          el('li', {}, [el('span', { class: 'kv-k', text: '地址' }), el('span', { class: 'kv-v num', text: `${city.descriptor.endpoint.host}:${city.descriptor.endpoint.port}` })]),
        ]),
        el('p', { class: 'warn-note', text: '仅限局域网开发使用，不要暴露到公网。' }),
        el('button', { class: 'link tiny inspect', text: '协议细节', onclick: () => openInspector('配对 · 协议细节', { cityId: city.cityId, pairingSessionId: city.descriptor.pairingSessionId, discovery: city.discovery, apiVersion: 0, schemaVersion: 0 }) }),
      ]),
    ]),
  ]);
}

function viewSettings() {
  return el('div', { class: 'view', dataset: { view: 'settings' } }, [
    el('header', { class: 'view-head' }, [
      el('h1', { class: 'view-title', text: '设置' }),
      el('p', { class: 'view-sub', text: '语言、连接与协议。' }),
    ]),
    el('div', { class: 'zones' }, [
      el('section', { class: 'zone' }, [
        label('界面语言'),
        el('div', { class: 'facet' }, ['English', '简体中文'].map((n, i) => el('button', { class: i === 0 ? 'btn tiny is-on' : 'btn tiny', text: n }))),
      ]),
      el('section', { class: 'zone' }, [
        label('连接'),
        el('ul', { class: 'kv' }, [
          el('li', {}, [el('span', { class: 'kv-k', text: '会话令牌' }), el('span', { class: 'kv-v', text: rt.state.connected ? '已设置' : '已断开' })]),
          el('li', {}, [el('span', { class: 'kv-k', text: '源' }), el('span', { class: 'kv-v num', text: 'http://127.0.0.1:4310' })]),
        ]),
        el('button', { class: 'btn', text: rt.state.connected ? '更换令牌' : '已断开', disabled: !rt.state.connected, onclick: () => { rt.disconnect(); render(); } }),
        el('button', { class: 'link tiny inspect', text: '协议细节', onclick: () => openInspector('设置 · 协议细节', { apiVersion: 0, schemaVersion: 0, origin: 'http://127.0.0.1:4310' }) }),
      ]),
    ]),
  ]);
}

const VIEWS = { home: viewHome, ask: viewAsk, tools: viewTools, devices: viewDevices, activity: viewActivity, tasks: viewTasks, actions: viewActions, services: viewServices, pairing: viewPairing, settings: viewSettings };

/* --------------------------------------------------------------- wiring */

function setAsk(k) { state.ask = k; render(); }

function renderRail() {
  document.getElementById('objects').replaceChildren(...OBJECTS.map((o) =>
    el('button', { class: o.id === state.object ? 'object is-current' : 'object', dataset: { object: o.id }, onclick: () => { state.object = o.id; go(o.views[0]); } }, [
      el('span', { class: 'object-icon', html: icon(o.icon) }),
      el('span', { class: 'object-text' }, [el('span', { class: 'object-label', text: o.label }), el('span', { class: 'object-zh', text: o.zh })]),
      el('span', { class: 'object-count', text: String(o.views.length) }),
    ]),
  ));
  const adv = document.getElementById('rail-advanced');
  adv.hidden = !state.advanced;
  document.getElementById('rail-more').setAttribute('aria-expanded', String(state.advanced));
  adv.replaceChildren(...ADVANCED_OBJECTS.map((o) =>
    el('button', { class: o.views[0] === state.view ? 'object is-current' : 'object', dataset: { object: o.id }, onclick: () => go(o.views[0]) }, [
      el('span', { class: 'object-icon', html: icon(o.icon) }),
      el('span', { class: 'object-text' }, el('span', { class: 'object-label', text: o.label })),
    ]),
  ));
}

function render() {
  const canvas = document.getElementById('canvas');
  canvas.replaceChildren(VIEWS[state.view]());
  canvas.dataset.view = state.view;
  document.body.dataset.view = state.view;
  document.title = `Utopia Atlas · ${SURFACES.find((s) => s.id === state.view)?.label ?? ''}`;
  renderRail();
}

function go(view) {
  if (!VIEWS[view]) view = 'home';
  state.view = view;
  const owner = [...OBJECTS, ...ADVANCED_OBJECTS].find((o) => o.views.includes(view));
  if (owner) { state.object = owner.id; state.advanced = ADVANCED_OBJECTS.includes(owner); }
  render();
}

document.getElementById('rail-more').addEventListener('click', () => { state.advanced = !state.advanced; renderRail(); });
document.getElementById('inspector-close').addEventListener('click', closeInspector);
window.addEventListener('hashchange', () => go(location.hash.replace(/^#/, '') || 'home'));

window.__ui000 = {
  candidate: 'b',
  go,
  setAsk,
  surfaces: SURFACES.map((s) => s.id),
  get surface() { return state.view; },
  openInspector,
  /* This direction demotes technical values into the inspector, which holds one
     payload at a time. revealAll() is what a reviewer does by hand: open every
     openable row and keep what it showed, so scripts/ui-000/parity.mjs can prove
     the values are still reachable rather than deleted. */
  revealAll: () => {
    const log = ensureRevealLog();
    /* .inspect marks the controls that exist only to open the inspector for a
       value that has no table row (service availability, protocol, discovery). */
    for (const element of document.querySelectorAll('#canvas .row.is-openable, #canvas .inspect')) {
      element.click();
      log.append(el('pre', { text: document.getElementById('inspector-body').textContent }));
    }
  },
};

function ensureRevealLog() {
  let log = document.getElementById('reveal-log');
  if (!log) {
    log = el('div', { id: 'reveal-log', hidden: true });
    document.body.append(log);
  }
  return log;
}

go(location.hash.replace(/^#/, '') || 'home');
closeInspector();
