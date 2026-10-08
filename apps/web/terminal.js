/**
 * UTOPIA · Web Control Surface — Universal Personal Terminal views (T1–T3).
 *
 * Owns four shell pages: `Ask/Do`, `Rooms` (Tools / Rooms), `Actions` and `Action`.
 * Like `services.js`, this module only renders; every fetch goes through the `api`
 * helper handed in by `app.js`, so auth headers, version headers and the flat
 * envelope check stay in exactly one place.
 *
 * Truthfulness rules this file must never break:
 * - Action / Ask status is rendered verbatim from the Gateway. Nothing is re-derived,
 *   upgraded or downgraded locally (a RUNNING action is never shown as done).
 * - `rooms.available === false` is a product state, not an error: rooms are shown as
 *   UNAVAILABLE with the Gateway's `reason`, and no hub iframe is offered.
 * - The hub iframe is only created when `available` is true. It is loopback-only, so a
 *   failed embed is reported as "may not be reachable from this browser" — never faked.
 * - The routing banner always states what the Gateway reported (`router`,
 *   `deterministic`, `llm`); the UI never implies an AI chose the route.
 *
 * Data models are never rewritten: room ids, action ids, `backendRef` and provenance
 * are passed through as opaque Gateway values.
 */

import { t, formatTime } from './i18n/index.js';

// Page ids owned by this module. `app.js` keeps these out of its own render switch.
export const TERMINAL_PAGES = ['Ask/Do', 'Rooms', 'Actions', 'Action'];

const MAX_ROOMS = 64;
const ACTION_LIMITS = [25, 50, 100];
const DEFAULT_ACTION_LIMIT = 50;
const SOURCE_DOC = 'Document Intake';
const SOURCE_ROOM = 'Room Pack';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const doc = () => globalThis.document;
/** Rendered host for the active view; queried first so a detached container still works. */
let host = null;
const node = (id) => host?.querySelector('#' + id) ?? doc()?.querySelector('#' + id) ?? null;
/** Translate, then escape: params are escaped so a translated value can be escaped whole. */
const tr = (key, params) => esc(params ? t(key, params) : t(key));
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' ? value.trim() : '');
const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
/** True only when a terminal view is actually rendered, so stray document clicks stay inert. */
const inTerminal = () => Boolean(host?.querySelector?.('[data-terminal]'));

const state = {
  rooms: { data: null, busy: false, error: '', open: null, note: '' },
  ask: { input: '', busy: false, result: null, targets: [], error: '', confirmed: false, note: '', pendingFor: null, pendingKey: null },
  actions: { data: null, busy: false, error: '', detail: null, selected: null, limit: DEFAULT_ACTION_LIMIT },
};
let catalogOpen=false,catalogBusy=false,preparedTarget=null,catalogEpoch=0,catalogCredential=null;
let call = null;
let context = { online: false, go: null, external: false };
let frameTimer = null;

function roomIdSet() {
  return new Set(list(state.rooms.data?.rooms).map((room) => String(room?.id ?? '')).filter(Boolean));
}
function candidatePayload(candidate) {
  const selection = {};
  if (candidate.route) selection.route = candidate.route;
  if (candidate.target) selection.target = candidate.target;
  if (candidate.operation) selection.operation = candidate.operation;
  return selection;
}

/* ---------------------------------------------------------------- shared bits */

/* `value` is the state token and stays as the CSS class; `label` is what a person
   reads. Callers that pass only a value keep the previous behaviour. */
const badge = (value, label) => `<span class="badge ${esc(value)}">${esc(label ?? value)}</span>`;
const taskId = (value) => `<div class="task-id">${esc(value)}</div>`;

/** External links leave the shell; plain anchors would hit the dev-gateway's file table. */
const rawLink = (href, label, className = 'primary') => (/^https?:\/\//i.test(String(href ?? ''))
  ? `<a class="${className} link-button" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`
  : `<button class="${className}" disabled title="${tr('terminal.rooms.linkUnsafe')}">${esc(label)}</button>`);

