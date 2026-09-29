/**
 * UTOPIA · Rooms · Room 14 — Document Intake Lab (client).
 * Load or paste a document, see the detected format/encoding, the parsed sections
 * with their offsets and any warnings. Nothing is written to the Knowledge Room.
 */

let kit;
let api;
let dom = {};

const SAMPLES = {
  'notes.md': '# Release plan\n\n## Scope\n\nShip the intake core.\n\n- item one\n- item two\n\n```js\nconst x = 1;\n```\n\n1. first\n2. second\n',
  'catalog.csv': 'shelf,name,trust\nutopia,budget note,HIGH\nutopia,retrieval note,MEDIUM\nside,other,LOW\n',
  'record.json': '{"id":"k-1","domain":"engineering","tags":["retrieval","budget"],"title":"Budgeted retrieval"}\n',
  'sheet.tsv': 'shelf\tname\nutopia\tnote one\nside\tnote two\n',
  'markup.xml': '<root><t>First run</t><t>Second &amp; third</t></root>\n',
  'plain.txt': '一、目标\n\n保持预算内检索。\n\n二、范围\n\n仅文本格式。\n',
};

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new Error('the file could not be read'));
    reader.readAsDataURL(file);
  });
}

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const fileInput = kit.el('input', { type: 'file', id: 'di-file' });
  const sampleRow = kit.el('div', { class: 'row', id: 'di-samples' });
  const textInput = kit.el('textarea', { id: 'di-text', rows: '10' });
  const feedback = kit.el('p', { class: 'feedback', id: 'di-feedback' });
  const stats = kit.el('div', { class: 'stat-grid', id: 'di-stats' });
  const warnings = kit.el('div', { id: 'di-warnings' });
  const table = kit.el('div', { class: 'scroll-y', id: 'di-sections' });
  const capabilities = kit.el('p', { class: 'muted small', id: 'di-capabilities', text: 'loading…' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Document Intake Lab' }),
    kit.el('p', { class: 'muted small', text: 'Text formats only in D4a. The file is decoded in the room and never written to the Knowledge Room.' }),
    kit.el('label', { for: 'di-file', text: 'Load a local file' }),
    fileInput,
    kit.el('p', { class: 'muted small', text: 'or pick a sample:' }),
    sampleRow,
    kit.el('label', { for: 'di-text', text: 'Document text' }),
    textInput,
    kit.el('div', { class: 'row' }, [
      kit.el('button', { class: 'primary', type: 'button', text: 'Ingest', id: 'di-ingest' }),
      kit.el('button', { type: 'button', text: 'Clear', id: 'di-clear' }),
    ]),
    feedback,
    capabilities,
  ]);

  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Parsed result' }),
    stats,
    warnings,
    table,
  ]);

  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));
  dom = { fileInput, sampleRow, textInput, feedback, stats, warnings, table, capabilities };
  dom.bytes = null;
  dom.fileName = 'notes.md';

  for (const name of Object.keys(SAMPLES)) {
    dom.sampleRow.append(
      kit.el('button', { type: 'button', class: 'tag-button', text: name, id: `di-sample-${name.replace(/[^a-z]/gi, '-')}`, onclick: () => loadSample(name) }),
    );
  }

  dom.fileInput.addEventListener('change', async () => {
    const file = dom.fileInput.files?.[0];
    if (!file) return;
    dom.fileName = file.name;
    dom.bytes = await readFileAsBase64(file);
    kit.createFeedback(dom.feedback).set(`loaded ${file.name} (${file.size} bytes) — press Ingest`);
  });
  document.getElementById('di-ingest').addEventListener('click', ingest);
  document.getElementById('di-clear').addEventListener('click', () => {
    dom.textInput.value = '';
    dom.bytes = null;
    dom.stats.textContent = '';
    dom.warnings.textContent = '';
    dom.table.textContent = '';
    kit.createFeedback(dom.feedback).clear();
  });

  try {
    const caps = await api.get('/capabilities');
    dom.capabilities.textContent = [
      `donor ${caps.donor.repository} @ ${caps.donor.commit.slice(0, 12)}`,
      `accepts: ${caps.accepts.join(' / ')}`,
      `deferred: ${caps.deferred.join('; ')}`,
      `writes to the knowledge room: ${caps.writesToKnowledgeRoom ? 'yes' : 'no'}`,
    ].join('\n');
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }

  loadSample('notes.md');
  return () => {};
}

function loadSample(name) {
  dom.fileName = name;
  dom.bytes = null;
  dom.textInput.value = SAMPLES[name] ?? '';
  kit.createFeedback(dom.feedback).set(`sample ${name} loaded — press Ingest`);
}

function stat(label, value) {
  return kit.el('div', { class: 'stat' }, [kit.el('b', { text: String(value) }), kit.el('span', { text: label })]);
}

async function ingest() {
  const payload = { fileName: dom.fileName };
  if (dom.bytes) payload.base64 = dom.bytes;
  else if (dom.textInput.value.trim()) payload.text = dom.textInput.value;
  else {
    kit.createFeedback(dom.feedback).set('load a file or pick a sample first', 'warn');
    return;
  }
  try {
    const result = await api.post('/ingest', payload);
    dom.stats.textContent = '';
    dom.warnings.textContent = '';
    dom.table.textContent = '';

    if (result.ok === false) {
      dom.stats.append(stat('code', result.code), stat('characters', '—'), stat('sections', '—'), stat('encoding', result.encoding));
      kit.createFeedback(dom.feedback).set(result.reason, 'error');
      return;
    }

    dom.stats.append(
      stat('format', result.format),
      stat('encoding', result.encoding),
      stat('characters', result.characters),
      stat('sections', result.sections),
      stat('content', result.contentCharacters),
      stat('preview', result.preview.length),
    );
    for (const warning of result.warnings) {
      dom.warnings.append(kit.el('p', { class: 'feedback', style: 'color:#f0c674', text: warning }));
    }
    const rows = kit.el('table', { class: 'grid' });
    rows.append(kit.el('tr', {}, [
      kit.el('th', { text: 'kind' }),
      kit.el('th', { text: 'heading' }),
      kit.el('th', { text: 'level' }),
      kit.el('th', { text: 'start-end' }),
      kit.el('th', { text: 'chars' }),
      kit.el('th', { text: 'text' }),
    ]));
    for (const section of result.preview) {
      rows.append(kit.el('tr', {}, [
        kit.el('td', { text: section.kind }),
        kit.el('td', { text: section.heading ?? '—' }),
        kit.el('td', { text: section.level === null ? '—' : String(section.level) }),
        kit.el('td', { class: 'mono', text: `${section.start}–${section.end}` }),
        kit.el('td', { text: String(section.characters) }),
        kit.el('td', { class: 'mono', text: section.text.replace(/\n/g, ' ⏎ ') }),
      ]));
    }
    dom.table.append(rows);
    if (result.sections > result.preview.length) {
      dom.table.append(kit.el('p', { class: 'muted small', text: `${result.sections - result.preview.length} more section(s) not shown` }));
    }
    kit.createFeedback(dom.feedback).set(`parsed ${result.sections} section(s) as ${result.format}`);
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}
