/**
 * UI-000 · Candidate A — "Halo / 随行"
 *
 * Ambient companion. Structure: NO sidebar, NO card grid, NO permanent chrome.
 * One readable column with a bottom omnibox that is always present because
 * "ask" is the product's spine. Sections are reached by intent or by a plain
 * text switcher.
 *
 * Every fact from ../../shared/facts.js is expressed; technical values are
 * demoted into <details> disclosures, never deleted.
 *
 * TEMPORARY candidate surface — see ../README.md.
 */
import { DEMO, PRIMARY_SURFACES, ADVANCED_SURFACES, SURFACES } from '../shared/facts.js';
import { icon } from '../shared/icons.js';

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
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gb = (bytes) => (Number.isFinite(bytes) ? (bytes / 1024 ** 3).toFixed(1) + ' GB' : '未知');
const clock = (iso) => new Date(iso).toISOString().slice(11, 16);
const money = (n) => Number(n).toLocaleString('en-US');

const state = {
  surface: 'home',
  advancedOpen: false,
  device: null,
  task: null,
  action: null,
  ask: 'confirmed',
};

const city = DEMO.city;
const rooms = DEMO.rooms;
const node = city.nodes[0];
const online = true;

/* ------------------------------------------------------------------ chrome */

function renderSwitch() {
  const host = document.getElementById('switch');
  host.replaceChildren(
    ...PRIMARY_SURFACES.map((s) =>
      el('a', {
        href: `#${s.id}`,
        class: s.id === state.surface ? 'switch-item is-current' : 'switch-item',
        dataset: { surface: s.id },
        html: `${icon(s.id === 'ask' ? 'ask' : s.id)}<span>${esc(s.label)}</span>`,
      }),
    ),
  );
  const menu = document.getElementById('more-menu');
  menu.hidden = !state.advancedOpen;
  document.getElementById('more').setAttribute('aria-expanded', String(state.advancedOpen));
  menu.replaceChildren(
    ...ADVANCED_SURFACES.map((s) =>
      el('a', {
        href: `#${s.id}`,
        class: s.id === state.surface ? 'menu-item is-current' : 'menu-item',
        dataset: { surface: s.id },
        text: `${s.label} · ${s.zh}`,
      }),
    ),
  );
}

/* -------------------------------------------------------------- primitives */

function line(label, value, opts = {}) {
  return el('div', { class: opts.class ? `fact ${opts.class}` : 'fact' }, [
    el('dt', { text: label }),
    el('dd', {}, value),
  ]);
}

function technical(summary, payload) {
  return el('details', { class: 'technical' }, [
    el('summary', { text: summary }),
    el('pre', { text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }),
  ]);
}

function badge(kind, text) {
  return el('span', { class: `badge badge-${kind}`, text });
}

/* -------------------------------------------------------------- surfaces */

