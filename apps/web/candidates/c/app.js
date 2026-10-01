/**
 * UI-000 · Candidate C — "Prism / 剧场"
 *
 * Expressive deck. Structure: a horizontal "stage" of large act words across the
 * top, content presented as scenes with deliberately UNEQUAL panel sizes, and a
 * full-bleed spotlight overlay for Ask/Do instead of an inline conversation.
 * A "后台" drawer holds the advanced surfaces.
 *
 * Dark, saturated, layered surfaces instead of borders. Every fact from
 * ../../shared/facts.js is expressed; technical values go behind 运行详情.
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

const gb = (b) => (Number.isFinite(b) ? (b / 1024 ** 3).toFixed(1) + ' GB' : '未知');
const hhmm = (iso) => new Date(iso).toISOString().slice(11, 16);

const city = DEMO.city;
const rooms = DEMO.rooms;
const node = city.nodes[0];
/* Every control in this direction acts on the shared local runtime, so the same
   click produces the same fact here as in the other two directions. */
const rt = createRuntime();
const ROOM_ICONS = ['room', 'clock', 'search', 'shield', 'cpu', 'disk', 'filter', 'check', 'expand', 'user'];

const ACTS = [
  { id: 'home', label: '现在', en: 'NOW' },
  { id: 'tools', label: '工具', en: 'TOOLS' },
  { id: 'devices', label: '设备', en: 'DEVICES' },
  { id: 'activity', label: '动态', en: 'ACTIVITY' },
];

const state = { view: 'home', backstage: false, spotlight: false, ask: 'confirmed' };

/* -------------------------------------------------------------- primitives */

function panel(size, ...kids) {
  return el('section', { class: `panel panel-${size}` }, ...kids);
}
function tech(summary, payload) {
  return el('details', { class: 'tech' }, [
    el('summary', { text: summary }),
    el('pre', { text: JSON.stringify(payload, null, 2) }),
  ]);
}
const tag = (kind, text) => el('span', { class: `tag tag-${kind}`, text });

/* HUD cell primitives — Owner ruling 2026-10-01: keep C's theme, drop the big
 * sparse cards, move density toward B, render as a game HUD. A cell is a compact
 * framed panel with a micro label, an optional right-aligned reading, and a body. */
function cellHead(label, meta) {
  const kids = [el('p', { class: 'cell-label', text: label })];
  if (meta) kids.push(el('span', { class: 'cell-meta', text: meta }));
  return el('div', { class: 'cell-head' }, kids);
}
function cell(size, label, meta, ...kids) {
  /* `el` flattens only one level, so the body arrays are flattened here before
     being handed over — otherwise a nested array would be stringified. */
  return el('section', { class: `cell cell-${size}` }, cellHead(label, meta), ...kids.flat());
}
/** Small definition-list row used across the board for dense key/value readings. */
function kv(pairs) {
  return el('dl', { class: 'kv' }, pairs.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: v })]));
}

/**
 * Home's character slot — the assistant the Owner configures later.
 *
 * There is no character art in this repository, so this is an honest line-art
 * silhouette rather than an implied finished asset: the slot is deliberately
 * UNASSIGNED, and it only states what will be bound later (naming, appearance,
 * voice, duty). Per the v2 invariants the assistant's identity is configurable and
 * a profile field can never grant authority, so nothing here is a control — a
 * rendered control that does nothing is exactly the false-affordance defect the
 * review already caught once.
 */
