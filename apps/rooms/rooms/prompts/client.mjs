/**
 * UTOPIA · Rooms · Room 04 — Prompt Library (client).
 * Templates with {{variable}} detection, fill-in, live render and copy.
 * No AI provider is contacted: rendering is pure local text substitution.
 */

let kit;
let api;

const state = { prompts: [], tags: [], activeTags: [], query: '', selectedId: null, draftMode: null, values: {} };
let dom = {};

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const search = kit.el('input', { type: 'search', placeholder: 'Search title, template, note…', id: 'pr-q' });
  const tagRow = kit.el('div', { class: 'tags', id: 'pr-tags' });
  const list = kit.el('ul', { class: 'item-list', id: 'pr-list' });
  const empty = kit.el('p', { class: 'empty hidden', id: 'pr-empty' });
  const count = kit.el('p', { class: 'muted small', text: '0 prompts' });
  const newButton = kit.el('button', { class: 'primary', type: 'button', text: '＋ New prompt', id: 'pr-new' });

  const title = kit.el('input', { type: 'text', id: 'pr-title' });
  const template = kit.el('textarea', { id: 'pr-template', rows: '8', placeholder: 'Summarize {{topic}} for {{audience}}.' });
  const note = kit.el('textarea', { id: 'pr-note', rows: '3' });
  const tags = kit.el('input', { type: 'text', id: 'pr-tags-input' });
  const feedback = kit.el('p', { class: 'feedback', id: 'pr-feedback' });
  const save = kit.el('button', { class: 'primary', type: 'submit', text: 'Save', id: 'pr-save' });
  const remove = kit.el('button', { class: 'danger hidden', type: 'button', text: 'Delete', id: 'pr-delete' });
  const cancel = kit.el('button', { class: 'ghost hidden', type: 'button', text: 'Cancel', id: 'pr-cancel' });
  const mode = kit.el('p', { class: 'eyebrow', id: 'pr-mode', text: 'EDIT PROMPT' });
  const detected = kit.el('p', { class: 'muted small', id: 'pr-vars', text: 'variables: —' });

  const form = kit.el('form', { class: 'stack' }, [
    mode,
    kit.el('label', { for: 'pr-title', text: 'Title' }),
    title,
    kit.el('label', { for: 'pr-template', text: 'Template' }),
    template,
    detected,
    kit.el('label', { for: 'pr-note', text: 'Note' }),
    note,
    kit.el('label', { for: 'pr-tags-input', text: 'Tags (comma separated)' }),
    tags,
    feedback,
    kit.el('div', { class: 'row' }, [save, remove, cancel]),
  ]);

  const valuesBlock = kit.el('div', { class: 'hidden', id: 'pr-values-block' });
  const rendered = kit.el('pre', { class: 'mono', id: 'pr-rendered', style: 'white-space:pre-wrap;background:#0c1016;border:1px solid #27333f;border-radius:8px;padding:10px;min-height:60px' });
  const copyButton = kit.el('button', { type: 'button', text: 'Copy final prompt', id: 'pr-copy' });
  const renderFeedback = kit.el('p', { class: 'feedback', id: 'pr-render-feedback' });

  const exportButton = kit.el('button', { type: 'button', text: 'Export JSON', id: 'pr-export' });
  const importFile = kit.el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden', id: 'pr-import-file' });
  const importTrigger = kit.el('button', { type: 'button', text: 'Import JSON (replace)', id: 'pr-import-trigger' });
  const dataFeedback = kit.el('p', { class: 'feedback', id: 'pr-data-feedback' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('div', { class: 'row between' }, [
      kit.el('div', {}, [kit.el('h2', { class: 'pane-title', text: 'Prompt Library' }), count]),
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
    kit.el('h2', { class: 'pane-title', text: 'Prompt editor' }),
    form,
    valuesBlock,
    kit.el('h3', { style: 'margin-bottom:2px', text: 'Rendered prompt' }),
    rendered,
    kit.el('div', { class: 'row', style: 'margin-top:8px' }, [copyButton]),
    renderFeedback,
  ]);
  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));

  dom = { search, tagRow, list, empty, count, form, title, template, note, tags, feedback, save, remove, cancel, mode, detected, valuesBlock, rendered, copyButton, renderFeedback, dataFeedback, importFile };

  closeEditor();
  await refresh();

  let timer = null;
  search.addEventListener('input', () => {
    state.query = search.value.trim();
    clearTimeout(timer);
    timer = setTimeout(refresh, 120);
  });
  newButton.addEventListener('click', openNew);
  form.addEventListener('submit', savePrompt);
  remove.addEventListener('click', deleteSelected);
  cancel.addEventListener('click', closeEditor);
  template.addEventListener('input', () => {
    updateDetectedLine();
    updateRendered();
  });
  template.addEventListener('change', () => {
    renderValuesBlock();
  });
  copyButton.addEventListener('click', async () => {
    const ok = await kit.copyTextFallback(dom.rendered.textContent);
    kit.createFeedback(dom.renderFeedback).set(ok ? 'final prompt copied' : 'copy was blocked by the browser', ok ? 'ok' : 'warn');
  });
  exportButton.addEventListener('click', exportBundle);
  importTrigger.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => importBundle(importFile.files?.[0]));

  return () => clearTimeout(timer);
}