function home() {
  const running = city.tasks.filter((t) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.state));
  const failed = city.tasks.filter((t) => t.state === 'FAILED');
  const headline = failed.length
    ? `有 ${failed.length} 件事没做成，需要你看一眼。`
    : running.length
      ? `现在有 ${running.length} 件事在做，${city.nodes.filter((n) => n.online).length} 台设备在线。`
      : `一切安静。${city.nodes.filter((n) => n.online).length} 台设备在线，${rooms.count} 个工具随时可用。`;

  return el('section', { class: 'scene', dataset: { surface: 'home' } }, [
    el('p', { class: 'kicker', text: `${clock(city.updatedAt)} · 刚刚同步` }),
    el('h1', { class: 'display', text: headline }),
    el('p', { class: 'lede', text: '这里是你的城市。下面是你现在真正需要知道的三件事。' }),

    el('dl', { class: 'facts' }, [
      line('设备', `${node.displayName} · ${online ? '在线' : '离线'}`, {}),
      line('算力', `CPU ${node.telemetry.cpu.usagePercent}% · 内存 ${gb(node.telemetry.memory.usedBytes)} / ${gb(node.telemetry.memory.totalBytes)}`),
      line('工具', `${rooms.count} 个本地房间已就绪`),
      line('进行中', running.length ? running.map((t) => t.type).join('、') : '没有'),
    ]),

    el('div', { class: 'actions' }, [
      el('a', { class: 'text-link', href: '#ask', text: '直接用说的 →' }),
      el('a', { class: 'text-link', href: '#tools', text: `打开工具（${rooms.count}）→` }),
      el('a', { class: 'text-link', href: '#devices', text: '查看设备 →' }),
    ]),

    el('h2', { class: 'sub', text: '最近发生' }),
    el('ol', { class: 'rail' }, city.events.slice(0, 4).map((e) =>
      el('li', {}, [
        el('span', { class: 'rail-time', text: clock(e.timestamp) }),
        el('span', { class: 'rail-text', text: readable(e.type) }),
        technical('运行详情', { seq: e.seq, type: e.type, taskId: e.taskId, nodeId: e.payload?.nodeId ?? null }),
      ]),
    )),

    el('div', { class: 'disclosure' }, [
      technical('连接与协议详情', {
        cityId: city.cityId,
        apiVersion: 0,
        schemaVersion: 0,
        endpoint: city.descriptor.endpoint,
      }),
    ]),
  ]);
}

function readable(type) {
  return ({
    'task.completed': '一个任务完成了',
    'task.progress': '一个任务正在推进',
    'node.heartbeat': '设备发来一次心跳',
  })[type] ?? type;
}

function ask() {
  const a = DEMO.ask;
  const stage = state.ask;
  const blocks = {
    confirmed: () => [
      el('p', { class: 'said', text: a.confirmed.requestedIntent }),
      el('p', { class: 'reply' }, [
        '我把它交给 ',
        el('strong', { text: a.confirmed.target.label }),
        ' 去做了。',
      ]),
      el('div', { class: 'result' }, [
        el('span', { class: 'result-mark', html: icon('check') }),
        el('span', { text: a.confirmed.summary }),
      ]),
      technical('运行详情', a.confirmed),
    ],
    needsChoice: () => [
      el('p', { class: 'said', text: a.needsChoice.requestedIntent }),
      el('p', { class: 'reply', text: '这件事会真的改动东西，所以先问你一句。' }),
      el('div', { class: 'choose' }, [
        el('button', { class: 'primary', text: `确认，交给 ${a.needsChoice.target.label}`, onclick: () => setAsk('confirmed') }),
        el('button', { class: 'quiet', text: '算了', onclick: () => setAsk('confirmed') }),
      ]),
      el('p', { class: 'note', text: a.needsChoice.reason }),
      technical('运行详情', a.needsChoice),
    ],
    ambiguous: () => [
      el('p', { class: 'said', text: a.ambiguous.requestedIntent }),
      el('p', { class: 'reply', text: '你指的是哪一个？' }),
      el('div', { class: 'choose stacked' }, a.ambiguous.candidates.map((c) =>
        el('button', { class: 'choice', onclick: () => setAsk('confirmed') }, [
          el('span', { html: icon('room') }),
          el('span', { text: c.label }),
        ]),
      )),
      technical('运行详情', a.ambiguous),
    ],
    unmatched: () => [
      el('p', { class: 'said', text: a.unmatched.requestedIntent }),
      el('p', { class: 'reply', text: '没听懂。你可以直接挑一个。' }),
      el('p', { class: 'note', text: a.unmatched.reason }),
      el('div', { class: 'choose stacked' }, a.unmatched.targets.map((c) =>
        el('button', { class: 'choice', onclick: () => setAsk('confirmed') }, [
          el('span', { html: icon('room') }),
          el('span', { text: c.label }),
        ]),
      )),
      technical('运行详情', a.unmatched),
    ],
    working: () => [
      el('p', { class: 'said', text: a.working.text }),
      el('p', { class: 'reply working', text: '正在执行…' }),
    ],
  };

  return el('section', { class: 'scene', dataset: { surface: 'ask' } }, [
    el('p', { class: 'kicker', text: '对话 · 执行' }),
    el('h1', { class: 'display', text: '说一句，就够了。' }),
    el('p', { class: 'lede', text: '没有模型在猜你的意思。路由器按固定规则决定交给谁。' }),
    el('div', { class: 'conversation' }, blocks[stage]()),
    el('div', { class: 'stage-switch' },
      ['confirmed', 'needsChoice', 'ambiguous', 'unmatched', 'working'].map((k) =>
        el('button', {
          class: k === stage ? 'chip is-on' : 'chip',
          text: { confirmed: '已完成', needsChoice: '需要确认', ambiguous: '有歧义', unmatched: '没匹配', working: '进行中' }[k],
          onclick: () => setAsk(k),
        }),
      ),
    ),
  ]);
}

