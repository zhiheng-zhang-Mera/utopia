/**
 * UTOPIA · Rooms · Room D6 — Theme Package Lab (client).
 *
 * Edit a theme package as documents, validate it against the ownership contract,
 * generate deterministic procedural assets and read the readability report.
 * Nothing is installed, nothing is applied and no file is written.
 */

let kit;
let api;
let dom = {};

const SAMPLE = {
  manifest: {
    id: 'aurora-console',
    name: 'Aurora Console',
    version: '1.0.0',
    source: 'generated',
    theme_api_version: '1.0',
    supported_apps: ['utopia'],
  },
  tokens: {
    'color.bg.base': '#0f1115',
    'color.bg.layer1': '#151922',
    'color.bg.layer2': '#1b2130',
    'color.accent.primary': '#4d93f8',
    'color.accent.secondary': '#7aa7ff',
    'color.label.primary': '#e8ecf3',
  },
  components: {
    slots: {
      'surface.worker.card': { background: '#151922', border: '1px solid #232b3b', radius: '8px' },
      'common.button.primary': { background: '#4d93f8', label: '#0d1016', radius: '8px' },
    },
    animation: { type: 'fade', intensity: 0.4 },
  },
  surfacePlan: {
    surfaces: [
      { surface: 'owned_surface', writes: true, permission: 'full' },
      { surface: 'external_shell', writes: true, permission: 'full' },
      { surface: 'owned_overlay', writes: true, permission: 'visual-only' },
      { surface: 'protected_external_surface', writes: false, permission: 'protected' },
    ],
  },
  overlayPlan: {
    enabled: true,
    input: { pointer: 'passthrough', keyboard: 'passthrough', focus: 'passthrough', scroll: 'passthrough' },
    components: { global_tint: { color: '#0b0d12', opacity: 0.18 }, vignette: { opacity: 0.12 } },
  },
  files: ['manifest.json', 'tokens.json', 'components.json', 'surface-plan.json', 'overlay-plan.json'],
};

function stringify(value) {
  return JSON.stringify(value, null, 2);
}

