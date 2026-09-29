/**
 * UTOPIA · Knowledge Room (MECH-K0) — product UI.
 * Plain ES module, no framework, no build step, no external network calls.
 */

const API = '/local-kb/v0';

const el = (id) => document.getElementById(id);

const dom = {
  status: el('status'),
  count: el('count'),
  query: el('q'),
  clearSearch: el('clear-search'),
  tagFilter: el('tag-filter'),
  searchState: el('search-state'),
  list: el('list'),
  emptyState: el('empty-state'),
  newEntry: el('new-entry'),
  editorPane: el('editor-pane'),
  editorEmpty: el('editor-empty'),
  editor: el('editor'),
  editorMode: el('editor-mode'),
  editorMeta: el('editor-meta'),
  title: el('title'),
  body: el('body'),
  tags: el('tags'),
  feedback: el('editor-feedback'),
  save: el('save'),
  delete: el('delete'),
  cancel: el('cancel'),
  exportButton: el('export'),
  importTrigger: el('import-trigger'),
  importFile: el('import-file'),
  dataFeedback: el('data-feedback'),
};

const state = {
  entries: [],
  allTags: [],
  selectedId: null,
  draft: null, // { mode: 'create' | 'edit', id: string | null }
  query: '',
  activeTags: [],
  loading: false,
};
/* ---------------------------------------------------------------- utilities */

function setStatus(text, kind = 'ok') {
  dom.status.textContent = text;
  dom.status.dataset.kind = kind;
}

function setFeedback(node, text, kind = 'ok') {
  node.textContent = text;
  node.dataset.kind = kind;
}