function tools() {
  return el('section', { class: 'scene', dataset: { surface: 'tools' } }, [
    el('p', { class: 'kicker', text: `本地房间 · ${rooms.count} 个` }),
    el('h1', { class: 'display', text: '你的工具，都在这台机器上。' }),
    el('p', { class: 'lede', text: rooms.available ? '房间服务正在本机运行。' : `房间服务暂时不可用：${rooms.reason}` }),
    el('ul', { class: 'room-list' }, rooms.rooms.map((r) =>
      el('li', { class: 'room-row' }, [
        el('span', { class: 'room-mark', html: icon('room') }),
        el('span', { class: 'room-body' }, [
          el('a', { class: 'room-name', href: `#tools`, text: r.label }),
          el('span', { class: 'room-zh', text: r.zh }),
          el('span', { class: 'room-summary', text: r.summary }),
        ]),
        r.persistent ? el('span', { class: 'room-flag', text: '会保存' }) : el('span', { class: 'room-flag quiet', text: '不留痕' }),
        el('button', { class: 'room-open', text: '打开', onclick: () => {} }),
      ]),
    )),
    el('p', { class: 'note', text: '房间只监听本机回环地址，因此只有这台机器上的浏览器能打开它们。' }),
    el('div', { class: 'disclosure' }, [
      technical('房间服务详情', {
        hubUrl: rooms.hubUrl, checkedAt: rooms.checkedAt, product: rooms.product, version: rooms.version,
        rooms: rooms.rooms.map((r) => ({ id: r.id, number: r.number, lifecycle: r.lifecycle, tags: r.tags })),
      }),
    ]),
  ]);
}

function devices() {
  return el('section', { class: 'scene', dataset: { surface: 'devices' } }, [
    el('p', { class: 'kicker', text: '设备' }),
    el('h1', { class: 'display', text: '干活的地方。' }),
    el('p', { class: 'lede', text: '同一份状态在每台设备上看到的是同一个事实。' }),
    el('div', { class: 'device' }, [
      el('div', { class: 'device-head' }, [
        el('h2', { class: 'device-name', text: node.displayName }),
        badge(node.online ? 'ok' : 'muted', node.online ? '在线' : '离线'),
      ]),
      el('dl', { class: 'facts' }, [
        line('处理器', `${node.telemetry.cpu.usagePercent}%`),
        line('内存', `${gb(node.telemetry.memory.usedBytes)} / ${gb(node.telemetry.memory.totalBytes)}`),
        line('磁盘', `${gb(node.telemetry.disk.usedBytes)} / ${gb(node.telemetry.disk.totalBytes)}`),
        line('已开机', `${Math.floor(node.telemetry.uptimeSeconds / 3600)} 小时`),
        line('能做什么', node.capabilities.map(friendlyCap).join('・')),
      ]),
      el('p', { class: 'note', text: '遥测每 10 秒内视为实时，超过后标注为缓存值。' }),
      technical('设备详情', {
        nodeId: node.id, platform: node.metadata.platform, agentVersion: node.agentVersion,
        lastHeartbeatAt: node.lastHeartbeatAt, telemetryObservedAt: node.telemetry.observedAt,
        capabilities: node.capabilities,
      }),
      el('h3', { class: 'sub', text: '这台设备上的任务' }),
      el('ul', { class: 'plain-list' }, city.tasks.map((t) =>
        el('li', {}, [
          el('a', { class: 'text-link', href: '#tasks', text: t.type }),
          el('span', { class: 'muted-text', text: t.state === 'RUNNING' ? `进行中 ${t.progress}%` : t.state === 'COMPLETED' ? '已完成' : t.state }),
        ]),
      )),
    ]),
  ]);
}

