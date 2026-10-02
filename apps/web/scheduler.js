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

/** One task's card: user language, then the reasons, then the actions. */
function taskCard(entry, {advanced}) {
  const view = toSchedulerViewModel(entry.dto, {t, advanced});
  const providers = view.providers.length === 0
    ? `<p class="muted">${esc(t('scheduler.panel.noCandidates'))}</p>`
    : `<ul class="scheduler-providers">${view.providers.map((p) => {
      // An unavailable provider is SHOWN with its reason and is not a control. There is deliberately
      // no button and no click handler for it, so it cannot become clickable by accident.
      const state = p.selectable ? t('scheduler.panel.providerAvailable') : t('scheduler.panel.providerUnavailable');
      return `<li class="scheduler-provider ${esc(p.severity)}" data-selectable="${p.selectable ? 'true' : 'false'}">`
        + `<span class="scheduler-provider-state">${esc(state)}</span> `
        + `<span class="scheduler-provider-reason">${esc(p.reason)}</span></li>`;
    }).join('')}</ul>`;

  const actions = view.actions.length === 0
    ? ''
    : `<div class="scheduler-actions">${view.actions.map((a) => `<button class="scheduler-action${a.primary ? ' primary' : ''}" data-scheduler-action="${esc(a.token)}">${esc(a.label)}</button>`).join('')}</div>`;

  // The only place raw vocabulary is allowed, and only when the caller asked for it.
  const technical = advanced && view.technical
    ? `<details class="scheduler-technical"><summary>${esc(t('scheduler.advanced.summary'))}</summary><pre>${esc(JSON.stringify(view.technical, null, 2))}</pre></details>`
    : '';

  return `<article class="scheduler-task ${esc(view.severity)}" data-task-ref="${esc(entry.taskId ?? '')}">`
    + `<header class="scheduler-task-head"><span class="scheduler-task-state">${esc(view.stateLabel)}</span>`
    + `<span class="task-id">${esc(entry.taskId ?? '')}</span></header>`
    + (view.choiceRequired ? `<p class="scheduler-question">${esc(t('scheduler.choice.prompt'))}</p>` : '')
    + (view.degraded ? `<p class="muted scheduler-degraded">${esc(t('scheduler.panel.degradedNote'))}</p>` : '')
    + providers + actions + technical
    + '</article>';
}

/**
 * The whole panel.
 *
 * `feed` is the producer's response. A missing or malformed feed renders an honest "not available"
 * line rather than an invented status: an empty scheduler surface must never look like a healthy one.
 */
export function schedulerPanel(feed, {isOnline = true, advanced = false} = {}) {
  const title = `<h2>${esc(t('scheduler.panel.title'))}</h2>`;
  if (!isOnline) return `<section class="panel scheduler-panel">${title}<p class="muted">${esc(t('scheduler.panel.offline'))}</p></section>`;
  const entries = Array.isArray(feed?.tasks) ? feed.tasks : null;
  if (entries === null) return `<section class="panel scheduler-panel">${title}<p class="muted">${esc(t('scheduler.panel.feedUnavailable'))}</p></section>`;
  if (entries.length === 0) return `<section class="panel scheduler-panel">${title}<p class="muted">${esc(t('scheduler.panel.idle'))}</p></section>`;
  return `<section class="panel scheduler-panel">${title}${entries.map((e) => taskCard(e, {advanced})).join('')}</section>`;
}

export default {schedulerPanel, esc};
