/**
 * UTOPIA · Rooms · Room 13 — Knowledge Core Lab (client).
 * Paste a knowledge catalog, retrieve within a character budget, route a goal to
 * a domain, and inspect supersession / conflict metadata.
 */

let kit;
let api;
let dom = {};

const SAMPLE = JSON.stringify(
  [
    {
      id: 'k-1',
      domain: 'engineering',
      shelf: 'utopia',
      tags: ['retrieval', 'budget'],
      title: 'Character budget keeps context bounded',
      content: 'Retrieval stops once the character budget is reached, so a large knowledge base still yields a bounded context.',
      source: 'plan',
      trust: 'HIGH',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    },
    {
      id: 'k-2',
      domain: 'engineering',
      shelf: 'utopia',
      tags: ['retrieval'],
      title: 'Older retrieval note',
      content: 'Superseded by k-1.',
      source: 'notes',
      trust: 'LOW',
      supersedes: 'k-0',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    },
    {
      id: 'k-3',
      domain: 'planning',
      shelf: 'utopia',
      tags: ['taxonomy'],
      title: 'Taxonomy drives routing',
      content: 'Domains, shelves and tags are derived from the catalog itself.',
      source: 'plan',
      trust: 'MEDIUM',
      conflictGroup: 'routing',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-03-01T00:00:00.000Z',
    },
    {
      id: 'k-4',
      domain: 'planning',
      shelf: 'utopia',
      tags: ['taxonomy', 'routing'],
      title: 'Alternative routing view',
      content: 'Shares a conflict group with k-3.',
      source: 'review',
      trust: 'HIGH',
      conflictGroup: 'routing',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
    },
  ],
  null,
  2,
);