function friendlyCap(cap) {
  return ({ 'task.execute.safe': '安全执行任务', 'filesystem.temp': '临时文件读写' })[cap] ?? cap;
}

function activity() {
  return el('section', { class: 'scene', dataset: { surface: 'activity' } }, [
    el('p', { class: 'kicker', text: '动态' }),
    el('h1', { class: 'display', text: '城市里发生过什么。' }),
    el('ol', { class: 'rail wide' }, city.events.map((e) =>
      el('li', {}, [
        el('span', { class: 'rail-time', text: clock(e.timestamp) }),
        el('span', { class: 'rail-text', text: readable(e.type) }),
        el('a', { class: 'text-link small-link', href: '#actions', text: '相关操作 →' }),
        technical('运行详情', e),
      ]),
    )),
  ]);
}

function services() {
  return el('section', { class: 'scene advanced-scene', dataset: { surface: 'services' } }, [
    el('p', { class: 'kicker', text: '高级 · 能力服务' }),
    el('h1', { class: 'title', text: '城市能力' }),
    el('ul', { class: 'plain-list' }, city.capabilities.map((c) =>
      el('li', {}, [
        el('span', { class: 'cap-name', text: c.capabilityId }),
        badge(c.bridgeState === 'READY' ? 'ok' : 'muted', c.bridgeState),
        el('span', { class: 'muted-text', text: c.cityLifecycle }),
        el('button', { class: 'quiet small', text: '调用', onclick: () => {} }),
      ]),
    )),
    el('h2', { class: 'sub', text: '调用历史' }),
    el('ul', { class: 'plain-list' }, city.invocations.map((i) =>
      el('li', {}, [
        el('span', { text: i.capabilityId }),
        badge(i.status === 'COMPLETED' ? 'ok' : 'warn', i.status),
        technical('运行详情', i),
      ]),
    )),
  ]);
}

function tasks() {
  return el('section', { class: 'scene advanced-scene', dataset: { surface: 'tasks' } }, [
    el('p', { class: 'kicker', text: '高级 · 任务' }),
    el('h1', { class: 'title', text: '任务' }),
    el('button', { class: 'quiet', text: '运行一个演示任务', onclick: () => {} }),
    el('ul', { class: 'plain-list' }, city.tasks.map((t) =>
      el('li', {}, [
        el('span', { class: 'cap-name', text: t.type }),
        badge(t.state === 'COMPLETED' ? 'ok' : t.state === 'RUNNING' ? 'warn' : 'muted', t.state),
        el('span', { class: 'muted-text', text: `${t.progress}%` }),
        el('button', { class: 'quiet small', text: '取消', onclick: () => {} }),
        technical('检查点与结果', { lastCheckpoint: t.lastCheckpoint, result: t.result, error: t.error, taskId: t.id }),
      ]),
    )),
  ]);
}

function actions() {
  return el('section', { class: 'scene advanced-scene', dataset: { surface: 'actions' } }, [
    el('p', { class: 'kicker', text: '高级 · 操作记录' }),
    el('h1', { class: 'title', text: '操作记录' }),
    el('div', { class: 'stage-switch' }, [25, 50, 100].map((n) => el('button', { class: 'chip', text: String(n) }))),
    el('ul', { class: 'plain-list' }, [DEMO.ask.confirmed].map((x) =>
      el('li', {}, [
        el('span', { class: 'cap-name', text: x.requestedIntent }),
        badge('ok', x.status),
        el('span', { class: 'muted-text', text: `${x.route} · ${x.target.label}` }),
        technical('操作详情', { actionId: x.actionId, route: x.route, target: x.target, operation: x.operation, backendRef: null, resultRef: null, provenance: [] }),
      ]),
    )),
  ]);
}

