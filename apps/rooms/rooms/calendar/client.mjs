/**
 * UTOPIA · Rooms · Room 09 — Calendar Room (client).
 * Local dated events with today / upcoming views, editor, edit and delete.
 */

let kit;
let api;

const state = { events: [], selectedId: null, draftMode: null, scope: 'all', query: '' };
let dom = {};

function todayKey() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const scopeRow = kit.el('div', { class: 'row', id: 'cal-scope' });
  const search = kit.el('input', { type: 'search', placeholder: 'Search title, note, label…', id: 'cal-q' });
  const list = kit.el('ul', { class: 'item-list', id: 'cal-list' });
  const empty = kit.el('p', { class: 'empty hidden', id: 'cal-empty' });
  const count = kit.el('p', { class: 'muted small', text: '0 events' });
  const newButton = kit.el('button', { class: 'primary', type: 'button', text: '＋ New event', id: 'cal-new' });

  const title = kit.el('input', { type: 'text', id: 'cal-title' });
  const date = kit.el('input', { type: 'date', id: 'cal-date' });
  const startTime = kit.el('input', { type: 'time', id: 'cal-start' });
  const endTime = kit.el('input', { type: 'time', id: 'cal-end' });
  const label = kit.el('input', { type: 'text', id: 'cal-label', placeholder: 'work, study, personal' });
  const note = kit.el('textarea', { id: 'cal-note', rows: '5' });
  const feedback = kit.el('p', { class: 'feedback', id: 'cal-feedback' });
  const save = kit.el('button', { class: 'primary', type: 'submit', text: 'Save', id: 'cal-save' });
  const remove = kit.el('button', { class: 'danger hidden', type: 'button', text: 'Delete', id: 'cal-delete' });
  const cancel = kit.el('button', { class: 'ghost hidden', type: 'button', text: 'Cancel', id: 'cal-cancel' });
  const mode = kit.el('p', { class: 'eyebrow', id: 'cal-mode', text: 'EDIT EVENT' });

  const form = kit.el('form', { class: 'stack' }, [
    mode,
    kit.el('label', { for: 'cal-title', text: 'Title' }),
    title,
    kit.el('label', { for: 'cal-date', text: 'Date' }),
    date,
    kit.el('div', { class: 'row' }, [
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'cal-start', text: 'Start time' }), startTime]),
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'cal-end', text: 'End time' }), endTime]),
    ]),
    kit.el('label', { for: 'cal-label', text: 'Label' }),
    label,
    kit.el('label', { for: 'cal-note', text: 'Note' }),
    note,
    feedback,
    kit.el('div', { class: 'row' }, [save, remove, cancel]),
  ]);

  const exportButton = kit.el('button', { type: 'button', text: 'Export JSON', id: 'cal-export' });
  const importFile = kit.el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden', id: 'cal-import-file' });
  const importTrigger = kit.el('button', { type: 'button', text: 'Import JSON (replace)', id: 'cal-import-trigger' });
  const dataFeedback = kit.el('p', { class: 'feedback', id: 'cal-data-feedback' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('div', { class: 'row between' }, [
      kit.el('div', {}, [kit.el('h2', { class: 'pane-title', text: 'Calendar Room' }), count]),
      newButton,
    ]),
    scopeRow,
    search,
    empty,
    list,
    kit.el('div', { class: 'row', style: 'margin-top:12px' }, [exportButton, importTrigger, importFile]),
    dataFeedback,
  ]);
  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Event editor' }),
    kit.el('p', { class: 'muted small', id: 'cal-hint', text: 'Select an event, or create a new one. This room never sends reminders.' }),
    form,
  ]);
  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));

  dom = { scopeRow, search, list, empty, count, form, title, date, startTime, endTime, label, note, feedback, save, remove, cancel, mode, dataFeedback, importFile, hint: right.querySelector('#cal-hint') };

  renderScopes();
  closeEditor();
  await refresh();

  let timer = null;
  search.addEventListener('input', () => {
    state.query = search.value.trim();
    clearTimeout(timer);
    timer = setTimeout(refresh, 120);
  });
  newButton.addEventListener('click', openNew);
  form.addEventListener('submit', saveEvent);
  remove.addEventListener('click', deleteSelected);
  cancel.addEventListener('click', closeEditor);
  exportButton.addEventListener('click', exportBundle);
  importTrigger.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => importBundle(importFile.files?.[0]));

  return () => clearTimeout(timer);
}

function renderScopes() {
  dom.scopeRow.textContent = '';
  for (const [value, text] of [['all', 'All'], ['today', 'Today'], ['upcoming', 'Upcoming']]) {
    dom.scopeRow.append(
      kit.el('button', {
        type: 'button',
        class: state.scope === value ? 'primary' : '',
        id: `cal-scope-${value}`,
        text,
        onclick: () => {
          state.scope = value;
          renderScopes();
          refresh();
        },
      }),
    );
  }
}