function targetCard(candidate, action, extra = '') {
  const sideEffect = candidate?.sideEffect === true;
  const mutating = candidate?.mutating === true;
  const available = candidate?.available !== false;
  const origin = candidate?.source === SOURCE_DOC ? tr('terminal.source.document')
    : candidate?.source === SOURCE_ROOM ? tr('terminal.source.room')
      : '';
  const flags = [
    sideEffect ? tr('terminal.flag.sideEffect') : '',
    mutating ? tr('terminal.flag.mutating') : '',
    origin ? tr('terminal.flag.source', { source: origin }) : '',
  ].filter(Boolean).join(' · ');
  const reason = text(candidate?.unavailableReason);
  return `<button class="card terminal-card" data-terminal="${action}"${extra}${available ? '' : ' disabled'}>`
    + `<strong>${esc(candidate?.label ?? candidate?.target ?? '')}</strong>`
    + `<p class="muted">${esc(candidate?.description ?? '')}</p>`
    + `<small class="task-id">${esc([candidate?.route, candidate?.operation].filter(Boolean).join(' · '))}</small>`
    + (flags ? `<small class="muted">${esc(flags)}</small>` : '')
    + (available ? '' : `<small class="muted">${tr('terminal.targetUnavailable', { reason: reason ? t('terminal.reason', { reason }) : t('terminal.reasonUnknown') })}</small>`)
    + '</button>';
}

function provenanceHistory(action) {
  const history = list(action?.provenance?.history);
  if (!history.length) return '';
  return `<h3>${tr('terminal.actions.provenance')}</h3><ol class="terminal-history">`
    + history.map((step) => `<li><time>${esc(formatTime(step?.at))}</time> ${badge(step?.status ?? '')}`
      + (text(step?.note) ? ` <span class="muted">${esc(step.note)}</span>` : '') + '</li>').join('')
    + '</ol>';
}

function actionDetailMarkup(action) {
  const target = action?.target ?? {};
  const provenance = action?.provenance ?? {};
  return `<h2>${tr('terminal.actions.detail')}</h2>`
    + `<div class="row"><div><strong>${esc(action?.actionId ?? '')}</strong>`
    + `<p>${esc(text(action?.requestedIntent) ? action.requestedIntent : tr('terminal.actions.noIntent'))}</p>`
    + `<small class="task-id">${esc([action?.route, target?.label ?? target?.id, target?.operation].filter(Boolean).join(' · '))}</small></div>`
    + badge(action?.status ?? '') + '</div>'
    + `<p>${tr('terminal.actions.progress')}: ${esc(action?.progress ?? tr('terminal.unknown'))}</p>`
    + (text(action?.resultRef?.summary) ? `<p>${tr('terminal.actions.result')}: ${esc(action.resultRef.summary)}</p>` : '')
    + (text(action?.error?.message) ? `<p class="muted">${tr('terminal.actions.error')}: ${esc(action.error.message)}${text(action?.error?.code) ? ' (' + esc(action.error.code) + ')' : ''}</p>` : '')
    + `<h3>${tr('terminal.actions.backend')}</h3><pre>${esc(JSON.stringify(action?.backendRef ?? null, null, 2))}</pre>`
    + `<h3>${tr('terminal.actions.resultRef')}</h3><pre>${esc(JSON.stringify(action?.resultRef ?? null, null, 2))}</pre>`
    + `<h3>${tr('terminal.actions.provenance')}</h3><pre>${esc(JSON.stringify(provenance, null, 2))}</pre>`
    + provenanceHistory(action)
    + `<h3>${tr('terminal.actions.record')}</h3><pre>${esc(JSON.stringify(action ?? null, null, 2))}</pre>`;
}

function askActionBlock(action) {
  if (!action?.actionId) return '';
  const summary = text(action?.resultRef?.summary)
    || text(action?.error?.message)
    || text(action?.target?.label ?? action?.target?.id)
    || tr('terminal.actions.unknownAction');
  return `<div class="row"><div><strong>${tr('terminal.ask.actionLabel')}</strong>${taskId(action.actionId)}`
    + `<p class="muted">${esc(summary)}</p></div>${badge(action?.status ?? '')}</div>`
    + `<button data-terminal="ask-open" data-action="${esc(action.actionId)}">${tr('terminal.ask.viewAction')}</button>`;
}