function parseTagsInput(value) {
  const seen = new Set();
  const out = [];
  for (const raw of String(value).split(',')) {
    const tag = raw.trim().replace(/\s+/g, ' ').toLowerCase();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

function preview(entry) {
  const text = entry.body.replace(/\s+/g, ' ').trim();
  if (!text) return '—';
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    ...options,
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
  }
  if (!response.ok) {
    const error = new Error(payload?.message ?? `request failed with ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

/* ------------------------------------------------------------------ loading */

async function refresh({ keepSelection = true } = {}) {
  state.loading = true;
  try {
    const params = new URLSearchParams();
    if (state.query) params.set('q', state.query);
    const suffix = params.toString() ? `?${params}` : '';
    const payload = await api(`/entries${suffix}`);
    state.entries = payload.entries ?? [];
    setStatus('local · ready');
    render();
  } catch (error) {
    setStatus(`error · ${error.message}`, 'error');
  } finally {
    state.loading = false;
  }
}

async function refreshTags() {
  try {
    const payload = await api('/entries');
    const counts = new Map();
    for (const entry of payload.entries ?? []) {
      for (const tag of entry.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
    state.allTags = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  } catch {
    state.allTags = [];
  }
}

/* ------------------------------------------------------------------- render */

function visibleEntries() {
  if (state.activeTags.length === 0) return state.entries;
  return state.entries.filter((entry) => state.activeTags.every((tag) => entry.tags.includes(tag)));
}

function render() {
  const visible = visibleEntries();
  dom.count.textContent = `${state.entries.length} ${state.entries.length === 1 ? 'entry' : 'entries'}`;

  renderTagFilter();
  renderList(visible);

  const filtered = Boolean(state.query) || state.activeTags.length > 0;
  if (filtered) {
    dom.searchState.hidden = false;
    const bits = [];
    if (state.query) bits.push(`“${state.query}”`);
    if (state.activeTags.length > 0) bits.push(`tags: ${state.activeTags.join(' + ')}`);
    dom.searchState.textContent = `${visible.length} match(es) for ${bits.join(' · ')}`;
  } else {
    dom.searchState.hidden = true;
  }

  if (visible.length === 0) {
    dom.emptyState.hidden = false;
    dom.emptyState.textContent = filtered
      ? 'No entry matches the current search or tag filter.'
      : 'The Knowledge Room is empty. Create your first entry.';
  } else {
    dom.emptyState.hidden = true;
  }
}

function renderTagFilter() {
  dom.tagFilter.textContent = '';
  if (state.allTags.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'muted small';
    hint.textContent = 'no tags yet';
    dom.tagFilter.append(hint);
    return;
  }
  for (const [tag, count] of state.allTags) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'tag-chip';
    button.dataset.active = state.activeTags.includes(tag) ? 'true' : 'false';
    button.textContent = `${tag} (${count})`;
    button.setAttribute('aria-pressed', state.activeTags.includes(tag) ? 'true' : 'false');
    button.addEventListener('click', () => {
      state.activeTags = state.activeTags.includes(tag)
        ? state.activeTags.filter((value) => value !== tag)
        : [...state.activeTags, tag];
      render();
    });
    dom.tagFilter.append(button);
  }
  if (state.activeTags.length > 0) {
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'tag-chip tag-chip-clear';
    clear.textContent = 'clear tags';
    clear.addEventListener('click', () => {
      state.activeTags = [];
      render();
    });
    dom.tagFilter.append(clear);
  }
}

function renderList(entries) {
  dom.list.textContent = '';
  for (const entry of entries) {
    const item = document.createElement('li');
    item.className = 'entry-card';
    item.dataset.selected = entry.id === state.selectedId ? 'true' : 'false';
    item.tabIndex = 0;
    item.setAttribute('role', 'button');

    const title = document.createElement('h2');
    title.textContent = entry.title;

    const meta = document.createElement('p');
    meta.className = 'muted small';
    meta.textContent = `updated ${formatWhen(entry.updatedAt)}`;

    const tags = document.createElement('p');
    tags.className = 'entry-tags';
    if (entry.tags.length === 0) {
      tags.append(Object.assign(document.createElement('span'), { className: 'muted small', textContent: 'no tags' }));
    } else {
      for (const tag of entry.tags) {
        tags.append(Object.assign(document.createElement('span'), { className: 'tag-static', textContent: tag }));
      }
    }

    const body = document.createElement('p');
    body.className = 'entry-preview';
    body.textContent = preview(entry);

    item.append(title, meta, tags, body);
    const open = () => openEditor(entry);
    item.addEventListener('click', open);
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    dom.list.append(item);
  }
}

/* ------------------------------------------------------------------- editor */

function openEditor(entry) {
  state.selectedId = entry.id;
  state.draft = { mode: 'edit', id: entry.id };
  dom.editor.hidden = false;
  dom.editorEmpty.hidden = true;
  dom.editorMode.textContent = 'EDIT ENTRY';
  dom.editorMeta.textContent = `created ${formatWhen(entry.createdAt)} · updated ${formatWhen(entry.updatedAt)}`;
  dom.title.value = entry.title;
  dom.body.value = entry.body;
  dom.tags.value = entry.tags.join(', ');
  dom.delete.hidden = false;
  dom.cancel.hidden = true;
  setFeedback(dom.feedback, '');
  render();
  dom.title.focus();
}

function openNewEntry() {
  state.selectedId = null;
  state.draft = { mode: 'create', id: null };
  dom.editor.hidden = false;
  dom.editorEmpty.hidden = true;
  dom.editorMode.textContent = 'NEW ENTRY';
  dom.editorMeta.textContent = 'not saved yet';
  dom.title.value = '';
  dom.body.value = '';
  dom.tags.value = state.activeTags.join(', ');
  dom.delete.hidden = true;
  dom.cancel.hidden = false;
  setFeedback(dom.feedback, '');
  render();
  dom.title.focus();
}

function closeEditor() {
  state.selectedId = null;
  state.draft = null;
  dom.editor.hidden = true;
  dom.editorEmpty.hidden = false;
  setFeedback(dom.feedback, '');
  render();
}

async function saveEditor(event) {
  event.preventDefault();
  const payload = {
    title: dom.title.value.trim(),
    body: dom.body.value,
    tags: parseTagsInput(dom.tags.value),
  };
  if (!payload.title) {
    setFeedback(dom.feedback, 'title must not be empty', 'error');
    dom.title.focus();
    return;
  }
  dom.save.disabled = true;
  try {
    if (state.draft?.mode === 'create') {
      const created = await api('/entries', { method: 'POST', body: JSON.stringify(payload) });
      await refreshTags();
      await refresh();
      openEditor(created.entry);
      setFeedback(dom.feedback, 'saved', 'ok');
    } else if (state.draft?.id) {
      const updated = await api(`/entries/${encodeURIComponent(state.draft.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload),
      });
      await refreshTags();
      await refresh();
      openEditor(updated.entry);
      setFeedback(dom.feedback, 'saved', 'ok');
    }
  } catch (error) {
    setFeedback(dom.feedback, `save failed: ${error.message}`, 'error');
  } finally {
    dom.save.disabled = false;
  }
}

