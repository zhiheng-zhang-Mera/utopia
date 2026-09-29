/**
 * UTOPIA · Rooms · Room 10 — Decision Room (client).
 * Decision records with options, a chosen decision, rationale and status.
 */

let kit;
let api;

const state = { decisions: [], selectedId: null, draftMode: null, query: '', status: '', tags: [], activeTags: [] };
let dom = {};

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const search = kit.el('input', { type: 'search', placeholder: 'Search question, context, rationale…', id: 'dc-q' });
  const statusRow = kit.el('div', { class: 'row', id: 'dc-status-filter' });
  const tagRow = kit.el('div', { class: 'tags', id: 'dc-tags' });
  const list = kit.el('ul', { class: 'item-list', id: 'dc-list' });
  const empty = kit.el('p', { class: 'empty hidden', id: 'dc-empty' });
  const count = kit.el('p', { class: 'muted small', text: '0 decisions' });
  const newButton = kit.el('button', { class: 'primary', type: 'button', text: '＋ New decision', id: 'dc-new' });

  const question = kit.el('input', { type: 'text', id: 'dc-question' });
  const context = kit.el('textarea', { id: 'dc-context', rows: '4' });
  const options = kit.el('textarea', { id: 'dc-options', rows: '4', placeholder: 'One option per line' });
  const optionList = kit.el('div', { class: 'stack', id: 'dc-option-list' });
  const decision = kit.el('textarea', { id: 'dc-decision', rows: '3' });
  const rationale = kit.el('textarea', { id: 'dc-rationale', rows: '4' });
  const statusSelect = kit.el('select', { id: 'dc-status' }, [
    kit.el('option', { value: 'OPEN', text: 'OPEN' }),
    kit.el('option', { value: 'DECIDED', text: 'DECIDED' }),
    kit.el('option', { value: 'REVISIT', text: 'REVISIT' }),
  ]);
  const tags = kit.el('input', { type: 'text', id: 'dc-tags-input' });
  const feedback = kit.el('p', { class: 'feedback', id: 'dc-feedback' });
  const save = kit.el('button', { class: 'primary', type: 'submit', text: 'Save', id: 'dc-save' });
  const decideButton = kit.el('button', { type: 'button', text: 'Mark decided', id: 'dc-decide' });
  const revisitButton = kit.el('button', { type: 'button', text: 'Reopen (REVISIT)', id: 'dc-revisit' });
  const remove = kit.el('button', { class: 'danger hidden', type: 'button', text: 'Delete', id: 'dc-delete' });
  const cancel = kit.el('button', { class: 'ghost hidden', type: 'button', text: 'Cancel', id: 'dc-cancel' });
  const mode = kit.el('p', { class: 'eyebrow', id: 'dc-mode', text: 'EDIT DECISION' });
  const meta = kit.el('p', { class: 'muted small', id: 'dc-meta', text: '' });

  const form = kit.el('form', { class: 'stack' }, [
    mode,
    meta,
    kit.el('label', { for: 'dc-question', text: 'Question' }),
    question,
    kit.el('label', { for: 'dc-context', text: 'Context' }),
    context,
    kit.el('label', { for: 'dc-options', text: 'Options (one per line)' }),
    options,
    kit.el('p', { class: 'muted small', text: 'Select the option that was chosen' }),
    optionList,
    kit.el('label', { for: 'dc-decision', text: 'Decision' }),
    decision,
    kit.el('label', { for: 'dc-rationale', text: 'Rationale' }),
    rationale,
    kit.el('div', { class: 'row' }, [
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'dc-status', text: 'Status' }), statusSelect]),
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'dc-tags-input', text: 'Tags' }), tags]),
    ]),
    feedback,
    kit.el('div', { class: 'row' }, [save, decideButton, revisitButton, remove, cancel]),
  ]);

  const exportButton = kit.el('button', { type: 'button', text: 'Export JSON', id: 'dc-export' });
  const importFile = kit.el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden', id: 'dc-import-file' });
  const importTrigger = kit.el('button', { type: 'button', text: 'Import JSON (replace)', id: 'dc-import-trigger' });
  const dataFeedback = kit.el('p', { class: 'feedback', id: 'dc-data-feedback' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('div', { class: 'row between' }, [
      kit.el('div', {}, [kit.el('h2', { class: 'pane-title', text: 'Decision Room' }), count]),
      newButton,
    ]),
    statusRow,
    search,
    kit.el('p', { class: 'muted small', text: 'Tag filter' }),
    tagRow,
    empty,
    list,
    kit.el('div', { class: 'row', style: 'margin-top:12px' }, [exportButton, importTrigger, importFile]),
    dataFeedback,
  ]);
  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Decision editor' }),
    kit.el('p', { class: 'muted small', id: 'dc-hint', text: 'Select a decision, or record a new one.' }),
    form,
  ]);
  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));

  dom = { search, statusRow, tagRow, list, empty, count, form, question, context, options, optionList, decision, rationale, statusSelect, tags, feedback, save, decideButton, revisitButton, remove, cancel, mode, meta, dataFeedback, importFile, hint: right.querySelector('#dc-hint') };

  state.editingOptions = [];
  state.selectedOptionId = null;

  renderStatusFilter();
  closeEditor();
  await refresh();

  let timer = null;
  search.addEventListener('input', () => {
    state.query = search.value.trim();
    clearTimeout(timer);
    timer = setTimeout(refresh, 120);
  });
  newButton.addEventListener('click', openNew);
  form.addEventListener('submit', saveDecision);
  remove.addEventListener('click', deleteSelected);
  cancel.addEventListener('click', closeEditor);
  decideButton.addEventListener('click', () => decideAction());
  revisitButton.addEventListener('click', () => revisitAction());
  options.addEventListener('input', () => renderOptionList());
  exportButton.addEventListener('click', exportBundle);
  importTrigger.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => importBundle(importFile.files?.[0]));

  return () => clearTimeout(timer);
}