function askCandidates(candidates, action) {
  return `<div class="grid terminal-candidates">`
    + candidates.map((candidate, index) => targetCard(candidate, action, ` data-index="${esc(index)}"`)).join('')
    + '</div>';
}

/* UI-101 step 4: the protocol status is internal vocabulary. The badge keeps the raw
   token as its CSS class (styling) but shows a localised label, and the raw token stays
   reachable in the folded record below. */
const STATUS_LABELS={AWAITING_CONFIRMATION:'terminal.status.awaiting',AMBIGUOUS:'terminal.status.ambiguous',UNMATCHED:'terminal.status.unmatched',MATCHED:'terminal.status.matched'};
const statusLabel=(value)=>tr(STATUS_LABELS[value]||'terminal.status.matched');
function askResultMarkup() {
  const ask = state.ask;
  const result = ask.result ?? {};
  const status = text(result.status) || tr('terminal.unknown');
  const banner = `<p class="muted">${tr('terminal.ask.routerLine', {
    router: text(result.router) ? result.router : tr('terminal.unknown'),
    deterministic: result.deterministic === true ? tr('terminal.ask.yes') : tr('terminal.ask.no'),
    llm: result.llm === true ? tr('terminal.ask.yes') : tr('terminal.ask.no'),
  })}</p><p class="muted terminal-note">${tr('terminal.ask.noModel')}</p>`;
  const head = `<div class="row"><div><h2>${tr('terminal.ask.result')}</h2>`
    + `<p class="muted">${esc(text(result.text) ? result.text : '')}</p>`
    + (text(result.message) ? `<p>${esc(result.message)}</p>` : '')
    + (text(result.route) || text(result.target) ? `<small class="task-id">${esc([result.route, result.target, result.operation].filter(Boolean).join(' · '))}</small>` : '')
    + '</div>' + badge(status, statusLabel(status)) + '</div>';
  const candidates = list(result.candidates);
  if(status==='DRAFT_REQUIRED'&&result.draft){
    return head+'<button class="primary" data-terminal="ask-owner-draft">Review draft / 检查操作草稿</button>'+banner;
  }
  if (status === 'AWAITING_CONFIRMATION') {
    const candidate = result.confirmation ?? {};
    return head + `<div class="terminal-confirm"><strong>${esc(candidate.label ?? tr('terminal.ask.actionLabel'))}</strong>`
      + `<p>${esc(candidate.description ?? '')}</p>`
      + (text(candidate.operation) ? `<p class="task-id">${esc(candidate.operation)}</p>` : '')
      + `<button class="primary" data-terminal="ask-confirm">${tr('terminal.ask.confirm')}</button>`
      + `<button data-terminal="ask-cancel">${tr('terminal.ask.cancel')}</button>`
      + `<p class="muted">${tr('terminal.ask.confirmHint')}</p></div>` + banner;
  }
  if (status === 'AMBIGUOUS') return head + askCandidates(candidates.slice(0, 3), 'ask-select') + banner;
  if (status === 'UNMATCHED') {
    const manual = candidates.length ? candidates : ask.targets;
    return head + `<p class="terminal-note">${tr('terminal.ask.noMatch')}</p>`
      + (manual.length ? askCandidates(manual, 'ask-select') : `<p class="muted">${tr('terminal.ask.noTargets')}</p>`) + banner;
  }
  return head + askActionBlock(result.action)
    + `<button data-terminal="ask-toggle-record">${tr('terminal.ask.recordToggle')}</button>`
    + `<div id="ask-record"${ask.confirmed ? '' : ' hidden'}><h3>${tr('terminal.ask.recordTitle')}</h3>`
    + `<pre>${esc(JSON.stringify(result, null, 2))}</pre></div>` + banner;
}

