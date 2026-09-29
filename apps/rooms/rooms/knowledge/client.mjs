/**
 * UTOPIA · Rooms · Room 01 — Knowledge Room (client).
 * Local knowledge entries with search, tag filter, editor, export and import.
 */

let kit;
let api;

const state = {
  entries: [],
  tags: [],
  activeTags: [],
  query: '',
  selectedId: null,
  draftMode: null,
};

let dom = {};

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const search = kit.el('input', { type: 'search', placeholder: 'Search title, body, tags…', id: 'kr-q' });
  const tagRow = kit.el('div', { class: 'tags', id: 'kr-tags' });
  const list = kit.el('ul', { class: 'item-list', id: 'kr-list' });
  const stateLine = kit.el('p', { class: 'feedback', id: 'kr-state' });
  const empty = kit.el('p', { class: 'empty hidden', id: 'kr-empty' });
  const newButton = kit.el('button', { class: 'primary', type: 'button', text: '＋ New entry', id: 'kr-new' });
  const count = kit.el('p', { class: 'muted small', id: 'kr-count', text: '0 entries' });

  const titleInput = kit.el('input', { type: 'text', id: 'kr-title', maxlength: '200' });
  const bodyInput = kit.el('textarea', { id: 'kr-body', rows: '12' });
  const tagsInput = kit.el('input', { type: 'text', id: 'kr-tags-input', placeholder: 'research, utopia' });
  const feedback = kit.el('p', { class: 'feedback', id: 'kr-feedback' });
  const save = kit.el('button', { class: 'primary', type: 'submit', text: 'Save', id: 'kr-save' });
  const remove = kit.el('button', { class: 'danger hidden', type: 'button', text: 'Delete', id: 'kr-delete' });
  const cancel = kit.el('button', { class: 'ghost hidden', type: 'button', text: 'Cancel', id: 'kr-cancel' });
  const editorMeta = kit.el('p', { class: 'muted small', id: 'kr-meta', text: '' });
  const editorMode = kit.el('p', { class: 'eyebrow', id: 'kr-mode', text: 'EDIT ENTRY' });

  const form = kit.el('form', { class: 'stack', id: 'kr-form' }, [
    editorMode,
    editorMeta,
    kit.el('label', { for: 'kr-title', text: 'Title' }),
    titleInput,
    kit.el('label', { for: 'kr-body', text: 'Body' }),
    bodyInput,
    kit.el('label', { for: 'kr-tags-input', text: 'Tags (comma separated)' }),
    tagsInput,
    feedback,
    kit.el('div', { class: 'row' }, [save, remove, cancel]),
  ]);

  const exportButton = kit.el('button', { type: 'button', text: 'Export JSON', id: 'kr-export' });
  const importTrigger = kit.el('button', { type: 'button', text: 'Import JSON (replace)', id: 'kr-import-trigger' });
  const importFile = kit.el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden', id: 'kr-import-file' });
  const dataFeedback = kit.el('p', { class: 'feedback', id: 'kr-data-feedback' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('div', { class: 'row between' }, [
      kit.el('div', {}, [kit.el('h2', { class: 'pane-title', text: 'Knowledge Room' }), count]),
      newButton,
    ]),
    search,
    kit.el('p', { class: 'muted small', text: 'Tag filter' }),
    tagRow,
    stateLine,
    empty,
    list,
    kit.el('div', { class: 'row', style: 'margin-top:12px' }, [exportButton, importTrigger, importFile]),
    dataFeedback,
  ]);

  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Entry editor' }),
    kit.el('p', { class: 'muted small', id: 'kr-editor-hint', text: 'Select an entry, or create a new one.' }),
    form,
  ]);

  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));

  dom = { search, tagRow, list, stateLine, empty, count, form, titleInput, bodyInput, tagsInput, feedback, save, remove, cancel, editorMeta, editorMode, dataFeedback, importFile, hint: right.querySelector('#kr-editor-hint') };

  closeEditor();
  await refresh();

  let timer = null;
  search.addEventListener('input', () => {
    state.query = search.value.trim();
    clearTimeout(timer);
    timer = setTimeout(refresh, 120);
  });
  newButton.addEventListener('click', openNew);
  form.addEventListener('submit', saveEditor);
  remove.addEventListener('click', deleteSelected);
  cancel.addEventListener('click', closeEditor);
  exportButton.addEventListener('click', exportBundle);
  importTrigger.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => importBundle(importFile.files?.[0]));

  return () => clearTimeout(timer);
}

function visibleEntries() {
  if (state.activeTags.length === 0) return state.entries;
  return state.entries.filter((entry) => state.activeTags.every((tag) => entry.tags.includes(tag)));
}

