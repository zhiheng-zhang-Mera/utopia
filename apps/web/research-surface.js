// REX-807: the Research control surface's view model.
//
// The gateway already exposes experiments, campaigns, faults, replays and artifacts. What was missing was the LAYER:
// research.js rendered a manifest textarea and dumped raw JSON, so the surface was technically reachable but not
// usable without reading identifiers and exact config. This module turns those payloads into ordered sections with
// progressive disclosure, keeping the four exposure levels apart:
//
//   DIRECT_CONTROL    create/run/stop/choose scenario/repetitions/replay/export  -> open section, main controls
//   ADVANCED_CONTROL  fault injection, destructive cleanup, seed/config override  -> Danger Zone, needs confirmation
//   OBSERVABLE        current run, progress, failures, retries, metrics, exclusions, provenance, artifact status
//   INTERNAL_ONLY     the collector's own buffers - deliberately absent from the UI
//
// Two rules are enforced here rather than left to the renderer:
//   * NOTHING IMPORTANT IS HIDDEN. Errors, exclusions and incomplete metrics are visible alerts, and a payload field
//     this view model does not know about is listed as unmapped instead of silently dropped.
//   * IDENTIFIERS ARE FOLDED, NOT DELETED. Raw ids, exact config and trace text live in a collapsed Diagnostics
//     section: an operator who needs them can open it, and a newcomer is not greeted by them.
const L = (locale, en, zh) => (locale === 'zh-CN' ? zh : en);
const text = value => (value === null || value === undefined ? '' : String(value));
const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);

export const SURFACE_LEVELS = Object.freeze({DIRECT_CONTROL: 'DIRECT_CONTROL', ADVANCED_CONTROL: 'ADVANCED_CONTROL', OBSERVABLE: 'OBSERVABLE', INTERNAL_ONLY: 'INTERNAL_ONLY'});

/** Fields this view model knows how to place. Anything else a payload carries is reported as unmapped. */
export const MAPPED_FIELDS = Object.freeze([
  'experiments', 'experimentId', 'status', 'question', 'topology', 'repetitions', 'seedPolicy', 'baseSeed',
  'stopConditions', 'artifactPolicy', 'acceptance', 'variables', 'hosts', 'workers', 'controlSurfaces',
  'live', 'campaignId', 'scenarioId', 'state', 'planned', 'accounted', 'measured', 'failed', 'timedOut', 'warmup',
  'summary', 'runs', 'index', 'result', 'taskRef', 'waitedMs', 'excluded', 'reason', 'broken', 'storeState',
  'storeReason', 'exclusions', 'metrics', 'notMeasured', 'artifact', 'provenance', 'faults', 'replays',
]);

/** Short, human-readable summary of an experiment: the question first, the identifier only as a reference. */
export const summariseExperiment = (experiment = {}, locale = 'en') => ({
  id: text(experiment.experimentId),
  summary: text(experiment.question) || L(locale, 'An experiment with no stated question', '未写研究问题的实验'),
  status: text(experiment.status) || L(locale, 'unknown status', '状态未知'),
  topology: text(experiment.topology),
  repetitions: isFiniteNumber(experiment.repetitions) ? experiment.repetitions : null,
  raw: {...experiment},
});

/** Campaign progress in the user's language, with the numbers that matter and the reasons for the ones that do not. */
export const summariseRun = (live = {}, locale = 'en') => {
  if (!live || !live.campaignId) return null;
  const summary = live.summary ?? {};
  const measured = isFiniteNumber(summary.measured) ? summary.measured : (isFiniteNumber(live.measured) ? live.measured : null);
  const planned = isFiniteNumber(summary.planned) ? summary.planned : (isFiniteNumber(live.planned) ? live.planned : null);
  const failed = isFiniteNumber(summary.failed) ? summary.failed : (isFiniteNumber(live.failed) ? live.failed : null);
  const incomplete = planned !== null && measured !== null && measured < planned;
  return {
    campaignId: text(live.campaignId),
    scenarioId: text(live.scenarioId),
    state: text(live.state),
    progress: planned !== null && measured !== null && planned > 0 ? `${measured}/${planned}` : L(locale, 'progress unavailable', '进度不可用'),
    incomplete,
    // A run that has not accounted for every planned repetition says so, in words, rather than only in numbers.
    note: incomplete ? L(locale, `${planned - measured} planned repetition(s) have not been accounted for yet`, `还有 ${planned - measured} 次计划重复尚未结清`) : '',
    raw: {...live},
  };
};

