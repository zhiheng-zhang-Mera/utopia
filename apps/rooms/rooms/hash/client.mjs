/**
 * UTOPIA · Rooms · Room 06 — Hash Room (client).
 *
 * The file is read locally with the File API and hashed with Web Crypto. Nothing
 * is uploaded: the file never leaves the page and is never written to .runtime-rooms/.
 */

let kit;
let api;
let dom = {};

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const fileInput = kit.el('input', { type: 'file', id: 'hs-file' });
  const expected = kit.el('input', { type: 'text', id: 'hs-expected', placeholder: 'expected SHA-256 (optional)' });
  const name = kit.el('p', { class: 'mono', id: 'hs-name', text: 'no file selected' });
  const size = kit.el('p', { class: 'mono', id: 'hs-size', text: '—' });
  const digest = kit.el('p', { class: 'mono', id: 'hs-digest', text: '—' });
  const verdict = kit.el('p', { class: 'feedback', id: 'hs-verdict' });
  const feedback = kit.el('p', { class: 'feedback', id: 'hs-feedback' });
  const copyButton = kit.el('button', { type: 'button', text: 'Copy hash', id: 'hs-copy', disabled: true });
  const verifyButton = kit.el('button', { type: 'button', text: 'Compare with expected', id: 'hs-verify' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Hash Room' }),
    kit.el('p', { class: 'muted small', text: 'Select a local file. It is hashed in this page and never uploaded or copied into room storage.' }),
    kit.el('label', { for: 'hs-file', text: 'File' }),
    fileInput,
    kit.el('label', { for: 'hs-expected', text: 'Expected SHA-256' }),
    expected,
    kit.el('div', { class: 'row', style: 'margin-top:8px' }, [verifyButton]),
    feedback,
  ]);
  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Result' }),
    kit.el('div', { class: 'stat' }, [kit.el('b', { class: 'mono', id: 'hs-name-b', text: 'no file' }), kit.el('span', { text: 'file name' })]),
    kit.el('p', { class: 'muted small', text: 'Size' }),
    size,
    kit.el('p', { class: 'muted small', text: 'SHA-256' }),
    digest,
    verdict,
    kit.el('div', { class: 'row' }, [copyButton]),
  ]);
  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));

  dom = { fileInput, expected, name, size, digest, verdict, feedback, copyButton, verifyButton, nameB: right.querySelector('#hs-name-b') };

  dom.fileInput.addEventListener('change', () => hashSelected());
  dom.expected.addEventListener('input', () => applyExpectation());
  dom.copyButton.addEventListener('click', async () => {
    const ok = await kit.copyTextFallback(dom.digest.textContent);
    kit.createFeedback(dom.feedback).set(ok ? 'hash copied' : 'copy was blocked by the browser', ok ? 'ok' : 'warn');
  });
  dom.verifyButton.addEventListener('click', () => applyExpectation());

  return () => {};
}

let lastDigest = null;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function applyExpectation() {
  const wanted = dom.expected.value.trim().toLowerCase();
  if (!lastDigest) {
    kit.createFeedback(dom.verdict).set('hash a file first', 'warn');
    return;
  }
  if (!wanted) {
    kit.createFeedback(dom.verdict).clear();
    return;
  }
  if (!/^[0-9a-f]{64}$/.test(wanted)) {
    kit.createFeedback(dom.verdict).set('expected value is not a 64 character hex SHA-256', 'error');
    return;
  }
  const matches = wanted === lastDigest;
  kit.createFeedback(dom.verdict).set(matches ? 'MATCH' : 'MISMATCH', matches ? 'ok' : 'error');
}

async function hashSelected() {
  const file = dom.fileInput.files?.[0];
  if (!file) return;
  dom.name.textContent = file.name;
  dom.nameB.textContent = file.name;
  dom.size.textContent = `${formatBytes(file.size)} (${file.size} bytes)`;
  kit.createFeedback(dom.feedback).set('hashing…');
  try {
    const buffer = await file.arrayBuffer();
    const hex = await kit.sha256Hex(buffer);
    if (!hex) throw new Error('Web Crypto is unavailable in this browser');
    lastDigest = hex;
    dom.digest.textContent = hex;
    dom.copyButton.disabled = false;
    kit.createFeedback(dom.feedback).set('hashed locally, nothing uploaded');
    applyExpectation();
  } catch (error) {
    dom.digest.textContent = '—';
    dom.copyButton.disabled = true;
    kit.createFeedback(dom.feedback).error(error);
  }
}
