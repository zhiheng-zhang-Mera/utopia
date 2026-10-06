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

/** Fault injection is a high-impact control: it lands in the Danger Zone and must be confirmed. */
export const faultSection = (faults = [], locale = 'en') => ({
  id: 'advanced-faults',
  title: L(locale, 'Danger Zone · Fault injection', '危险区 · 故障注入'),
  level: SURFACE_LEVELS.ADVANCED_CONTROL,
  collapsed: true,
  requiresConfirmation: true,
  confirmation: L(locale, 'Type the campaign id to confirm: this injects a real fault into a running City', '输入 campaign id 以确认：这会向运行中的 City 注入真实故障'),
  items: (Array.isArray(faults) ? faults : []).map(fault => ({id: text(fault?.faultId ?? fault?.id), label: text(fault?.kind ?? fault?.mechanism ?? fault?.faultId), detail: text(fault?.reason ?? '')})),
});

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
      controls: [
        {id: 'replay', label: L(locale, 'Replay selected run', '回放所选运行'), level: SURFACE_LEVELS.DIRECT_CONTROL, requiresConfirmation: false},
        {id: 'export', label: L(locale, 'Export artifact', '导出工件'), level: SURFACE_LEVELS.DIRECT_CONTROL, requiresConfirmation: false},
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

  return Object.freeze({
    entry: Object.freeze({id: 'research', label: L(locale, 'Research / Experiments', '研究与实验'), level: 'SECONDARY', section: 'advanced'}),
    // The primary product surfaces must stay free of research controls; the guard is data, not a convention.
    primarySurfaces: Object.freeze([...primarySurfaces]),
    alerts: Object.freeze(alerts),
    sections: Object.freeze(sections),
    defaultOpen: Object.freeze(sections.filter(section => !section.collapsed).map(section => section.id)),
    confirmationRequired: Object.freeze(sections.filter(section => section.requiresConfirmation).map(section => section.id)),
  });
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
    metrics: `<p>${escaper(metrics.note || (locale === 'zh-CN' ? '本次运行报告的指标都可测量。' : 'Every metric this run reports could be measured.'))}</p>`,
    technical: technical.items.map(item => `<details><summary>${escaper(item.label)}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escaper(item.value)}</pre></details>`).join('') + (technical.note ? `<p role="status">${escaper(technical.note)}</p>` : ''),
  });
};