function assistantArt() {
  return `<svg viewBox="0 0 200 240" fill="none" stroke="#5ee7ff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path d="M26 240c0-38 18-58 44-66l30-8 30 8c26 8 44 28 44 66" stroke="#8b5cf6"/>
    <path d="M70 174l30 22 30-22"/>
    <path d="M100 196v44" stroke="#8b5cf6"/>
    <path d="M86 140v22c0 7 6 12 14 12s14-5 14-12v-22"/>
    <path d="M62 96c0-26 17-44 38-44s38 18 38 44c0 30-17 50-38 50S62 126 62 96Z"/>
    <path d="M56 92c2-30 20-50 44-50s42 20 44 50" stroke="#c6f24e"/>
    <path d="M56 92c8 4 14 2 20-4M144 92c-8 4-14 2-20-4" stroke="#c6f24e"/>
    <path d="M100 42c-6 12-6 26 2 36" stroke="#c6f24e"/>
    <path d="M74 100h20M106 100h20"/>
    <path d="M78 112c8 5 16 5 24 0" opacity=".65"/>
    <circle cx="100" cy="184" r="4" stroke="#c6f24e"/>
  </svg>`;
}

function operatorHero() {
  const t = node.telemetry;
  return el('section', { class: 'operator' }, [
    el('div', { class: 'op-frame' }, [
      el('span', { class: 'op-side' }),
      el('span', { class: 'op-tag', text: 'ASSISTANT' }),
      el('div', { class: 'op-art', html: assistantArt() }),
      el('span', { class: 'op-slot', text: 'SLOT 01' }),
    ]),
    el('div', { class: 'op-body' }, [
      el('p', { class: 'op-role', text: '助理 · ASSISTANT' }),
      el('p', { class: 'op-name', html: '未指派<small>UNASSIGNED</small>' }),
      el('p', { class: 'op-sub', text: '主页人物就是你的助理。命名、形象、语气与职务在后续设置中绑定，现在只是占位。' }),
      kv([
        ['绑定设备', node.displayName],
        ['形象', '占位剪影'],
        ['语音', '未启用'],
        ['职务', '待设定'],
      ]),
      el('ul', { class: 'meters op-vitals' }, [
        meter('负载', `${t.cpu.usagePercent}%`, t.cpu.usagePercent / 100),
        meter('内存', gb(t.memory.usedBytes), t.memory.usedBytes / t.memory.totalBytes),
        meter('链路', rt.state.connected ? '已连接' : '已断开', rt.state.connected ? 1 : 0),
      ]),
    ]),
  ]);
}

/* ----------------------------------------------------------------- scenes */

function sceneHome() {
  const open = rt.state.tasks.filter((t) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.state));
  return el('div', { class: 'act', dataset: { view: 'home' } }, [
    el('p', { class: 'act-kicker', text: `NOW · ${hhmm(city.updatedAt)}` }),
    el('h1', { class: 'act-title', html: '你的城市<em>现在</em>是这样。' }),
    operatorHero(),
    el('div', { class: 'board' }, [
      /* 1 — machine readings NOT already shown on the assistant card above:
         the assistant carries 负载/内存/绑定设备, so this cell keeps storage,
         platform and heartbeat rather than repeating them. */
      cell(4, '设备', node.online ? 'ONLINE' : 'OFFLINE', [
        kv([
          ['磁盘剩余', gb(node.telemetry.disk.freeBytes)],
          ['磁盘占用', gb(node.telemetry.disk.usedBytes)],
          ['平台', node.metadata.platform],
          ['心跳', hhmm(node.lastHeartbeatAt)],
        ]),
        tech('运行详情', { nodeId: node.id, displayName: node.displayName, agentVersion: node.agentVersion, telemetry: node.telemetry }),
      ]),
      /* 2 — what is running now */
      cell(4, '正在发生', open.length ? `${open.length} 运行中` : 'IDLE', [
        el('p', { class: 'hero-mid', text: open.length ? `${open.length} 件事在做` : '没有正在运行的事' }),
        kv([
          ['最近同步', hhmm(city.updatedAt)],
          ['作业', open.length ? open.map((t) => t.type).join(' · ') : '—'],
        ]),
        el('a', { class: 'pill-link ghosty', href: '#devices', text: '看设备' }),
      ]),
      /* 3 — tools, compact chips (keeps the B-style brevity the Owner asked for) */
      cell(4, '随时可用', `${rooms.count} 项`, [
        el('p', { class: 'hero-mid', text: `${rooms.count} 个本地工具` }),
        el('div', { class: 'poster-row' }, rooms.rooms.slice(0, 6).map((r, i) =>
          el('button', { class: 'mini', onclick: () => go('tools') }, [
            el('span', { class: 'mini-icon', html: icon(ROOM_ICONS[i % ROOM_ICONS.length]) }),
            el('span', { class: 'mini-label', text: r.label }),
          ]),
        )),
        el('a', { class: 'pill-link', href: '#tools', text: '全部工具' }),
      ]),
      /* 4 — activity as a tight ledger strip, full width */
      cell(12, '最近动态', `${rt.state.events.length} 条`, [
        el('ul', { class: 'beats' }, rt.state.events.slice(0, 4).map((e) =>
          el('li', {}, [
            el('span', { class: 'beat-time', text: hhmm(e.timestamp) }),
            el('span', { class: 'beat-text', text: readable(e.type) }),
            tech('运行详情', e),
          ]),
        )),
      ]),
    ]),
  ]);
}

