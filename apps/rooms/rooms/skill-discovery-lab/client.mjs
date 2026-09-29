/**
 * UTOPIA · Rooms · Room 15 — Skill Discovery Lab (client).
 * Paste a GitHub reference or a sandbox path, search the curated catalog and
 * preview what a source resolves to. Nothing is installed and nothing downloads.
 */

let kit;
let api;
let dom = {};

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const referenceInput = kit.el('input', { type: 'text', id: 'sd-ref', value: 'anthropics/skills@main/skills/docx' });
  const refFeedback = kit.el('p', { class: 'feedback', id: 'sd-ref-feedback' });
  const refDetail = kit.el('div', { id: 'sd-ref-detail' });
  const planList = kit.el('div', { class: 'scroll-y', id: 'sd-plan' });

  const pathInput = kit.el('input', { type: 'text', id: 'sd-path', placeholder: 'samples/skills' });
  const subpathInput = kit.el('input', { type: 'text', id: 'sd-subpath', placeholder: '(optional)' });
  const scanFeedback = kit.el('p', { class: 'feedback', id: 'sd-scan-feedback' });
  const scanTable = kit.el('div', { class: 'scroll-y', id: 'sd-scan' });

  const queryInput = kit.el('input', { type: 'text', id: 'sd-query', placeholder: 'search the catalog…' });
  const tagInput = kit.el('input', { type: 'text', id: 'sd-tags', placeholder: 'tags (all must match)' });
  const catalogFeedback = kit.el('p', { class: 'feedback', id: 'sd-catalog-feedback' });
  const catalogList = kit.el('ul', { class: 'item-list', id: 'sd-catalog' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Source reference' }),
    kit.el('p', { class: 'muted small', text: 'owner/repo, owner/repo@ref, /tree/, /blob/, raw URLs. Resolution is planned offline; nothing is downloaded.' }),
    kit.el('label', { for: 'sd-ref', text: 'Reference' }),
    referenceInput,
    kit.el('div', { class: 'row' }, [kit.el('button', { class: 'primary', type: 'button', text: 'Resolve reference', id: 'sd-resolve' })]),
    refFeedback,
    refDetail,
    planList,
    kit.el('h2', { class: 'pane-title', style: 'margin-top:16px', text: 'Local source scan' }),
    kit.el('p', { class: 'muted small', id: 'sd-sandbox', text: 'sandbox: loading…' }),
    kit.el('label', { for: 'sd-path', text: 'Path (inside the sandbox root)' }),
    pathInput,
    kit.el('label', { for: 'sd-subpath', text: 'Subpath' }),
    subpathInput,
    kit.el('div', { class: 'row' }, [kit.el('button', { class: 'primary', type: 'button', text: 'Scan', id: 'sd-scan-run' })]),
    scanFeedback,
    scanTable,
  ]);

  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Skill catalog' }),
    kit.el('p', { class: 'muted small', text: 'Curated collections plus bundled offline skills. Live GitHub search is optional and never required.' }),
    kit.el('label', { for: 'sd-query', text: 'Query' }),
    queryInput,
    kit.el('label', { for: 'sd-tags', text: 'Tags' }),
    tagInput,
    kit.el('div', { class: 'row' }, [
      kit.el('button', { class: 'primary', type: 'button', text: 'Search catalog', id: 'sd-search' }),
      kit.el('button', { type: 'button', text: 'Live search (failed is fine)', id: 'sd-live' }),
    ]),
    catalogFeedback,
    catalogList,
  ]);

  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));
  dom = { referenceInput, refFeedback, refDetail, planList, pathInput, subpathInput, scanFeedback, scanTable, queryInput, tagInput, catalogFeedback, catalogList, sandbox: left.querySelector('#sd-sandbox') };

  document.getElementById('sd-resolve').addEventListener('click', resolveReference);
  document.getElementById('sd-scan-run').addEventListener('click', runScan);
  document.getElementById('sd-search').addEventListener('click', () => searchCatalog(false));
  document.getElementById('sd-live').addEventListener('click', () => searchCatalog(true));

  try {
    const caps = await api.get('/capabilities');
    dom.sandbox.textContent = `sandbox root: ${caps.sandbox.scanRoot}`;
  } catch (error) {
    kit.createFeedback(dom.refFeedback).error(error);
  }

  await searchCatalog(false);
  await runScan();
  return () => {};
}

function stat(label, value) {
  return kit.el('div', { class: 'stat' }, [kit.el('b', { text: String(value) }), kit.el('span', { text: label })]);
}