/** Fault injection is a high-impact control: it lands in the Danger Zone and must be confirmed by the exact gateway token. */
export const faultSection = (faults = [], locale = 'en') => ({
  id: 'advanced-faults',
  title: L(locale, 'Danger Zone · Fault injection', '危险区 · 故障注入'),
  level: SURFACE_LEVELS.ADVANCED_CONTROL,
  collapsed: true,
  requiresConfirmation: true,
  confirmation: L(locale, 'Type FAULT:<kind>:<target> exactly: this injects a real fault into a running City', '请原样输入 FAULT:<故障类型>:<目标>：这会向运行中的 City 注入真实故障'),
  confirmationShape: 'FAULT:<kind>:<nodeId>',
  items: (Array.isArray(faults) ? faults : []).map(fault => ({id: text(fault?.faultId ?? fault?.id), label: text(fault?.kind ?? fault?.mechanism ?? fault?.faultId), detail: text(fault?.reason ?? '')})),
});

/**
 * A high-impact control must not be triggerable by accident, and "must be confirmed" has to be a REFUSING function
 * rather than a sentence in a data structure. The exact token is the one the gateway itself enforces in
 * services/dev-gateway/research/faults.mjs (`FAULT:<kind>:<nodeId>`); building it here rather than phrasing it in prose
 * is what keeps the page from asking the operator for something the gateway will reject. An earlier revision of this
 * module told the operator to "type the campaign id" while the gateway required the kind/node token, so an operator who
 * followed the instruction exactly was refused with FAULT_CONFIRMATION_REQUIRED - a safety prompt that cannot be
 * satisfied is worse than no prompt, because it teaches the operator to paste whatever makes it go away. The token is
 * NOT invented here: tests/rex807-danger-confirmation.test.mjs proves it against a real gateway.
 */
export const faultConfirmationToken = ({kind = '', nodeId = ''} = {}) => `FAULT:${text(kind)}:${text(nodeId)}`;

/** The gateway refuses anything that is not exactly the expected token; the client refuses it first, by the same rule. */
export const confirmationSatisfied = (expected, typed) => typeof expected === 'string' && expected.length > 0 && typed === expected;

/**
 * NO ADVANCED CONTROL MAY BE UNCONFIRMED. Every section and every control at ADVANCED_CONTROL level must declare
 * requiresConfirmation, so a later addition cannot quietly become one-click. Returns the view for chaining and throws
 * with the offending ids named.
 */
export const assertAdvancedControlsConfirmed = view => {
  const unconfirmed = [];
  for (const section of view.sections ?? []) {
    if (section.level === SURFACE_LEVELS.ADVANCED_CONTROL && section.requiresConfirmation !== true) unconfirmed.push(`section:${section.id}`);
    for (const control of section.controls ?? []) {
      if (control.level === SURFACE_LEVELS.ADVANCED_CONTROL && control.requiresConfirmation !== true) unconfirmed.push(`control:${section.id}/${control.id}`);
    }
  }
  for (const control of view.controls ?? []) {
    if (control.level === SURFACE_LEVELS.ADVANCED_CONTROL && control.requiresConfirmation !== true) unconfirmed.push(`control:${control.id}`);
  }
  if (unconfirmed.length) throw new Error(`ADVANCED_CONTROL_UNCONFIRMED: ${unconfirmed.join(', ')}`);
  return view;
};

/**
 * Build the whole surface: ordered sections, visible alerts, folded diagnostics.
 * `payload` is whatever the City answered; unknown keys are surfaced instead of dropped.
 */