const readable = (t) => ({ 'task.completed': '一件事完成了', 'task.progress': '一件事在推进', 'node.heartbeat': '设备心跳' }[t] ?? t);

function sceneTools() {
  return el('div', { class: 'act', dataset: { view: 'tools' } }, [
    el('p', { class: 'act-kicker', text: 'TOOLS' }),
    el('h1', { class: 'act-title', html: `本地工具<br><em>${rooms.count}</em> 个` }),
    el('p', { class: 'act-lede', text: rooms.available ? '房间服务正在这台机器上运行。' : `房间服务不可用：${rooms.reason}` }),
    el('div', { class: 'room-grid' }, rooms.rooms.map((r, i) =>
      el('article', { class: 'room' }, [
        el('div', { class: 'room-top' }, [
          el('span', { class: 'room-icon', html: icon(ROOM_ICONS[i % ROOM_ICONS.length]) }),
          el('span', { class: 'room-num', text: r.number }),
          el('h2', { class: 'room-title', text: r.label }),
        ]),
        el('p', { class: 'room-zh', text: r.zh }),
        el('p', { class: 'room-note', text: r.summary }),
        el('div', { class: 'room-foot' }, [
          r.persistent ? tag('ok', '保存') : tag('idle', '不留痕'),
          el('span', { class: 'room-tags', text: r.tags.join(' · ') }),
          el('button', { class: 'cta poster-open', text: '打开', onclick: () => { rt.openRoom(r.id); render(); } }),
        ]),
        tech('运行详情', { id: r.id, number: r.number, lifecycle: r.lifecycle, tags: r.tags, persistent: r.persistent }),
      ]),
    )),
    rt.state.openedRoom
      ? el('p', { class: 'act-lede dim', text: `已打开 ${rt.state.openedRoom.id} · ${rt.state.openedRoom.url}` })
      : null,
    el('p', { class: 'act-lede dim', text: '房间只监听本机回环地址，只有这台机器上的浏览器能打开。' }),
    el('div', { class: 'btn-row' }, [
      el('button', { class: 'cta', text: '打开房间服务', onclick: () => { rt.openHub(); render(); } }),
      tech('房间服务详情', { hubUrl: rooms.hubUrl, checkedAt: rooms.checkedAt, product: rooms.product, version: rooms.version, count: rooms.count }),
    ]),
  ]);
}

