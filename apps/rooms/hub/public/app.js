/**
 * UTOPIA · Rooms — hub shell.
 *
 * Responsibilities: render the room navigation, load one room module at a time
 * from /rooms/<id>/client.mjs and unmount it cleanly when the user switches.
 * All product behaviour lives in the room modules.
 */

const kit = globalThis.RoomsKit;

/* UI-103: embedded mode drops the hub's own rail so the Utopia Web shell owns the
   chrome and the room reads as one product rather than two. The flag is set from an
   explicit query parameter in index.html, never sniffed. */
const EMBEDDED = new URLSearchParams(window.location.search).get('embedded') === '1';
if (EMBEDDED) document.body.dataset.embedded = 'true';

const dom = {
  nav: document.getElementById('nav'),
  status: document.getElementById('hub-status'),
  number: document.getElementById('room-number'),
  title: document.getElementById('room-title'),
  summary: document.getElementById('room-summary'),
  data: document.getElementById('room-data'),
  root: document.getElementById('room-root'),
  diagOrigin: document.getElementById('diag-origin'),
  diagRuntime: document.getElementById('diag-runtime'),
  diagProduct: document.getElementById('diag-product'),
};

const state = {
  rooms: [],
  currentId: null,
  teardown: null,
  bootToken: 0,
};

function setStatus(text, kind = 'ok') {
  dom.status.textContent = text;
  dom.status.dataset.kind = kind;
}

/**
 * Local/debug facts are diagnostics, not product copy (UI-103). They stay
 * discoverable in the rail's disclosure instead of sitting on the reading path.
 */
function setDiagnostics({ origin, runtime, product }) {
  if (origin !== undefined && dom.diagOrigin) dom.diagOrigin.textContent = origin;
  if (runtime !== undefined && dom.diagRuntime) dom.diagRuntime.textContent = runtime;
  if (product !== undefined && dom.diagProduct) dom.diagProduct.textContent = product;
}

function renderNav() {
  dom.nav.textContent = '';
  for (const room of state.rooms) {
    const button = kit.el('button', {
      type: 'button',
      class: 'nav-item',
      dataset: { room: room.id, active: String(room.id === state.currentId) },
      onclick: () => selectRoom(room.id),
    }, [
      kit.el('span', { class: 'nav-number', text: room.number }),
      kit.el('span', { class: 'nav-body' }, [
        kit.el('span', { class: 'nav-label', text: room.label }),
        kit.el('span', { class: 'nav-zh', text: room.zh }),
      ]),
    ]);
    dom.nav.append(button);
  }
}

async function selectRoom(roomId) {
  const room = state.rooms.find((item) => item.id === roomId);
  if (!room) return;
  if (state.currentId === roomId) return;

  if (typeof state.teardown === 'function') {
    try {
      state.teardown();
    } catch (error) {
      console.warn('room teardown failed', error);
    }
  }
  state.teardown = null;
  state.currentId = roomId;
  window.location.hash = `#/${roomId}`;
  renderNav();

  dom.number.textContent = `ROOM ${room.number}`;
  dom.title.textContent = room.label;
  dom.summary.textContent = room.summary;
  /* Product-level statement, not a runtime path: UI-103 forbids printing
     .runtime/<id>.json as default product information. The exact path stays in
     the rail's diagnostics disclosure. */
  dom.data.textContent = room.persistent ? '会保存在本机' : '不留痕';
  dom.root.textContent = '';
  dom.root.append(kit.el('p', { class: 'muted', text: '正在打开房间…' }));

  const token = ++state.bootToken;
  try {
    const module = await import(`/rooms/${room.id}/client.mjs`);
    if (token !== state.bootToken) return;
    dom.root.textContent = '';
    const result = await module.mount(dom.root, kit.createRoomApi(room.id), kit);
    if (token !== state.bootToken) return;
    if (typeof result === 'function') state.teardown = result;
    setStatus(`${room.label} · 已就绪`);
    setDiagnostics({ runtime: room.persistent ? `.runtime-rooms/${room.id}.json` : '不持久化' });
  } catch (error) {
    if (token !== state.bootToken) return;
    dom.root.textContent = '';
    dom.root.append(
      kit.el('div', { class: 'banner error' }, [
        kit.el('strong', { text: `${room.label} failed to load` }),
        kit.el('p', { text: String(error?.message ?? error) }),
      ]),
    );
    setStatus(`${room.label} · 载入失败`, 'error');
  }
}

async function boot() {
  try {
    const health = await (await fetch('/health')).json();
    const payload = await (await fetch('/local-rooms/v1/rooms')).json();
    state.rooms = payload.rooms;
    setStatus(`${payload.rooms.length} 个本地工具 · 已就绪`);
    setDiagnostics({
      origin: window.location.origin,
      product: `${health.product ?? 'utopia-room-pack'} ${health.version ?? ''}`.trim(),
    });
  } catch (error) {
    setStatus(`房间服务不可用 · ${error.message}`, 'error');
    dom.root.append(kit.el('div', { class: 'banner error', text: `Room Hub unavailable: ${error.message}` }));
    return;
  }

  const requested = window.location.hash.replace(/^#\/?/, '') || state.rooms[0].id;
  await selectRoom(state.rooms.some((room) => room.id === requested) ? requested : state.rooms[0].id);
}

window.addEventListener('hashchange', () => {
  const requested = window.location.hash.replace(/^#\/?/, '');
  const room = state.rooms.find((item) => item.id === requested);
  if (room && room.id !== state.currentId) selectRoom(room.id);
});

boot();