function parseDocument(label, text, fallback) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return fallback;
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const capabilities = await api.get('/capabilities');

  const manifestInput = kit.el('textarea', { id: 'tp-manifest', rows: '9', spellcheck: 'false' });
  const tokensInput = kit.el('textarea', { id: 'tp-tokens', rows: '9', spellcheck: 'false' });
  const componentsInput = kit.el('textarea', { id: 'tp-components', rows: '9', spellcheck: 'false' });
  const surfaceInput = kit.el('textarea', { id: 'tp-surface-plan', rows: '8', spellcheck: 'false' });
  const overlayInput = kit.el('textarea', { id: 'tp-overlay-plan', rows: '8', spellcheck: 'false' });
  const filesInput = kit.el('textarea', { id: 'tp-files', rows: '4', spellcheck: 'false' });

  const validateFeedback = kit.el('p', { class: 'feedback', id: 'tp-validate-feedback' });
  const issuesList = kit.el('div', { class: 'scroll-y', id: 'tp-issues' });
  const readabilityBox = kit.el('div', { id: 'tp-readability' });
  const reportBox = kit.el('textarea', { id: 'tp-report', rows: '10', spellcheck: 'false', readonly: 'readonly' });

  const assetKind = kit.el('select', { id: 'tp-asset-kind' }, capabilities.assets.generators.map((kind) => kit.el('option', { value: kind, text: kind })));
  const assetStyle = kit.el('input', { type: 'text', id: 'tp-asset-style', value: 'research' });
  const assetSeed = kit.el('input', { type: 'text', id: 'tp-asset-seed', value: 'demo' });
  const assetWidth = kit.el('input', { type: 'number', id: 'tp-asset-width', value: '256' });
  const assetHeight = kit.el('input', { type: 'number', id: 'tp-asset-height', value: '160' });
  const assetFeedback = kit.el('p', { class: 'feedback', id: 'tp-asset-feedback' });
  const assetBox = kit.el('div', { id: 'tp-asset' });
  const bundleBox = kit.el('div', { class: 'scroll-y', id: 'tp-bundle' });

  const gateSurface = kit.el('select', { id: 'tp-gate-surface' }, capabilities.contract.surfaces.map((id) => kit.el('option', { value: id, text: id })));
  const gateKind = kit.el('select', { id: 'tp-gate-kind' }, ['component', 'asset', 'layout', 'override'].map((kind) => kit.el('option', { value: kind, text: kind })));
  const gateFeedback = kit.el('p', { class: 'feedback', id: 'tp-gate-feedback' });

  const contractBox = kit.el('div', { id: 'tp-contract' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Package documents' }),
    kit.el('p', { class: 'muted small', text: 'Declarative data only. A package never carries executable payload and never writes a protected surface.' }),
    kit.el('div', { class: 'row' }, [
      kit.el('button', { class: 'primary', type: 'button', text: 'Validate package', id: 'tp-validate' }),
      kit.el('button', { type: 'button', text: 'Load sample', id: 'tp-sample' }),
      kit.el('button', { type: 'button', text: 'Clear', id: 'tp-clear' }),
    ]),
    validateFeedback,
    kit.el('label', { for: 'tp-manifest', text: 'manifest.json' }),
    manifestInput,
    kit.el('label', { for: 'tp-tokens', text: 'tokens.json' }),
    tokensInput,
    kit.el('label', { for: 'tp-components', text: 'components.json' }),
    componentsInput,
    kit.el('label', { for: 'tp-surface-plan', text: 'surface-plan.json' }),
    surfaceInput,
    kit.el('label', { for: 'tp-overlay-plan', text: 'overlay-plan.json' }),
    overlayInput,
    kit.el('label', { for: 'tp-files', text: 'files in the package (one per line)' }),
    filesInput,
    issuesList,
  ]);

  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Ownership contract' }),
    contractBox,
    kit.el('h2', { class: 'pane-title', style: 'margin-top:16px', text: 'Write gate' }),
    kit.el('p', { class: 'muted small', text: 'Every writer asks the contract first. A protected surface is refused even when a caller skips a higher-level check.' }),
    kit.el('label', { for: 'tp-gate-surface', text: 'Surface' }),
    gateSurface,
    kit.el('label', { for: 'tp-gate-kind', text: 'Write kind' }),
    gateKind,
    kit.el('div', { class: 'row' }, [kit.el('button', { class: 'primary', type: 'button', text: 'Check write', id: 'tp-gate' })]),
    gateFeedback,
    kit.el('h2', { class: 'pane-title', style: 'margin-top:16px', text: 'Readability' }),
    readabilityBox,
    kit.el('h2', { class: 'pane-title', style: 'margin-top:16px', text: 'Procedural assets' }),
    kit.el('p', { class: 'muted small', text: 'Every generator is a pure function of palette, style and seed, so the same seed renders byte-identical bytes.' }),
    kit.el('label', { for: 'tp-asset-kind', text: 'Asset kind' }),
    assetKind,
    kit.el('label', { for: 'tp-asset-style', text: 'Style tag' }),
    assetStyle,
    kit.el('label', { for: 'tp-asset-seed', text: 'Seed' }),
    assetSeed,
    kit.el('div', { class: 'row' }, [
      kit.el('div', {}, [kit.el('label', { for: 'tp-asset-width', text: 'Width' }), assetWidth]),
      kit.el('div', {}, [kit.el('label', { for: 'tp-asset-height', text: 'Height' }), assetHeight]),
    ]),
    kit.el('div', { class: 'row' }, [
      kit.el('button', { class: 'primary', type: 'button', text: 'Generate', id: 'tp-generate' }),
      kit.el('button', { type: 'button', text: 'Generate twice (determinism)', id: 'tp-determinism' }),
      kit.el('button', { type: 'button', text: 'Build bundle', id: 'tp-bundle-run' }),
    ]),
    assetFeedback,
    assetBox,
    bundleBox,
    kit.el('h2', { class: 'pane-title', style: 'margin-top:16px', text: 'Validation report' }),
    kit.el('div', { class: 'row' }, [kit.el('button', { type: 'button', text: 'Export report', id: 'tp-export' })]),
    reportBox,
  ]);

  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));
  dom = {
    manifestInput, tokensInput, componentsInput, surfaceInput, overlayInput, filesInput,
    validateFeedback, issuesList, readabilityBox, reportBox,
    assetKind, assetStyle, assetSeed, assetWidth, assetHeight, assetFeedback, assetBox, bundleBox,
    gateSurface, gateKind, gateFeedback, contractBox,
  };

  await renderContract();

  document.getElementById('tp-validate').addEventListener('click', validatePackage);
  document.getElementById('tp-sample').addEventListener('click', () => loadDocuments(SAMPLE));
  document.getElementById('tp-clear').addEventListener('click', () => loadDocuments({}));
  document.getElementById('tp-generate').addEventListener('click', () => runGenerate(false));
  document.getElementById('tp-determinism').addEventListener('click', () => runGenerate(true));
  document.getElementById('tp-bundle-run').addEventListener('click', runBundle);
  document.getElementById('tp-gate').addEventListener('click', runGate);
  document.getElementById('tp-export').addEventListener('click', () => {
    dom.reportBox.value = dom.reportBox.dataset.report ? dom.reportBox.dataset.report : '{}';
    kit.createFeedback(dom.validateFeedback).set('report exported below');
  });

  loadDocuments(SAMPLE);
  await validatePackage();
  return () => {};
}