function sceneDevices() {
  const t = node.telemetry;
  return el('div', { class: 'act', dataset: { view: 'devices' } }, [
    el('p', { class: 'act-kicker', text: 'DEVICES' }),
    el('h1', { class: 'act-title', html: '干活的地方<br><em>一个</em>也好。' }),
    el('div', { class: 'deck' }, [
      panel('hero', [
        el('p', { class: 'panel-label', text: '机器' }),
        el('p', { class: 'hero-line', text: node.displayName }),
        el('p', { class: 'panel-note', text: node.online ? '在线' : '离线' }),
        tech('运行详情', { nodeId: node.id, platform: node.metadata.platform, agentVersion: node.agentVersion, lastHeartbeatAt: node.lastHeartbeatAt }),
      ]),
      panel('std', [
        el('p', { class: 'panel-label', text: '负载' }),
        el('ul', { class: 'meters' }, [
          meter('处理器', `${t.cpu.usagePercent}%`, t.cpu.usagePercent / 100),
          meter('内存', gb(t.memory.usedBytes), t.memory.usedBytes / t.memory.totalBytes),
          meter('磁盘', gb(t.disk.usedBytes), t.disk.usedBytes / t.disk.totalBytes),
        ]),
      ]),
      panel('std', [
        el('p', { class: 'panel-label', text: '能做什么' }),
        el('ul', { class: 'beats' }, node.capabilities.map((c) => el('li', {}, [el('span', { html: icon('check') }), el('span', { text: c })]))),
        el('p', { class: 'panel-note', text: '遥测 10 秒内为实时，超时标注缓存。' }),
      ]),
      panel('wide', [
        el('p', { class: 'panel-label', text: '这台机器上的作业' }),
        el('div', { class: 'poster-row' }, rt.state.tasks.map((x) =>
          el('button', { class: 'mini mini-sm' }, [
            el('span', { class: 'mini-label', text: x.type }),
            el('span', { class: 'mini-meta', text: `${x.state} · ${x.progress}%` }),
          ]),
        )),
      ]),
    ]),
  ]);
}

const meter = (k, v, ratio) => el('li', {}, [
  el('span', { class: 'meter-k', text: k }),
  el('span', { class: 'meter-bar' }, el('span', { class: 'meter-fill', style: `width:${Math.round(Math.min(1, ratio) * 100)}%` })),
  el('span', { class: 'meter-v', text: v }),
]);

function sceneActivity() {
  return el('div', { class: 'act', dataset: { view: 'activity' } }, [
    el('p', { class: 'act-kicker', text: 'ACTIVITY' }),
    el('h1', { class: 'act-title', html: `城市里<br>发生过 <em>${rt.state.events.length}</em> 件事。` }),
    el('ul', { class: 'beats big' }, rt.state.events.map((e) =>
      el('li', {}, [
        el('span', { class: 'beat-time', text: hhmm(e.timestamp) }),
        el('span', { class: 'beat-text', text: readable(e.type) }),
        tech('运行详情', e),
      ]),
    )),
  ]);
}

function sceneBackstage() {
  return el('div', { class: 'act', dataset: { view: 'services' } }, [
    el('p', { class: 'act-kicker', text: 'BACKSTAGE' }),
    el('h1', { class: 'act-title', html: '后台<br><em>能力服务</em>' }),
    el('div', { class: 'list-table' }, city.capabilities.map((c) =>
      el('div', { class: 'lt-row' }, [
        el('span', { class: 'lt-key', text: c.capabilityId }),
        tag(c.bridgeState === 'READY' ? 'ok' : 'idle', c.bridgeState),
        el('span', { class: 'lt-note', text: c.cityLifecycle }),
        el('button', { class: 'link', text: '调用', onclick: () => { rt.invoke(c.capabilityId); render(); } }),
        tech('运行详情', c),
      ]),
    )),
    el('h2', { class: 'act-sub', text: '调用历史' }),
    el('div', { class: 'list-table' }, rt.state.invocations.map((i) =>
      el('div', { class: 'lt-row' }, [
        el('span', { class: 'lt-key', text: i.capabilityId }),
        tag('ok', i.status),
        el('span', { class: 'lt-note', text: i.resultDigest ?? '—' }),
        tech('运行详情', i),
      ]),
    )),
  ]);
}