export async function mount(root, roomApi, sharedKit) {
  kit = sharedKit;
  api = roomApi;

  const catalog = kit.el('textarea', { id: 'kc-catalog', rows: '12' });
  catalog.value = SAMPLE;
  const catalogFeedback = kit.el('p', { class: 'feedback', id: 'kc-catalog-feedback' });
  const taxonomyStats = kit.el('div', { class: 'stat-grid', id: 'kc-taxonomy' });
  const taxonomyDetail = kit.el('div', { id: 'kc-taxonomy-detail' });

  const goalInput = kit.el('input', { type: 'text', id: 'kc-goal', value: 'how does retrieval stay inside a budget for engineering knowledge' });
  const domainInput = kit.el('input', { type: 'text', id: 'kc-domain', placeholder: '(from route)' });
  const tagsInput = kit.el('input', { type: 'text', id: 'kc-tags', placeholder: 'retrieval, budget' });
  const trustSelect = kit.el('select', { id: 'kc-trust' }, [
    kit.el('option', { value: '', text: 'any trust' }),
    kit.el('option', { value: 'UNVERIFIED', text: 'at least UNVERIFIED' }),
    kit.el('option', { value: 'LOW', text: 'at least LOW' }),
    kit.el('option', { value: 'MEDIUM', text: 'at least MEDIUM' }),
    kit.el('option', { value: 'HIGH', text: 'at least HIGH' }),
  ]);
  const budgetInput = kit.el('input', { type: 'text', id: 'kc-budget', value: '200' });
  const retrieveFeedback = kit.el('p', { class: 'feedback', id: 'kc-retrieve-feedback' });
  const retrieveStats = kit.el('div', { class: 'stat-grid', id: 'kc-retrieve-stats' });
  const retrieveList = kit.el('ul', { class: 'item-list', id: 'kc-retrieve-list' });

  const routeFeedback = kit.el('p', { class: 'feedback', id: 'kc-route-feedback' });
  const routeDetail = kit.el('div', { id: 'kc-route-detail' });
  const conflictFeedback = kit.el('p', { class: 'feedback', id: 'kc-conflict-feedback' });
  const conflictDetail = kit.el('div', { id: 'kc-conflict-detail' });

  const left = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Knowledge catalog' }),
    kit.el('p', { class: 'muted small', text: 'Domain, shelf, tags, trust, validity, supersession and conflict metadata. No embeddings and no storage.' }),
    kit.el('label', { for: 'kc-catalog', text: 'Entries (JSON array)' }),
    catalog,
    kit.el('div', { class: 'row' }, [
      kit.el('button', { class: 'primary', type: 'button', text: 'Analyse taxonomy', id: 'kc-analyse' }),
      kit.el('button', { type: 'button', text: 'Reset sample', id: 'kc-reset' }),
    ]),
    catalogFeedback,
    taxonomyStats,
    taxonomyDetail,
    kit.el('h3', { style: 'margin-top:14px', text: 'Conflicts and supersession' }),
    kit.el('div', { class: 'row' }, [kit.el('button', { type: 'button', text: 'Inspect conflicts', id: 'kc-conflicts' })]),
    conflictFeedback,
    conflictDetail,
  ]);

  const right = kit.el('div', { class: 'pane' }, [
    kit.el('h2', { class: 'pane-title', text: 'Retrieval' }),
    kit.el('label', { for: 'kc-goal', text: 'Goal (optional: reranks by relevance)' }),
    goalInput,
    kit.el('div', { class: 'row' }, [
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'kc-domain', text: 'Domain' }), domainInput]),
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'kc-tags', text: 'Tags (all must match)' }), tagsInput]),
    ]),
    kit.el('div', { class: 'row' }, [
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'kc-trust', text: 'Trust floor' }), trustSelect]),
      kit.el('div', { class: 'grow' }, [kit.el('label', { for: 'kc-budget', text: 'maxChars' }), budgetInput]),
    ]),
    kit.el('div', { class: 'row' }, [
      kit.el('button', { class: 'primary', type: 'button', text: 'Retrieve', id: 'kc-retrieve' }),
      kit.el('button', { type: 'button', text: 'Route goal to domain', id: 'kc-route' }),
    ]),
    retrieveFeedback,
    retrieveStats,
    retrieveList,
    routeFeedback,
    routeDetail,
  ]);

  root.append(kit.el('div', { class: 'room-grid' }, [left, right]));
  dom = { catalog, catalogFeedback, taxonomyStats, taxonomyDetail, goalInput, domainInput, tagsInput, trustSelect, budgetInput, retrieveFeedback, retrieveStats, retrieveList, routeFeedback, routeDetail, conflictFeedback, conflictDetail };

  document.getElementById('kc-analyse').addEventListener('click', analyseTaxonomy);
  document.getElementById('kc-reset').addEventListener('click', () => {
    dom.catalog.value = SAMPLE;
    kit.createFeedback(dom.catalogFeedback).set('sample restored');
  });
  document.getElementById('kc-retrieve').addEventListener('click', retrieve);
  document.getElementById('kc-route').addEventListener('click', route);
  document.getElementById('kc-conflicts').addEventListener('click', inspectConflicts);

  await analyseTaxonomy();
  return () => {};
}

function stat(label, value) {
  return kit.el('div', { class: 'stat' }, [kit.el('b', { text: String(value) }), kit.el('span', { text: label })]);
}