function visible() {
  if (state.activeTags.length === 0) return state.prompts;
  return state.prompts.filter((item) => state.activeTags.every((tag) => item.tags.includes(tag)));
}

async function refresh() {
  try {
    const params = new URLSearchParams();
    if (state.query) params.set('q', state.query);
    const payload = await api.get(`/prompts${params.toString() ? `?${params}` : ''}`);
    state.prompts = payload.prompts ?? [];
    const counts = new Map();
    for (const item of state.prompts) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    state.tags = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    render();
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

function render() {
  const rows = visible();
  dom.count.textContent = `${state.prompts.length} ${state.prompts.length === 1 ? 'prompt' : 'prompts'}`;
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
  dom.list.textContent = '';
  for (const item of rows) {
    dom.list.append(
      kit.el('li', {
        class: 'item',
        id: `pr-${item.id}`,
        dataset: { selected: String(item.id === state.selectedId) },
        onclick: () => openEditor(item),
      }, [
        kit.el('h3', { text: item.title }),
        kit.el('p', { class: 'muted small', text: `${item.variables.length} variable(s) · updated ${kit.formatWhen(item.updatedAt)}` }),
        kit.el('div', { class: 'tags' }, item.variables.map((name) => kit.el('span', { class: 'tag', text: `{{${name}}}` }))),
        kit.el('p', { class: 'preview', text: kit.preview(item.template) }),
      ]),
    );
  }
  dom.empty.classList.toggle('hidden', rows.length > 0);
  dom.empty.textContent = state.prompts.length === 0 ? 'No prompts yet.' : 'No prompt matches the current filter.';
}

function detectLocal(text) {
  const seen = new Set();
  const out = [];
  for (const match of String(text ?? '').matchAll(/\{\{\s*([A-Za-z0-9_.\- ]+?)\s*\}\}/g)) {
    const name = match[1].trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

function updateDetectedLine() {
  const names = detectLocal(dom.template.value);
  dom.detected.textContent = names.length ? `variables: ${names.join(', ')}` : 'variables: —';
  return names;
}

function renderLocal(text, values) {
  return String(text ?? '').replace(/\{\{\s*([A-Za-z0-9_.\- ]+?)\s*\}\}/g, (whole, rawName) => {
    const name = rawName.trim();
    return Object.prototype.hasOwnProperty.call(values, name) ? String(values[name] ?? '') : whole;
  });
}

function renderValuesBlock() {
  const names = updateDetectedLine();
  dom.valuesBlock.textContent = '';
  if (names.length === 0) {
    dom.valuesBlock.classList.add('hidden');
    updateRendered();
    return;
  }
  dom.valuesBlock.classList.remove('hidden');
  dom.valuesBlock.append(kit.el('h3', { style: 'margin-bottom:2px', text: 'Variables' }));
  for (const name of names) {
    dom.valuesBlock.append(
      kit.el('label', { for: `pr-var-${name}`, text: name }),
      kit.el('input', {
        type: 'text',
        id: `pr-var-${name}`,
        value: state.values[name] ?? '',
        oninput: (event) => {
          state.values[name] = event.target.value;
          updateRendered();
        },
      }),
    );
  }
  updateRendered();
}

function updateRendered() {
  dom.rendered.textContent = renderLocal(dom.template.value, state.values);
}

function openEditor(item) {
  state.selectedId = item.id;
  state.draftMode = 'edit';
  state.values = { ...(item.values ?? {}) };
  dom.form.classList.remove('hidden');
  dom.mode.textContent = 'EDIT PROMPT';
  dom.title.value = item.title;
  dom.template.value = item.template;
  dom.note.value = item.note;
  dom.tags.value = item.tags.join(', ');
  dom.remove.classList.remove('hidden');
  dom.cancel.classList.add('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
  renderValuesBlock();
}

function openNew() {
  state.selectedId = null;
  state.draftMode = 'create';
  state.values = {};
  dom.form.classList.remove('hidden');
  dom.mode.textContent = 'NEW PROMPT';
  dom.title.value = '';
  dom.template.value = '';
  dom.note.value = '';
  dom.tags.value = state.activeTags.join(', ');
  dom.remove.classList.add('hidden');
  dom.cancel.classList.remove('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
  renderValuesBlock();
  dom.title.focus();
}

function closeEditor() {
  state.selectedId = null;
  state.draftMode = null;
  state.values = {};
  dom.form.classList.add('hidden');
  dom.valuesBlock.classList.add('hidden');
  dom.rendered.textContent = '';
  kit.createFeedback(dom.feedback).clear();
  render();
}

async function savePrompt(event) {
  event.preventDefault();
  const payload = {
    title: dom.title.value.trim(),
    template: dom.template.value,
    note: dom.note.value,
    tags: kit.parseTagsInput(dom.tags.value),
    values: state.values,
  };
  if (!payload.title) {
    kit.createFeedback(dom.feedback).set('title must not be empty', 'error');
    return;
  }
  if (!payload.template.trim()) {
    kit.createFeedback(dom.feedback).set('template must not be empty', 'error');
    return;
  }
  dom.save.disabled = true;
  const feedback = kit.createFeedback(dom.feedback);
  try {
    if (state.draftMode === 'create') {
      const created = await api.post('/prompts', payload);
      await refresh();
      openEditor(created.prompt);
      feedback.set('saved');
    } else if (state.selectedId) {
      const updated = await api.patch(`/prompts/${encodeURIComponent(state.selectedId)}`, payload);
      await refresh();
      openEditor(updated.prompt);
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
  const item = state.prompts.find((entry) => entry.id === state.selectedId);
  if (!window.confirm(`Delete prompt “${item?.title ?? ''}”?`)) return;
  try {
    await api.del(`/prompts/${encodeURIComponent(state.selectedId)}`);
    closeEditor();
    await refresh();
    kit.createFeedback(dom.dataFeedback).set('prompt deleted');
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

async function exportBundle() {
  try {
    const bundle = await api.get('/export');
    kit.downloadText(`prompts-${new Date().toISOString().slice(0, 10)}.json`, `${JSON.stringify(bundle, null, 2)}\n`);
    kit.createFeedback(dom.dataFeedback).set(`exported ${bundle.prompts.length} prompt(s)`);
  } catch (error) {
    kit.createFeedback(dom.dataFeedback).error(error);
  }
}

async function importBundle(file) {
  if (!file) return;
  if (!window.confirm('Import replaces ALL current prompts with the bundle contents.\n\nContinue?')) {
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
    kit.createFeedback(dom.dataFeedback).set(`imported ${payload.imported} prompt(s) · current data replaced`);
  } catch (error) {
    kit.createFeedback(dom.dataFeedback).error(error);
  } finally {
    dom.importFile.value = '';
  }
}
