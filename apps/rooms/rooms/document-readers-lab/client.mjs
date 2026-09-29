/**
 * UTOPIA · Rooms · Room D7b — Document Readers Lab (client).
 * Choose a document (or build a synthetic sample), read it with the real engine and
 * see what the reader really found: type, counts, warnings, preview and truncation.
 * The original file is never stored.
 */

let kit;
let api;
let dom = {};

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const capabilities = await api.get('/capabilities');

  const kindSelect = kit.el('select', { id: 'dr-kind' }, capabilities.readers.map((reader) => kit.el('option', { value: reader.kind, text: `${reader.kind} (${reader.extension})` })));
  const fileInput = kit.el('input', { type: 'file', id: 'dr-file' });
  const feedback = kit.el('p', { class: 'feedback', id: 'dr-feedback' });
  const capsBox = kit.el('div', { id: 'dr-caps' });
  const countsBox = kit.el('div', { id: 'dr-counts' });
  const warningsBox = kit.el('div', { id: 'dr-warnings' });
  const previewBox = kit.el('pre', { class: 'mono small', id: 'dr-preview' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Document' }),
    kit.el('p', { class: 'muted small', text: 'The bytes go to the reader in the city tree and nowhere else: nothing is stored, re-encoded or uploaded.' }),
    kit.el('label', { for: 'dr-kind', text: 'Reader' }),
    kindSelect,
    kit.el('label', { for: 'dr-file', text: 'Local document' }),
    fileInput,
    kit.el('div', { class: 'row' }, [
      kit.el('button', { class: 'primary', type: 'button', text: 'Read the file', id: 'dr-read-file' }),
      kit.el('button', { type: 'button', text: 'Read a built sample', id: 'dr-read-sample' }),
    ]),
    feedback,
    capsBox,
  ]);

  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'What the reader found' }),
    countsBox,
    warningsBox,
    kit.el('h2', { class: 'pane-title', style: 'margin-top:16px', text: 'Extracted preview' }),
    previewBox,
  ]);

  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));
  dom = { kindSelect, fileInput, feedback, capsBox, countsBox, warningsBox, previewBox };

  capsBox.append(
    kit.el('p', { class: 'muted small', text: `engines: ${capabilities.engines.map((engine) => `${engine.engine}${engine.available ? '' : ' (unavailable)'}`).join(', ')}` }),
    kit.el('p', { class: 'muted small', text: `room upload cap: ${capabilities.max_upload_bytes} bytes · input persisted: ${capabilities.persists_input}` }),
  );

  document.getElementById('dr-read-file').addEventListener('click', readFile);
  document.getElementById('dr-read-sample').addEventListener('click', readSample);
  return () => {};
}

async function readFile() {
  const file = dom.fileInput.files?.[0];
  if (!file) {
    kit.createFeedback(dom.feedback).set('choose a .docx, .xlsx or .pdf file first', 'warn');
    return;
  }
  const buffer = await file.arrayBuffer();
  const kind = dom.kindSelect.value;
  const base64 = bytesToBase64(new Uint8Array(buffer));
  await read({ kind, base64, fileName: file.name });
}

async function readSample() {
  try {
    const kind = dom.kindSelect.value;
    const sample = await api.post('/sample', { kind });
    kit.createFeedback(dom.feedback).set(`built a synthetic ${kind} sample (${sample.bytes} bytes) — real container, real engine`);
    await read({ kind, base64: sample.base64, fileName: sample.fileName });
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

async function read(payload) {
  try {
    const result = await api.post('/read', payload);
    dom.countsBox.textContent = '';
    dom.warningsBox.textContent = '';
    dom.previewBox.textContent = '';
    if (result.ok === false) {
      kit.createFeedback(dom.feedback).set(`${result.code}: ${result.reason}`, 'error');
      return;
    }
    kit.createFeedback(dom.feedback).set(
      `read ${result.kind} · ${result.bytes} bytes${result.truncated ? ' · truncated at a limit' : ''}`,
      result.warnings.length ? 'warn' : 'ok',
    );
    const counts = Object.entries(result.counts ?? {});
    dom.countsBox.append(kit.el('p', {
      class: 'mono',
      text: counts.length ? counts.map(([name, value]) => `${name}: ${value}`).join(' · ') : 'no countable structure',
    }));
    for (const warning of result.warnings ?? []) {
      dom.warningsBox.append(kit.el('p', { class: 'muted small', text: `warning: ${warning}` }));
    }
    dom.previewBox.textContent = String(result.preview ?? '').slice(0, 4000);
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