function renderAsk(container) {
  const ask = state.ask;
  // The always-visible Ask / Do bar in index.html owns the text input and the submit button
  // (`ask-text` / `ask-submit`). This page deliberately renders neither: two elements with
  // the same id made every id-based lookup ambiguous, and a second submit path made one
  // user action post twice.
  container.innerHTML = `<section class="panel terminal-ask"><h2>${tr('terminal.ask.title')}</h2>`
    + `<p class="muted">${tr('terminal.ask.hint')}</p>`
    + `<p class="muted terminal-note">${tr('terminal.ask.barHint')}</p>`
    + `<p>${tr('catalog.hint')}</p><button data-terminal="catalog-open" ${!context.online||catalogBusy?'disabled':''}>${tr(catalogBusy?'terminal.loading':'catalog.open')}</button>`
    + (catalogOpen ? `<section id="ask-catalog"><h3>${tr('catalog.title')}</h3>${state.ask.targets.map((candidate,index)=>targetCard(candidate,'catalog-select',` data-index="${index}" data-target="${esc(candidate.target)}"`)).join('')}</section>` : '')
    + `<div class="terminal-actions"><button data-terminal="ask-clear">${tr('terminal.ask.clear')}</button></div>`
    + (ask.note ? `<p class="muted terminal-note">${esc(ask.note)}</p>` : '')
    + (ask.error ? `<p class="terminal-error" role="alert">${esc(ask.error)}</p>` : '')
    + `</section>`
    + (ask.result ? `<section class="panel" id="ask-result">${askResultMarkup()}</section>` : '');
}

function renderRooms(container) {
  const rooms = state.rooms;
  const payload = rooms.data;
  const items = list(payload?.rooms).slice(0, MAX_ROOMS);
  const available = payload?.available === true;
  const reason = text(payload?.reason);
  const open = rooms.open && roomIdSet().has(rooms.open) ? rooms.open : null;
  const hub = open && available ? rooms.hub : null;
  const body = !payload ? `<p class="muted">${tr('terminal.loading')}</p>`
    : !available
      ? `<div class="terminal-unavailable"><h2>${tr('terminal.rooms.unavailableTitle')}</h2>`
        + `<p>${reason ? tr('terminal.rooms.unavailableReason', { reason }) : tr('terminal.rooms.unavailableNoReason')}</p>`
        + `<p class="muted">${tr('terminal.rooms.loopbackNote')}</p>`
        + (text(payload.checkedAt) ? `<p class="task-id">${esc(payload.checkedAt)}</p>` : '') + '</div>'
      : `<p class="muted">${tr('terminal.rooms.hubReady', { count: items.length })}</p>`;
  const cards = available ? items.map((room) => {
    const id = String(room?.id ?? '');
    if (!id) return '';
    return `<article class="card terminal-room"><div class="row"><div>`
      + `<strong>${esc(room.label ?? id)}</strong>`
      + `<p class="muted">${esc(room.zh ?? '')}</p>`
      + `<small class="task-id">${esc(room.number ?? '')}</small><details><summary>${esc(t('common.runDetails'))}</summary><div class="task-id">${esc(id)}</div></details></div>`
      + badge(room.persistent === true ? tr('terminal.rooms.persistent') : tr('terminal.rooms.ephemeral')) + '</div>'
      + `<p>${esc(room.summary ?? '')}</p>`
      + `<small class="muted">${esc(list(room.tags).join(' · '))}</small><details><summary>${esc(t('common.runDetails'))}</summary><div class="task-id">${esc(room.lifecycle ?? '')}</div></details>`
      + `<div class="terminal-actions"><button data-terminal="room-open" data-room="${esc(id)}">${tr('terminal.rooms.open')}</button>`
      + (payload.hubUrl ? rawLink(`${String(payload.hubUrl).replace(/\/$/, '')}/#/${encodeURIComponent(id)}`, t('terminal.rooms.openTab')) : '')
      + '</div></article>';
  }).join('') : '';
  container.innerHTML = `<div id="terminal-rooms"><div class="title"><div><h1>${tr('terminal.rooms.title')}</h1>`
    + `<p class="muted">${tr('terminal.rooms.intro')}</p></div>`
    + `<button id="rooms-reload">${tr('terminal.refresh')}</button></div>`
    + (rooms.error ? `<p class="terminal-error" role="alert">${esc(rooms.error)}</p>` : '')
    + `<section class="panel">${body}${cards ? `<div class="grid terminal-room-grid">${cards}</div>` : ''}</section>`
    + (open && available ? `<section class="panel" id="terminal-hub"><div class="row"><div><h2>${tr('terminal.rooms.hubTitle')}</h2>`
      + `<p class="muted">${tr('terminal.rooms.hubCaveat')}</p></div>`
      + `<button data-terminal="room-close">${tr('terminal.rooms.close')}</button></div>`
      + (hub ? `<iframe class="terminal-frame" src="${esc(hub)}" title="${tr('terminal.rooms.frameTitle')}" sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads allow-modals" referrerpolicy="no-referrer" allow="clipboard-read; clipboard-write; downloads"></iframe>`
        : `<p class="muted">${tr('terminal.rooms.frameLoading')}</p>`)
      + `<p class="muted">${tr('terminal.rooms.linkNote')} ${rawLink(rooms.hubStandalone ?? hub ?? '', tr('terminal.rooms.openTab'))}</p>`
      + (rooms.note ? `<p class="muted terminal-note">${esc(rooms.note)}</p>` : '')
      + '</section>' : '');
}