function parseCatalog() {
  let parsed;
  try {
    parsed = JSON.parse(dom.catalog.value);
  } catch (error) {
    throw new Error(`catalog is not valid JSON: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('catalog must be a non-empty JSON array');
  return parsed;
}

async function analyseTaxonomy() {
  try {
    const entries = parseCatalog();
    const result = await api.post('/taxonomy', { entries });
    dom.taxonomyStats.textContent = '';
    dom.taxonomyStats.append(
      stat('entries', result.total),
      stat('domains', result.taxonomy.domains.length),
      stat('shelves', result.taxonomy.shelves.length),
      stat('tags', result.taxonomy.tags.length),
    );
    dom.taxonomyDetail.textContent = '';
    dom.taxonomyDetail.append(
      kit.el('p', { class: 'mono', text: `domains: ${result.taxonomy.domains.join(', ')}` }),
      kit.el('p', { class: 'mono', text: `shelves: ${result.taxonomy.shelves.join(', ')}` }),
      kit.el('p', { class: 'mono', text: `tags: ${result.taxonomy.tags.join(', ')}` }),
    );
    kit.createFeedback(dom.catalogFeedback).set(`analysed ${result.total} entries`);
  } catch (error) {
    kit.createFeedback(dom.catalogFeedback).error(error);
  }
}

async function retrieve() {
  try {
    const entries = parseCatalog();
    const query = {
      maxChars: Number.parseInt(dom.budgetInput.value, 10) || 200,
    };
    if (dom.domainInput.value.trim()) query.domain = dom.domainInput.value.trim();
    if (dom.tagsInput.value.trim()) query.tags = dom.tagsInput.value.split(',').map((tag) => tag.trim()).filter(Boolean);
    if (dom.trustSelect.value) query.trustAtLeast = dom.trustSelect.value;
    const goal = dom.goalInput.value.trim();
    const result = await api.post('/retrieve', { entries, query, ...(goal ? { goal } : {}) });

    dom.retrieveStats.textContent = '';
    dom.retrieveStats.append(
      stat('returned', result.total),
      stat('characters', result.characters),
      stat('budget', result.budget),
      stat('mode', result.mode),
    );
    dom.retrieveList.textContent = '';
    if (result.total === 0) {
      dom.retrieveList.append(kit.el('li', { class: 'empty', text: 'Nothing matched the query.' }));
    }
    for (const entry of result.entries) {
      dom.retrieveList.append(
        kit.el('li', { class: 'item' }, [
          kit.el('div', { class: 'row between' }, [
            kit.el('h3', { text: entry.title }),
            kit.el('span', { class: 'tag', text: entry.trust }),
          ]),
          kit.el('p', { class: 'mono', text: `${entry.domain} / ${entry.shelf} · ${entry.characters} chars${entry.relevance === undefined ? '' : ` · relevance ${entry.relevance}`}` }),
          kit.el('div', { class: 'tags' }, entry.tags.map((tag) => kit.el('span', { class: 'tag', text: tag }))),
        ]),
      );
    }
    kit.createFeedback(dom.retrieveFeedback).set(
      result.withinBudget ? 'retrieval stayed inside the character budget' : 'budget exceeded',
      result.withinBudget ? 'ok' : 'error',
    );
  } catch (error) {
    kit.createFeedback(dom.retrieveFeedback).error(error);
  }
}

async function route() {
  try {
    const entries = parseCatalog();
    const goal = dom.goalInput.value.trim();
    if (!goal) {
      kit.createFeedback(dom.routeFeedback).set('enter a goal first', 'warn');
      return;
    }
    const result = await api.post('/route', { entries, goal });
    dom.domainInput.value = result.query.domain ?? '';
    dom.tagsInput.value = (result.query.tags ?? []).join(', ');
    dom.routeDetail.textContent = '';
    dom.routeDetail.append(
      kit.el('p', { class: 'mono', text: `query: ${JSON.stringify(result.query)}` }),
      kit.el('p', { class: 'muted small', text: `${result.matches.length} match(es): ${result.matches.map((match) => match.id).join(', ') || 'none'}` }),
    );
    kit.createFeedback(dom.routeFeedback).set(`routed to ${result.query.domain ?? 'no domain'}`);
  } catch (error) {
    kit.createFeedback(dom.routeFeedback).error(error);
  }
}

async function inspectConflicts() {
  try {
    const entries = parseCatalog();
    const result = await api.post('/conflicts', { entries });
    const report = result.conflicts;
    dom.conflictDetail.textContent = '';
    dom.conflictDetail.append(
      kit.el('p', { class: 'mono', text: `supersedes: ${report.supersedes.map((item) => `${item.id}→${item.supersedes}${item.known ? '' : ' (missing)'}`).join(', ') || 'none'}` }),
      kit.el('p', { class: 'mono', text: `superseded: ${report.superseded.join(', ') || 'none'}` }),
      kit.el('p', { class: 'mono', text: `live: ${report.live.join(', ') || 'none'}` }),
      kit.el('p', { class: 'mono', text: `conflict groups: ${report.conflicts.map((item) => `${item.group}(${item.ids.length})`).join(', ') || 'none'}` }),
    );
    kit.createFeedback(dom.conflictFeedback).set(
      result.conflicts.danglingSupersedes.length > 0
        ? `dangling supersedes: ${result.conflicts.danglingSupersedes.join(', ')}`
        : 'supersession metadata is consistent',
      result.conflicts.danglingSupersedes.length > 0 ? 'warn' : 'ok',
    );
  } catch (error) {
    kit.createFeedback(dom.conflictFeedback).error(error);
  }
}
