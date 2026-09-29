/**
 * UTOPIA · Rooms · Room D7a — YAML Intake Lab (client).
 * Paste a YAML document (or any structured text), see the format that really ran,
 * the nested data, the deterministic sections, the warnings - and the refusal when
 * the document is not valid. Nothing is stored.
 */

let kit;
let api;
let dom = {};

const SAMPLE_YAML = [
  'shelf:',
  '  - id: trust',
  '    level: 3',
  '    tags: [review, quality]',
  '  - id: memory',
  '    level: 2',
  'owner:',
  '  name: operator',
  '  contact:',
  '    channel: local',
  '    retries: 2',
  'enabled: true',
  'reviewed_at: 2026-09-29',
].join('\n');

const SAMPLE_JSON = '{"shelf":[{"id":"trust","level":3}],"enabled":true}';

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const capabilities = await api.get('/capabilities');

  const textInput = kit.el('textarea', { id: 'yi-text', rows: '14', spellcheck: 'false' });
  const fileInput = kit.el('input', { type: 'text', id: 'yi-file', value: 'note.yaml' });
  const feedback = kit.el('p', { class: 'feedback', id: 'yi-feedback' });
  const formatBox = kit.el('div', { id: 'yi-format' });
  const warningsBox = kit.el('div', { id: 'yi-warnings' });
  const sectionsBox = kit.el('div', { class: 'scroll-y', id: 'yi-sections' });
  const renderedBox = kit.el('pre', { id: 'yi-rendered', class: 'mono small' });
  const statsBox = kit.el('div', { id: 'yi-stats' });

  const capsBox = kit.el('div', { id: 'yi-caps' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Document' }),
    kit.el('p', { class: 'muted small', text: 'A .yaml / .yml document is parsed as YAML first and only. Any other extension tries JSON, then JSON Lines, then YAML, and says so when it falls back.' }),
    kit.el('label', { for: 'yi-file', text: 'File name (the extension decides the order)' }),
    fileInput,
    kit.el('label', { for: 'yi-text', text: 'Document' }),
    textInput,
    kit.el('div', { class: 'row' }, [
      kit.el('button', { class: 'primary', type: 'button', text: 'Parse', id: 'yi-parse' }),
      kit.el('button', { type: 'button', text: 'Validate only', id: 'yi-validate' }),
      kit.el('button', { type: 'button', text: 'Sample YAML', id: 'yi-sample-yaml' }),
      kit.el('button', { type: 'button', text: 'Sample JSON', id: 'yi-sample-json' }),
      kit.el('button', { type: 'button', text: 'Break it', id: 'yi-break' }),
    ]),
    feedback,
    warningsBox,
    capsBox,
  ]);

  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Format and sections' }),
    formatBox,
    statsBox,
    sectionsBox,
    kit.el('h2', { class: 'pane-title', style: 'margin-top:16px', text: 'Deterministic rendering' }),
    renderedBox,
  ]);

  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));
  dom = { textInput, fileInput, feedback, formatBox, warningsBox, sectionsBox, renderedBox, statsBox, capsBox };

  capsBox.append(
    kit.el('p', { class: 'muted small', text: `parser: ${capabilities.parser.package} ${String(capabilities.parser.resolvedFrom || '').split('yaml@')[1]?.split(/[\\/]/)[0] ?? ''}`.trim() }),
    kit.el('p', { class: 'muted small', text: `quarantined in ${capabilities.parser.quarantinedIn}` }),
    kit.el('p', { class: 'muted small', text: `limits: ${capabilities.parser.maxBytes} bytes per document, ${capabilities.parser.maxAliasCount} aliases` }),
  );

  document.getElementById('yi-parse').addEventListener('click', () => run('parse'));
  document.getElementById('yi-validate').addEventListener('click', () => run('validate'));
  document.getElementById('yi-sample-yaml').addEventListener('click', () => {
    dom.textInput.value = SAMPLE_YAML;
    dom.fileInput.value = 'note.yaml';
  });
  document.getElementById('yi-sample-json').addEventListener('click', () => {
    dom.textInput.value = SAMPLE_JSON;
    dom.fileInput.value = 'note.json';
  });
  document.getElementById('yi-break').addEventListener('click', () => {
    dom.textInput.value = 'shelf: [trust, quality\nowner: operator';
    dom.fileInput.value = 'broken.yaml';
  });

  dom.textInput.value = SAMPLE_YAML;
  await run('parse');
  return () => {};
}

async function run(mode) {
  const payload = { text: dom.textInput.value, fileName: dom.fileInput.value.trim() };
  try {
    const result = mode === 'validate'
      ? await api.post('/yaml/validate', payload)
      : await api.post('/yaml/parse', payload);
    dom.formatBox.textContent = '';
    dom.warningsBox.textContent = '';
    dom.sectionsBox.textContent = '';
    dom.renderedBox.textContent = '';
    dom.statsBox.textContent = '';

    if (result.ok === false) {
      kit.createFeedback(dom.feedback).set(`${result.code}: ${result.reason}`, 'error');
      if (result.detail?.line) {
        dom.formatBox.append(kit.el('p', { class: 'mono small', text: `parser reported line ${result.detail.line}, column ${result.detail.column}` }));
      }
      return;
    }

    kit.createFeedback(dom.feedback).set(
      mode === 'validate' ? `valid ${result.format} (${result.bytes} bytes)` : `parsed as ${result.format}`,
      result.warnings?.length ? 'warn' : 'ok',
    );
    const declared = result.declared ?? null;
    dom.formatBox.append(kit.el('p', { class: 'mono', text: `declared: ${declared ? `${declared.format}/${declared.kind}` : 'unknown'} · parsed: ${result.format}` }));
    for (const warning of result.warnings ?? []) {
      dom.warningsBox.append(kit.el('p', { class: 'muted small', text: `warning: ${warning}` }));
    }
    if (mode === 'validate') return;

    const stats = result.stats ?? {};
    dom.statsBox.append(kit.el('p', { class: 'muted small', text: `bytes ${stats.bytes} · sections ${stats.sections} · keys ${stats.keys} · arrays ${stats.arrays} · depth ${stats.maxDepth}` }));

    const table = kit.el('table', { class: 'grid' });
    table.append(kit.el('tr', {}, [kit.el('th', { text: 'kind' }), kit.el('th', { text: 'heading' }), kit.el('th', { text: 'text' })]));
    for (const section of result.sections ?? []) {
      table.append(kit.el('tr', {}, [
        kit.el('td', { class: 'mono', text: section.kind }),
        kit.el('td', { text: section.heading ?? '—' }),
        kit.el('td', { class: 'mono small', text: String(section.text).slice(0, 120) }),
      ]));
    }
    dom.sectionsBox.append(table);
    dom.renderedBox.textContent = result.rendered ?? '';
  } catch (error) {
    kit.createFeedback(dom.feedback).error(error);
  }
}