export const researchView = (payload = {}, {locale = 'en', primarySurfaces = []} = {}) => {
  const experiments = Array.isArray(payload.experiments) ? payload.experiments : [];
  const live = summariseRun(payload.live ?? {}, locale);
  const alerts = [];

  // 1. NOTHING IMPORTANT IS HIDDEN - visible diagnostics first.
  if (payload.storeState === 'UNAVAILABLE') {
    alerts.push({id: 'store-unavailable', severity: 'ERROR', visible: true, role: 'alert', message: L(locale, 'Experiment storage is unavailable, so validated manifests cannot be filed.', '实验存储不可用，验证后的清单无法保存。'), detail: text(payload.storeReason)});
  }
  for (const broken of Array.isArray(payload.broken) ? payload.broken : []) {
    alerts.push({id: `broken-${text(broken?.experimentId ?? broken?.name ?? alerts.length)}`, severity: 'ERROR', visible: true, role: 'alert', message: L(locale, 'A stored experiment record could not be read.', '有一条已存实验记录无法读取。'), detail: text(broken?.reason ?? broken?.detail ?? broken)});
  }
  for (const exclusion of Array.isArray(payload.exclusions) ? payload.exclusions : []) {
    alerts.push({id: `exclusion-${text(exclusion?.campaignId ?? alerts.length)}-${text(exclusion?.reason ?? '')}`, severity: 'WARNING', visible: true, role: 'status', message: L(locale, 'A campaign exclusion applies to this data.', '这批数据包含一条 campaign 排除。'), detail: text(exclusion?.reason ?? exclusion)});
  }
  const notMeasured = payload.metrics?.notMeasured ?? payload.notMeasured;
  if (Array.isArray(notMeasured) && notMeasured.length > 0) {
    alerts.push({id: 'metrics-incomplete', severity: 'WARNING', visible: true, role: 'status', message: L(locale, `${notMeasured.length} metric(s) could not be measured; each carries its reason.`, `有 ${notMeasured.length} 项指标无法测量，每项都带原因。`), detail: notMeasured.map(entry => `${text(entry?.metric ?? entry)}: ${text(entry?.reason ?? '')}`).join('; ')});
  }
  if (live?.incomplete) {
    alerts.push({id: 'run-incomplete', severity: 'WARNING', visible: true, role: 'status', message: live.note, detail: live.campaignId});
  }

  const unmappedFields = Object.keys(payload).filter(key => !MAPPED_FIELDS.includes(key)).sort();

  const sections = [
    {
      id: 'experiments',
      title: L(locale, 'Experiments', '实验'),
      level: SURFACE_LEVELS.DIRECT_CONTROL,
      collapsed: false,
      items: experiments.map(experiment => summariseExperiment(experiment, locale)),
      controls: [
        {id: 'create', label: L(locale, 'Create experiment', '创建实验'), level: SURFACE_LEVELS.DIRECT_CONTROL, requiresConfirmation: false},
        {id: 'start', label: L(locale, 'Start run', '开始运行'), level: SURFACE_LEVELS.DIRECT_CONTROL, requiresConfirmation: false, enabled: Boolean(live) === false},
        {id: 'stop', label: L(locale, 'Stop run', '停止运行'), level: SURFACE_LEVELS.DIRECT_CONTROL, requiresConfirmation: false, enabled: Boolean(live)},
      ],
    },
    {
      id: 'runs',
      title: L(locale, 'Runs and progress', '运行与进度'),
      level: SURFACE_LEVELS.OBSERVABLE,
      collapsed: false,
      items: live ? [live] : [],
    },
    {
      id: 'metrics',
      title: L(locale, 'Metrics', '指标'),
      level: SURFACE_LEVELS.OBSERVABLE,
      collapsed: false,
      items: Array.isArray(payload.metrics?.reported) ? payload.metrics.reported : [],
      note: Array.isArray(notMeasured) && notMeasured.length ? L(locale, 'Metrics that could not be measured are listed with their reasons above.', '无法测量的指标及其原因见上方提示。') : '',
    },
    {
      id: 'replay-export',
      title: L(locale, 'Replay and export', '回放与导出'),
      level: SURFACE_LEVELS.DIRECT_CONTROL,
      collapsed: false,
      items: [],
      // Replay and ablation live on the campaign surface (apps/web/research-replay.js); artifact export is implemented
      // HERE, because the workbook requires the research capability to be usable without a raw API call and export was
      // the one DIRECT_CONTROL that existed only as an endpoint. A control listed but not wired is a false button, so
      // every control declares where it is actually implemented.
      note: L(locale, 'Replay and ablation are on the Campaign surface. The artifact export is here.', '回放与消融在 Campaign 面；工件导出在本页。'),
      controls: [
        {id: 'replay', label: L(locale, 'Replay selected run', '回放所选运行'), level: SURFACE_LEVELS.DIRECT_CONTROL, requiresConfirmation: false, wired: false, wiredAt: 'research-replay'},
        {id: 'export', label: L(locale, 'Export artifact', '导出工件'), level: SURFACE_LEVELS.DIRECT_CONTROL, requiresConfirmation: false, wired: true, wiredAt: 'research-export'},
      ],
    },
    faultSection(payload.faults, locale),
    {
      id: 'diagnostics',
      title: L(locale, 'Technical details', '技术细节'),
      level: SURFACE_LEVELS.INTERNAL_ONLY,
      collapsed: true,
      items: [
        ...experiments.map(experiment => ({id: `raw-${text(experiment.experimentId)}`, label: L(locale, 'exact manifest', '完整清单'), value: JSON.stringify(experiment)})),
        ...(live ? [{id: 'raw-live', label: L(locale, 'exact run record', '完整运行记录'), value: JSON.stringify(live.raw)}] : []),
      ],
      unmappedFields,
      note: unmappedFields.length ? L(locale, `This City reported ${unmappedFields.length} field(s) this view does not place yet: ${unmappedFields.join(', ')}`, `City 报告了 ${unmappedFields.length} 个本视图尚未归位的字段：${unmappedFields.join('、')}`) : '',
    },
  ];

  const view = {
    entry: Object.freeze({id: 'research', label: L(locale, 'Research / Experiments', '研究与实验'), level: 'SECONDARY', section: 'advanced'}),
    // The primary product surfaces must stay free of research controls; the guard is data, not a convention.
    primarySurfaces: Object.freeze([...primarySurfaces]),
    alerts: Object.freeze(alerts),
    sections: Object.freeze(sections),
    defaultOpen: Object.freeze(sections.filter(section => !section.collapsed).map(section => section.id)),
    confirmationRequired: Object.freeze(sections.filter(section => section.requiresConfirmation).map(section => section.id)),
  };
  // The surface REFUSES to exist in a shape where a high-impact control would be one click. Throwing here (rather than
  // only asserting in a test) means a later section cannot be added unconfirmed and still render.
  assertAdvancedControlsConfirmed(view);
  return Object.freeze(view);
};

