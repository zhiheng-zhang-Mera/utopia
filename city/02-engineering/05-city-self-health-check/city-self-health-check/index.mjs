import { readFile, lstat, realpath } from 'node:fs/promises';
import { resolve, relative, dirname, posix, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import YAML from 'yaml';
import { AUTHORITY, quarterlyReview } from './review.mjs';
import { minimize } from './sanitize.mjs';
export { diagnose, appendCaseRevision, validateCaseHistory, reconcileBoss, routeCandidate, querySelfModel, quarterlyReview } from './review.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const fullSha = x => typeof x === 'string' && /^[a-f0-9]{40}$/.test(x);
const slash = x => x.replace(/\\/g, '/');
const sensitivePath = x => /(?:^|\/)(?:\.env(?:\..*)?|credentials?|secrets?|tokens?|node_modules|\.git)(?:\/|$)|\.(?:pem|key|p12|keystore)$/i.test(x);
function git(root, args, timeout = 5000) { return execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function identity(root) { return { head_sha: git(root, ['rev-parse', 'HEAD']), dirty: git(root, ['status', '--porcelain']).length > 0 }; }
function parse(text) { return YAML.parse(text, { maxAliasCount: 20 }); }
function frontmatter(text) {
  // The Mission Book's tolerant parser accepts historical colon-bearing notes.
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/), result = {};
  for (const line of (match?.[1] ?? '').split(/\r?\n/)) {
    const field = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/); if (!field) continue;
    let value = field[2].trim(); if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1).trim();
    result[field[1]] = /^true$/i.test(value) ? true : /^false$/i.test(value) ? false : /^(?:null|none|~)?$/i.test(value) ? null : value;
    if (/^[\[{]/.test(value)) { try { result[field[1]] = parse(value); } catch { /* historical string remains a string */ } }
  }
  return result;
}
function list(x) { return Array.isArray(x) ? x : []; }
function architecture(path) { return path.startsWith('packages/core/') || path.startsWith('city/00-foundation/01-core-os/') ? 'Core' : path.startsWith('services/') ? 'Platform/System Service' : path.startsWith('apps/android/') ? 'Native App' : path.startsWith('apps/') ? 'System App' : /connector|adapter|bridge/.test(path) ? 'Connector' : 'UNKNOWN'; }
function sourceSeams(path, text) {
  const symbols = [...text.matchAll(/(?:export\s+(?:async\s+)?(?:function|class|const|let|var)\s+|\bfun\s+)([A-Za-z_$][\w$]*)/g)].map(x => x[1]);
  const actions = [...new Set([...text.matchAll(/["'`](\/api\/[A-Za-z0-9_/:.{}-]+)["'`]/g)].map(x => x[1]))];
  const imports = [...text.matchAll(/(?:from\s*|import\s*|import\s*\(|require\s*\()\s*["'](\.[^"']+)["']/g)].map(x => posix.normalize(posix.join(posix.dirname(path), x[1])));
  return { path, classification: architecture(path), symbols: [...new Set(symbols)], api_or_actions: actions, imports, runtime_state: 'UNKNOWN', analysis: 'STATIC_HEURISTIC' };
}
export async function runHealthCheck({ utopiaRoot, cityRoot, mode = 'small', maxFiles = mode === 'small' ? 500 : 12000, maxBytes = mode === 'small' ? 8_000_000 : 80_000_000, maxDurationMs = 30000, runtimeSnapshot = null } = {}) {
  if (!['small', 'full', 'quarterly'].includes(mode)) throw new Error('Unsupported check mode');
  for (const value of [maxFiles, maxBytes, maxDurationMs]) if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Bounds must be positive integers');
  if (maxFiles > 100000 || maxBytes > 200_000_000 || maxDurationMs > 120000) throw new Error('Bounds exceed read-only safety ceiling');
  const started = performance.now(), roots = { utopia: await realpath(resolve(utopiaRoot)), city: await realpath(resolve(cityRoot)) };
  const identities = { utopia: identity(roots.utopia), city: identity(roots.city) };
  const findings = [], files = new Map(), manifest = [], skipped = [];
  let bytesRead = 0, filesRead = 0, truncated = false;
  function withinDeadline() { if (performance.now() - started >= maxDurationMs) { truncated = true; return false; } return true; }
  const ancestorCache = new Map();
  function ancestorObserved(value) {
    if (value === identities.utopia.head_sha) return true;
    if (ancestorCache.has(value)) return ancestorCache.get(value);
    if (!withinDeadline()) return null;
    let result; try { git(roots.utopia, ['merge-base', '--is-ancestor', value, identities.utopia.head_sha], Math.max(1, Math.min(5000, Math.floor(maxDurationMs - (performance.now() - started))))); result = true; }
    catch (error) { result = error.code === 'ETIMEDOUT' ? null : false; if (result === null) truncated = true; }
    ancestorCache.set(value, result); return result;
  }
  function finding(code, owner, path, detail, severity = 'WARNING', destination = 'CAPABILITY_LINKED_MISSION') {
    const file = files.get(path);
    findings.push({ finding_id: `CHK-${sha(`${code}:${path}:${detail}`).slice(0, 16)}`, code, owner_surface: owner ?? 'UNKNOWN', severity, evidence: [{ path, ...(file ? { sha256: file.sha256, source_sha: identities[file.repo].head_sha } : {}) }], detail, recommended_destination: destination, state: 'OPEN', verification: 'OBSERVED_STATIC_NOT_ROOT_CAUSE', execution_authority: false });
  }
  // Git enumerates tracked paths only: no arbitrary filesystem crawl, node_modules or secret discovery.
  const selected = [];
  for (const [repo, root] of Object.entries(roots)) {
    if (!withinDeadline()) break;
    const paths = git(root, ['ls-files', '-z']).split('\0').filter(Boolean).map(slash);
    for (const path of paths) {
      if (!withinDeadline()) break;
      if (sensitivePath(path)) continue;
      const registry = repo === 'city' && /^capability-registry\/.*\.(?:yaml|yml|json)$/.test(path);
      const mission = repo === 'city' && /^mission-book\/(?:mission-group|future-plans|finished)\/.*\.md$/.test(path) && !path.includes('/en/') && !path.includes('/zh-CN/');
      const progress = repo === 'city' && ['mission-book/MISSION_PROGRESS.json', 'mission-book/PROGRESS_MANIFEST.json'].includes(path);
      const topology = repo === 'utopia' && path === 'city/CITY_IMPLEMENTATION_MANIFEST.json';
      const rules = repo === 'city' && path === 'mission-book/CONSTRUCTION_RULES.md';
      const source = repo === 'utopia' && /^(?:services|apps|packages|contracts|agents|city)\//.test(path) && /\.(?:mjs|js|ts|kt)$/.test(path) && !/(?:\/tests?\/|\.test\.|\/build\/)/.test(path);
      if (registry || mission || progress || topology || rules || (source && mode !== 'small')) selected.push({ repo, path, kind: registry ? 'registry' : mission ? 'workbook' : progress ? 'progress' : topology ? 'topology' : rules ? 'rules' : 'source' });
    }
  }
  selected.sort((a, b) => ({ registry: 0, progress: 1, topology: 1, rules: 1, workbook: 2, source: 3 }[a.kind] - { registry: 0, progress: 1, topology: 1, rules: 1, workbook: 2, source: 3 }[b.kind]) || `${a.repo}/${a.path}`.localeCompare(`${b.repo}/${b.path}`));
  async function boundedRead(repo, path) {
    if (performance.now() - started > maxDurationMs || filesRead >= maxFiles) { truncated = true; return null; }
    const normalized = slash(path), target = resolve(roots[repo], normalized), rel = relative(roots[repo], target);
    if (!normalized || sensitivePath(normalized) || isAbsolute(normalized) || rel.startsWith('..') || isAbsolute(rel)) { skipped.push({ path: `${repo}:${normalized}`, reason: 'UNSAFE_PATH' }); return null; }
    try {
      const stats = await lstat(target), canonical = await realpath(target);
      if (!stats.isFile() || stats.isSymbolicLink() || relative(roots[repo], canonical).startsWith('..')) { skipped.push({ path: `${repo}:${normalized}`, reason: 'SYMLINK_OR_NON_FILE' }); return null; }
      if (bytesRead + stats.size > maxBytes || stats.size > 2_000_000) { truncated = true; skipped.push({ path: `${repo}:${normalized}`, reason: 'BYTE_BUDGET' }); return null; }
      const content = await readFile(target, 'utf8'); bytesRead += Buffer.byteLength(content); filesRead++;
      const file = { repo, path: normalized, sha256: sha(content), content };
      files.set(`${repo}:${normalized}`, file); manifest.push({ repo, path: normalized, sha256: file.sha256 }); return file;
    } catch (error) { if (error.code === 'ENOENT') return null; skipped.push({ path: `${repo}:${normalized}`, reason: 'UNREADABLE' }); return null; }
  }
  for (const entry of selected) { const file = await boundedRead(entry.repo, entry.path); if (file) file.kind = entry.kind; if (performance.now() - started > maxDurationMs || filesRead >= maxFiles) { truncated = filesRead < selected.length; break; } }
  const records = [], workbooks = [], source = [], governanceRules = [], cityMapping = [];
  let progress = null, topology = null;
  for (const [pointer, file] of files) {
    if (!withinDeadline()) break;
    try {
      if (file.kind === 'registry') { const data = parse(file.content); if (data?.capability_id) records.push({ ...data, pointer }); }
      if (file.kind === 'workbook') { const data = frontmatter(file.content); if (data.workbook_id || data.mission_id) workbooks.push({ ...data, id: data.workbook_id ?? data.mission_id, pointer }); }
      if (file.path === 'mission-book/MISSION_PROGRESS.json') progress = JSON.parse(file.content);
      if (file.kind === 'source') source.push(sourceSeams(file.path, file.content));
      if (file.kind === 'topology') topology = JSON.parse(file.content);
      if (file.kind === 'rules') for (const [index, line] of file.content.split(/\r?\n/).entries()) if (/^##?\s/.test(line)) governanceRules.push({ heading: line.replace(/^#+\s*/, ''), evidence: { path: pointer, line: index + 1, sha256: file.sha256 }, source_failure: 'UNKNOWN', current_scope: 'MISSION_BOOK', still_needed: 'OWNER_REVIEW_REQUIRED', false_blocks: 'NOT_MEASURED', conflicts: 'NOT_MEASURED', overhead: 'NOT_MEASURED', superseded: 'UNKNOWN', recommendation: 'KEEP_PENDING_EVIDENCE' });
    } catch { finding('UNREADABLE_RECORD', 'Mission/Registry', pointer, 'Record parsing failed; content omitted', 'WARNING', 'MISSION_BOOK'); }
  }
  const ids = new Map(), claimedPaths = new Set(), selfModel = [];
  const runtime = runtimeSnapshot ? { implementation_sha: fullSha(runtimeSnapshot.implementation_sha) ? runtimeSnapshot.implementation_sha : null, captured_at: /^\d{4}-\d\d-\d\dT/.test(runtimeSnapshot.captured_at ?? '') ? runtimeSnapshot.captured_at : null, capabilities: list(runtimeSnapshot.capabilities).filter(x => /^CAP-[A-Z0-9-]+$/.test(x.capability_id ?? '')).map(x => ({ capability_id: x.capability_id, state: ['ONLINE', 'OFFLINE', 'DEGRADED', 'UNKNOWN'].includes(x.state) ? x.state : 'UNKNOWN' })) } : null;
  const runtimeIdentityMatches = runtime?.implementation_sha === identities.utopia.head_sha;
  if (runtime && !runtimeIdentityMatches) finding('STALE_EXECUTION_IDENTITY', 'Runtime snapshot provider', 'runtime:snapshot', 'Snapshot is not bound to current exact implementation SHA', 'WARNING', 'GAI_ENGINEERING');
  for (const record of records) {
    if (!withinDeadline()) break;
    const owner = record.ownership?.city_owner ?? record.ownership?.programme ?? 'UNKNOWN';
    if (ids.has(record.capability_id)) finding('DUPLICATE_CAPABILITY', owner, record.pointer, 'Duplicate immutable capability ID');
    ids.set(record.capability_id, record);
    const paths = list(record.implementation?.paths), symbols = list(record.implementation?.symbols), observed = [];
    for (const path of paths) {
      if (!withinDeadline()) break;
      if (typeof path !== 'string') continue;
      const directoryMatches = [...files.values()].filter(x => x.repo === 'utopia' && x.kind === 'source' && x.path.startsWith(path.replace(/\/$/, '') + '/'));
      if (directoryMatches.length) { for (const file of directoryMatches) { claimedPaths.add(file.path); observed.push(file); } continue; }
      claimedPaths.add(path);
      const pointer = `utopia:${path}`, file = files.get(pointer) ?? await boundedRead('utopia', path);
      if (!file) { finding(truncated ? 'IMPLEMENTATION_NOT_OBSERVED' : 'DEAD_CAPABILITY_RECORD', owner, record.pointer, `Implementation path unavailable: ${path}`); continue; }
      observed.push(file);
    }
    for (const symbol of symbols) if (typeof symbol === 'string' && observed.length && !observed.some(x => new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(x.content))) finding('DEAD_CAPABILITY_SYMBOL', owner, record.pointer, `Claimed symbol absent from observed paths: ${symbol}`);
    const verifiedSha = record.implementation?.last_verified_full_sha;
    if (!fullSha(verifiedSha)) finding('UNVERIFIED_CAPABILITY_IDENTITY', owner, record.pointer, 'No full exact verified implementation SHA');
    else if (ancestorObserved(verifiedSha) === false) finding('BASELINE_ANCESTRY_MISMATCH', owner, record.pointer, 'Verified SHA is not observed as an ancestor or is unavailable');
    if (owner === 'UNKNOWN') finding('WRONG_OWNER', owner, record.pointer, 'Canonical owner is not declared; assignment requires owner confirmation');
    if (record.exposure?.class === 'INTERNAL_ONLY' && !record.exposure.internal_only_exemption_reason) finding('WRONG_EXPOSURE_CLASS', owner, record.pointer, 'INTERNAL_ONLY lacks an exemption reason');
    if (record.exposure?.class !== 'INTERNAL_ONLY' && record.status?.user_reachability_status === 'VERIFIED' && !list(record.surfaces).length) finding('FALSE_AFFORDANCE_CANDIDATE', owner, record.pointer, 'Verified reachability has no declared user surface');
    const observedRuntime = runtimeIdentityMatches ? runtime.capabilities.find(x => x.capability_id === record.capability_id) : null;
    if (observedRuntime && observedRuntime.state !== 'ONLINE' && record.status?.backend_wiring_status === 'VERIFIED') finding('REGISTRY_RUNTIME_MISMATCH', owner, record.pointer, `Current snapshot state ${observedRuntime.state} differs from verified wiring; diagnosis required`);
    selfModel.push({ capability_id: record.capability_id, where_implemented: paths, canonical_owner: owner, dependencies: list(record.dependencies), dependents: [], authority: 'UNKNOWN', user_surfaces: list(record.surfaces).map(x => ({ platform: ['WEB', 'ANDROID', 'DESKTOP', 'CLI'].includes(x.platform) ? x.platform : 'UNKNOWN', discoverable: x.discoverable === true })), runtime_state: observedRuntime?.state ?? 'UNKNOWN', runtime_evidence: observedRuntime ? 'INPUT_SNAPSHOT_EXACT_SHA' : 'NOT_OBSERVED', blast_radius: 'NOT_MEASURED', implementation_status: record.status?.implementation_status ?? 'UNKNOWN', backend_wiring_status: record.status?.backend_wiring_status ?? 'UNKNOWN', user_reachability_status: record.status?.user_reachability_status ?? 'UNKNOWN', intent_validation_status: record.status?.intent_validation_status ?? 'NOT_MEASURED' });
    // Only local evidence pointers can be checked offline. Remote references stay unverified.
    for (const ref of Object.values(record.evidence ?? {}).flatMap(list)) {
      if (!withinDeadline()) break;
      if (typeof ref !== 'string' || /^https?:/.test(ref) || !/^(?:utopia:|mission-book\/)/.test(ref)) continue;
      const repo = ref.startsWith('utopia:') ? 'utopia' : 'city', path = ref.replace(/^utopia:/, '').replace(/:\d+$/, '');
      if (sensitivePath(path)) continue;
      try { const target = resolve(roots[repo], path); if (relative(roots[repo], target).startsWith('..')) throw new Error(); await lstat(target); }
      catch { finding('EVIDENCE_POINTER_MISMATCH', owner, record.pointer, 'Referenced local evidence is unavailable', 'WARNING', 'MISSION_BOOK'); }
    }
  }
  for (const model of selfModel) model.dependents = selfModel.filter(x => x.dependencies.includes(model.capability_id)).map(x => x.capability_id);
  for (const district of list(topology?.districts)) for (const building of list(district.buildings)) for (const module of list(building.modules)) {
    if (!withinDeadline()) break;
    if (typeof module.path !== 'string') continue;
    const matches = source.filter(x => x.path.startsWith(module.path.replace(/\/$/, '') + '/'));
    const mapping = { district: district.id, building: building.id, module: module.id, path: module.path, lifecycle: module.lifecycle, owner: `${district.id}/${building.id}`, observed_source_count: matches.length, consumers: source.filter(x => x.imports.some(p => p.startsWith(module.path + '/'))).map(x => x.path), roads: matches.flatMap(x => x.api_or_actions), runtime_state: 'UNKNOWN', runtime_dependency_coverage: 'NOT_MEASURED' };
    cityMapping.push(mapping);
    if (mode !== 'small' && ['ACTIVE', 'PROMOTED', 'DEPRECATED'].includes(module.lifecycle) && !matches.length && !truncated) finding('CITY_MAPPING_DRIFT', mapping.owner, 'utopia:city/CITY_IMPLEMENTATION_MANIFEST.json', `Implemented module has no observed source: ${module.id}`, 'WARNING', 'URA');
    if (mode !== 'small' && ['PLANNED', 'INCUBATING'].includes(module.lifecycle) && matches.length) finding('CITY_LIFECYCLE_DRIFT', mapping.owner, 'utopia:city/CITY_IMPLEMENTATION_MANIFEST.json', `Source exists for non-implemented module: ${module.id}`, 'WARNING', 'URA');
  }
  const activeWorkbooks = [], workbookIds = new Set();
  const generatedTasks = list(progress?.programmes).flatMap(x => list(x.tasks));
  for (const workbook of workbooks) {
    if (!withinDeadline()) break;
    if (workbookIds.has(workbook.id)) finding('DUPLICATE_WORKBOOK_ID', 'Mission Book', workbook.pointer, 'Duplicate canonical workbook ID', 'ERROR', 'MISSION_BOOK');
    workbookIds.add(workbook.id);
    const inactive = workbook.execution_enabled === false || /PARKED|SUSPEND|FUTURE|CANCELLED/.test(workbook.status ?? '') || workbook.pointer.includes('/future-plans/');
    if (!inactive && !workbook.pointer.includes('/finished/')) activeWorkbooks.push({ id: workbook.id, status: workbook.status ?? 'UNKNOWN', pointer: workbook.pointer });
    const projection = generatedTasks.find(x => x.id === workbook.id);
    if (inactive && projection?.execution_enabled === true) finding('PARKED_ACTIVE_TRUTH', 'Mission Book', workbook.pointer, 'Inactive workbook is enabled in generated progress', 'ERROR', 'MISSION_BOOK');
    if (projection && ['status', 'development_complete', 'review_complete', 'execution_enabled'].some(key => workbook[key] !== undefined && projection[key] !== workbook[key])) finding('MISSION_PROGRESS_DRIFT', 'Mission Book', workbook.pointer, 'Generated task disagrees with canonical frontmatter', 'WARNING', 'MISSION_BOOK');
    if (workbook.status === 'COMPLETE' && workbook.review_complete !== true) finding('FALSE_COMPLETE', 'Mission Book', workbook.pointer, 'Complete record lacks independent review', 'ERROR', 'MISSION_BOOK');
    for (const value of list(workbook.required_ancestor_shas)) {
      if (!withinDeadline()) break;
      if (!fullSha(value)) { finding('STALE_MUTABLE_REF', 'Mission Book', workbook.pointer, 'Required ancestor is not a full SHA', 'ERROR', 'MISSION_BOOK'); continue; }
      if (ancestorObserved(value) === false) finding('BASELINE_ANCESTRY_MISMATCH', 'Mission Book', workbook.pointer, 'Required dependency ancestry unavailable or mismatched', 'WARNING', 'MISSION_BOOK');
    }
    if (workbook.review_complete === true && !fullSha(workbook.review_head_sha) && workbook.baseline_policy) finding('EVIDENCE_POINTER_MISMATCH', 'Mission Book', workbook.pointer, 'Modern reviewed workbook lacks exact review SHA', 'WARNING', 'MISSION_BOOK');
  }
  const sourcePaths = new Set(source.map(x => x.path)); const graph = new Map(source.map(x => [x.path, x.imports.filter(p => sourcePaths.has(p))]));
  for (const seam of source) {
    if (!withinDeadline()) break;
    if (!claimedPaths.has(seam.path) && seam.api_or_actions.length) finding('UNREGISTERED_CAPABILITY', 'Source owner UNKNOWN', `utopia:${seam.path}`, 'Observed API seam has no registry implementation path; aggregation/owner review required');
    for (const dependency of graph.get(seam.path) ?? []) if (seam.classification === 'Core' && ['System App', 'Native App'].includes(architecture(dependency))) finding('REVERSE_DEPENDENCY', 'Architecture', `utopia:${seam.path}`, 'Core imports an application seam', 'WARNING', 'URA');
  }
  const visited = new Set(), active = new Set(), cycles = new Set();
  function visit(path) { if (!withinDeadline()) return; if (active.has(path)) { cycles.add(path); return; } if (visited.has(path)) return; visited.add(path); active.add(path); for (const child of graph.get(path) ?? []) visit(child); active.delete(path); }
  for (const path of graph.keys()) visit(path);
  for (const path of cycles) finding('DEPENDENCY_CYCLE', 'Architecture', `utopia:${path}`, 'Static relative-import cycle observed; runtime impact not measured', 'WARNING', 'URA');
  const report = { schema_version: 1, series: ['CHK-101', 'CHK-201', 'CHK-301', 'CHK-401', 'CHK-990'], mode, generated_at: new Date().toISOString(), identities, authority: AUTHORITY, scheduler_created: false, outcome: findings.length ? 'DRIFT_FOUND' : 'OBSERVE_MORE', findings, census: { source, city_mapping: cityMapping, governance_rules: governanceRules, registry_count: records.length, workbook_count: workbooks.length, activeWorkbooks, dependency_graph: [...graph].map(([path, dependencies]) => ({ path, dependencies })), runtime_snapshot: runtime }, self_model: selfModel, architecture_recommendations: source.map(x => ({ path: x.path, observed_classification: x.classification, recommendation: cycles.has(x.path) ? 'BOUNDARY_REPAIR' : 'KEEP', authority: 'PROPOSAL_ONLY' })), coverage: { complete: false, static_scan_complete: !truncated && skipped.length === 0, selected_files: selected.length, skipped, static_analysis: 'HEURISTIC_NOT_SEMANTIC_PROOF', runtime: runtimeIdentityMatches ? 'SUPPLIED_SNAPSHOT_NOT_INDEPENDENTLY_VERIFIED' : 'UNKNOWN', sentinel_flows: 'NOT_RUN', ui_parity: 'NOT_RUN', governance_rule_debt: governanceRules.length ? 'HEADINGS_CENSUSED_OUTCOMES_NOT_MEASURED' : 'NOT_MEASURED', autonomy_outcomes: 'NOT_MEASURED', security_runtime_permissions: 'NOT_RUN', remote_evidence_retrievability: 'NOT_RUN', registry_granularity: 'OWNER_REVIEW_REQUIRED', city_topology_mapping: topology ? 'SOURCE_MANIFEST_RECONCILED_RUNTIME_UNKNOWN' : 'NOT_MEASURED' }, evidence_manifest: manifest, metrics: { filesRead, bytesRead, elapsed_ms: performance.now() - started, maxFiles, maxBytes, maxDurationMs, heap_used_bytes: process.memoryUsage().heapUsed }, independent_review: 'NOT_RUN', freeze_outcome: 'NOT_ACCEPTED_PENDING_WHOLE_SERIES_REVIEW' };
  report.quarterly = quarterlyReview(report);
  report.identities_after = { utopia: identity(roots.utopia), city: identity(roots.city) };
  report.source_identity_stable = JSON.stringify(report.identities) === JSON.stringify(report.identities_after);
  if (!report.source_identity_stable) { report.outcome = 'REQUIRES_RECONCILIATION'; report.coverage.complete = false; }
  report.metrics.elapsed_ms = performance.now() - started;
  report.metrics.duration_limit = 'COOPERATIVE_SCAN_PLUS_BOUNDED_IDENTITY_RECEIPTS';
  return minimize(report);
}