function actionRow(action) {
  const target = action?.target ?? {};
  const label = text(target.label) ? target.label : text(target.id) ? target.id : t('terminal.actions.unknownTarget');
  const outcome = text(action?.resultRef?.summary) ? action.resultRef.summary
    : text(action?.error?.message) ? tr('terminal.actions.errorLine', { message: action.error.message })
      : text(action?.error?.code) ? tr('terminal.actions.errorLine', { message: action.error.code }) : '';
  const progress = action?.progress === undefined || action?.progress === null ? '' : ` · ${tr('terminal.actions.progress')}: ${esc(action.progress)}`;
  return `<button class="row terminal-action${state.actions.selected === action?.actionId ? ' selected' : ''}" data-terminal="action-open" data-action="${esc(action?.actionId ?? '')}">`
    + `<span class="terminal-action-main"><strong>${esc(text(action?.requestedIntent) ? action.requestedIntent : t('terminal.actions.noIntent'))}</strong>`
    + `<small class="task-id">${esc(label)}${progress}</small><details><summary>${esc(t('common.runDetails'))}</summary><div class="task-id">${esc(action?.actionId ?? '')} · ${esc(action?.route ?? '')}</div></details>`
    + (outcome ? `<small class="muted">${outcome}</small>` : '') + '</span>'
    + badge(action?.status ?? t('terminal.unknown')) + '</button>';
}

function renderActions(container) {
  const actions = state.actions;
  const items = list(actions.data?.actions);
  const options = ACTION_LIMITS.map((limit) => `<option value="${limit}"${limit === actions.limit ? ' selected' : ''}>${limit}</option>`).join('');
  container.innerHTML = `<div id="terminal-actions"><div class="title"><div><h1>${tr('terminal.actions.title')}</h1>`
    + `<p class="muted">${tr('terminal.actions.intro', { count: items.length })}</p></div>`
    + `<div class="terminal-actions"><label for="actions-limit">${tr('terminal.actions.limit')}</label>`
    + `<select id="actions-limit">${options}</select>`
    + `<button id="actions-reload">${tr('terminal.refresh')}</button></div></div>`
    + (actions.error ? `<p class="terminal-error" role="alert">${esc(actions.error)}</p>` : '')
    + `<section class="panel"><h2>${tr('terminal.actions.list')}</h2>`
    + (items.length ? items.map(actionRow).join('') : `<p class="muted">${actions.data ? tr('terminal.actions.empty') : tr('terminal.loading')}</p>`)
    + '</section>'
    + `<section class="panel" id="action-detail">${actions.action ? actionDetailMarkup(actions.action) : actions.detailBusy ? `<p class="muted">${tr('terminal.loading')}</p>` : `<p class="muted">${tr('terminal.actions.pick')}</p>`}</section></div>`;
}

/* ------------------------------------------------------------------ data load */

async function loadRooms() {
  const rooms = state.rooms;
  if (rooms.busy || rooms.data) return;
  rooms.busy = true; rooms.error = '';
  try {
    const payload = await call('rooms');
    rooms.data = payload?.rooms ?? null;
    if (!rooms.data) rooms.error = t('terminal.rooms.malformed');
  } catch (error) { rooms.error = error?.message || String(error); } finally { rooms.busy = false; }
}

