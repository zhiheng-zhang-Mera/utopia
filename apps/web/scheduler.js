/**
 * UTOPIA · Web Control Surface — scheduler status panel (UXI-301 steps 2, 3, 5, 6).
 *
 * Renders the feed from `GET /api/v0/presentation` for a person: what is happening, why, and what
 * they may do about it. It is a pure string builder with no DOM access, so the rendering rules are
 * testable in Node against real contract DTOs rather than only in a browser.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: raw scheduler vocabulary never renders by default. It arrives
 * only inside the "Technical detail" disclosure, which is built from the adapter's `technical` block -
 * so the disclosure is the single, explicit gate rather than a convention scattered across a template.
 * That is what the workbook means by technical detail going into an expandable Advanced.
 *
 * It also never decides anything: which providers exist, whether one is selectable, and which actions
 * are offered all arrive from the feed. This file chooses words and markup, nothing else.
 */

import {t} from './i18n/index.js';
import {toSchedulerViewModel} from './scheduler-adapter.js';

const ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'};
/** Escape for both text and attribute positions; the shell's own esc is text-only. */
export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);

/**
 * How each action reaches the backend, if it does.
 *
 * This table exists because an acceptance item the independent review checks is whether the user's
 * choice REALLY RETURNS to the backend, and the honest answer differs per action:
 *
 *   - CANCEL  -> POST /api/v0/tasks/:id/cancel   (a real route, verified end to end)
 *   - RETRY   -> POST /api/v0/tasks              (a real route; "try again" means a new task, which is
 *                                                 how the shell's own Run Test Task behaves)
 *   - KEEP_WAITING -> local, and correct to be local: it means "do nothing", so there is nothing to send
 *   - CHOOSE_PROVIDER -> POST /api/v0/tasks/:id/provider-choice, a real route added for this task so the
 *                       workbook's "switch path really executable" and "the user's choice really returns
 *                       to the backend" are both true
 *   - CONFIRM -> NO ROUTE EXISTS YET, so it is rendered disabled and labelled rather than as a button
 *                that appears to work
 *
 * The UI still never DECIDES a provider: relaying a user's explicit choice is not choosing for them,
 * but until a route exists there is nothing honest to send.
 */
export const ACTION_WIRING = Object.freeze({
  CANCEL: {kind: 'backend', route: 'cancel'},
  RETRY: {kind: 'backend', route: 'create'},
  KEEP_WAITING: {kind: 'local', route: null},
  CHOOSE_PROVIDER: {kind: 'backend', route: 'providerChoice'},
  CONFIRM: {kind: 'unwired', route: null},
});