function sceneTasks() {
  return el('div', { class: 'act', dataset: { view: 'tasks' } }, [
    el('p', { class: 'act-kicker', text: 'BACKSTAGE' }),
    el('h1', { class: 'act-title', html: '任务' }),
    el('div', { class: 'btn-row' }, [el('button', { class: 'cta', text: '运行演示任务', onclick: () => { rt.createDemoTask(); render(); } })]),
    el('div', { class: 'list-table' }, rt.state.tasks.map((t) =>
      el('div', { class: 'lt-row' }, [
        el('span', { class: 'lt-key', text: t.type }),
        tag(t.state === 'COMPLETED' ? 'ok' : t.state === 'RUNNING' ? 'run' : 'idle', t.state),
        el('span', { class: 'lt-note', text: `${t.progress}%` }),
        el('button', { class: 'link', text: '取消', disabled: ['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.state), onclick: () => { rt.cancelTask(t.id); render(); } }),
        tech('检查点与结果', { taskId: t.id, lastCheckpoint: t.lastCheckpoint, result: t.result, error: t.error }),
      ]),
    )),
  ]);
}

function sceneActions() {
  return el('div', { class: 'act', dataset: { view: 'actions' } }, [
    el('p', { class: 'act-kicker', text: 'BACKSTAGE' }),
    el('h1', { class: 'act-title', html: '操作记录' }),
    el('div', { class: 'chips' }, [25, 50, 100].map((n) => el('button', { class: 'chip', text: `${n} 条` }))),
    el('div', { class: 'list-table' }, [DEMO.ask.confirmed].map((x) =>
      el('div', { class: 'lt-row' }, [
        el('span', { class: 'lt-key', text: x.requestedIntent }),
        tag('ok', x.status),
        el('span', { class: 'lt-note', text: `${x.route} · ${x.target.label}` }),
        tech('操作详情', { actionId: x.actionId, route: x.route, operation: x.operation, backendRef: null, resultRef: null, provenance: [] }),
      ]),
    )),
  ]);
}

function scenePairing() {
  return el('div', { class: 'act', dataset: { view: 'pairing' } }, [
    el('p', { class: 'act-kicker', text: 'BACKSTAGE' }),
    el('h1', { class: 'act-title', html: '把新设备<br><em>带进来</em>' }),
    el('div', { class: 'deck' }, [
      panel('hero', [
        el('p', { class: 'panel-label', text: '配对码' }),
        el('p', { class: 'code', text: rt.state.pairing ? rt.state.pairing.shortCode : '— — — —' }),
        el('button', { class: 'cta', text: '生成配对码', onclick: () => { rt.startPairing(); render(); } }),
        rt.state.pairing
          ? el('p', { class: 'panel-note', text: `有效期 ${rt.state.pairing.expiresInSeconds} 秒` })
          : null,
      ]),
      panel('std', [
        el('p', { class: 'panel-label', text: '发现' }),
        el('p', { class: 'panel-note', text: `mDNS ${city.discovery.mdns.state}` }),
        el('p', { class: 'panel-note', text: `蓝牙 ${city.discovery.ble.state}` }),
        el('p', { class: 'panel-note warn', text: '仅限局域网开发使用，不要暴露到公网。' }),
        tech('协议细节', { cityId: city.cityId, pairingSessionId: city.descriptor.pairingSessionId, discovery: city.discovery, apiVersion: 0, schemaVersion: 0 }),
      ]),
    ]),
  ]);
}

function sceneSettings() {
  return el('div', { class: 'act', dataset: { view: 'settings' } }, [
    el('p', { class: 'act-kicker', text: 'BACKSTAGE' }),
    el('h1', { class: 'act-title', html: '设置' }),
    el('p', { class: 'act-lede', text: '界面语言' }),
    el('div', { class: 'chips' }, ['English', '简体中文'].map((n, i) => el('button', { class: i === 0 ? 'chip is-on' : 'chip', text: n }))),
    el('p', { class: 'act-lede', text: '连接' }),
    el('p', { class: 'panel-note', text: rt.state.connected ? '当前会话使用一次性配对令牌。更换令牌会断开连接。' : '已断开。重新输入配对令牌即可连接。' }),
    el('div', { class: 'btn-row' }, [el('button', { class: 'cta', text: rt.state.connected ? '更换令牌' : '已断开', disabled: !rt.state.connected, onclick: () => { rt.disconnect(); render(); } })]),
    tech('协议细节', { apiVersion: 0, schemaVersion: 0, origin: 'http://127.0.0.1:4310' }),
  ]);
}

function sceneAsk() {
  /* Ask/Do is a spotlight in this direction, so the scene is the same content
     presented full-bleed; the floating pill opens the overlay variant. */
  return el('div', { class: 'act act-ask', dataset: { view: 'ask' } }, [
    el('p', { class: 'act-kicker', text: 'SPOTLIGHT' }),
    el('h1', { class: 'act-title', html: '说一句<br><em>就够了</em>。' }),
    el('form', { class: 'overlay-form inline', onsubmit: (e) => { e.preventDefault(); setAsk('confirmed'); } }, [
      el('input', { type: 'text', placeholder: '说你想做什么…', 'aria-label': '说你想做什么' }),
      el('button', { class: 'cta', type: 'submit', text: '去做' }),
    ]),
    el('div', { class: 'ov-body' }, askContent()),
    el('div', { class: 'chips' }, ['confirmed', 'needsChoice', 'ambiguous', 'unmatched', 'working'].map((k) =>
      el('button', { class: k === state.ask ? 'chip is-on' : 'chip', text: { confirmed: '已完成', needsChoice: '需确认', ambiguous: '有歧义', unmatched: '未匹配', working: '进行中' }[k], onclick: () => setAsk(k) })
    )),
  ]);
}

const SCENES = { home: sceneHome, ask: sceneAsk, tools: sceneTools, devices: sceneDevices, activity: sceneActivity, services: sceneBackstage, tasks: sceneTasks, actions: sceneActions, pairing: scenePairing, settings: sceneSettings };

/* --------------------------------------------------------------- spotlight */

function askContent() {
  const a = DEMO.ask;
  const s = state.ask;
  const content = {
    confirmed: () => [
      el('p', { class: 'ov-said', text: a.confirmed.requestedIntent }),
      el('p', { class: 'ov-reply' }, ['交给 ', el('em', { text: a.confirmed.target.label }), ' 完成。']),
      el('p', { class: 'ov-result', text: a.confirmed.summary }),
      tech('运行详情', a.confirmed),
    ],
    needsChoice: () => [
      el('p', { class: 'ov-said', text: a.needsChoice.requestedIntent }),
      el('p', { class: 'ov-reply', text: '这一步会真的改动东西。' }),
      el('div', { class: 'btn-row' }, [
        el('button', { class: 'cta', text: `确认 · ${a.needsChoice.target.label}`, onclick: () => setAsk('confirmed') }),
        el('button', { class: 'chip', text: '算了', onclick: () => setAsk('confirmed') }),
      ]),
      el('p', { class: 'panel-note', text: a.needsChoice.reason }),
    ],
    ambiguous: () => [
      el('p', { class: 'ov-said', text: a.ambiguous.requestedIntent }),
      el('p', { class: 'ov-reply', text: '哪一个？' }),
      el('div', { class: 'chips' }, a.ambiguous.candidates.map((c) => el('button', { class: 'chip', text: c.label, onclick: () => setAsk('confirmed') }))),
    ],
    unmatched: () => [
      el('p', { class: 'ov-said', text: a.unmatched.requestedIntent }),
      el('p', { class: 'ov-reply', text: '没听懂。挑一个：' }),
      el('div', { class: 'chips' }, a.unmatched.targets.map((c) => el('button', { class: 'chip', text: c.label, onclick: () => setAsk('confirmed') }))),
      el('p', { class: 'panel-note', text: a.unmatched.reason }),
    ],
    working: () => [el('p', { class: 'ov-said', text: a.working.text }), el('p', { class: 'ov-reply working', text: '正在执行…' })],
  };
  return content[s]();
}

function askBody() {
  return el('div', {}, [
    el('div', { class: 'ov-body' }, askContent()),
    el('div', { class: 'chips' }, ['confirmed', 'needsChoice', 'ambiguous', 'unmatched', 'working'].map((k) =>
      el('button', { class: k === state.ask ? 'chip is-on' : 'chip', text: { confirmed: '已完成', needsChoice: '需确认', ambiguous: '有歧义', unmatched: '未匹配', working: '进行中' }[k], onclick: () => setAsk(k) })
    )),
  ]);
}

/* ----------------------------------------------------------------- wiring */

function setAsk(k) { state.ask = k; renderOverlay(); }

function renderActs() {
  const host = document.getElementById('acts');
  host.replaceChildren(...ACTS.map((a) =>
    el('button', {
      class: a.id === state.view ? 'act-btn is-current' : 'act-btn',
      dataset: { act: a.id },
      onclick: () => go(a.id),
    }, [el('span', { class: 'act-label', text: a.label }), el('span', { class: 'act-en', text: a.en })]),
  ));
  const back = document.getElementById('backstage');
  back.hidden = !state.backstage;
  document.getElementById('backstage-btn').setAttribute('aria-expanded', String(state.backstage));
  back.replaceChildren(...ADVANCED_SURFACES.map((s) =>
    el('button', { class: s.id === state.view ? 'back-item is-current' : 'back-item', onclick: () => { go(s.id); } }, [
      el('span', { class: 'back-icon', html: icon(s.id) }),
      el('span', { text: `${s.label} · ${s.zh}` }),
    ]),
  ));
}

function renderOverlay() {
  document.getElementById('overlay').hidden = !state.spotlight;
  document.body.dataset.spotlight = state.spotlight ? 'open' : 'closed';
  document.getElementById('overlay-body').replaceChildren(askBody());
}

function render() {
  const scene = document.getElementById('scene');
  scene.replaceChildren(SCENES[state.view]());
  scene.dataset.view = state.view;
  document.body.dataset.view = state.view;
  document.title = `Utopia Prism · ${SURFACES.find((s) => s.id === state.view)?.label ?? ''}`;
  renderActs();
}

function go(view) {
  if (!SCENES[view]) view = 'home';
  state.view = view;
  state.spotlight = false;
  state.backstage = ADVANCED_SURFACES.some((s) => s.id === view);
  render();
  renderOverlay();
}

document.getElementById('spot').addEventListener('click', () => { state.spotlight = true; renderOverlay(); document.getElementById('overlay-input').focus(); });
document.getElementById('overlay-close').addEventListener('click', () => { state.spotlight = false; renderOverlay(); });
document.getElementById('backstage-btn').addEventListener('click', () => { state.backstage = !state.backstage; renderActs(); });
document.getElementById('overlay-form').addEventListener('submit', (e) => { e.preventDefault(); setAsk('confirmed'); });
window.addEventListener('keydown', (e) => { if (e.key === 'Escape') { state.spotlight = false; renderOverlay(); } });
window.addEventListener('hashchange', () => go(location.hash.replace(/^#/, '') || 'home'));

window.__ui000 = {
  candidate: 'c',
  go,
  setAsk,
  openSpotlight: () => { state.spotlight = true; renderOverlay(); },
  surfaces: SURFACES.map((s) => s.id),
  get surface() { return state.view; },
  /* Opening every disclosure is how a reviewer reads the demoted values.
     Used by scripts/ui-000/parity.mjs to prove they are still reachable. */
  revealAll: () => { document.querySelectorAll('details').forEach((d) => { d.open = true; }); },
};

go(location.hash.replace(/^#/, '') || 'home');
