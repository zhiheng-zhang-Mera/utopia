// The connection surface: ONE list of PCs, whichever way each of them can be reached.
//
// THE OWNER'S REQUIREMENT, STATED AS A SHAPE. Several PCs each start their own Utopia while disconnected. They may
// be in one room on one wifi, in different rooms on one network, or on different networks in different cities over
// broadband. What the user needs on the connection screen is therefore NOT "a token box" and NOT "a fixed pair":
// it is a LIST of the PCs this client can reach (any number of them, including this machine), each with the
// quickest way to get onto it, and a recommendation of which one should carry the City for everybody.
//
// WHAT THIS MODULE IS: pure presentation logic. It turns facts (this machine, what discovery found, what this
// client has joined before, what the City already carries) into rows and actions. It renders HTML and decides
// nothing about trust: every row carries `grantsTrust: false` through from discovery, and the invite/approve path
// is the existing JOIN-502 join flow, untouched.
//
// WHY ACTIONS ARE DATA AND NOT CLOSURES: the surface is re-rendered constantly by the app's existing render loop,
// so an action must survive a re-render. Each action is `{ id, kind, ref, labelKey }`, the DOM carries
// `data-connect-action` + `data-connect-ref`, and the app dispatches on a click. That also makes the action set
// testable without a DOM.
//
// THE ENTRY CHANNEL STAYS WHERE IT WAS: the invite / short code / QR / manual-token controls are NOT moved or
// re-styled by this module. `fallbackRows()` exists only to DESCRIBE those existing channels so the list can point
// at them, and the app keeps rendering the real controls in place.

import { rankPrimaryCity } from './primary-city.js';

/** Cap on rendered rows: the list is a connection screen, not an inventory. Discarded rows are counted, not hidden. */
export const MAX_CONNECT_ROWS = 12;

/** The kinds of action a row can offer. `invite` is only ever offered for a City this client is already on. */
export const CONNECT_ACTIONS = Object.freeze({
  join: 'join',        // ask to join that PC's City (the JOIN-502 request/approve flow)
  invite: 'invite',    // invite that PC to join the City this client is on (mints a utopia://pair invite)
  useSelf: 'useSelf',  // this machine hosts: connect to the City already running here
});

const isText = v => typeof v === 'string' && v.trim().length > 0;

/**
 * Where a candidate sits relative to this client, in the terms the Owner described the topology in.
 * Returned as a stable token the surface can translate, never as prose.
 */
export function scopeOf({ address = null, transport = 'unknown', cityId = null, selfCityId = null } = {}) {
  if (cityId && selfCityId && cityId === selfCityId) return 'local';
  if (typeof address === 'string' && /^(127\.0\.0\.1|localhost|::1)$/i.test(address)) return 'local';
  if (transport === 'bluetooth') return 'bluetooth';
  if (transport === 'lan') return 'lan';
  // Anything else that is reachable by an address we hold is a path that needed configuration: an invite, a VPN, a
  // forwarded port. It is legitimate and it is not "nearby", so it gets its own token rather than being called lan.
  return isText(address) ? 'remote' : 'unknown';
}

/** Which actions a row may offer, as data. `join` needs a City identity; `invite` needs US to be on a City. */
export function actionsFor({ cityRef = null, scope = 'unknown', connected = false, selfCityId = null } = {}) {
  const actions = [];
  if (!connected) return actions;
  if (cityRef && cityRef !== selfCityId) actions.push({ id: 'join:' + cityRef, kind: CONNECT_ACTIONS.join, ref: cityRef, labelKey: 'connect.action.join' });
  // Inviting asks the PC to come to US, so it is offered for every reachable PC that is not already here - and the
  // local City is ours already, so inviting it is meaningless.
  if (scope !== 'local') actions.push({ id: 'invite:' + (cityRef ?? 'unknown'), kind: CONNECT_ACTIONS.invite, ref: cityRef ?? null, labelKey: 'connect.action.invite' });
  return actions;
}

/** A short, honest capability summary. Never invents a number: missing fields are simply absent from the text. */
export function capabilityLabel(facts = null, translate = key => key) {
  if (!facts) return translate('connect.capability.unknown');
  const parts = [];
  if (Number.isFinite(facts.cores)) parts.push(translate('connect.capability.cores', { count: facts.cores }));
  if (Number.isFinite(facts.memoryFreeBytes) && Number.isFinite(facts.memoryTotalBytes) && facts.memoryTotalBytes > 0) {
    parts.push(translate('connect.capability.memory', { free: Math.round(facts.memoryFreeBytes / 1073741824), total: Math.round(facts.memoryTotalBytes / 1073741824) }));
  }
  if (isText(facts.attachment)) parts.push(translate('connect.attachment.' + facts.attachment));
  if (parts.length === 0) return translate('connect.capability.unknown');
  return parts.join(' · ');
}