async function resolveReference() {
  const reference = dom.referenceInput.value.trim();
  if (!reference) {
    kit.createFeedback(dom.refFeedback).set('enter a reference first', 'warn');
    return;
  }
  try {
    const result = await api.post('/reference/parse', { reference });
    dom.refDetail.textContent = '';
    dom.planList.textContent = '';
    if (result.ok === false) {
      kit.createFeedback(dom.refFeedback).set(result.reason, 'error');
      return;
    }
    dom.refDetail.append(
      stat('kind', result.ref.kind),
      stat('owner', result.ref.owner ?? '—'),
      stat('repo', result.ref.repo ?? '—'),
      stat('attempts', result.plan.attempts?.length ?? 0),
    );
    dom.refDetail.append(kit.el('p', { class: 'mono', text: result.describe }));
    const table = kit.el('table', { class: 'grid' });
    table.append(kit.el('tr', {}, [kit.el('th', { text: '#' }), kit.el('th', { text: 'url' }), kit.el('th', { text: 'ref' }), kit.el('th', { text: 'subpath' })]));
    (result.plan.attempts ?? []).slice(0, 40).forEach((attempt, index) => {
      table.append(kit.el('tr', {}, [
        kit.el('td', { text: String(index + 1) }),
        kit.el('td', { class: 'mono', text: attempt.url }),
        kit.el('td', { text: attempt.branch ?? '—' }),
        kit.el('td', { text: attempt.subpath ?? '—' }),
      ]));
    });
    dom.planList.append(table);
    kit.createFeedback(dom.refFeedback).set(`resolved as ${result.ref.kind} with ${result.plan.attempts?.length ?? 0} offline attempt(s)`);
  } catch (error) {
    kit.createFeedback(dom.refFeedback).error(error);
  }
}

async function runScan() {
  try {
    const payload = { path: dom.pathInput.value.trim() || undefined };
    if (dom.subpathInput.value.trim()) payload.subpath = dom.subpathInput.value.trim();
    const result = await api.post('/source/scan', payload);
    dom.scanTable.textContent = '';
    if (result.ok === false) {
      kit.createFeedback(dom.scanFeedback).set(result.reason, 'error');
      return;
    }
    const rows = [...(result.bundles ?? []), ...(result.files ?? []), ...(result.candidates ?? [])];
    const table = kit.el('table', { class: 'grid' });
    table.append(kit.el('tr', {}, [kit.el('th', { text: 'name' }), kit.el('th', { text: 'description' }), kit.el('th', { text: 'path' })]));
    for (const row of rows.slice(0, 60)) {
      table.append(kit.el('tr', {}, [
        kit.el('td', { text: row.name }),
        kit.el('td', { text: row.description ?? '—' }),
        kit.el('td', { class: 'mono', text: row.file ?? row.dir ?? '' }),
      ]));
    }
    dom.scanTable.append(table);
    kit.createFeedback(dom.scanFeedback).set(
      result.isBundle ? `bundles: ${rows.length} (this path is one skill)` : `candidates: ${rows.length}`,
    );
  } catch (error) {
    kit.createFeedback(dom.scanFeedback).error(error);
  }
}

async function searchCatalog(includeLive) {
  try {
    const payload = {
      query: dom.queryInput.value.trim(),
      tags: kit.parseTagsInput(dom.tagInput.value),
      includeLive,
    };
    const result = await api.post('/catalog/search', payload);
    dom.catalogList.textContent = '';
    for (const entry of result.offline.entries) {
      dom.catalogList.append(
        kit.el('li', { class: 'item' }, [
          kit.el('div', { class: 'row between' }, [
            kit.el('h3', { text: entry.name }),
            kit.el('span', { class: 'tag', text: entry.origin }),
          ]),
          kit.el('p', { class: 'preview', text: entry.summary }),
          kit.el('p', { class: 'mono', text: entry.owner ? `${entry.owner}/${entry.repo}${entry.subpath ? `/${entry.subpath}` : ''}` : `bundled: ${entry.id}` }),
          kit.el('div', { class: 'tags' }, (entry.tags ?? []).map((tag) => kit.el('span', { class: 'tag', text: tag }))),
        ]),
      );
    }
    if (result.offline.entries.length === 0) dom.catalogList.append(kit.el('li', { class: 'empty', text: 'Nothing matched in the offline catalog.' }));
    const live = includeLive ? ` · live: ${result.liveStatus}` : '';
    const notices = result.notices.length ? ` · ${result.notices.join(' · ')}` : '';
    kit.createFeedback(dom.catalogFeedback).set(
      `offline matches: ${result.offline.total}${live}${notices}`,
      result.liveStatus === 'failed' || result.liveStatus === 'unavailable' ? 'warn' : 'ok',
    );
  } catch (error) {
    kit.createFeedback(dom.catalogFeedback).error(error);
  }
}