async function renderContract() {
  const described = await api.get('/contract');
  dom.contractBox.textContent = '';
  const table = kit.el('table', { class: 'grid' });
  table.append(kit.el('tr', {}, [
    kit.el('th', { text: 'surface' }),
    kit.el('th', { text: 'permission' }),
    kit.el('th', { text: 'asset kinds' }),
    kit.el('th', { text: 'dom' }),
  ]));
  for (const surface of described.surfaces) {
    table.append(kit.el('tr', {}, [
      kit.el('td', { class: 'mono', text: surface.id }),
      kit.el('td', { text: surface.permission }),
      kit.el('td', { text: surface.protected ? 'none (protected)' : String(surface.assetKinds.length) }),
      kit.el('td', { text: String(surface.access.dom) }),
    ]));
  }
  dom.contractBox.append(
    table,
    kit.el('p', { class: 'muted small', text: `Theme API ${described.theme_api_version} · ${described.tokens.length} tokens · ${described.slots.length} slots · ${described.worker_states.length} worker states` }),
  );
}

function loadDocuments(documents) {
  dom.manifestInput.value = documents.manifest ? stringify(documents.manifest) : '';
  dom.tokensInput.value = documents.tokens ? stringify(documents.tokens) : '';
  dom.componentsInput.value = documents.components ? stringify(documents.components) : '';
  dom.surfaceInput.value = documents.surfacePlan ? stringify(documents.surfacePlan) : '';
  dom.overlayInput.value = documents.overlayPlan ? stringify(documents.overlayPlan) : '';
  dom.filesInput.value = documents.files ? documents.files.join('\n') : '';
}

function readDocuments() {
  return {
    manifest: parseDocument('manifest', dom.manifestInput.value, null),
    tokens: parseDocument('tokens', dom.tokensInput.value, null),
    components: parseDocument('components', dom.componentsInput.value, null),
    surfacePlan: parseDocument('surface-plan', dom.surfaceInput.value, null),
    overlayPlan: parseDocument('overlay-plan', dom.overlayInput.value, null),
    files: dom.filesInput.value.split('\n').map((line) => line.trim()).filter(Boolean),
  };
}

async function validatePackage() {
  let documents;
  try {
    documents = readDocuments();
  } catch (error) {
    kit.createFeedback(dom.validateFeedback).set(error.message, 'error');
    return;
  }
  try {
    const result = await api.post('/package/validate', documents);
    dom.issuesList.textContent = '';
    const errors = result.errors ?? [];
    const warnings = result.warnings ?? [];
    kit.createFeedback(dom.validateFeedback).set(
      result.ok ? `package accepted · ${warnings.length} warning(s)` : `package rejected · ${errors.length} error(s)`,
      result.ok ? (warnings.length ? 'warn' : 'ok') : 'error',
    );
    for (const entry of errors) {
      dom.issuesList.append(kit.el('p', { class: 'error', text: `${entry.code}: ${entry.message}` }));
    }
    for (const entry of warnings) {
      dom.issuesList.append(kit.el('p', { class: 'muted', text: `warning ${entry.code}: ${entry.message}` }));
    }
    dom.reportBox.dataset.report = JSON.stringify(result.report, null, 2);
    dom.reportBox.value = '';
    const readability = await api.post('/readability', { tokens: documents.tokens || {} });
    renderReadability(readability);
  } catch (error) {
    kit.createFeedback(dom.validateFeedback).error(error);
  }
}