function pairing() {
  return el('section', { class: 'scene advanced-scene', dataset: { surface: 'pairing' } }, [
    el('p', { class: 'kicker', text: '高级 · 配对' }),
    el('h1', { class: 'title', text: '把一台新设备带进来。' }),
    el('button', { class: 'primary', text: '生成配对码', onclick: () => {} }),
    el('dl', { class: 'facts' }, [
      line('配对码', '—— 未生成 ——'),
      line('地址', `${city.descriptor.endpoint.host}:${city.descriptor.endpoint.port}`),
      line('发现', `mDNS ${city.discovery.mdns.state} · 蓝牙 ${city.discovery.ble.state}`),
    ]),
    el('p', { class: 'note warn', text: '仅限局域网开发使用，不要暴露到公网。' }),
    technical('配对与协议详情', { cityId: city.cityId, pairingSessionId: city.descriptor.pairingSessionId, discovery: city.discovery, apiVersion: 0, schemaVersion: 0 }),
  ]);
}

function settings() {
  return el('section', { class: 'scene advanced-scene', dataset: { surface: 'settings' } }, [
    el('p', { class: 'kicker', text: '高级 · 设置' }),
    el('h1', { class: 'title', text: '设置' }),
    el('h2', { class: 'sub', text: '界面语言' }),
    el('div', { class: 'stage-switch' }, ['English', '简体中文'].map((n, i) =>
      el('button', { class: i === 0 ? 'chip is-on' : 'chip', text: n }),
    )),
    el('h2', { class: 'sub', text: '连接' }),
    el('p', { class: 'muted-text', text: '当前会话使用一次性配对令牌。更换令牌会断开连接。' }),
    el('button', { class: 'quiet', text: '更换令牌', onclick: () => {} }),
    technical('协议详情', { apiVersion: 0, schemaVersion: 0, origin: 'http://127.0.0.1:4310' }),
  ]);
}

const RENDERERS = { home, ask, tools, devices, activity, services, tasks, actions, pairing, settings };

/* ------------------------------------------------------------------- wiring */

function setAsk(k) { state.ask = k; render(); }

function render() {
  const root = document.getElementById('root');
  root.replaceChildren(RENDERERS[state.surface]());
  root.dataset.surface = state.surface;
  document.body.dataset.surface = state.surface;
  renderSwitch();
  document.title = `Utopia · ${SURFACES.find((s) => s.id === state.surface)?.label ?? ''}`;
}

function go(surface) {
  if (!RENDERERS[surface]) surface = 'home';
  state.surface = surface;
  state.advancedOpen = ADVANCED_SURFACES.some((s) => s.id === surface);
  render();
}

document.getElementById('more').addEventListener('click', () => { state.advancedOpen = !state.advancedOpen; renderSwitch(); });
document.getElementById('omnibox').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('omni-input');
  if (!input.value.trim()) return;
  state.ask = 'confirmed';
  go('ask');
});
window.addEventListener('hashchange', () => go(location.hash.replace(/^#/, '') || 'home'));

/* deterministic hook for the screenshot harness and the parity test */
window.__ui000 = {
  candidate: 'a',
  go,
  setAsk,
  surfaces: SURFACES.map((s) => s.id),
  get surface() { return state.surface; },
  /* Opening every disclosure is how a reviewer reads the demoted values.
     Used by scripts/ui-000/parity.mjs to prove they are still reachable. */
  revealAll: () => { document.querySelectorAll('#root details').forEach((d) => { d.open = true; }); },
};

go(location.hash.replace(/^#/, '') || 'home');
