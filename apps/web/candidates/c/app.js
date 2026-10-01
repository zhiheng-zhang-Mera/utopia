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

/* ----------------------------------------------------------------- scenes */

function sceneHome() {
  const open = rt.state.tasks.filter((t) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.state));
  return el('div', { class: 'act', dataset: { view: 'home' } }, [
    el('p', { class: 'act-kicker', text: `NOW · ${hhmm(city.updatedAt)}` }),
    el('h1', { class: 'act-title', html: '你的城市<br><em>现在</em>是这样。' }),
    el('div', { class: 'deck' }, [
      panel('hero', [
        el('p', { class: 'panel-label', text: '正在发生' }),
        el('p', { class: 'hero-line', text: open.length ? `${open.length} 件事在做` : '没有正在运行的事' }),
        el('p', { class: 'panel-note', text: `最近一次同步 ${hhmm(city.updatedAt)}` }),
        el('a', { class: 'pill-link', href: '#devices', text: '看设备' }),
      ]),
      panel('tall', [
        el('p', { class: 'panel-label', text: '设备' }),
        el('p', { class: 'hero-mid', text: node.displayName }),
        el('p', { class: 'panel-note', text: `CPU ${node.telemetry.cpu.usagePercent}% · 内存 ${gb(node.telemetry.memory.usedBytes)}` }),
        el('p', { class: 'panel-note', text: `磁盘剩余 ${gb(node.telemetry.disk.freeBytes)}` }),
        tech('运行详情', { nodeId: node.id, platform: node.metadata.platform, agentVersion: node.agentVersion, telemetry: node.telemetry }),
      ]),
      panel('wide', [
        el('p', { class: 'panel-label', text: '随时可用' }),
        el('p', { class: 'hero-mid', text: `${rooms.count} 个本地工具` }),
        el('div', { class: 'poster-row' }, rooms.rooms.slice(0, 5).map((r, i) =>
          el('button', { class: `mini mini-${i === 0 ? 'lg' : 'sm'}`, onclick: () => go('tools') }, [
            el('span', { class: 'mini-icon', html: icon(ROOM_ICONS[i % ROOM_ICONS.length]) }),
            el('span', { class: 'mini-label', text: r.label }),
          ]),
        )),
        el('a', { class: 'pill-link', href: '#tools', text: '全部工具' }),
      ]),
      panel('std', [
        el('p', { class: 'panel-label', text: '最近动态' }),
        el('ul', { class: 'beats' }, rt.state.events.slice(0, 3).map((e) =>
          el('li', {}, [
            el('span', { class: 'beat-time', text: hhmm(e.timestamp) }),
            el('span', { text: readable(e.type) }),
            tech('#', e),
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
    el('div', { class: 'ribbon' }, rooms.rooms.map((r, i) =>
      el('article', { class: i % 4 === 0 ? 'poster poster-xl' : i % 3 === 0 ? 'poster poster-lg' : 'poster' }, [
        el('span', { class: 'poster-icon', html: icon(ROOM_ICONS[i % ROOM_ICONS.length]) }),
        el('span', { class: 'poster-num', text: r.number }),
        el('h2', { class: 'poster-title', text: r.label }),
        el('p', { class: 'poster-zh', text: r.zh }),
        el('p', { class: 'poster-note', text: r.summary }),
        el('div', { class: 'poster-foot' }, [
          r.persistent ? tag('ok', '保存') : tag('idle', '不留痕'),
          el('span', { class: 'poster-tags', text: r.tags.join(' · ') }),
        ]),
        tech('运行详情', { id: r.id, number: r.number, lifecycle: r.lifecycle, tags: r.tags, persistent: r.persistent }),
        el('button', { class: 'cta poster-open', text: '打开', onclick: () => { rt.openRoom(r.id); render(); } }),
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