function renderReadability(readability) {
  dom.readabilityBox.textContent = '';
  const table = kit.el('table', { class: 'grid' });
  table.append(kit.el('tr', {}, [kit.el('th', { text: 'pair' }), kit.el('th', { text: 'value' })]));
  for (const entry of readability.primary ?? []) {
    table.append(kit.el('tr', {}, [kit.el('td', { text: entry.key }), kit.el('td', { class: 'mono', text: String(entry.value) })]));
  }
  const swatches = kit.el('div', { class: 'tags' }, (readability.worker_states ?? []).map((entry) => kit.el('span', {
    class: 'tag',
    style: `background:${entry.color}`,
    text: entry.state,
  })));
  dom.readabilityBox.append(
    table,
    kit.el('p', { class: 'muted small', text: readability.ok ? 'readability holds' : `readability errors: ${(readability.issues ?? []).map((entry) => entry.code).join(', ')}` }),
    kit.el('p', { class: 'muted small', text: 'worker state swatches (machine state, never translated):' }),
    swatches,
  );
}

async function runGenerate(twice) {
  try {
    const payload = {
      kind: dom.assetKind.value,
      style: dom.assetStyle.value.trim() || 'research',
      seed: dom.assetSeed.value.trim() || 'demo',
      width: Number(dom.assetWidth.value) || undefined,
      height: Number(dom.assetHeight.value) || undefined,
      tokens: parseDocument('tokens', dom.tokensInput.value, null) || {},
    };
    const first = await api.post('/assets/generate', payload);
    dom.assetBox.textContent = '';
    dom.assetBox.append(
      kit.el('img', { src: first.asset.dataUri, alt: first.asset.kind, style: 'max-width:100%;border:1px solid var(--line);border-radius:8px' }),
      kit.el('p', { class: 'mono small', text: `${first.asset.kind} ${first.asset.width}x${first.asset.height} · ${first.asset.bytes} bytes` }),
      kit.el('p', { class: 'mono small', text: `sha256 ${first.asset.sha256}` }),
    );
    if (!twice) {
      kit.createFeedback(dom.assetFeedback).set(`generated ${first.asset.kind} deterministically from style + seed`);
      return;
    }
    const second = await api.post('/assets/generate', payload);
    const same = first.asset.sha256 === second.asset.sha256;
    kit.createFeedback(dom.assetFeedback).set(
      same ? `same seed, same palette: byte-identical (${first.asset.bytes} bytes)` : 'non-deterministic output detected',
      same ? 'ok' : 'error',
    );
  } catch (error) {
    kit.createFeedback(dom.assetFeedback).error(error);
  }
}

async function runBundle() {
  try {
    const result = await api.post('/assets/bundle', {
      style: dom.assetStyle.value.trim() || 'research',
      seed: dom.assetSeed.value.trim() || 'demo',
      tokens: parseDocument('tokens', dom.tokensInput.value, null) || {},
    });
    dom.bundleBox.textContent = '';
    const table = kit.el('table', { class: 'grid' });
    table.append(kit.el('tr', {}, [kit.el('th', { text: 'path' }), kit.el('th', { text: 'bytes' })]));
    for (const file of result.files) {
      table.append(kit.el('tr', {}, [kit.el('td', { class: 'mono', text: file.path }), kit.el('td', { text: String(file.bytes) })]));
    }
    dom.bundleBox.append(table);
    kit.createFeedback(dom.assetFeedback).set(`bundle: ${result.count} asset(s), all self-contained under assets/`);
  } catch (error) {
    kit.createFeedback(dom.assetFeedback).error(error);
  }
}

async function runGate() {
  try {
    const result = await api.post('/surface/write-check', {
      surface: dom.gateSurface.value,
      kind: dom.gateKind.value,
    });
    const verdict = result.verdict;
    kit.createFeedback(dom.gateFeedback).set(
      verdict.ok ? `${verdict.surface} accepts a ${dom.gateKind.value} write (${verdict.permission})` : `${verdict.code}: ${verdict.reason}`,
      verdict.ok ? 'ok' : 'error',
    );
  } catch (error) {
    kit.createFeedback(dom.gateFeedback).error(error);
  }
}
