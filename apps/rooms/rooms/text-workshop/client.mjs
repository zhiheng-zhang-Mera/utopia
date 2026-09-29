/**
 * UTOPIA · Rooms · Room 05 — Text Workshop (client).
 * Transforms happen locally in the page; the server endpoint is the reference
 * implementation for the same operations and is used for the line diff.
 */

const OPERATIONS = [
  ['trim', 'Trim'],
  ['normalize-whitespace', 'Normalize whitespace'],
  ['remove-blank-lines', 'Remove blank lines'],
  ['sort-lines', 'Sort lines'],
  ['dedupe-lines', 'Dedupe lines'],
  ['upper', 'UPPER CASE'],
  ['lower', 'lower case'],
  ['title', 'Title Case'],
];

let kit;
let api;
let dom = {};

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const input = kit.el('textarea', { id: 'tw-input', rows: '12', placeholder: 'Paste text here…' });
  const output = kit.el('textarea', { id: 'tw-output', rows: '12', readonly: true });
  const stats = kit.el('div', { class: 'stat-grid', id: 'tw-stats' });
  const opRow = kit.el('div', { class: 'row', id: 'tw-ops' });
  const feedback = kit.el('p', { class: 'feedback', id: 'tw-feedback' });
  const copyButton = kit.el('button', { type: 'button', text: 'Copy result', id: 'tw-copy' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Input' }),
    stats,
    input,
  ]);
  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Operations' }),
    opRow,
    kit.el('div', { class: 'row' }, [
      kit.el('button', { type: 'button', text: 'Sort descending', id: 'tw-sort-desc' }),
      kit.el('button', { type: 'button', text: 'Dedupe ignoring case', id: 'tw-dedupe-ci' }),
    ]),
    kit.el('h2', { class: 'pane-title', style: 'margin-top:14px', text: 'Result' }),
    output,
    kit.el('div', { class: 'row' }, [copyButton]),
    feedback,
    kit.el('h2', { class: 'pane-title', style: 'margin-top:14px', text: 'Line diff (input vs result)' }),
    kit.el('div', { class: 'scroll-y', id: 'tw-diff', style: 'border:1px solid #27333f;border-radius:8px' }),
  ]);
  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));

  dom = { input, output, stats, opRow, feedback, copyButton, diff: right.querySelector('#tw-diff') };

  for (const [operation, label] of OPERATIONS) {
    dom.opRow.append(
      kit.el('button', { type: 'button', text: label, id: `tw-op-${operation}`, onclick: () => transform(operation) }),
    );
  }

  let timer = null;
  dom.input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      updateStats(dom.input.value);
      updateDiff(dom.input.value, dom.output.value);
    }, 150);
  });
  dom.copyButton.addEventListener('click', async () => {
    const ok = await kit.copyTextFallback(dom.output.value);
    kit.createFeedback(dom.feedback).set(ok ? 'result copied' : 'copy was blocked by the browser', ok ? 'ok' : 'warn');
  });
  document.getElementById('tw-sort-desc').addEventListener('click', () => transform('sort-lines', { descending: true }));
  document.getElementById('tw-dedupe-ci').addEventListener('click', () => transform('dedupe-lines', { caseInsensitive: true }));

  await updateStats('');
  return () => clearTimeout(timer);
}

function localApply(text, operation, options) {
  const lines = () => String(text).replace(/\r\n?/g, '\n').split('\n');
  switch (operation) {
    case 'trim':
      return String(text).trim();
    case 'normalize-whitespace':
      return lines().map((line) => line.replace(/[ \t]+/g, ' ').trim()).join('\n');
    case 'remove-blank-lines':
      return lines().filter((line) => line.trim() !== '').join('\n');
    case 'sort-lines': {
      const decorated = lines().map((line, index) => ({ line, index }));
      decorated.sort((a, b) => {
        const left = a.line.toLowerCase();
        const right = b.line.toLowerCase();
        if (left === right) return a.index - b.index;
        return left < right ? -1 : 1;
      });
      if (options?.descending) decorated.reverse();
      return decorated.map((item) => item.line).join('\n');
    }
    case 'dedupe-lines': {
      const seen = new Set();
      const out = [];
      for (const line of lines()) {
        const key = options?.caseInsensitive ? line.toLowerCase() : line;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(line);
      }
      return out.join('\n');
    }
    case 'upper':
      return String(text).toUpperCase();
    case 'lower':
      return String(text).toLowerCase();
    case 'title':
      return String(text).replace(/\S+/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
    default:
      return String(text);
  }
}

function localStats(text) {
  const value = String(text ?? '');
  return {
    characters: [...value].length,
    charactersNoWhitespace: value.replace(/\s/g, '').length,
    words: value.trim() ? value.trim().split(/\s+/).length : 0,
    lines: value === '' ? 0 : value.replace(/\r\n?/g, '\n').split('\n').length,
  };
}

async function updateStats(text) {
  const stats = localStats(text);
  dom.stats.textContent = '';
  for (const [label, value] of [
    ['Characters', stats.characters],
    ['No whitespace', stats.charactersNoWhitespace],
    ['Words', stats.words],
    ['Lines', stats.lines],
  ]) {
    dom.stats.append(kit.el('div', { class: 'stat', id: `tw-stat-${label.replace(/\s/g, '-').toLowerCase()}` }, [
      kit.el('b', { text: String(value) }),
      kit.el('span', { text: label }),
    ]));
  }
}

async function transform(operation, options = {}) {
  const text = dom.input.value;
  try {
    const payload = await api.post('/transform', { text, operation, ...options });
    dom.output.value = payload.result;
    await updateStats(text);
    await updateDiff(text, payload.result);
    kit.createFeedback(dom.feedback).set(`${operation} applied`);
  } catch (error) {
    // the local implementation keeps the room usable even if the endpoint fails
    dom.output.value = localApply(text, operation, options);
    await updateDiff(text, dom.output.value);
    kit.createFeedback(dom.feedback).set(`server unavailable, applied locally (${error.message})`, 'warn');
  }
}

async function updateDiff(left, right) {
  dom.diff.textContent = '';
  if (!left && !right) {
    dom.diff.append(kit.el('p', { class: 'muted small', style: 'padding:8px', text: 'No content to compare yet.' }));
    return;
  }
  let rows;
  try {
    const payload = await api.post('/diff', { left, right });
    rows = payload.rows;
  } catch {
    rows = String(left).split('\n').map((line) => ({ type: 'same', text: line }));
  }
  for (const row of rows) {
    dom.diff.append(kit.el('div', { class: `diff-row ${row.type}`, text: `${row.type === 'added' ? '+' : row.type === 'removed' ? '-' : ' '} ${row.text}` }));
  }
}