async function loadActions() {
  const actions = state.actions;
  if (actions.busy) return;
  actions.busy = true; actions.error = '';
  try {
    const payload = await call('actions?limit=' + actions.limit);
    actions.data = { actions: list(payload?.actions) };
  } catch (error) { actions.error = error?.message || String(error); } finally { actions.busy = false; }
}

async function openAction(actionId) {
  if (!actionId) return;
  state.actions.selected = actionId; state.actions.action = null; state.actions.detailBusy = true; state.actions.error = '';
  try {
    const payload = await call('actions/' + encodeURIComponent(actionId));
    state.actions.action = payload?.action ?? null;
    if (state.actions.action) {
      const known = list(state.actions.data?.actions).some((item) => item?.actionId === actionId);
      if (!known) state.actions.data = { actions: [state.actions.action, ...list(state.actions.data?.actions)] };
    } else state.actions.error = t('terminal.actions.malformed');
  } catch (error) { state.actions.error = error?.message || String(error); }
  state.actions.detailBusy = false;
  controller.render();
}

async function ask(body) {
  const payload = await call('ask', body);
  return payload?.ask ?? null;
}

/** Fill the manual picker from the contract's full target list. */
async function ensureTargets() {
  if (state.ask.targets.length) return;
  try {
    const payload = await call('ask/targets');
    state.ask.targets = list(payload?.targets);
  } catch (error) { state.ask.error = error?.message || String(error); }
}

/**
 * A key for one user action.
 *
 * `crypto.randomUUID` needs a secure context and the product is served over plain HTTP on the
 * LAN, so this uses `getRandomValues`, which does not.
 */
