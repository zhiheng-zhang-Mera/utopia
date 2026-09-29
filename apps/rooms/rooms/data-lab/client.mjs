/**
 * UTOPIA · Rooms · Room 07 — Data Lab (client).
 * JSON parse / pretty / minify / validate with error position, and a CSV preview.
 * Nothing is persisted.
 */

let kit;
let api;
let dom = {};

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const jsonInput = kit.el('textarea', { id: 'dl-json', rows: '12', placeholder: '{"hello": "world"}' });
  const jsonOutput = kit.el('textarea', { id: 'dl-json-output', rows: '12', readonly: true });
  const jsonFeedback = kit.el('p', { class: 'feedback', id: 'dl-json-feedback' });
  const csvInput = kit.el('textarea', { id: 'dl-csv', rows: '8', placeholder: 'name,role\nAda,engineer' });
  const csvFeedback = kit.el('p', { class: 'feedback', id: 'dl-csv-feedback' });
  const csvTable = kit.el('div', { id: 'dl-csv-table', class: 'scroll-y' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Input' }),
    kit.el('label', { for: 'dl-json', text: 'JSON' }),
    jsonInput,
    kit.el('div', { class: 'row' }, [
      kit.el('button', { type: 'button', text: 'Parse', id: 'dl-parse' }),
      kit.el('button', { type: 'button', text: 'Pretty print', id: 'dl-pretty' }),
      kit.el('button', { type: 'button', text: 'Minify', id: 'dl-minify' }),
      kit.el('button', { type: 'button', text: 'Validate', id: 'dl-validate' }),
      kit.el('button', { type: 'button', text: 'Copy result', id: 'dl-copy' }),
    ]),
    jsonFeedback,
    kit.el('label', { for: 'dl-csv', text: 'CSV (RFC4180 style)' }),
    csvInput,
    kit.el('div', { class: 'row' }, [kit.el('button', { type: 'button', text: 'Preview CSV', id: 'dl-csv-preview' })]),
    csvFeedback,
  ]);
  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Result' }),
    kit.el('p', { class: 'muted small', id: 'dl-json-type', text: '—' }),
    jsonOutput,
    kit.el('h2', { class: 'pane-title', style: 'margin-top:14px', text: 'CSV preview' }),
    csvTable,
  ]);
  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));

  dom = { jsonInput, jsonOutput, jsonFeedback, csvInput, csvFeedback, csvTable, jsonType: right.querySelector('#dl-json-type') };

  document.getElementById('dl-parse').addEventListener('click', () => jsonAction('parse'));
  document.getElementById('dl-pretty').addEventListener('click', () => jsonAction('pretty'));
  document.getElementById('dl-minify').addEventListener('click', () => jsonAction('minify'));
  document.getElementById('dl-validate').addEventListener('click', () => jsonAction('validate'));
  document.getElementById('dl-csv-preview').addEventListener('click', () => csvPreview());
  document.getElementById('dl-copy').addEventListener('click', async () => {
    const ok = await kit.copyTextFallback(dom.jsonOutput.value);
    kit.createFeedback(dom.jsonFeedback).set(ok ? 'result copied' : 'copy was blocked by the browser', ok ? 'ok' : 'warn');
  });

  return () => {};
}

async function jsonAction(mode) {
  const text = dom.jsonInput.value;
  if (!text.trim()) {
    kit.createFeedback(dom.jsonFeedback).set('paste some JSON first', 'warn');
    return;
  }
  try {
    const payload = await api.post('/json/transform', { text, mode });
    if (!payload.ok) {
      const where = payload.error.line ? `line ${payload.error.line}${payload.error.column ? `, column ${payload.error.column}` : ''}` : `position ${payload.error.position}`;
      dom.jsonOutput.value = '';
      dom.jsonType.textContent = 'invalid';
      kit.createFeedback(dom.jsonFeedback).set(`invalid JSON at ${where}: ${payload.error.message}`, 'error');
      return;
    }
    if (mode === 'validate') {
      dom.jsonType.textContent = `${payload.type} · valid`;
      kit.createFeedback(dom.jsonFeedback).set('valid JSON');
      return;
    }
    dom.jsonOutput.value = payload.value;
    dom.jsonType.textContent = payload.type;
    kit.createFeedback(dom.jsonFeedback).set(`${mode} applied`);
  } catch (error) {
    kit.createFeedback(dom.jsonFeedback).error(error);
  }
}

async function csvPreview() {
  const text = dom.csvInput.value;
  if (!text.trim()) {
    kit.createFeedback(dom.csvFeedback).set('paste some CSV first', 'warn');
    return;
  }
  try {
    const payload = await api.post('/csv/preview', { text });
    dom.csvTable.textContent = '';
    const table = kit.el('table', { class: 'grid' });
    const head = kit.el('tr', {}, payload.columns.map((column) => kit.el('th', { text: column })));
    table.append(head);
    for (const row of payload.rows) {
      table.append(kit.el('tr', {}, row.map((cell) => kit.el('td', { text: cell }))));
    }
    dom.csvTable.append(table);
    kit.createFeedback(dom.csvFeedback).set(
      `${payload.rowCount} data row(s), ${payload.columnCount} column(s)${payload.truncated ? ' · preview truncated' : ''}`,
    );
  } catch (error) {
    kit.createFeedback(dom.csvFeedback).error(error);
  }
}
