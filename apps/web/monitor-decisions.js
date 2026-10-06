// MON-903: the decision provenance surface.
//
// WHAT THIS SHOWS. What the City decided, why, on which task, how long it took, whether it went to the owner - and,
// folded away, the canonical event each decision came from. Two things are deliberate:
//   * owner-required decisions are shown FIRST, because they are the only ones that need a person;
//   * the screen never claims a decision did something. Every receipt carries `appliedBy: null` and this surface says
//     so in words, so a recommendation cannot be read as a performed action.
// It also refuses to flatter the reader: an empty window says "no decision has been recorded", never "all clear".
import {t,getLocale} from './i18n/index.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const POLL_MS = 2000;

export function createMonitorDecisionsView() {
  let context = null, connectivity = null, epoch = 0, data = null, error = null, pending = false, timer = null,signature='';
  const stopPolling = () => { if (timer) { clearTimeout(timer); timer = null; } };
  function reset() { stopPolling(); context = null; connectivity = null; epoch += 1; data = null; error = null; pending = false;signature=''; }

  function render(host, {contextKey, online, api, isCurrent}) {
    if (contextKey !== context || online !== connectivity) { reset(); context = contextKey; connectivity = online; }
    const current = () => context === contextKey && connectivity === online && isCurrent();

    function draw() {
      if (!current()) return;
      const refresh=host.querySelector('#dec-refresh');if(refresh)refresh.disabled=pending||!online;
      const key=JSON.stringify([getLocale(),online,data,error]);if(signature===key&&refresh)return;signature=key;
      const opened=new Set([...host.querySelectorAll('details[open][data-provenance]')].map(element=>element.dataset.provenance));
      const metrics = data?.metrics ?? null;
      const window = data?.window ?? null;
      const decisions = window?.decisions ?? [];
      const ownerRequired = decisions.filter(row => row.ownerRequired);
      const rate = metrics?.autoResolutionRate === null || metrics?.autoResolutionRate === undefined
        ? (metrics?.autoResolutionRateReason ?? t('dec.notMeasured'))
        : `${Math.round(metrics.autoResolutionRate * 100)}% (${metrics.autoResolved}/${metrics.decisions})`;
      const row = decision => `<tr data-decision="${esc(decision.decisionId)}">
        <td>${esc(decision.triggerEvent?.kind)}</td>
        <td>${esc(decision.taskRef ?? t('dec.cityWide'))}</td>
        <td>${esc(decision.source)}</td>
        <td>${esc(decision.action)}</td>
        <td>${decision.ownerRequired ? esc(t('dec.yes')) : esc(t('dec.no'))}</td>
        <td>${esc(decision.decisionLatencyMs)}</td>
        <td>${esc(decision.queueWaitMs)}</td>
        <td><details data-provenance="${esc(decision.decisionId)}"><summary>${esc(t('dec.provenance'))}</summary><p>${esc(t('dec.prePost', {pre: decision.preState ?? t('dec.unknown'), post: decision.postState ?? t('dec.unknown')}))}</p><p>${esc(t('dec.applied', {applied: decision.appliedBy ?? t('dec.nobody')}))}</p><p>${esc(t('dec.evidence', {refs: (decision.evidenceRefs ?? []).map(ref => `${ref.source}:${ref.canonicalEventId}`).join(', ') || t('dec.none')}))}</p><pre>${esc(JSON.stringify({triggerEvent: decision.triggerEvent, decisionTrace: decision.decisionTrace, timeoutOrFallback: decision.timeoutOrFallback, escalationReason: decision.escalationReason, applicationReason: decision.applicationReason, confidence: decision.confidence, confidenceReason: decision.confidenceReason}, null, 2))}</pre></details></td>
      </tr>`;
      host.innerHTML = `<section class="panel" id="monitor-decisions" data-loaded="${Boolean(data || error)}">
        <h2>${esc(t('dec.title'))}</h2>
        <p>${esc(t('dec.hint'))}</p>
        ${!online ? `<p>${esc(t('dec.offline'))}</p>` : ''}
        ${pending && !data ? `<p>${esc(t('terminal.loading'))}</p>` : ''}
        ${error ? `<p id="dec-error" role="alert">${esc(error)}</p>` : ''}
        <button id="dec-refresh" ${pending || !online ? 'disabled' : ''}>${esc(t('dec.refresh'))}</button>
        ${data ? `
        <p id="dec-metrics">${esc(t('dec.metrics', {decisions: metrics.decisions, owner: metrics.ownerRequired, auto: rate, timeouts: metrics.timeouts}))}</p>
        <p id="dec-notblocking">${esc(t('dec.noBarrier', {value: metrics.unrelatedTaskBlocking, concurrent: metrics.concurrentDecisionTasks}))}</p>
        <h3>${esc(t('dec.ownerRequiredTitle'))}</h3>
        ${ownerRequired.length === 0 ? `<p id="dec-owner-empty">${esc(t('dec.noOwnerRequired'))}</p>` : `<ul id="dec-owner-list">${ownerRequired.map(decision => `<li data-owner-required="${esc(decision.decisionId)}">${esc(decision.triggerEvent?.kind)} · ${esc(decision.taskRef ?? t('dec.cityWide'))} · ${esc(decision.escalationReason ?? t('dec.unknown'))}</li>`).join('')}</ul>`}
        <h3>${esc(t('dec.recent'))}</h3>
        ${decisions.length === 0 ? `<p id="dec-empty">${esc(t('dec.empty'))}</p>` : `<table id="dec-table"><thead><tr><th>${esc(t('dec.trigger'))}</th><th>${esc(t('dec.task'))}</th><th>${esc(t('dec.source'))}</th><th>${esc(t('dec.action'))}</th><th>${esc(t('dec.owner'))}</th><th>${esc(t('dec.latency'))}</th><th>${esc(t('dec.queueWait'))}</th><th>${esc(t('dec.provenance'))}</th></tr></thead><tbody>${decisions.map(row).join('')}</tbody></table>`}
        ${(window?.unsupportedSources ?? []).length > 0 ? `<p id="dec-unsupported">${esc(t('dec.notObservable', {list: window.unsupportedSources.join('; ')}))}</p>` : ''}
        ${window?.retentionTruncated ? `<p id="dec-retention">${esc(t('dec.retention', {retained: window.retained, limit: window.retainedLimit}))}</p>` : ''}
        ${window?.persistence && window.persistence!=='READY' ? `<p id="dec-persistence" role="status">${esc(t('dec.persistenceUnavailable'))}</p>` : ''}
        ${(window?.failures ?? []).length > 0 ? `<p id="dec-failures">${esc(t('dec.failures', {list: window.failures.map(failure => failure.code).join(', ')}))}</p>` : ''}
        ` : ''}
      </section>`;
      host.querySelectorAll('details[data-provenance]').forEach(element=>{if(opened.has(element.dataset.provenance))element.open=true;});
      host.querySelector('#dec-refresh').onclick = () => load();
    }

    async function load() {
      if (pending || !online || !current()) return;
      const requestEpoch = ++epoch; pending = true; draw();
      try {
        const result = await api('monitor/decisions');
        if (requestEpoch !== epoch || !current()) return;
        data = result;error=null;
      } catch (reason) {
        if (requestEpoch !== epoch || !current()) return;
        error = reason?.status === 401 || reason?.status === 403 ? t('dec.ownerRequired') : t('dec.unavailable');
      } finally { if (requestEpoch === epoch) { pending = false; if (current()) draw(); } }
    }

    draw();
    if (online && !data && !error && !pending) void load();
    // The overlay records continuously, so the surface refreshes on a bounded interval while it is on screen.
    const tick = () => { if (!current() || !online) return; void load().then(() => { if (current() && online) timer = setTimeout(tick, POLL_MS); }); };
    // Canonical snapshots may render faster than POLL_MS. Keep the existing timer instead of postponing it forever.
    if (online && !timer) timer = setTimeout(tick, POLL_MS);
  }
  return {render, reset};
}