function newIdempotencyKey() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return `web-${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

async function submitAsk(body) {
  const askState = state.ask;
  const selectedDraft=preparedTarget;
  if (askState.busy) return;
  // The same action retried (after a timeout, say) reuses its key so the gateway replays
  // instead of executing twice; a changed action mints a new key so the user can legitimately
  // ask for the same thing again.
  const signature = JSON.stringify(body);
  if (askState.pendingFor !== signature) {
    askState.pendingFor = signature;
    askState.pendingKey = newIdempotencyKey();
  }
  askState.busy = true; askState.error = ''; askState.note = '';
  try {
    const result = await ask({ ...body, idempotencyKey: askState.pendingKey });
    if (!result) { askState.error = t('terminal.ask.malformed'); return; }
    if(selectedDraft&&preparedTarget===selectedDraft&&body.selection===selectedDraft.selection)preparedTarget=null;
    askState.result = result;
    askState.confirmed = body.confirm === true;
    askState.pendingFor = null; askState.pendingKey = null;
    if (result.status === 'UNMATCHED' && !list(result.candidates).length) await ensureTargets();
  } catch (error) { askState.error = error?.message || String(error); } finally {
    askState.busy = false;
    controller.render();
  }
}

/* ---------------------------------------------------------------- open a room */

function openRoom(roomId) {
  const rooms = state.rooms;
  if (!roomId || !roomIdSet().has(roomId) || rooms.data?.available !== true) return;
  const base = text(rooms.data.hubUrl).replace(/\/$/, '');
  if (!base) { rooms.error = t('terminal.rooms.noHubUrl'); controller.render(); return; }
  rooms.open = roomId;
  /* UI-101 post-review delta: UI-103's frontmatter records a pending_seam whose CONSUMER
     side is this file - the embedded hub drops its own rail so the Web shell owns the
     frame (hub.css: body[data-embedded="true"] .rail { display:none }), and the hub reads
     the flag from location.search. The flag therefore has to go BEFORE the '#' fragment;
     appending it after would leave location.search empty and the rail would reappear
     inside the shell. Built through URL rather than string concatenation so an existing
     query on hubUrl cannot produce a second '?'. The new-tab link deliberately does NOT
     carry the flag: standalone must stay complete. */
  const frameUrl = new URL(`${base}/`);
  frameUrl.searchParams.set('embedded', '1');
  frameUrl.hash = `/${encodeURIComponent(roomId)}`;
  rooms.hub = frameUrl.toString();
  /* The new-tab link must stay STANDALONE (the hub keeps its own rail there), so it needs
     the same URL WITHOUT the flag. Sharing one value for both was a defect this delta
     introduced and its own probe caught: the remove-and-re-add is done through URL so the
     parameter is dropped cleanly rather than by string surgery. */
  const standalone = new URL(frameUrl.toString());
  standalone.searchParams.delete('embedded');
  rooms.hubStandalone = standalone.toString();
  rooms.note = '';
  clearTimeout(frameTimer);
  controller.render();
  const frame = node('terminal-hub')?.querySelector('iframe');
  if (frame) frame.addEventListener('load', () => { state.rooms.note = ''; }, { once: true });
  frameTimer = setTimeout(() => {
    const current = node('terminal-hub')?.querySelector('iframe');
    if (current && !current.contentDocument) state.rooms.note = t('terminal.rooms.frameNote');
    if (controller.isPage('Rooms')) controller.render();
  }, 12000);
}

/* ----------------------------------------------------------------- controller */

const controller = {
  isPage: (page) => TERMINAL_PAGES.includes(page),

  // The shell calls this with the same argument list as `renderTerminal`, and also calls it
  // with no arguments after a state change. Only a supplied `hooks` object refreshes the
  // context, so an internal re-render can never silently reset the current page back to the
  // one that happened to be active when the terminal was first mounted.
  render(container = host, snapshot, isOnline, api, hooks) {
    if (!container) return;
    host = container;
    if (typeof api === 'function') call = api;
    if (hooks && typeof hooks === 'object') {
      if(hooks.credentialContext!==undefined&&hooks.credentialContext!==catalogCredential){catalogCredential=hooks.credentialContext;++catalogEpoch;catalogOpen=false;catalogBusy=false;preparedTarget=null;state.ask.targets=[];}
      context = { online: isOnline === true, go: hooks.go ?? context.go, page: hooks.page ?? context.page, external: hooks.external !== false, openOwnerDraft:hooks.openOwnerDraft??context.openOwnerDraft };
    }
    const page = context.page;
    if (page === 'Rooms') renderRooms(container);
    else if (page === 'Ask/Do') renderAsk(container);
    else if (page === 'Actions') renderActions(container);
    else if (page === 'Action') {
      container.innerHTML = `<section class="panel">${state.actions.action ? actionDetailMarkup(state.actions.action)
        : state.actions.detailBusy ? `<p class="muted">${tr('terminal.loading')}</p>`
          : `<p class="muted">${tr('terminal.actions.pick')}</p>`}</section>`;
    }
    else return;
    if (page === 'Rooms' && !state.rooms.data && !state.rooms.busy && !state.rooms.error) {
      loadRooms().then(() => { if (controller.isPage(context.page)) controller.render(); });
    }
    if (page === 'Actions' && !state.actions.data && !state.actions.busy && !state.actions.error) {
      loadActions().then(() => { if (controller.isPage(context.page)) controller.render(); });
    }
    if (page === 'Action' && state.actions.selected && !state.actions.action && !state.actions.detailBusy) {
      openAction(state.actions.selected).catch(() => {});
    }
  },

  onNav() {
    state.actions.detailBusy = false;
    state.rooms.note = '';
  },

  /** Entry for the always-visible Ask / Do bar in index.html. */
  submit(value) {
    const text = String(value ?? '').trim();
    if (!text) { state.ask.error = t('terminal.ask.empty'); controller.render(); return; }
    state.ask.input = text; state.ask.confirmed = false;
    const prepared=preparedTarget;if(prepared?.text!==text)preparedTarget=null;submitAsk({ text,...(prepared?.text===text?{selection:prepared.selection}:{}) }).catch(() => {});
  },

  onClick(event) {
    const target = event.target.closest?.('[data-terminal]');
    if (!target || !host?.contains(target)) return;
    const action = target.dataset.terminal;
    if (action === 'catalog-open') {
      if(!context.online||catalogBusy)return;catalogBusy=true;state.ask.error='';controller.render();
      const epoch=catalogEpoch;call('ask/targets').then(payload=>{if(epoch!==catalogEpoch)return;state.ask.targets=list(payload?.targets);catalogOpen=true;}).catch(error=>{if(epoch!==catalogEpoch)return;state.ask.error=error.message;catalogOpen=false;}).finally(()=>{if(epoch!==catalogEpoch)return;catalogBusy=false;controller.render();});
    } else if (action === 'catalog-select') {
      const candidate=state.ask.targets[Number(target.dataset.index)];if(!context.online||candidate?.available!==true||state.ask.busy)return;
      const value=text(candidate.example)||text(candidate.label)||text(candidate.target);preparedTarget={text:value,selection:candidatePayload(candidate)};state.ask.input=value;state.ask.result=null;catalogOpen=false;controller.render();const input=doc()?.querySelector('#ask-text');if(input){input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();}
    } else if (action === 'room-open') openRoom(target.dataset.room);
    else if (action === 'room-close') { state.rooms.open = null; state.rooms.hub = null; state.rooms.hubStandalone = null; controller.render(); }
    else if (action === 'action-open') openAction(target.dataset.action).catch(() => {});
    else if (action === 'ask-open') {
      context.go?.('Actions');
      state.actions.selected = target.dataset.action;
      if (state.actions.data) controller.render();
      openAction(target.dataset.action).catch(() => {});
    } else if (action === 'ask-select') {
      const candidate = list(state.ask.result?.candidates)[Number(target.dataset.index)] ?? state.ask.targets[Number(target.dataset.index)];
      const selection = candidatePayload(candidate ?? {});
      if (!Object.keys(selection).length) return;
      submitAsk({ text: state.ask.result?.text ?? state.ask.input, selection }).catch(() => {});
    } else if (action === 'ask-owner-draft') {
      if(context.online&&state.ask.result?.status==='DRAFT_REQUIRED'&&state.ask.result?.draft)context.openOwnerDraft?.(structuredClone(state.ask.result.draft));
    } else if (action === 'ask-confirm') {
      const confirmation = state.ask.result?.confirmation ?? {};
      submitAsk({ text: state.ask.result?.text ?? state.ask.input, selection: candidatePayload(confirmation), confirm: true }).catch(() => {});
    } else if (action === 'ask-cancel') {
      state.ask.result = null; state.ask.note = t('terminal.ask.cancelled');
      state.ask.error = ''; controller.render();
    } else if (action === 'ask-toggle-record') {
      const record = node('ask-record');
      if (record) record.hidden = !record.hidden;
    } else if (action === 'ask-clear') {
      catalogOpen=false;preparedTarget=null;state.ask = { input: '', busy: false, result: null, targets: state.ask.targets, error: '', confirmed: false, note: '', pendingFor: null, pendingKey: null };
      controller.render();
    }
  },
};

doc()?.addEventListener('click', (event) => {
  if (!context.external || !inTerminal()) return;
  const id = event.target?.id;
  // `ask-submit` is NOT handled here: the shell's form owns it, and handling it in both
  // places made a single click submit twice.
  if (id === 'rooms-reload') {
    state.rooms.data = null; state.rooms.error = '';
    loadRooms().then(() => controller.render());
    return;
  }
  if (id === 'actions-reload') { loadActions().then(() => controller.render()); return; }
  controller.onClick(event);
});
doc()?.addEventListener('input',event=>{if(event.target?.id==='ask-text'&&preparedTarget&&event.target.value.trim()!==preparedTarget.text)preparedTarget=null;});

doc()?.addEventListener('change', (event) => {
  if (event.target?.id !== 'actions-limit' || !context.external) return;
  const limit = Number(event.target.value);
  if (!ACTION_LIMITS.includes(limit)) return;
  state.actions.limit = limit;
  loadActions().then(() => controller.render());
});
doc()?.addEventListener('input', (event) => {
  if (event.target?.id === 'ask-text') state.ask.input = event.target.value;
});

export function renderTerminal(container, snapshot, isOnline, api, hooks = {}) {
  if (typeof hooks.api === 'function') call = hooks.api;
  if (typeof api === 'function') call = api;
  context = { online: isOnline === true, go: hooks.go ?? null, page: hooks.page, external: true };
  controller.render(container);
  // The caller keeps this as its terminal handle (`terminal = renderTerminal(...)`), so it
  // must be the controller itself. Returning a boolean here made every later
  // `terminal.isPage(...)` / `terminal.submit(...)` a silent no-op.
  return controller;
}

export { controller as terminal };
export default { TERMINAL_PAGES, renderTerminal, terminal: controller };
