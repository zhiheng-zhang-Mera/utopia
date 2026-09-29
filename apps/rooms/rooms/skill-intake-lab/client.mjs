/**
 * UTOPIA · Rooms · Room 11 — Skill Intake Lab (client).
 *
 * Paste or load a `SKILL.md`, or drop in a `.tar` / `.tar.gz` bundle. The room
 * reports whether the skill format is acceptable and what an archive contains,
 * and never installs anything.
 */

let kit;
let api;
let dom = {};

function readFileAsText(file) {
  return file.text();
}

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

  const documentInput = kit.el('textarea', {
    id: 'si-doc',
    rows: '10',
    placeholder: '---\nname: demo-skill\ndescription: What it does\n---\n\nInstructions…',
  });
  const docFile = kit.el('input', { type: 'file', id: 'si-doc-file', accept: '.md,text/markdown,text/plain' });
  const docFeedback = kit.el('p', { class: 'feedback', id: 'si-doc-feedback' });
  const docVerdict = kit.el('div', { class: 'stat-grid', id: 'si-verdict' });
  const docDetail = kit.el('div', { id: 'si-doc-detail' });

  const archiveFile = kit.el('input', { type: 'file', id: 'si-archive', accept: '.tar,.gz,application/gzip,application/x-tar' });
  const stripInput = kit.el('input', { type: 'text', id: 'si-strip', value: '0', style: 'width:80px' });
  const archiveFeedback = kit.el('p', { class: 'feedback', id: 'si-archive-feedback' });
  const archiveSummary = kit.el('div', { class: 'stat-grid', id: 'si-archive-summary' });
  const archiveTable = kit.el('div', { class: 'scroll-y', id: 'si-archive-table' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'SKILL.md validation' }),
    kit.el('p', { class: 'muted small', text: 'Paste a skill document or load one from disk. Nothing is installed in wave 1.' }),
    kit.el('label', { for: 'si-doc', text: 'Document' }),
    documentInput,
    kit.el('div', { class: 'row' }, [
      kit.el('button', { class: 'primary', type: 'button', text: 'Validate skill', id: 'si-validate' }),
      kit.el('button', { type: 'button', text: 'Clear', id: 'si-clear' }),
      kit.el('span', { class: 'muted small', text: 'or load:' }),
      docFile,
    ]),
    docFeedback,
    docVerdict,
    docDetail,
    kit.el('h2', { class: 'pane-title', style: 'margin-top:18px', text: 'Bundle inspection' }),
    kit.el('p', { class: 'muted small', text: 'Select a local .tar or .tar.gz. Entries are inspected in memory; links, devices, absolute paths and traversal are refused.' }),
    kit.el('label', { for: 'si-archive', text: 'Archive' }),
    archiveFile,
    kit.el('label', { for: 'si-strip', text: 'Strip leading components' }),
    stripInput,
    kit.el('div', { class: 'row' }, [kit.el('button', { class: 'primary', type: 'button', text: 'Inspect archive', id: 'si-inspect' })]),
    archiveFeedback,
    archiveSummary,
    archiveTable,
  ]);

  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Donor and limits' }),
    kit.el('p', { class: 'muted small', id: 'si-capabilities', text: 'loading…' }),
  ]);
  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));

  dom = { documentInput, docFile, docFeedback, docVerdict, docDetail, archiveFile, stripInput, archiveFeedback, archiveSummary, archiveTable, capabilities: right.querySelector('#si-capabilities') };

  document.getElementById('si-validate').addEventListener('click', validateDocument);
  document.getElementById('si-clear').addEventListener('click', () => {
    dom.documentInput.value = '';
    dom.docVerdict.textContent = '';
    dom.docDetail.textContent = '';
    kit.createFeedback(dom.docFeedback).clear();
  });
  dom.docFile.addEventListener('change', async () => {
    const file = dom.docFile.files?.[0];
    if (!file) return;
    dom.documentInput.value = await readFileAsText(file);
    kit.createFeedback(dom.docFeedback).set(`loaded ${file.name} (${file.size} bytes)`);
  });
  document.getElementById('si-inspect').addEventListener('click', inspectBundle);

  try {
    const capabilities = await api.get('/capabilities');
    dom.capabilities.textContent = [
      `donor ${capabilities.donor.repository} @ ${capabilities.donor.commit.slice(0, 12)}`,
      `source: ${capabilities.donor.sourcePaths.join(', ')}`,
      `accepts: ${capabilities.accepts.join(' / ')}`,
      `installs skills: ${capabilities.installs ? 'yes' : 'no'}`,
      `limits: SKILL.md ${Math.round(capabilities.limits.maxSkillBytes / 1024)} KB, archive ${Math.round(capabilities.limits.maxArchiveBase64Bytes / 1024 / 1024)} MB`,
    ].join('\n');
  } catch (error) {
    kit.createFeedback(dom.docFeedback).error(error);
  }

  return () => {};
}

