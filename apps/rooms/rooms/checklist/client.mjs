/**
 * UTOPIA · Rooms · Room 03 — Checklist Room (client).
 * Checklists with items: add, toggle, move up/down, delete, clear completed.
 */

let kit;
let api;

const state = { checklists: [], selectedId: null, draftMode: null };
let dom = {};

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const listPane = kit.el('div', { class: 'pane' });
  const editorPane = kit.el('div', { class: 'pane' });
  root.append(kit.el('div', { class: 'room-grid' }, [listPane, editorPane]));

  const count = kit.el('p', { class: 'muted small', text: '0 checklists' });
  const newList = kit.el('button', { class: 'primary', type: 'button', text: '＋ New checklist', id: 'cl-new' });
  const list = kit.el('ul', { class: 'item-list', id: 'cl-lists' });
  const empty = kit.el('p', { class: 'empty hidden', id: 'cl-empty' });

  listPane.append(
    kit.el('div', { class: 'row between' }, [
      kit.el('div', {}, [kit.el('h2', { class: 'pane-title', text: 'Checklists' }), count]),
      newList,
    ]),
    empty,
    list,
  );

  const titleInput = kit.el('input', { type: 'text', id: 'cl-title' });
  const noteInput = kit.el('textarea', { id: 'cl-note', rows: '4' });
  const feedback = kit.el('p', { class: 'feedback', id: 'cl-feedback' });
  const saveList = kit.el('button', { class: 'primary', type: 'submit', text: 'Save', id: 'cl-save' });
  const deleteList = kit.el('button', { class: 'danger hidden', type: 'button', text: 'Delete checklist', id: 'cl-delete' });
  const cancelList = kit.el('button', { class: 'ghost hidden', type: 'button', text: 'Cancel', id: 'cl-cancel' });
  const mode = kit.el('p', { class: 'eyebrow', id: 'cl-mode', text: 'EDIT CHECKLIST' });
  const progress = kit.el('p', { class: 'muted small', id: 'cl-progress', text: '' });

  const form = kit.el('form', { class: 'stack' }, [
    mode,
    kit.el('label', { for: 'cl-title', text: 'Title' }),
    titleInput,
    kit.el('label', { for: 'cl-note', text: 'Note' }),
    noteInput,
    feedback,
    kit.el('div', { class: 'row' }, [saveList, deleteList, cancelList]),
  ]);

  const itemInput = kit.el('input', { type: 'text', id: 'cl-item-input', placeholder: 'New item…' });
  const addItem = kit.el('button', { class: 'primary', type: 'submit', text: 'Add', id: 'cl-add-item' });
  const itemForm = kit.el('form', { class: 'row', style: 'margin-top:10px' }, [kit.el('div', { class: 'grow' }, [itemInput]), addItem]);
  const itemList = kit.el('ul', { class: 'item-list', id: 'cl-items' });
  const clearDone = kit.el('button', { type: 'button', text: 'Clear completed', id: 'cl-clear' });
  const itemFeedback = kit.el('p', { class: 'feedback', id: 'cl-item-feedback' });

  const itemsBlock = kit.el('div', { class: 'hidden', id: 'cl-items-block' }, [
    kit.el('h3', { style: 'margin-bottom:2px', text: 'Items' }),
    progress,
    itemForm,
    itemList,
    kit.el('div', { class: 'row', style: 'margin-top:8px' }, [clearDone]),
    itemFeedback,
  ]);

  editorPane.append(kit.el('h2', { class: 'pane-title', text: 'Checklist editor' }), kit.el('p', { class: 'muted small', id: 'cl-hint', text: 'Select a checklist, or create a new one.' }), form, itemsBlock);

  dom = { count, list, empty, form, titleInput, noteInput, feedback, saveList, deleteList, cancelList, mode, progress, itemInput, itemForm, itemList, clearDone, itemFeedback, itemsBlock, hint: editorPane.querySelector('#cl-hint') };

  closeEditor();
  await refresh();

  newList.addEventListener('click', openNew);
  form.addEventListener('submit', saveChecklist);
  deleteList.addEventListener('click', deleteChecklist);
  cancelList.addEventListener('click', closeEditor);
  itemForm.addEventListener('submit', addItemHandler);
  clearDone.addEventListener('click', clearCompleted);

  return () => {};
}

function current() {
  return state.checklists.find((list) => list.id === state.selectedId) ?? null;
}