async function refresh() {
  try {
    const params = new URLSearchParams();
    if (state.query) params.set('q', state.query);
    if (state.scope !== 'all') params.set('scope', state.scope);
    const payload = await api.get(`/events${params.toString() ? `?${params}` : ''}`);
    state.events = payload.events ?? [];
    state.todayCount = payload.today ?? 0;
    state.upcomingCount = payload.upcoming ?? 0;
    render();
    if (state.selectedId) {
      const still = state.events.find((item) => item.id === state.selectedId);
      if (still) openEditor(still);
      else closeEditor();
    }
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

function render() {
  const today = todayKey();
  dom.count.textContent = `${state.events.length} event(s) · ${state.todayCount ?? 0} today · ${state.upcomingCount ?? 0} upcoming`;
  dom.list.textContent = '';
  for (const event of state.events) {
    const when = `${event.date}${event.startTime ? ` ${event.startTime}` : ''}${event.endTime ? `–${event.endTime}` : ''}`;
    dom.list.append(
      kit.el('li', {
        class: 'item',
        id: `cal-${event.id}`,
        dataset: { selected: String(event.id === state.selectedId) },
        onclick: () => openEditor(event),
      }, [
        kit.el('div', { class: 'row between' }, [
          kit.el('h3', { text: event.title }),
          kit.el('span', { class: 'muted small', text: event.date === today ? 'today' : event.date < today ? 'past' : 'upcoming' }),
        ]),
        kit.el('p', { class: 'mono', text: when }),
        event.label ? kit.el('div', { class: 'tags' }, [kit.el('span', { class: 'tag', text: event.label })]) : null,
        event.note ? kit.el('p', { class: 'preview', text: kit.preview(event.note) }) : null,
      ]),
    );
  }
  dom.empty.classList.toggle('hidden', state.events.length > 0);
  dom.empty.textContent = state.events.length === 0
    ? state.scope === 'all'
      ? 'No events yet. Create your first local event.'
      : `No ${state.scope} events.`
    : 'No event matches the current search.';
}

function openEditor(event) {
  state.selectedId = event.id;
  state.draftMode = 'edit';
  dom.form.classList.remove('hidden');
  dom.hint.classList.add('hidden');
  dom.mode.textContent = 'EDIT EVENT';
  dom.title.value = event.title;
  dom.date.value = event.date;
  dom.startTime.value = event.startTime ?? '';
  dom.endTime.value = event.endTime ?? '';
  dom.label.value = event.label ?? '';
  dom.note.value = event.note ?? '';
  dom.remove.classList.remove('hidden');
  dom.cancel.classList.add('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
}

function openNew() {
  state.selectedId = null;
  state.draftMode = 'create';
  dom.form.classList.remove('hidden');
  dom.hint.classList.add('hidden');
  dom.mode.textContent = 'NEW EVENT';
  dom.title.value = '';
  dom.date.value = todayKey();
  dom.startTime.value = '';
  dom.endTime.value = '';
  dom.label.value = '';
  dom.note.value = '';
  dom.remove.classList.add('hidden');
  dom.cancel.classList.remove('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
  dom.title.focus();
}

function closeEditor() {
  state.selectedId = null;
  state.draftMode = null;
  dom.form.classList.add('hidden');
  dom.hint.classList.remove('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
}

async function saveEvent(submitEvent) {
  submitEvent.preventDefault();
  const payload = {
    title: dom.title.value.trim(),
    date: dom.date.value,
    startTime: dom.startTime.value || null,
    endTime: dom.endTime.value || null,
    label: dom.label.value.trim(),
    note: dom.note.value,
  };
  if (!payload.title) {
    kit.createFeedback(dom.feedback).set('title must not be empty', 'error');
    return;
  }
  if (!payload.date) {
    kit.createFeedback(dom.feedback).set('date is required', 'error');
    return;
  }
  dom.save.disabled = true;
  const feedback = kit.createFeedback(dom.feedback);
  try {
    if (state.draftMode === 'create') {
      const created = await api.post('/events', payload);
      await refresh();
      openEditor(created.event);
      feedback.set('saved');
    } else if (state.selectedId) {
      const updated = await api.patch(`/events/${encodeURIComponent(state.selectedId)}`, payload);
      await refresh();
      openEditor(updated.event);
      feedback.set('saved');
    }
  } catch (error) {
    feedback.error(error);
  } finally {
    dom.save.disabled = false;
  }
}

async function deleteSelected() {
  if (!state.selectedId) return;
  const event = state.events.find((item) => item.id === state.selectedId);
  if (!window.confirm(`Delete “${event?.title ?? 'this event'}”?`)) return;
  try {
    await api.del(`/events/${encodeURIComponent(state.selectedId)}`);
    closeEditor();
    await refresh();
    kit.createFeedback(dom.dataFeedback).set('event deleted');
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

async function exportBundle() {
  try {
    const bundle = await api.get('/export');
    kit.downloadText(`calendar-${todayKey()}.json`, `${JSON.stringify(bundle, null, 2)}\n`);
    kit.createFeedback(dom.dataFeedback).set(`exported ${bundle.events.length} event(s)`);
  } catch (error) {
    kit.createFeedback(dom.dataFeedback).error(error);
  }
}

async function importBundle(file) {
  if (!file) return;
  if (!window.confirm('Import replaces ALL current events with the bundle contents.\n\nContinue?')) {
    dom.importFile.value = '';
    return;
  }
  try {
    const text = await file.text();
    const response = await fetch(`${api.base}/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: text,
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload?.message ?? `import failed with ${response.status}`);
    closeEditor();
    await refresh();
    kit.createFeedback(dom.dataFeedback).set(`imported ${payload.imported} event(s) · current data replaced`);
  } catch (error) {
    kit.createFeedback(dom.dataFeedback).error(error);
  } finally {
    dom.importFile.value = '';
  }
}
