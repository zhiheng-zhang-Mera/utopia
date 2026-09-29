/**
 * UTOPIA · Rooms · Room 02 — Bookmark Room (client).
 *
 * Bookmarks are opened only through an explicit click on the "Open link" action,
 * which uses a real anchor with rel="noopener noreferrer". Nothing is fetched or
 * previewed by this room.
 */

let kit;
let api;

const state = { bookmarks: [], tags: [], activeTags: [], query: '', selectedId: null, draftMode: null };
let dom = {};

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const search = kit.el('input', { type: 'search', placeholder: 'Search title, url, note…', id: 'bm-q' });
  const tagRow = kit.el('div', { class: 'tags', id: 'bm-tags' });
  const list = kit.el('ul', { class: 'item-list', id: 'bm-list' });
  const empty = kit.el('p', { class: 'empty hidden', id: 'bm-empty' });
  const count = kit.el('p', { class: 'muted small', id: 'bm-count', text: '0 bookmarks' });
  const newButton = kit.el('button', { class: 'primary', type: 'button', text: '＋ New bookmark', id: 'bm-new' });

  const title = kit.el('input', { type: 'text', id: 'bm-title' });
  const url = kit.el('input', { type: 'text', id: 'bm-url', placeholder: 'https://example.com/' });
  const note = kit.el('textarea', { id: 'bm-note', rows: '6' });
  const tags = kit.el('input', { type: 'text', id: 'bm-tags-input', placeholder: 'reading, tools' });
  const feedback = kit.el('p', { class: 'feedback', id: 'bm-feedback' });
  const save = kit.el('button', { class: 'primary', type: 'submit', text: 'Save', id: 'bm-save' });
  const open = kit.el('button', { type: 'button', text: 'Open link', id: 'bm-open' });
  const remove = kit.el('button', { class: 'danger hidden', type: 'button', text: 'Delete', id: 'bm-delete' });
  const cancel = kit.el('button', { class: 'ghost hidden', type: 'button', text: 'Cancel', id: 'bm-cancel' });
  const mode = kit.el('p', { class: 'eyebrow', id: 'bm-mode', text: 'EDIT BOOKMARK' });
  const openHint = kit.el('p', { class: 'muted small', text: 'Links open only when you press “Open link”. The room never fetches the page.' });

  const form = kit.el('form', { class: 'stack' }, [
    mode,
    kit.el('label', { for: 'bm-title', text: 'Title' }),
    title,
    kit.el('label', { for: 'bm-url', text: 'URL' }),
    url,
    kit.el('label', { for: 'bm-note', text: 'Note' }),
    note,
    kit.el('label', { for: 'bm-tags-input', text: 'Tags (comma separated)' }),
    tags,
    feedback,
    kit.el('div', { class: 'row' }, [save, open, remove, cancel]),
    openHint,
  ]);

  const exportButton = kit.el('button', { type: 'button', text: 'Export JSON', id: 'bm-export' });
  const importFile = kit.el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden', id: 'bm-import-file' });
  const importTrigger = kit.el('button', { type: 'button', text: 'Import JSON (replace)', id: 'bm-import-trigger' });
  const dataFeedback = kit.el('p', { class: 'feedback', id: 'bm-data-feedback' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('div', { class: 'row between' }, [
      kit.el('div', {}, [kit.el('h2', { class: 'pane-title', text: 'Bookmarks' }), count]),
      newButton,
    ]),
    search,
    kit.el('p', { class: 'muted small', text: 'Tag filter' }),
    tagRow,
    empty,
    list,
    kit.el('div', { class: 'row', style: 'margin-top:12px' }, [exportButton, importTrigger, importFile]),
    dataFeedback,
  ]);
  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Bookmark editor' }),
    kit.el('p', { class: 'muted small', id: 'bm-hint', text: 'Select a bookmark, or create a new one.' }),
    form,
  ]);
  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));

  dom = { search, tagRow, list, empty, count, form, title, url, note, tags, feedback, save, open, remove, cancel, mode, dataFeedback, importFile, hint: right.querySelector('#bm-hint') };

  closeEditor();
  await refresh();

  let timer = null;
  search.addEventListener('input', () => {
    state.query = search.value.trim();
    clearTimeout(timer);
    timer = setTimeout(refresh, 120);
  });
  newButton.addEventListener('click', openNew);
  form.addEventListener('submit', saveBookmark);
  remove.addEventListener('click', deleteSelected);
  cancel.addEventListener('click', closeEditor);
  open.addEventListener('click', () => {
    const bookmark = state.bookmarks.find((item) => item.id === state.selectedId);
    if (!bookmark) return;
    const anchor = kit.el('a', { href: bookmark.url, target: '_blank', rel: 'noopener noreferrer' });
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    kit.createFeedback(dom.feedback).set('link opened in a new tab');
  });
  exportButton.addEventListener('click', exportBundle);
  importTrigger.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => importBundle(importFile.files?.[0]));

  return () => clearTimeout(timer);
}