async function validateDocument() {
  const text = dom.documentInput.value;
  if (!text.trim()) {
    kit.createFeedback(dom.docFeedback).set('paste a skill document first', 'warn');
    return;
  }
  try {
    const result = await api.post('/skill/analyze', { text });
    dom.docVerdict.textContent = '';
    dom.docVerdict.append(
      stat('Verdict', result.accepted ? 'ACCEPTED' : 'REJECTED'),
      stat('Bytes', String(result.bytes)),
      stat('Name', result.name ?? '—'),
    );
    dom.docDetail.textContent = '';
    if (!result.accepted) {
      kit.createFeedback(dom.docFeedback).set(result.reason, 'error');
      return;
    }
    kit.createFeedback(dom.docFeedback).set('the skill document is acceptable');
    const skill = result.skill;
    dom.docDetail.append(
      kit.el('p', { class: 'mono', text: `name: ${skill.name}` }),
      kit.el('p', { class: 'mono', text: `description: ${skill.description}` }),
      skill.whenToUse ? kit.el('p', { class: 'mono', text: `whenToUse: ${skill.whenToUse}` }) : null,
      kit.el('p', { class: 'mono', text: `metadata: ${JSON.stringify(skill.metadata)}` }),
      kit.el('p', { class: 'mono', text: `modelInvocable: ${skill.modelInvocable} · userInvocable: ${skill.userInvocable} · body lines: ${skill.bodyLines}` }),
    );
  } catch (error) {
    kit.createFeedback(dom.docFeedback).error(error);
  }
}

async function inspectBundle() {
  const file = dom.archiveFile.files?.[0];
  if (!file) {
    kit.createFeedback(dom.archiveFeedback).set('choose an archive first', 'warn');
    return;
  }
  try {
    const base64 = await readFileAsBase64(file);
    const result = await api.post('/archive/inspect', {
      base64,
      stripComponents: Number.parseInt(dom.stripInput.value, 10) || 0,
    });
    dom.archiveSummary.textContent = '';
    dom.archiveTable.textContent = '';
    if (result.ok === false) {
      kit.createFeedback(dom.archiveFeedback).set(`refused (${result.limit}): ${result.reason}`, 'error');
      dom.archiveSummary.append(stat('Archive bytes', String(result.archiveBytes)), stat('Limit', result.limit));
      return;
    }
    dom.archiveSummary.append(
      stat('Verdict', result.verdict),
      stat('Entries', `${result.entries} (${result.fileCount} files / ${result.directoryCount} dirs)`),
      stat('Accepted bytes', String(result.bytes)),
      stat('Refused', String(result.refused.length)),
      stat('SKILL.md', result.skillDocumentPath ?? '—'),
      stat('Compression', result.gzip ? 'gzip' : 'plain tar'),
    );
    kit.createFeedback(dom.archiveFeedback).set(
      result.verdict === 'ACCEPTED' ? 'bundle looks safe to intake' : `bundle verdict: ${result.verdict}`,
      result.verdict === 'ACCEPTED' ? 'ok' : 'warn',
    );

    const rows = [
      ...result.accepted.map((entry) => ({ path: entry.path, type: entry.type, size: entry.size, note: 'accepted' })),
      ...result.refused.map((entry) => ({ path: entry.path, type: 'refused', size: 0, note: entry.reason })),
    ];
    const table = kit.el('table', { class: 'grid' });
    table.append(kit.el('tr', {}, [kit.el('th', { text: 'path' }), kit.el('th', { text: 'type' }), kit.el('th', { text: 'bytes' }), kit.el('th', { text: 'note' })]));
    for (const row of rows.slice(0, 200)) {
      table.append(kit.el('tr', {}, [
        kit.el('td', { class: 'mono', text: row.path }),
        kit.el('td', { text: row.type }),
        kit.el('td', { text: String(row.size) }),
        kit.el('td', { text: row.note }),
      ]));
    }
    dom.archiveTable.append(table);
    if (rows.length > 200) dom.archiveTable.append(kit.el('p', { class: 'muted small', text: `${rows.length - 200} more entries not shown` }));
  } catch (error) {
    kit.createFeedback(dom.archiveFeedback).error(error);
  }
}

function stat(label, value) {
  return kit.el('div', { class: 'stat' }, [kit.el('b', { text: String(value) }), kit.el('span', { text: label })]);
}