async function deleteSelected() {
  if (!state.draft?.id) return;
  const entry = state.entries.find((item) => item.id === state.draft.id);
  const label = entry?.title ?? 'this entry';
  if (!window.confirm(`Delete “${label}”? This cannot be undone.`)) return;
  try {
    await api(`/entries/${encodeURIComponent(state.draft.id)}`, { method: 'DELETE' });
    closeEditor();
    await refreshTags();
    await refresh();
    setFeedback(dom.dataFeedback, 'entry deleted', 'ok');
  } catch (error) {
    setFeedback(dom.feedback, `delete failed: ${error.message}`, 'error');
  }
}

/* -------------------------------------------------------------- import/export */

async function exportBundle() {
  try {
    const response = await fetch(`${API}/export`);
    if (!response.ok) throw new Error(`export failed with ${response.status}`);
    const text = await response.text();
    const digest = await sha256(text);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `utopia-knowledge-room-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setFeedback(dom.dataFeedback, `exported ${state.entries.length} entr(ies) · sha256 ${digest.slice(0, 16)}…`, 'ok');
  } catch (error) {
    setFeedback(dom.dataFeedback, `export failed: ${error.message}`, 'error');
  }
}

async function sha256(text) {
  const bytes = new TextEncoder().encode(text);
  if (!globalThis.crypto?.subtle) return 'unavailable';
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function importBundle(file) {
  if (!file) return;
  const confirmed = window.confirm(
    'Import replaces ALL current Knowledge Room data with the bundle contents.\n\nContinue?',
  );
  if (!confirmed) {
    dom.importFile.value = '';
    return;
  }
  try {
    const text = await file.text();
    const payload = await api('/import', { method: 'POST', body: text });
    state.activeTags = [];
    state.query = '';
    dom.query.value = '';
    closeEditor();
    await refreshTags();
    await refresh();
    setFeedback(dom.dataFeedback, `imported ${payload.imported} entr(ies) · current data replaced`, 'ok');
  } catch (error) {
    setFeedback(dom.dataFeedback, `import rejected: ${error.message}`, 'error');
  } finally {
    dom.importFile.value = '';
  }
}

/* -------------------------------------------------------------------- events */

let searchTimer = null;
dom.query.addEventListener('input', () => {
  state.query = dom.query.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => refresh(), 120);
});
dom.clearSearch.addEventListener('click', () => {
  dom.query.value = '';
  state.query = '';
  refresh();
});
dom.newEntry.addEventListener('click', openNewEntry);
dom.editor.addEventListener('submit', saveEditor);
dom.delete.addEventListener('click', deleteSelected);
dom.cancel.addEventListener('click', closeEditor);
dom.exportButton.addEventListener('click', exportBundle);
dom.importTrigger.addEventListener('click', () => dom.importFile.click());
dom.importFile.addEventListener('change', () => importBundle(dom.importFile.files?.[0]));
dom.editorPane.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.draft?.mode === 'create') closeEditor();
});

/* --------------------------------------------------------------------- boot */

(async function boot() {
  try {
    const response = await fetch('/health');
    const health = response.ok ? await response.json() : null;
    setStatus(health ? `local · ready · schema v${health.schemaVersion}` : 'local · ready');
  } catch {
    setStatus('local · ready');
  }
  await refreshTags();
  await refresh();
  closeEditor();
})();