function visible() {
  if (state.activeTags.length === 0) return state.bookmarks;
  return state.bookmarks.filter((item) => state.activeTags.every((tag) => item.tags.includes(tag)));
}

async function refresh() {
  try {
    const params = new URLSearchParams();
    if (state.query) params.set('q', state.query);
    const payload = await api.get(`/bookmarks${params.toString() ? `?${params}` : ''}`);
    state.bookmarks = payload.bookmarks ?? [];
    const counts = new Map();
    for (const item of state.bookmarks) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    state.tags = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    render();
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

function render() {
  const rows = visible();
  dom.count.textContent = `${state.bookmarks.length} ${state.bookmarks.length === 1 ? 'bookmark' : 'bookmarks'}`;

  dom.tagRow.textContent = '';
  if (state.tags.length === 0) dom.tagRow.append(kit.el('span', { class: 'muted small', text: 'no tags yet' }));
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

  dom.list.textContent = '';
  for (const item of rows) {
    dom.list.append(
      kit.el('li', {
        class: 'item',
        id: `bm-${item.id}`,
        dataset: { selected: String(item.id === state.selectedId) },
        onclick: () => openEditor(item),
      }, [
        kit.el('h3', { text: item.title }),
        kit.el('p', { class: 'mono', text: item.url }),
        kit.el('p', { class: 'muted small', text: `updated ${kit.formatWhen(item.updatedAt)}` }),
        kit.el('div', { class: 'tags' }, item.tags.map((tag) => kit.el('span', { class: 'tag', text: tag }))),
        item.note ? kit.el('p', { class: 'preview', text: kit.preview(item.note) }) : null,
      ]),
    );
  }
  dom.empty.classList.toggle('hidden', rows.length > 0);
  dom.empty.textContent = state.bookmarks.length === 0
    ? 'No bookmarks yet. Add your first URL.'
    : 'No bookmark matches the current search or tag filter.';
}

function openEditor(item) {
  state.selectedId = item.id;
  state.draftMode = 'edit';
  dom.form.classList.remove('hidden');
  dom.hint.classList.add('hidden');
  dom.mode.textContent = 'EDIT BOOKMARK';
  dom.title.value = item.title;
  dom.url.value = item.url;
  dom.note.value = item.note;
  dom.tags.value = item.tags.join(', ');
  dom.open.classList.remove('hidden');
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
  dom.mode.textContent = 'NEW BOOKMARK';
  dom.title.value = '';
  dom.url.value = '';
  dom.note.value = '';
  dom.tags.value = state.activeTags.join(', ');
  dom.open.classList.add('hidden');
  dom.remove.classList.add('hidden');
  dom.cancel.classList.remove('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
  dom.url.focus();
}

function closeEditor() {
  state.selectedId = null;
  state.draftMode = null;
  dom.form.classList.add('hidden');
  dom.hint.classList.remove('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
}

async function saveBookmark(event) {
  event.preventDefault();
  const payload = {
    title: dom.title.value.trim(),
    url: dom.url.value.trim() || dom.title.value.trim(),
    note: dom.note.value,
    tags: kit.parseTagsInput(dom.tags.value),
  };
  if (!payload.url) {
    kit.createFeedback(dom.feedback).set('url is required', 'error');
    dom.url.focus();
    return;
  }
  dom.save.disabled = true;
  const feedback = kit.createFeedback(dom.feedback);
  try {
    if (state.draftMode === 'create') {
      const created = await api.post('/bookmarks', payload);
      await refresh();
      openEditor(created.bookmark);
      feedback.set('saved');
    } else if (state.selectedId) {
      const updated = await api.patch(`/bookmarks/${encodeURIComponent(state.selectedId)}`, payload);
      await refresh();
      openEditor(updated.bookmark);
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
  const item = state.bookmarks.find((entry) => entry.id === state.selectedId);
  if (!window.confirm(`Delete “${item?.title ?? 'this bookmark'}”? This cannot be undone.`)) return;
  try {
    await api.del(`/bookmarks/${encodeURIComponent(state.selectedId)}`);
    closeEditor();
    await refresh();
    kit.createFeedback(dom.dataFeedback).set('bookmark deleted');
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

async function exportBundle() {
  try {
    const bundle = await api.get('/export');
    const text = `${JSON.stringify(bundle, null, 2)}\n`;
    kit.downloadText(`bookmarks-${new Date().toISOString().slice(0, 10)}.json`, text);
    kit.createFeedback(dom.dataFeedback).set(`exported ${bundle.bookmarks.length} bookmark(s)`);
  } catch (error) {
    kit.createFeedback(dom.dataFeedback).error(error);
  }
}

async function importBundle(file) {
  if (!file) return;
  if (!window.confirm('Import replaces ALL current bookmarks with the bundle contents.\n\nContinue?')) {
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
    kit.createFeedback(dom.dataFeedback).set(`imported ${payload.imported} bookmark(s) · current data replaced`);
  } catch (error) {
    kit.createFeedback(dom.dataFeedback).error(error);
  } finally {
    dom.importFile.value = '';
  }
}