/**
 * Build the whole list: this machine first, then every reached PC, then the best carrier marked.
 *
 * @param {object} input
 *   `self`        - `{ cityRef, displayName, address, transport, carrierFacts, connected, attachedNodes }` for THIS machine's City
 *   `nearby`      - discovery rows (address/transport/displayName/cityRef/carrierFacts)
 *   `remembered`  - PCs this client has joined before: `{ cityRef, displayName, address, port, lastJoinedAt }`
 *   `previousJoins` - set-like: which cityRefs are in `remembered` (used for the role tie-breaker)
 */
export function buildConnectList({ self = null, nearby = [], remembered = [], previousJoins = null, max = MAX_CONNECT_ROWS, translate = key => key } = {}) {
  const selfRef = self?.cityRef ?? null;
  const known = previousJoins instanceof Set ? previousJoins : new Set((remembered ?? []).map(r => r?.cityRef).filter(Boolean));

  const rows = [];
  const seen = new Set();
  const push = row => {
    if (!row.cityRef && !row.address) return;
    const key = row.cityRef ?? ('addr:' + row.address + ':' + row.port);
    if (seen.has(key)) return;   // discovery and memory overlap constantly; one row per PC
    seen.add(key);
    rows.push(row);
  };

  if (self && (self.cityRef || self.address)) {
    const scope = 'local';
    push({
      cityRef: selfRef,
      displayName: self.displayName ?? translate('connect.thisMachine'),
      address: self.address ?? null,
      port: self.port ?? null,
      transport: self.transport ?? 'loopback',
      scope,
      carrierFacts: self.carrierFacts ?? null,
      attachedNodes: Number.isFinite(self.attachedNodes) ? self.attachedNodes : 0,
      previouslyJoined: true,       // it is where we are, or the City we started
      reachable: true,
      source: 'self',
      actions: [{ id: 'self:' + (selfRef ?? 'local'), kind: CONNECT_ACTIONS.useSelf, ref: selfRef, labelKey: 'connect.action.useSelf' }],
    });
  }

  for (const row of Array.isArray(nearby) ? nearby : []) {
    if (!row || typeof row !== 'object') continue;
    const scope = scopeOf({ address: row.address, transport: row.transport, cityId: row.cityRef, selfCityId: selfRef });
    push({
      cityRef: row.cityRef ?? null,
      displayName: row.displayName ?? null,
      address: row.address ?? null,
      port: row.port ?? null,
      transport: row.transport ?? 'unknown',
      scope,
      carrierFacts: row.carrierFacts ?? null,
      attachedNodes: Number.isFinite(row.attachedNodes) ? row.attachedNodes : 0,
      previouslyJoined: known.has(row.cityRef),
      reachable: true,
      source: row.source ?? 'discovery',
      actions: actionsFor({ cityRef: row.cityRef, scope, connected: true, selfCityId: selfRef }),
    });
  }

  // A remembered PC that discovery did NOT find is still listed: "it worked yesterday and it is not advertising
  // today" is exactly when a user needs the direct address, and dropping it would hide the one row that can help.
  for (const row of Array.isArray(remembered) ? remembered : []) {
    if (!row || typeof row !== 'object') continue;
    const scope = scopeOf({ address: row.address, transport: 'remote', cityId: row.cityRef, selfCityId: selfRef });
    push({
      cityRef: row.cityRef ?? null,
      displayName: row.displayName ?? null,
      address: row.address ?? null,
      port: row.port ?? null,
      transport: 'remote',
      scope,
      carrierFacts: row.carrierFacts ?? null,
      attachedNodes: 0,
      previouslyJoined: true,
      reachable: Boolean(row.address),
      source: 'remembered',
      actions: actionsFor({ cityRef: row.cityRef, scope, connected: true, selfCityId: selfRef }),
    });
  }

  // The recommendation is computed over exactly the rows the user can act on, and its result is attached to the row
  // rather than shown separately, so the list and the recommendation can never disagree.
  const scored = rankPrimaryCity(rows.filter(r => r.reachable).map(r => ({
    cityRef: r.cityRef ?? r.address,
    displayName: r.displayName,
    host: r.address,
    transport: r.transport,
    scope: r.scope,
    telemetry: r.carrierFacts ? { cores: r.carrierFacts.cores ?? undefined, memory: { usedBytes: r.carrierFacts.memoryTotalBytes != null && r.carrierFacts.memoryFreeBytes != null ? r.carrierFacts.memoryTotalBytes - r.carrierFacts.memoryFreeBytes : undefined, totalBytes: r.carrierFacts.memoryTotalBytes ?? undefined } } : {},
    attachedNodes: r.attachedNodes,
    previouslyJoined: r.previouslyJoined,
  })));
  const bestRef = scored.recommended?.cityRef ?? null;
  const byRef = new Map(rows.map(r => [r.cityRef ?? r.address, r]));

  const visible = rows.slice(0, max);
  const withRecommendation = visible.map(row => {
    const scoredRow = scored.ranked.find(s => s.cityRef === (row.cityRef ?? row.address));
    return Object.freeze({
      ...row,
      score: scoredRow?.score ?? null,
      capacityKnown: scoredRow?.capacityKnown ?? false,
      recommended: bestRef !== null && (row.cityRef ?? row.address) === bestRef,
      summary: capabilityLabel(row.carrierFacts, translate),
    });
  });
  return Object.freeze({
    rows: Object.freeze(withRecommendation),
    recommendedRef: bestRef,
    reason: scored.reason,
    discarded: Math.max(0, rows.length - visible.length),
    // The existing channels, described rather than moved: the app still renders the real controls in place.
    fallbacks: fallbackRows(translate),
    selfCityRef: selfRef,
    rememberedCount: known.size,
    byRef,
  });
}