/** One task's card: user language, then the reasons, then the actions. */
function taskCard(entry, {advanced, candidateRefs,candidateLabels,busyTasks}) {
  const view = toSchedulerViewModel(entry.dto, {t, advanced});
  const providers = view.providers.length === 0
    ? `<p class="muted">${esc(t('scheduler.panel.noCandidates'))}</p>`
    : `<ul class="scheduler-providers">${view.providers.map((p) => {
      // An unavailable provider is SHOWN with its reason and is not a control. There is deliberately
      // no button and no click handler for it, so it cannot become clickable by accident.
      const state = p.selectable ? t('scheduler.panel.providerAvailable') : t('scheduler.panel.providerUnavailable');
      // The user's choice lives HERE, on the row for the service they are choosing. An unavailable
      // provider gets no control at all, which is what "visible but forced unselectable" means.
      const ref = candidateRefs[p.index];
      const label=candidateLabels[p.index]??ref??'';
      const choose = p.selectable && typeof ref === 'string' && ref.length > 0
        ? ` <button class="scheduler-provider-choose" data-scheduler-action="CHOOSE_PROVIDER" data-scheduler-route="providerChoice" data-scheduler-task="${esc(entry.taskId ?? '')}" data-scheduler-provider="${esc(ref)}">${esc(t('scheduler.panel.useThis'))}</button>`
        : '';
      return `<li class="scheduler-provider ${esc(p.severity)}" data-selectable="${p.selectable ? 'true' : 'false'}">`
        + `<span class="scheduler-provider-label">${esc(label)}</span> · <span class="scheduler-provider-state">${esc(state)}</span> `
        + `<span class="scheduler-provider-reason">${esc(p.reason)}</span>${choose}</li>`;
    }).join('')}</ul>`;

  const actions = view.actions.length === 0
    ? ''
    : `<div class="scheduler-actions">${view.actions.map((a) => {
      const wiring = ACTION_WIRING[a.token];
      // An action with no way to reach the backend is rendered DISABLED and labelled as not yet
      // available, rather than as a button that silently does nothing. A control that appears to work
      // and does not is worse than an honest gap: it teaches the user that their choice was received.
      if (wiring.kind === 'unwired') {
        return `<button class="scheduler-action" disabled aria-disabled="true" data-scheduler-unwired="${esc(a.token)}">`
          + `${esc(a.label)} · ${esc(t('scheduler.action.notWired'))}</button>`;
      }
      // A provider choice must name the service chosen. The selected candidate is the first SELECTABLE
      // one, addressed through the feed's own candidates list, so the ref sent to the backend is one the
      // producer actually offered rather than an index invented here.
      if (a.token === 'CHOOSE_PROVIDER') {
        // Deliberately NOT a submitting control: the user chooses on the provider row above, and a
        // button here that sent the first available ref would be the UI making the choice. It is an
        // instruction, so it is rendered as one, and it says the opposite thing when there is nothing
        // available to switch to.
        const anySelectable = view.providers.some((p) => p.selectable);
        const note = anySelectable ? t('scheduler.action.chooseFromList') : t('scheduler.action.nothingToSwitchTo');
        return `<span class="scheduler-action-note" data-scheduler-action-note="${esc(a.token)}">${esc(a.label)} · ${esc(note)}</span>`;
      }
      return `<button class="scheduler-action${a.primary ? ' primary' : ''}" data-scheduler-action="${esc(a.token)}" data-scheduler-task="${esc(entry.taskId ?? '')}" data-scheduler-route="${esc(wiring.route)}">${esc(a.label)}</button>`;
    }).join('')}</div>`;

  // The only place raw vocabulary is allowed, and only when the caller asked for it.
  const technical = advanced && view.technical
    ? `<details class="scheduler-technical"><summary>${esc(t('scheduler.advanced.summary'))}</summary><pre>${esc(JSON.stringify({taskId:entry.taskId,...view.technical}, null, 2))}</pre></details>`
    : '';
  const choices=entry.userChoices;
  const decision=choices?.version===1&&choices.decisionRequired===true;
  const alternate=choices?.alternateDevice;
  const busy=busyTasks.has(entry.taskId);
  const alternateChoice=decision?`<div class="scheduler-choice"><p>${esc(t('scheduler.choice.explicitPrompt'))}</p><button data-scheduler-action="ALTERNATE_DEVICE" data-scheduler-route="switchDeclined" data-scheduler-task="${esc(entry.taskId)}" data-scheduler-revision="${esc(alternate?.expectedUpdatedAt)}" ${!alternate?.allowed||busy?'disabled':''}>${esc(t('scheduler.choice.alternateDevice'))}</button>${alternate?.reason?`<p class="muted">${esc(t('scheduler.choice.reason.'+alternate.reason))}</p>`:''}<button data-scheduler-action="KEEP_WAITING" data-scheduler-route="local" data-scheduler-task="${esc(entry.taskId)}" ${busy?'disabled':''}>${esc(t('scheduler.action.keep_waiting'))}</button></div>`:'';

  return `<article class="scheduler-task ${esc(view.severity)}" data-task-ref="${esc(entry.taskId ?? '')}">`
    + `<header class="scheduler-task-head"><span class="scheduler-task-state">${esc(view.stateLabel)}</span>`
    + `</header>`
    + (view.choiceRequired ? `<p class="scheduler-question">${esc(t('scheduler.choice.prompt'))}</p>` : '')
    + (view.degraded ? `<p class="muted scheduler-degraded">${esc(t('scheduler.panel.degradedNote'))}</p>` : '')
    + providers + alternateChoice + actions + technical
    + '</article>';
}

/**
 * The whole panel.
 *
 * `feed` is the producer's response. A missing or malformed feed renders an honest "not available"
 * line rather than an invented status: an empty scheduler surface must never look like a healthy one.
 */
export function schedulerPanel(feed, {isOnline = true, advanced = false,busyTasks=new Set()} = {}) {
  const title = `<h2>${esc(t('scheduler.panel.title'))}</h2>`;
  if (!isOnline) return `<section class="panel scheduler-panel">${title}<p class="muted">${esc(t('scheduler.panel.offline'))}</p></section>`;
  const entries = Array.isArray(feed?.tasks) ? feed.tasks : null;
  if (entries === null) return `<section class="panel scheduler-panel">${title}<p class="muted">${esc(t('scheduler.panel.feedUnavailable'))}</p></section>`;
  if (entries.length === 0) return `<section class="panel scheduler-panel">${title}<p class="muted">${esc(t('scheduler.panel.idle'))}</p></section>`;
  return `<section class="panel scheduler-panel">${title}${entries.map((e) => taskCard(e, {advanced,busyTasks,candidateRefs:Array.isArray(feed?.candidates)?feed.candidates:[],candidateLabels:Array.isArray(feed?.candidateLabels)?feed.candidateLabels:[]})).join('')}</section>`;
}

export default {schedulerPanel, esc, ACTION_WIRING};