async function refresh() {
  try {
    const payload = await api.get('/checklists');
    state.checklists = payload.checklists ?? [];
    render();
    if (state.selectedId) {
      const still = current();
      if (still) await renderItems(still);
      else closeEditor();
    }
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

function render() {
  dom.count.textContent = `${state.checklists.length} ${state.checklists.length === 1 ? 'checklist' : 'checklists'}`;
  dom.list.textContent = '';
  for (const list of state.checklists) {
    const progress = list.progress ?? { done: 0, total: list.items?.length ?? 0 };
    dom.list.append(
      kit.el('li', {
        class: 'item',
        id: `cl-list-${list.id}`,
        dataset: { selected: String(list.id === state.selectedId) },
        onclick: () => openEditor(list.id),
      }, [
        kit.el('h3', { text: list.title }),
        kit.el('p', { class: 'muted small', text: `${progress.done}/${progress.total} done · updated ${kit.formatWhen(list.updatedAt)}` }),
        list.note ? kit.el('p', { class: 'preview', text: kit.preview(list.note) }) : null,
      ]),
    );
  }
  dom.empty.classList.toggle('hidden', state.checklists.length > 0);
  dom.empty.textContent = 'No checklists yet. Create your first one.';
}

async function renderItems(list) {
  dom.progress.textContent = `${list.progress?.done ?? 0} of ${list.progress?.total ?? 0} done`;
  dom.itemList.textContent = '';
  for (const [index, item] of list.items.entries()) {
    dom.itemList.append(
      kit.el('li', { class: 'item', id: `cl-item-${item.id}`, dataset: { selected: 'false' } }, [
        kit.el('div', { class: 'row' }, [
          kit.el('input', {
            type: 'checkbox',
            style: 'width:auto',
            checked: item.done,
            id: `cl-toggle-${item.id}`,
            onchange: async (event) => {
              await api.patch(`/checklists/${list.id}/items/${item.id}`, { done: event.target.checked });
              await refresh();
            },
          }),
          kit.el('span', { class: 'grow', style: item.done ? 'text-decoration:line-through;color:#8b98a9' : '', text: item.text }),
          kit.el('button', { class: 'tiny', type: 'button', text: '↑', disabled: index === 0, onclick: () => move(list.id, item.id, 'up') }),
          kit.el('button', { class: 'tiny', type: 'button', text: '↓', disabled: index === list.items.length - 1, onclick: () => move(list.id, item.id, 'down') }),
          kit.el('button', { class: 'tiny danger', type: 'button', text: '✕', onclick: () => removeItem(list.id, item.id) }),
        ]),
        item.dueDate || item.note
          ? kit.el('p', { class: 'muted small', text: [item.dueDate ? `due ${item.dueDate}` : null, item.note || null].filter(Boolean).join(' · ') })
          : null,
      ]),
    );
  }
  if (list.items.length === 0) dom.itemList.append(kit.el('li', { class: 'empty', text: 'No items yet.' }));
}

function openEditor(id) {
  const list = state.checklists.find((entry) => entry.id === id);
  if (!list) return;
  state.selectedId = id;
  state.draftMode = 'edit';
  dom.form.classList.remove('hidden');
  dom.itemsBlock.classList.remove('hidden');
  dom.hint.classList.add('hidden');
  dom.mode.textContent = 'EDIT CHECKLIST';
  dom.titleInput.value = list.title;
  dom.noteInput.value = list.note ?? '';
  dom.deleteList.classList.remove('hidden');
  dom.cancelList.classList.add('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
  renderItems(list);
}

function openNew() {
  state.selectedId = null;
  state.draftMode = 'create';
  dom.form.classList.remove('hidden');
  dom.itemsBlock.classList.add('hidden');
  dom.hint.classList.add('hidden');
  dom.mode.textContent = 'NEW CHECKLIST';
  dom.titleInput.value = '';
  dom.noteInput.value = '';
  dom.deleteList.classList.add('hidden');
  dom.cancelList.classList.remove('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
  dom.titleInput.focus();
}

function closeEditor() {
  state.selectedId = null;
  state.draftMode = null;
  dom.form.classList.add('hidden');
  dom.itemsBlock.classList.add('hidden');
  dom.hint.classList.remove('hidden');
  kit.createFeedback(dom.feedback).clear();
  render();
}

async function saveChecklist(event) {
  event.preventDefault();
  const payload = { title: dom.titleInput.value.trim(), note: dom.noteInput.value };
  if (!payload.title) {
    kit.createFeedback(dom.feedback).set('title must not be empty', 'error');
    return;
  }
  dom.saveList.disabled = true;
  const feedback = kit.createFeedback(dom.feedback);
  try {
    if (state.draftMode === 'create') {
      const created = await api.post('/checklists', payload);
      await refresh();
      openEditor(created.checklist.id);
      feedback.set('saved');
    } else if (state.selectedId) {
      await api.patch(`/checklists/${encodeURIComponent(state.selectedId)}`, payload);
      await refresh();
      feedback.set('saved');
    }
  } catch (error) {
    feedback.error(error);
  } finally {
    dom.saveList.disabled = false;
  }
}

async function deleteChecklist() {
  if (!state.selectedId) return;
  const list = current();
  if (!window.confirm(`Delete checklist “${list?.title ?? ''}” and all of its items?`)) return;
  try {
    await api.del(`/checklists/${encodeURIComponent(state.selectedId)}`);
    closeEditor();
    await refresh();
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

async function addItemHandler(event) {
  event.preventDefault();
  const text = dom.itemInput.value.trim();
  if (!text || !state.selectedId) return;
  try {
    await api.post(`/checklists/${encodeURIComponent(state.selectedId)}/items`, { text });
    dom.itemInput.value = '';
    await refresh();
    kit.createFeedback(dom.itemFeedback).set('item added');
  } catch (error) {
    kit.createFeedback(dom.itemFeedback).error(error);
  }
}

async function move(listId, itemId, direction) {
  try {
    await api.post(`/checklists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}/move`, { direction });
    await refresh();
  } catch (error) {
    kit.createFeedback(dom.itemFeedback).error(error);
  }
}

async function removeItem(listId, itemId) {
  try {
    await api.del(`/checklists/${encodeURIComponent(listId)}/items/${encodeURIComponent(itemId)}`);
    await refresh();
  } catch (error) {
    kit.createFeedback(dom.itemFeedback).error(error);
  }
}

async function clearCompleted() {
  if (!state.selectedId) return;
  try {
    const result = await api.post(`/checklists/${encodeURIComponent(state.selectedId)}/clear-completed`, {});
    await refresh();
    kit.createFeedback(dom.itemFeedback).set(`removed ${result.removed} completed item(s)`);
  } catch (error) {
    kit.createFeedback(dom.itemFeedback).error(error);
  }
}