/** The other ways in, as descriptors. These are the channels that ALREADY exist on this screen. */
export function fallbackRows(translate = key => key) {
  return Object.freeze([
    { id: 'qr', labelKey: 'pairing.qr' },
    { id: 'code', labelKey: 'pairing.code' },
    { id: 'link', labelKey: 'pairing.share' },
    { id: 'manual', labelKey: 'pair.manual' },
  ].map(Object.freeze));
}

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Render the list. Every control carries its action as data, so a click survives a re-render and the dispatcher
 * reads it instead of the DOM being wired up twice.
 */
export function renderConnectList(list, { translate = key => key } = {}) {
  if (!list || !list.rows.length) return `<p class="muted">${esc(translate('connect.none'))}</p>`;
  const rows = list.rows.map(row => {
    const actions = row.actions.map(a => `<button data-connect-action="${esc(a.kind)}" data-connect-ref="${esc(a.ref ?? '')}">${esc(translate(a.labelKey))}</button>`).join('');
    const badges = [
      row.recommended ? `<span class="badge ONLINE">${esc(translate('connect.recommended'))}</span>` : '',
      row.reachable ? '' : `<span class="badge UNKNOWN">${esc(translate('connect.unreachable'))}</span>`,
    ].join('');
    const endpoint = row.address ? `${esc(row.address)}${row.port ? ':' + esc(row.port) : ''}` : esc(translate('connect.noAddress'));
    return `<li class="connect-row" data-connect-row="${esc(row.cityRef ?? row.address ?? '')}">`
      + `<div class="connect-main"><strong>${esc(row.displayName ?? translate('device.unknown'))}</strong>${badges}`
      + `<p class="muted">${esc(translate('connect.scope.' + row.scope))} · <span class="task-id">${endpoint}</span></p>`
      + `<p class="muted">${esc(row.summary)}${row.capacityKnown ? '' : ' · ' + esc(translate('connect.thinEvidence'))}</p></div>`
      + `<div class="connect-actions">${actions}</div></li>`;
  }).join('');
  const discarded = list.discarded ? `<p class="muted">${esc(translate('connect.discarded', { count: list.discarded }))}</p>` : '';
  const reason = list.recommendedRef ? `<p class="muted" data-connect-reason>${esc(recommendedReason(list, translate))}</p>` : '';
  return `<ul class="connect-list">${rows}</ul>${discarded}${reason}`;
}

/**
 * The recommendation, in words a person can act on. Deliberately NOT the scoring module's internal reason string:
 * that one talks about weights, this one talks about the machine the user is being pointed at.
 */
export function recommendedReason(list, translate = key => key) {
  const row = list.rows.find(r => r.recommended);
  if (!row) return translate('connect.recommend.none');
  const name = row.displayName ?? translate('device.unknown');
  if (row.scope === 'local') return translate('connect.recommend.self', { name });
  if (!row.capacityKnown) return translate('connect.recommend.thin', { name });
  return translate('connect.recommend.best', { name });
}
