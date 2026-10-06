// REX-803: the campaign control surface (DIRECT_CONTROL / OBSERVABLE).
//
// WHAT THIS VIEW IS FOR. The owner picks a described experiment and one of the City's own scenarios, sets the
// repetitions, starts the campaign, can stop it, and can always see what actually happened: which repetitions were
// measured, and - for every repetition that was not - the typed reason it was not. That last part is the whole point
// of the screen. A progress bar that says "7/10" without saying why three repetitions are missing is the defect this
// surface exists to remove, so exclusions and failures are shown as prominently as successes, never collapsed.
//
// WHAT IT DELIBERATELY DOES NOT DO. It does not invent an experiment, a scenario, a repetition count or a seed. It
// never shows a result the City did not report, and it keeps every technical identifier (run reference, seed, task
// reference) behind a disclosure rather than in the primary reading. The controls are owner-only, and the view states
// that plainly when the City refuses a member.
import {t} from './i18n/index.js';
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const number = value => (Number.isFinite(value) ? String(value) : '');
const POLL_MS = 750;
const POLL_LIMIT = 400;

export function createResearchCampaignView() {
  let context = null, connectivity = null, epoch = 0, data = null, error = null, pending = false, busy = false, timer = null;
  const stopPolling = () => { if (timer) { clearTimeout(timer); timer = null; } };
  function reset() { stopPolling(); context = null; connectivity = null; epoch += 1; data = null; error = null; pending = false; busy = false; }

  function render(host, {contextKey, online, api, isCurrent}) {
    if (contextKey !== context || online !== connectivity) { reset(); context = contextKey; connectivity = online; }
    const current = () => context === contextKey && connectivity === online && isCurrent();
    const shell = () => host.querySelector('#research-campaign');
    const selection = () => ({
      experimentId: shell()?.querySelector('#rc-experiment')?.value ?? '',
      scenarioId: shell()?.querySelector('#rc-scenario')?.value ?? '',
      repetitions: Number(shell()?.querySelector('#rc-repetitions')?.value || 0),
      warmup: Number(shell()?.querySelector('#rc-warmup')?.value || 0),
      seed: shell()?.querySelector('#rc-seed')?.value ?? '',
    });
    const described = experimentId => (data?.experiments ?? []).find(experiment => experiment.experimentId === experimentId) ?? null;

    function draw() {
      if (!current()) return;
      const live = data?.live ?? null;
      const unfinished = Boolean(data?.unfinished);
      const interrupted = live?.state === 'INTERRUPTED';
      const experiments = data?.experiments ?? [];
      const scenarios = data?.scenarios ?? [];
      const chosen = selection();
      const selectedExperiment = described(chosen.experimentId) ?? experiments[0] ?? null;
      const disabled = busy || !online || pending;
      const row = run => `<tr data-rc-run="${esc(run.index)}"><td>${esc(run.index)}</td><td>${esc(run.state)}</td><td>${esc(run.warmup ? t('rc.warmupYes') : t('rc.warmupNo'))}</td><td>${esc(run.durationMs == null ? t('rc.notMeasuredValue') : number(run.durationMs))}</td><td>${esc(run.seed)}</td><td>${esc(run.result?.taskRef ?? '')}</td></tr>`;
      const reasonRow = run => `<tr data-rc-excluded="${esc(run.index)}"><td>${esc(run.index)}</td><td>${esc(run.state)}</td><td>${esc(run.reason ?? t('rc.noReasonRecorded'))}</td></tr>`;
      host.innerHTML = `<section class="panel" id="research-campaign" data-loaded="${Boolean(data || error)}">
        <h2>${esc(t('rc.title'))}</h2>
        <p>${esc(t('rc.hint'))}</p>
        ${!online ? `<p>${esc(t('rc.offline'))}</p>` : ''}
        ${pending && !data ? `<p>${esc(t('terminal.loading'))}</p>` : ''}
        ${error ? `<p id="rc-error" role="alert">${esc(error)}</p>` : ''}
        <button id="rc-refresh" ${disabled ? 'disabled' : ''}>${esc(t('rc.refresh'))}</button>
        ${data ? `
        <div class="rc-controls">
          <label for="rc-experiment">${esc(t('rc.experiment'))}</label>
          <select id="rc-experiment" ${disabled ? 'disabled' : ''}>${experiments.map(experiment => `<option value="${esc(experiment.experimentId)}" ${experiment.experimentId === selectedExperiment?.experimentId ? 'selected' : ''}>${esc(experiment.experimentId)}</option>`).join('')}</select>
          <p id="rc-experiment-facts">${selectedExperiment ? esc(t('rc.declaredRepetitions', {count: selectedExperiment.repetitions ?? t('rc.none')})) : esc(t('rc.noExperiments'))}</p>
          <p id="rc-live-topology">${esc(t('rc.liveTopology', {workers: (data?.topology?.workers ?? []).join(', ') || t('rc.none'), surfaces: (data?.topology?.surfaces ?? []).map(surface => surface.ref).join(', ') || t('rc.none')}))}</p>
          <label for="rc-scenario">${esc(t('rc.scenario'))}</label>
          <select id="rc-scenario" ${disabled ? 'disabled' : ''}>${scenarios.map(scenario => `<option value="${esc(scenario.id)}" ${scenario.id === chosen.scenarioId ? 'selected' : ''}>${esc(scenario.id)}</option>`).join('')}</select>
          <label for="rc-repetitions">${esc(t('rc.repetitions'))}</label>
          <input id="rc-repetitions" type="number" min="1" value="${esc(chosen.repetitions || selectedExperiment?.repetitions || 1)}" ${disabled ? 'disabled' : ''}>
          <label for="rc-warmup">${esc(t('rc.warmup'))}</label>
          <input id="rc-warmup" type="number" min="0" value="${esc(chosen.warmup || 0)}" ${disabled ? 'disabled' : ''}>
          <p>${esc(t('rc.warmupNote'))}</p>
          <label for="rc-seed">${esc(t('rc.seed'))}</label>
          <input id="rc-seed" type="text" value="${esc(chosen.seed)}" placeholder="${esc(t('rc.seedPlaceholder'))}" ${disabled ? 'disabled' : ''}>
          <button id="rc-start" ${disabled || experiments.length === 0 || scenarios.length === 0 ? 'disabled' : ''}>${esc(t('rc.start'))}</button>
          <button id="rc-stop" ${disabled || live?.state !== 'RUNNING' ? 'disabled' : ''}>${esc(t('rc.stop'))}</button>
          ${interrupted || (unfinished && live?.state !== 'RUNNING') ? `<button id="rc-resume" ${disabled ? 'disabled' : ''}>${esc(t('rc.resume'))}</button><button id="rc-abandon" ${disabled ? 'disabled' : ''}>${esc(t('rc.abandon'))}</button><p>${esc(t('rc.interruptedNote'))}</p>` : ''}
        </div>
        <h3>${esc(t('rc.current'))}</h3>
        <p id="rc-status">${esc(t('rc.state'))}: ${esc(live?.state ?? t('rc.idle'))}${live?.reason ? ` · ${esc(t('rc.reason'))}: ${esc(live.reason)}` : ''}</p>
        ${live && live.state !== 'IDLE' ? `<p id="rc-totals">${esc(t('rc.totals', {planned: live.totals.planned, measured: live.totals.measured, notMeasured: live.totals.notMeasured, warmup: live.totals.warmup}))}</p>
          ${live.readiness ? `<p id="rc-readiness">${esc(t('rc.readiness'))}: ${esc(live.readiness.state)} ${esc((live.readiness.missing ?? []).join(', '))}</p>` : ''}
          <h4>${esc(t('rc.measured'))}</h4>
          <table id="rc-measured"><thead><tr><th>#</th><th>${esc(t('rc.state'))}</th><th>${esc(t('rc.warmup'))}</th><th>${esc(t('rc.duration'))}</th><th>${esc(t('rc.seed'))}</th><th>${esc(t('rc.task'))}</th></tr></thead><tbody>${live.measured.map(row).join('')}</tbody></table>
          <h4>${esc(t('rc.notMeasured'))}</h4>
          <p>${esc(t('rc.notMeasuredHint'))}</p>
          <table id="rc-excluded"><thead><tr><th>#</th><th>${esc(t('rc.state'))}</th><th>${esc(t('rc.exclusionReason'))}</th></tr></thead><tbody>${live.notMeasured.map(reasonRow).join('')}</tbody></table>
          <details id="rc-technical"><summary>${esc(t('rc.technical'))}</summary><pre>${esc(JSON.stringify({campaignId: live.campaignId, campaignSeed: live.campaignSeed, seedPolicy: live.seedPolicy, resumeCount: live.resumeCount, limits: live.limits, startedAt: live.startedAt, finishedAt: live.finishedAt, receipt: live.receipt}, null, 2))}</pre></details>` : ''}
        <h3>${esc(t('rc.receipts'))}</h3>
        <p>${esc(t('rc.receiptsHint'))}</p>
        <ul id="rc-receipts">${(data?.receipts ?? []).map(receipt => `<li data-rc-receipt="${esc(receipt.campaignId ?? receipt.file)}">${esc(receipt.campaignId ?? receipt.file)} · ${esc(receipt.scenarioId ?? '?')} · ${esc(receipt.state)} · ${esc(t('rc.receiptTotals', {measured: receipt.summary?.measured ?? '?', planned: receipt.summary?.planned ?? '?'}))}${receipt.reason ? ` · ${esc(receipt.reason)}` : ''}</li>`).join('') || `<li>${esc(t('rc.noReceipts'))}</li>`}</ul>` : ''}
      </section>`;
      const shellNode = shell();
      shellNode.querySelector('#rc-refresh').onclick = () => load();
      const start = shellNode.querySelector('#rc-start');
      if (start) start.onclick = () => act(() => api('research/campaigns', {
        experimentId: selection().experimentId,
        scenarioId: selection().scenarioId,
        repetitions: selection().repetitions,
        warmup: selection().warmup,
        ...(selection().seed ? {seed: selection().seed} : {}),
      }));
      const stop = shellNode.querySelector('#rc-stop');
      if (stop) stop.onclick = () => act(() => api('research/campaigns/stop', {campaignId: data?.live?.campaignId, reason: 'stopped from the Research campaign surface'}));
      // Resuming is offered only for the campaign the City says is unfinished, and it is sent back with the SAME
      // bounded parameters and seed. The City refuses a resume that changes them, so a stale page cannot turn a
      // continuation into a different experiment.
      const resume = shellNode.querySelector('#rc-resume');
      if (resume) resume.onclick = () => act(() => api('research/campaigns', {
        experimentId: data?.live?.context?.experimentId,
        scenarioId: data?.live?.scenarioId,
        repetitions: Math.max(1, (data?.live?.totals?.planned ?? 1) - (data?.live?.totals?.warmup ?? 0)),
        warmup: data?.live?.totals?.warmup ?? 0,
        seed: data?.live?.campaignSeed,
        resume: true,
      }));
      const abandon = shellNode.querySelector('#rc-abandon');
      if (abandon) abandon.onclick = () => act(() => api('research/campaigns', {
        experimentId: data?.live?.context?.experimentId,
        scenarioId: data?.live?.scenarioId,
        repetitions: 1,
        abandon: true,
      }));
    }

    async function act(operation) {
      if (busy || pending || !online || !current()) return;
      busy = true; error = null; draw();
      try { await operation(); }
      catch (reason) { if (current()) error = reason?.status === 403 ? t('rc.ownerRequired') : String(reason?.message ?? reason); }
      finally { busy = false; if (current()) { await load(); schedule(); } }
    }

    async function load() {
      if (pending || !online || !current()) return;
      const requestEpoch = ++epoch; pending = true; draw();
      try {
        const result = await api('research/campaigns');
        if (requestEpoch !== epoch || !current()) return;
        data = result;
      } catch (reason) {
        if (requestEpoch !== epoch || !current()) return;
        error = reason?.status === 403 ? t('rc.ownerRequired') : t('rc.unavailable');
      } finally { if (requestEpoch === epoch) { pending = false; if (current()) draw(); } }
    }

    /** A running campaign is watched, not polled forever: the loop is bounded and dies with the view. */
    function schedule() {
      stopPolling();
      if (!current() || !online || data?.live?.state !== 'RUNNING') return;
      let ticks = 0;
      const tick = async () => {
        timer = null;
        if (!current() || !online || ticks >= POLL_LIMIT) return;
        ticks += 1;
        await load();
        if (current() && data?.live?.state === 'RUNNING') timer = setTimeout(tick, POLL_MS);
      };
      timer = setTimeout(tick, POLL_MS);
    }

    draw();
    if (online && !data && !error && !pending) void load().then(schedule);
    else schedule();
  }
  return {render, reset};
}