async function refresh() {
  try {
    const params = new URLSearchParams();
    if (state.query) params.set('q', state.query);
    const payload = await api.get(`/entries${params.toString() ? `?${params}` : ''}`);
    state.entries = payload.entries ?? [];
    const tagCounts = new Map();
    for (const entry of state.entries) {
      for (const tag of entry.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
    state.tags = [...tagCounts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    render();
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

function render() {
  const visible = visibleEntries();
  dom.count.textContent = `${state.entries.length} ${state.entries.length === 1 ? 'entry' : 'entries'}`;

  dom.tagRow.textContent = '';
  if (state.tags.length === 0) {
    dom.tagRow.append(kit.el('span', { class: 'muted small', text: 'no tags yet' }));
  } else {
    for (const [tag, n] of state.tags) {
      dom.tagRow.append(
        kit.el('button', {
          type: 'button',
          class: 'tag-button',
          text: `${tag} (${n})`,
          dataset: { active: String(state.activeTags.includes(tag)) },
          onclick: () => {
            state.activeTags = state.activeTags.includes(tag)
              ? state.activeTags.filter((value) => value !== tag)
              : [...state.activeTags, tag];
            render();
          },
        }),
      );
    }
    if (state.activeTags.length > 0) {
      dom.tagRow.append(
        kit.el('button', {
          type: 'button',
          class: 'tag-button',
          text: 'clear tags',
          onclick: () => {
            state.activeTags = [];
            render();
          },
        }),
      );
    }
  }

  dom.list.textContent = '';
  for (const entry of visible) {
    const card = kit.el('li', {
      class: 'item',
      id: `kr-entry-${entry.id}`,
      dataset: { selected: String(entry.id === state.selectedId) },
      onclick: () => openEditor(entry),
    }, [
      kit.el('h3', { text: entry.title }),
      kit.el('p', { class: 'muted small', text: `updated ${kit.formatWhen(entry.updatedAt)}` }),
      kit.el('div', { class: 'tags' }, entry.tags.length
        ? entry.tags.map((tag) => kit.el('span', { class: 'tag', text: tag }))
        : [kit.el('span', { class: 'muted small', text: 'no tags' })]),
      kit.el('p', { class: 'preview', text: kit.preview(entry.body) }),
    ]);
    dom.list.append(card);
  }

  const filtered = Boolean(state.query) || state.activeTags.length > 0;
  dom.stateLine.textContent = filtered
    ? `${visible.length} match(es)${state.query ? ` for “${state.query}”` : ''}${state.activeTags.length ? ` · tags: ${state.activeTags.join(' + ')}` : ''}`
    : '';
  dom.empty.classList.toggle('hidden', visible.length > 0);
  dom.empty.textContent = filtered
    ? 'No entry matches the current search or tag filter.'
    : 'The room is empty. Create your first entry.';
}

function openEditor(entry) {
  state.selectedId = entry.id;
  state.draftMode = 'edit';
  dom.form.classList.remove('hidden');
  dom.hint.classList.add('hidden');
  dom.editorMode.textContent = 'EDIT ENTRY';
  dom.editorMeta.textContent = `created ${kit.formatWhen(entry.createdAt)} · updated ${kit.formatWhen(entry.updatedAt)}`;
  dom.titleInput.value = entry.title;
  dom.bodyInput.value = entry.body;
  dom.tagsInput.value = entry.tags.join(', ');
  dom.remove.classList.remove('hidden');
  dom.cancel.classList.add('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
  dom.titleInput.focus();
}

function openNew() {
  state.selectedId = null;
  state.draftMode = 'create';
  dom.form.classList.remove('hidden');
  dom.hint.classList.add('hidden');
  dom.editorMode.textContent = 'NEW ENTRY';
  dom.editorMeta.textContent = 'not saved yet';
  dom.titleInput.value = '';
  dom.bodyInput.value = '';
  dom.tagsInput.value = state.activeTags.join(', ');
  dom.remove.classList.add('hidden');
  dom.cancel.classList.remove('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
  dom.titleInput.focus();
}

function closeEditor() {
  state.selectedId = null;
  state.draftMode = null;
  dom.form.classList.add('hidden');
  dom.hint.classList.remove('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
}

async function saveEditor(event) {
  event.preventDefault();
  const payload = {
    title: dom.titleInput.value.trim(),
    body: dom.bodyInput.value,
    tags: kit.parseTagsInput(dom.tagsInput.value),
  };
  if (!payload.title) {
    kit.createFeedback(dom.feedback).set('title must not be empty', 'error');
    dom.titleInput.focus();
    return;
  }
  dom.save.disabled = true;
  const feedback = kit.createFeedback(dom.feedback);
  try {
    if (state.draftMode === 'create') {
      const created = await api.post('/entries', payload);
      await refresh();
      openEditor(created.entry);
      feedback.set('saved');
    } else if (state.selectedId) {
      const updated = await api.patch(`/entries/${encodeURIComponent(state.selectedId)}`, payload);
      await refresh();
      openEditor(updated.entry);
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
  const entry = state.entries.find((item) => item.id === state.selectedId);
  if (!window.confirm(`Delete “${entry?.title ?? 'this entry'}”? This cannot be undone.`)) return;
  try {
    await api.del(`/entries/${encodeURIComponent(state.selectedId)}`);
    closeEditor();
    await refresh();
    kit.createFeedback(dom.dataFeedback).set('entry deleted');
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

async function exportBundle() {
  try {
    const bundle = await api.get('/export');
    const text = `${JSON.stringify(bundle, null, 2)}\n`;
    const digest = await kit.sha256Hex(text);
    kit.downloadText(`knowledge-room-${new Date().toISOString().slice(0, 10)}.json`, text);
    kit.createFeedback(dom.dataFeedback).set(
      `exported ${bundle.entries.length} entr(ies)${digest ? ` · sha256 ${digest.slice(0, 16)}…` : ''}`,
    );
  } catch (error) {
    kit.createFeedback(dom.dataFeedback).error(error);
  }
}

async function importBundle(file) {
  if (!file) return;
  if (!window.confirm('Import replaces ALL current knowledge entries with the bundle contents.\n\nContinue?')) {
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
    state.activeTags = [];
    state.query = '';
    dom.search.value = '';
    closeEditor();
    await refresh();
    kit.createFeedback(dom.dataFeedback).set(`imported ${payload.imported} entr(ies) · current data replaced`);
  } catch (error) {
    kit.createFeedback(dom.dataFeedback).error(error);
  } finally {
    dom.importFile.value = '';
  }
}