function renderStatusFilter() {
  dom.statusRow.textContent = '';
  for (const [value, text] of [['', 'All'], ...['OPEN', 'DECIDED', 'REVISIT'].map((status) => [status, status])]) {
    dom.statusRow.append(
      kit.el('button', {
        type: 'button',
        class: state.status === value ? 'primary' : '',
        id: `dc-filter-${value || 'all'}`,
        text,
        onclick: () => {
          state.status = value;
          renderStatusFilter();
          refresh();
        },
      }),
    );
  }
}

function visible() {
  if (state.activeTags.length === 0) return state.decisions;
  return state.decisions.filter((item) => state.activeTags.every((tag) => item.tags.includes(tag)));
}

async function refresh() {
  try {
    const params = new URLSearchParams();
    if (state.query) params.set('q', state.query);
    if (state.status) params.set('status', state.status);
    const payload = await api.get(`/decisions${params.toString() ? `?${params}` : ''}`);
    state.decisions = payload.decisions ?? [];
    const counts = new Map();
    for (const item of state.decisions) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    state.tags = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    render();
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

function render() {
  const rows = visible();
  dom.count.textContent = `${state.decisions.length} decision(s)`;
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
    const chosen = item.options.find((option) => option.id === item.selectedOptionId);
    dom.list.append(
      kit.el('li', {
        class: 'item',
        id: `dc-${item.id}`,
        dataset: { selected: String(item.id === state.selectedId) },
        onclick: () => openEditor(item),
      }, [
        kit.el('div', { class: 'row between' }, [
          kit.el('h3', { text: item.question }),
          kit.el('span', { class: 'tag', text: item.status }),
        ]),
        chosen ? kit.el('p', { class: 'muted small', text: `chosen: ${chosen.text}` }) : null,
        item.decision && !chosen ? kit.el('p', { class: 'preview', text: kit.preview(item.decision) }) : null,
        kit.el('p', { class: 'muted small', text: `${item.options.length} option(s) · updated ${kit.formatWhen(item.updatedAt)}${item.decidedAt ? ` · decided ${kit.formatWhen(item.decidedAt)}` : ''}` }),
        kit.el('div', { class: 'tags' }, item.tags.map((tag) => kit.el('span', { class: 'tag', text: tag }))),
      ]),
    );
  }
  dom.empty.classList.toggle('hidden', rows.length > 0);
  dom.empty.textContent = state.decisions.length === 0 ? 'No decisions recorded yet.' : 'No decision matches the current filter.';
}

function parseOptionText(value) {
  return String(value ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function renderOptionList() {
  const previous = new Map(state.editingOptions.map((option) => [option.text, option.id]));
  state.editingOptions = parseOptionText(dom.options.value).map((text) => ({ id: previous.get(text) ?? `local-${Math.random().toString(36).slice(2)}`, text }));
  if (state.selectedOptionId && !state.editingOptions.some((option) => option.id === state.selectedOptionId)) {
    state.selectedOptionId = null;
  }
  dom.optionList.textContent = '';
  if (state.editingOptions.length === 0) {
    dom.optionList.append(kit.el('span', { class: 'muted small', text: 'no options yet' }));
    return;
  }
  for (const option of state.editingOptions) {
    dom.optionList.append(
      kit.el('label', { class: 'row', style: 'gap:6px;color:#e6edf3' }, [
        kit.el('input', {
          type: 'radio',
          name: 'dc-option',
          style: 'width:auto',
          checked: state.selectedOptionId === option.id,
          id: `dc-option-${option.id}`,
          onchange: () => {
            state.selectedOptionId = option.id;
            if (!dom.decision.value.trim()) dom.decision.value = option.text;
          },
        }),
        kit.el('span', { text: option.text }),
      ]),
    );
  }
}

function openEditor(item) {
  state.selectedId = item.id;
  state.draftMode = 'edit';
  state.editingOptions = item.options.map((option) => ({ ...option }));
  state.selectedOptionId = item.selectedOptionId ?? null;
  dom.form.classList.remove('hidden');
  dom.hint.classList.add('hidden');
  dom.mode.textContent = 'EDIT DECISION';
  dom.meta.textContent = `created ${kit.formatWhen(item.createdAt)} · updated ${kit.formatWhen(item.updatedAt)}${item.decidedAt ? ` · decided ${kit.formatWhen(item.decidedAt)}` : ''}`;
  dom.question.value = item.question;
  dom.context.value = item.context ?? '';
  dom.options.value = item.options.map((option) => option.text).join('\n');
  dom.decision.value = item.decision ?? '';
  dom.rationale.value = item.rationale ?? '';
  dom.statusSelect.value = item.status;
  dom.tags.value = item.tags.join(', ');
  dom.remove.classList.remove('hidden');
  dom.decideButton.classList.remove('hidden');
  dom.revisitButton.classList.remove('hidden');
  dom.cancel.classList.add('hidden');
  kit.createFeedback(dom.feedback).clear();
  renderOptionList();
  render();
}

function openNew() {
  state.selectedId = null;
  state.draftMode = 'create';
  state.editingOptions = [];
  state.selectedOptionId = null;
  dom.form.classList.remove('hidden');
  dom.hint.classList.add('hidden');
  dom.mode.textContent = 'NEW DECISION';
  dom.meta.textContent = 'not saved yet';
  dom.question.value = '';
  dom.context.value = '';
  dom.options.value = '';
  dom.decision.value = '';
  dom.rationale.value = '';
  dom.statusSelect.value = 'OPEN';
  dom.tags.value = state.activeTags.join(', ');
  dom.remove.classList.add('hidden');
  dom.decideButton.classList.add('hidden');
  dom.revisitButton.classList.add('hidden');
  dom.cancel.classList.remove('hidden');
  kit.createFeedback(dom.feedback).clear();
  renderOptionList();
  render();
  dom.question.focus();
}

function closeEditor() {
  state.selectedId = null;
  state.draftMode = null;
  state.editingOptions = [];
  state.selectedOptionId = null;
  dom.form.classList.add('hidden');
  dom.hint.classList.remove('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
}

function collectPayload() {
  return {
    question: dom.question.value.trim(),
    context: dom.context.value,
    options: state.editingOptions,
    decision: dom.decision.value,
    rationale: dom.rationale.value,
    status: dom.statusSelect.value,
    tags: kit.parseTagsInput(dom.tags.value),
  };
}

async function saveDecision(submitEvent) {
  submitEvent.preventDefault();
  const payload = collectPayload();
  if (!payload.question) {
    kit.createFeedback(dom.feedback).set('question must not be empty', 'error');
    return;
  }
  dom.save.disabled = true;
  const feedback = kit.createFeedback(dom.feedback);
  try {
    if (state.draftMode === 'create') {
      const created = await api.post('/decisions', payload);
      await refresh();
      openEditor(created.decision);
      feedback.set('saved');
    } else if (state.selectedId) {
      // keep option ids stable: send text only, the server preserves existing ids by order
      const updated = await api.patch(`/decisions/${encodeURIComponent(state.selectedId)}`, {
        ...payload,
        selectedOptionId: state.selectedOptionId,
      });
      await refresh();
      openEditor(updated.decision);
      feedback.set('saved');
    }
  } catch (error) {
    feedback.error(error);
  } finally {
    dom.save.disabled = false;
  }
}

async function decideAction() {
  if (!state.selectedId) return;
  try {
    const result = await api.post(`/decisions/${encodeURIComponent(state.selectedId)}/decide`, {
      selectedOptionId: state.selectedOptionId,
      decision: dom.decision.value,
      rationale: dom.rationale.value,
    });
    await refresh();
    openEditor(result.decision);
    kit.createFeedback(dom.feedback).set('marked as DECIDED');
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

async function revisitAction() {
  if (!state.selectedId) return;
  try {
    const result = await api.post(`/decisions/${encodeURIComponent(state.selectedId)}/revisit`, {});
    await refresh();
    openEditor(result.decision);
    kit.createFeedback(dom.feedback).set('reopened as REVISIT', 'warn');
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

async function deleteSelected() {
  if (!state.selectedId) return;
  const item = state.decisions.find((entry) => entry.id === state.selectedId);
  if (!window.confirm(`Delete decision “${item?.question ?? ''}”?`)) return;
  try {
    await api.del(`/decisions/${encodeURIComponent(state.selectedId)}`);
    closeEditor();
    await refresh();
    kit.createFeedback(dom.dataFeedback).set('decision deleted');
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

async function exportBundle() {
  try {
    const bundle = await api.get('/export');
    kit.downloadText(`decisions-${new Date().toISOString().slice(0, 10)}.json`, `${JSON.stringify(bundle, null, 2)}\n`);
    kit.createFeedback(dom.dataFeedback).set(`exported ${bundle.decisions.length} decision(s)`);
  } catch (error) {
    kit.createFeedback(dom.dataFeedback).error(error);
  }
}

async function importBundle(file) {
  if (!file) return;
  if (!window.confirm('Import replaces ALL current decisions with the bundle contents.\n\nContinue?')) {
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
    kit.createFeedback(dom.dataFeedback).set(`imported ${payload.imported} decision(s) · current data replaced`);
  } catch (error) {
    kit.createFeedback(dom.dataFeedback).error(error);
  } finally {
    dom.importFile.value = '';
  }
}