/** A research control may not appear on a primary product surface. Throws with the offending ids named. */
export const assertPrimarySurfacesClean = (view, {primarySurfaces = ['home', 'ask', 'devices']} = {}) => {
  const polluted = [];
  for (const surface of primarySurfaces) {
    if (typeof surface !== 'string') continue;
    if (/research|experiment|fault|replay/i.test(surface)) polluted.push(surface);
  }
  if (polluted.length) throw new Error(`PRIMARY_SURFACE_POLLUTED: ${polluted.join(', ')}`);
  return view;
};

const escaper = value => String(value ?? '').replace(/[&<>"']/g, character => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[character]));

/**
 * The markup fragments the page renders, kept here rather than inside the page so the SHAPE can be asserted without a
 * browser: the list shows the human summary and carries the identifier only as a title attribute, the alerts are
 * rendered with their role, and the technical fragment is the only place an exact record appears.
 */
export const researchMarkup = (view, {locale = 'en'} = {}) => {
  const take = id => view.sections.find(section => section.id === id) ?? {items: [], note: '', title: ''};
  const direct = take('experiments');
  const runs = take('runs');
  const metrics = take('metrics');
  const technical = take('diagnostics');
  const line = runs.items[0];
  return Object.freeze({
    alerts: view.alerts.map(alert => `<p role="${escaper(alert.role)}" data-severity="${escaper(alert.severity)}">${escaper(alert.message)}${alert.detail ? ` <span class="detail">${escaper(alert.detail)}</span>` : ''}</p>`).join(''),
    list: direct.items.map(item => `<button data-experiment="${escaper(item.id)}" title="${escaper(item.id)}">${escaper(item.summary)} · ${escaper(item.status)}${item.repetitions !== null && item.repetitions !== undefined ? ` · ${escaper(item.repetitions)}×` : ''}</button>`).join(''),
    run: line ? `<p>${escaper(line.scenarioId)} · ${escaper(line.state)} · ${escaper(line.progress)}</p>${line.note ? `<p role="status">${escaper(line.note)}</p>` : ''}` : `<p>${locale === 'zh-CN' ? '当前没有运行中的 experiment。' : 'No run is live.'}</p>`,
    metrics: (() => {
      // The Metrics entry is part of the workbook's minimum surface, and it used to render ONLY a sentence - a Metrics
      // section where no metric is ever readable is the "information too thin" failure the reviewer is asked to look
      // for. Each reported metric is now listed with its value, and an empty list says it is empty instead of asserting
      // that everything was measurable (which would be a claim about data this view does not have).
      const rows = metrics.items ?? [];
      const header = rows.length
        ? `<p>${escaper(L(locale, `${rows.length} metric(s) reported by this run:`, `本次运行报告了 ${rows.length} 项指标：`))}</p>`
        : `<p>${escaper(L(locale, 'No metric has been reported for this run yet.', '本次运行尚未报告任何指标。'))}</p>`;
      const list = rows.map(entry => {
        const name = escaper(text(entry?.metric ?? entry?.name ?? entry?.id ?? 'metric'));
        const value = entry?.value === undefined || entry?.value === null ? escaper(L(locale, 'no value', '无值')) : escaper(typeof entry.value === 'object' ? JSON.stringify(entry.value) : entry.value);
        const unit = entry?.unit ? ` <span class="unit">${escaper(text(entry.unit))}</span>` : '';
        const reason = entry?.reason ? ` <span class="detail">${escaper(text(entry.reason))}</span>` : '';
        return `<p data-metric="${name}">${name}: <strong>${value}</strong>${unit}${reason}</p>`;
      }).join('');
      return header + list + (metrics.note ? `<p role="status">${escaper(metrics.note)}</p>` : '');
    })(),
    technical: technical.items.map(item => `<details><summary>${escaper(item.label)}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escaper(item.value)}</pre></details>`).join('') + (technical.note ? `<p role="status">${escaper(technical.note)}</p>` : ''),
  });
};
