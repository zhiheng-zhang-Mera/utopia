/**
 * UTOPIA · Rooms — hub shell.
 *
 * Responsibilities: render the room navigation, load one room module at a time
 * from /rooms/<id>/client.mjs and unmount it cleanly when the user switches.
 * All product behaviour lives in the room modules.
 */

const kit = globalThis.RoomsKit;

const dom = {
  nav: document.getElementById('nav'),
  status: document.getElementById('hub-status'),
  number: document.getElementById('room-number'),
  title: document.getElementById('room-title'),
  summary: document.getElementById('room-summary'),
  data: document.getElementById('room-data'),
  root: document.getElementById('room-root'),
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
  dom.data.textContent = room.persistent ? `persistent · .runtime/${room.id}.json` : 'no persistence';
  dom.root.textContent = '';
  dom.root.append(kit.el('p', { class: 'muted', text: 'Loading room…' }));

  const token = ++state.bootToken;
  try {
    const module = await import(`/rooms/${room.id}/client.mjs`);
    if (token !== state.bootToken) return;
    dom.root.textContent = '';
    const result = await module.mount(dom.root, kit.createRoomApi(room.id), kit);
    if (token !== state.bootToken) return;
    if (typeof result === 'function') state.teardown = result;
    setStatus(`local · ready · ${room.label}`);
  } catch (error) {
    if (token !== state.bootToken) return;
    dom.root.textContent = '';
    dom.root.append(
      kit.el('div', { class: 'banner error' }, [
        kit.el('strong', { text: `${room.label} failed to load` }),
        kit.el('p', { text: String(error?.message ?? error) }),
      ]),
    );
    setStatus(`error · ${room.label}`, 'error');
  }
}

async function boot() {
  try {
    const health = await (await fetch('/health')).json();
    const payload = await (await fetch('/local-rooms/v1/rooms')).json();
    state.rooms = payload.rooms;
    setStatus(`local · ready · v${health.version} · ${payload.rooms.length} rooms`);
  } catch (error) {
    setStatus(`hub unreachable · ${error.message}`, 'error');
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
