// CEX-790 — build the entry inventory from the TEN sources the workbook names, on the dependency union baseline.
// Machine-readable output: evidence/raw/mission-book/CEX-790/capability-inventory.json
// Human-readable matrix:    printed as markdown (captured by the caller) for mission-book/reports/CEX-790/
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { ACTION_ROUTES, ROOM_OPERATIONS, CAPABILITY_OPERATIONS, CITY_TASK_TYPES } from '../services/dev-gateway/actions.mjs';
import { ALL_ROOMS, ROOMS } from '../apps/rooms/hub/manifest.mjs';

const ROOT = process.cwd();
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const outputRoot = process.env.CEX790_OUTPUT_DIR || 'evidence/raw/mission-book/CEX-790/current';
const read = p => readFileSync(join(ROOT, p), 'utf8');
const hash = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const items = [];
const add = (o) => { items.push(o); return o; };

// ---------------------------------------------------------------- source 1: Gateway user-facing routes
const server = read('services/dev-gateway/server.mjs');
const routes = [];
// static: else if(req.method==='GET' && path==='/api/v0/x')
for (const m of server.matchAll(/req\.method==='(GET|POST|PATCH)'\s*&&\s*path==='(\/api\/v0\/[^']+)'/g)) routes.push({ method: m[1], path: m[2], kind: 'static' });
for (const m of server.matchAll(/path==='(\/api\/v0\/[^']+)'\s*&&\s*req\.method==='(GET|POST|PATCH)'/g)) routes.push({method:m[2], path:m[1], kind:'static'});
routes.push({method:'GET',path:'/api/v0/health',kind:'public-health'});
// regex: else if(req.method==='POST' && /^\/api\/v0\/x\/[^/]+\/y$/.test(path))
for (const m of server.matchAll(/req\.method==='(GET|POST|PATCH)'\s*&&\s*\/\^\\\/api\\\/v0\\\/([^$]+)\$\/\.test\(path\)/g)) {
  // The captured text is the source spelling of the pattern body, e.g. `device\/installations\/[^/]+\/rebind`.
  // Rebuild a readable canonical path from it: unescape the slashes, replace the segment matcher with :id, and drop
  // the quantifier that belongs to the matcher rather than to the path. An earlier draft of this script kept neither
  // the /api/v0/ prefix nor the clean segment, which made every pattern route unrecognisable.
  const body = m[2].replace(/\\\//g, '/').replace(/\[\^\/\]\+/g, ':id');
  routes.push({ method: m[1], path: '/api/v0/' + body, kind: 'pattern' });
}
const seen = new Set();
for (const r of routes) {
  const key = r.method + ' ' + r.path;
  if (seen.has(key)) continue;
  seen.add(key);
  add({ source: 'gateway_route', id: key, method: r.method, path: r.path, pattern: r.kind === 'pattern' });
}
for (const m of server.matchAll(/u\.pathname(?:===|!==)'(\/api\/v0\/[^']+)'/g)) add({source:'gateway_transport',id:'WS '+m[1],path:m[1]});

// ---------------------------------------------------------------- source 2 + 4: action routes and the Room catalog
let ACTION_OPERATIONS = {};
for (const file of ['services/dev-gateway/actions.mjs', 'services/dev-gateway/rooms.mjs']) {
  if (!existsSync(join(ROOT, file))) continue;
  const src = read(file);
  for (const m of src.matchAll(/['"]([a-z0-9_.-]+)['"]\s*:\s*\{\s*room\s*:/g)) ACTION_OPERATIONS[m[1]] = file;
  for (const m of src.matchAll(/room\s*:\s*['"]([a-z0-9_.-]+)['"]/g)) ACTION_OPERATIONS[m[1]] = file;
}
for (const route of ACTION_ROUTES) add({source:'action_route_kind',id:route});
for (const op of Object.keys(ROOM_OPERATIONS)) add({source:'ask_target',id:'ROOM:'+op});
for (const [target, operations] of Object.entries(CAPABILITY_OPERATIONS)) for (const op of Object.keys(operations)) add({source:'ask_target',id:'CAPABILITY:'+target+':'+op});
for (const type of CITY_TASK_TYPES) add({source:'ask_target',id:'CITY_TASK:'+type});
const activeRooms = new Set(ROOMS.map(r=>r.id));
for (const room of ALL_ROOMS) add({source:'room_catalog',id:room.id,lifecycle:room.lifecycle,active:activeRooms.has(room.id)});

// ---------------------------------------------------------------- source 5 + 10: capability registry records and indexes
// The capability registry lives in the Digital-City control plane, NOT in this implementation repo. An earlier draft
// read it from the union worktree, found nothing, and therefore classified eleven already-registered capabilities as
// unregistered routes; the registry root is therefore explicit and is asserted to be non-empty.
const REG_ROOT = process.env.CEX790_REGISTRY_ROOT;
if (!REG_ROOT) throw new Error('Set CEX790_REGISTRY_ROOT to the Digital-City control-plane checkout');
const { parseDocument } = createRequire(join(ROOT, 'city/package.json'))('yaml');
const REG = 'capability-registry';
const records = [];
const regRecordsDir = join(REG_ROOT, REG, 'records');
if (!existsSync(regRecordsDir)) throw new Error('capability registry not found at ' + regRecordsDir);
{
  for (const f of readdirSync(regRecordsDir).filter(n => n.endsWith('.yaml'))) {
    const src = readFileSync(join(regRecordsDir, f), 'utf8');
    const parsed = parseDocument(src, {uniqueKeys:true});
    if (parsed.errors.length) throw new Error(`${f}: ${parsed.errors.map(e=>e.message).join('; ')}`);
    const rec = parsed.toJS();
    const id = rec.capability_id, cls = rec.exposure?.class;
    const impl = rec.status?.implementation_status, wire = rec.status?.backend_wiring_status;
    const reach = rec.status?.user_reachability_status, recon = rec.research_observations?.registry_reconciliation_result || rec.registry_reconciliation_result;
    const apis = (rec.implementation?.api_or_actions || []).filter(a=>typeof a==='string' && /^(GET|POST|PATCH)\s+\/api\/v0\//.test(a));
    const platforms = (rec.surfaces || []).map(s=>s.platform);
    if (!id || !cls) throw new Error(`Incomplete capability identity/exposure: ${f}`);
    const absentPaths = (rec.implementation?.paths || []).filter(p=>!existsSync(join(ROOT,p)));
    records.push({ file: f, id, cls, impl, wire, reach, recon, apis, platforms, absentPaths });
    add({ source: 'capability_registry_record', id, registry_class: cls, implementation: impl, backend_wiring: wire, reachability: reach, reconciliation: recon, apis, platforms, absent_paths: absentPaths, file: join(REG, 'records', f) });
  }
}

// ---------------------------------------------------------------- source 6: Web clickable entries
const webFiles = [];
const walk = (dir) => { for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (/\.(js|html)$/.test(e.name)) webFiles.push(p.replace(/\\/g, '/')); } };
walk('apps/web');
const webEntries = new Map();
for (const f of webFiles) {
  const src = read(f);
  for (const m of src.matchAll(/data-page="([A-Za-z/]+)"/g)) if (!webEntries.has('page:'+m[1])) webEntries.set('page:'+m[1], f);
  for (const m of src.matchAll(/data-terminal="([a-z-]+)"/g)) { const k = 'terminal:' + m[1]; if (!webEntries.has(k)) webEntries.set(k, f); }
  for (const m of src.matchAll(/data-scheduler-action="([A-Z_]+)"/g)) { const k = 'scheduler:' + m[1]; if (!webEntries.has(k)) webEntries.set(k, f); }
  for (const m of src.matchAll(/data-goto="([A-Za-z/]+)"/g)) { const k = 'goto:' + m[1]; if (!webEntries.has(k)) webEntries.set(k, f); }
  // Only interactive entries are inventoried. Every element carrying an id is NOT a user entry, and counting them
  // inflated the matrix with dozens of non-entries in an earlier draft.
  for (const m of src.matchAll(/<button[^>]*id="([a-z0-9-]+)"/g)) { const k = 'dom:' + m[1]; if (!webEntries.has(k)) webEntries.set(k, f); }
}
for (const [k, f] of webEntries) add({ source: 'web_entry', id: k, file: f });

// ---------------------------------------------------------------- source 7 + 8: Android clickable entries, Settings and recovery lifecycle
const KT = 'apps/android/app/src/main/java/city/utopia/control';
const ktFiles = readdirSync(join(ROOT, KT)).filter(n => n.endsWith('.kt'));
const androidEntries = [];
for (const f of ktFiles) {
  const src = read(join(KT, f));
  if (/@Composable\s+fun\s+\w*Panel\s*\(/.test(src)) for (const m of src.matchAll(/@Composable\s+fun\s+(\w*Panel)\s*\(/g)) androidEntries.push({ kind: 'panel', id: m[1], file: KT + '/' + f });
  if (/\bText\(".*"\)/.test(src)) for (const m of src.matchAll(/Button\([^)]*\)\s*\{\s*Text\("([^"]{1,40})"\)/g)) androidEntries.push({ kind: 'button', id: m[1], file: KT + '/' + f });
}
const main = read(join(KT, 'MainActivity.kt'));
const navLists = [...main.matchAll(/val \w*[Nn]av\s*=\s*listOf\(([\s\S]*?)\)/g)].map(m => m[1]);
const navTargets = [];
for (const l of navLists) for (const m of l.matchAll(/"([A-Za-z/]+)"\s*to/g)) navTargets.push(m[1]);
const pageBranches = [...main.matchAll(/page\s*==\s*"([A-Za-z/]+)"/g)].map(m => m[1]);
for (const t of new Set([...navTargets, ...pageBranches])) add({ source: 'android_entry', id: 'page:' + t, file: KT + '/MainActivity.kt' });
for (const e of androidEntries) add({ source: 'android_entry', id: e.kind + ':' + e.id, file: e.file });

// ---------------------------------------------------------------- source 9: scheduler user actions
const sched = read('apps/web/scheduler.js');
const ACTION_WIRING = {};
for (const m of sched.matchAll(/([A-Z_]+):\s*\{\s*kind:\s*'([a-z]+)',\s*route:\s*(null|'[a-z]+')\s*\}/g)) ACTION_WIRING[m[1]] = { kind: m[2], route: m[3] === 'null' ? null : m[3].replace(/'/g, '') };
for (const [k, v] of Object.entries(ACTION_WIRING)) add({ source: 'scheduler_user_action', id: k, wiring: v.kind, route: v.route });

// ---------------------------------------------------------------- classification
const WEB_TO_ANDROID_PAGE = { Home: 'Home', Ask: 'Ask', 'Ask/Do': 'Ask', Rooms: 'Rooms', Devices: 'Devices', Activity: 'Activity', Services: 'Services', Tasks: 'Tasks', Action: 'Action', Settings: 'Settings', Pairing: 'Find', ResearchTrace: 'ResearchTrace' };
const registryApiSet = new Set(records.flatMap(r => r.apis.map(a => a.replace(/\s+/g, ' ').toUpperCase())));
// Path-only view of the registry's declared API surface. The records declare `GET /api/v0/x`, so the comparison has to
// be made on the path alone; an earlier draft compared the whole method-plus-path string and therefore matched nothing,
// which silently turned eleven registered capabilities into unregistered routes.
const registryApiPaths = new Set(records.flatMap(r => r.apis.map(a => {
  const i = a.indexOf('/api/v0');
  return i >= 0 ? a.slice(i) : a;
})));
console.log('REGISTRY_API_PATHS ' + registryApiPaths.size + ' ' + JSON.stringify([...registryApiPaths].slice(0, 8)));
console.log('REGISTRY_RECORD_API_COUNTS ' + JSON.stringify(records.map(r => r.id + ':' + r.apis.length)));
const isInternalProtocol = p => /^\/api\/v0\/(health|events|presentation|city|join\/(info|nearby|status|exchange|request)|pairing\/(info|exchange)|device\/(session|enroll))$/.test(p) || /^\/api\/v0\/node\/(register|heartbeat|descriptor|claim|report)$/.test(p);
const webPages = new Set([...webEntries.keys()].filter(k => k.startsWith('page:')).map(k => k.slice(5)));
const androidPages = new Set(items.filter(i => i.source === 'android_entry' && i.id.startsWith('page:')).map(i => i.id.slice(5)));

function classify(item) {
  if (item.source === 'action_route_kind') return {class:item.id==='GENERAL_AI'?'FUTURE_PRODUCT_INTEGRATION':'EXPOSED',rule:item.id==='GENERAL_AI'?'Reserved route with typed UNAVAILABLE; no executor claimed.':'Canonical Action adapter reachable from Ask/Actions.'};
  if (item.source === 'ask_target') return {class:'EXPOSED',rule:'Authoritative Ask catalog export, reachable through target selection; availability is checked by the canonical adapter.'};
  if (item.source === 'room_catalog') return {class:item.active?'EXPOSED':'DEPRECATED',rule:item.active?'Active Room catalog; live availability is disclosed by the Room Hub.':'Retired/promoted/rejected catalog identity, not a current callable Room.'};
  if (item.source === 'gateway_transport') return {class:'INTERNAL_TRANSPORT',rule:'Authenticated WebSocket transport; users enter through pairing and live product pages, not a separate action.'};
  if (item.source === 'gateway_route') {
    const key = item.method + ' ' + item.path;
    const registered = registryApiPaths.has(item.path) || [...registryApiPaths].some(a => a === item.path || a.startsWith(item.path + '/'));
    const webSurface = [...webEntries.keys()].some(k => k.includes(item.path.replace('/api/v0/', '').split('/')[0]));
    const androidSurface = [...androidPages].some(p => item.path.toLowerCase().includes(p.toLowerCase()) && p.length > 2);
    if (isInternalProtocol(item.path)) return { class: 'INTERNAL_PROTOCOL', rule: 'matches the internal protocol/transport allow-list (health, events feed, node worker API, join/pairing handshake, device session mint)' };
    if (registered) {
      const rec = records.find(r => r.apis.some(a => { const i = a.indexOf('/api/v0'); const p = i >= 0 ? a.slice(i) : a; return p === item.path || p.startsWith(item.path + '/'); }));
      return { class: rec.cls === 'OBSERVABLE_ADVANCED' ? 'EXPOSED_ADVANCED' : rec.cls === 'INTERNAL_ONLY' ? 'INTERNAL_PROTOCOL' : 'EXPOSED', rule: `named by capability record ${rec.id} (exposure class ${rec.cls}); backend wiring ${rec.wire}; reconciliation ${rec.recon}`, capability: rec.id };
    }
    if (webSurface && androidSurface) return { class: 'EXPOSED', rule: 'has both a Web entry group and an Android page whose name matches the route family' };
    if (webSurface || androidSurface) return { class: 'PARITY_GAP', rule: `only one first-class surface is detectable (web=${webSurface}, android=${androidSurface})` };
    return { class: 'CURRENT_ENTRY_GAP', rule: 'no user surface and no capability record names this route' };
  }
  if (item.source === 'capability_registry_record') {
    if (item.absent_paths.length) return {class:'FUTURE_PRODUCT_INTEGRATION', rule:'Record is branch-scoped; implementation paths are absent from this integration tree. Not an accepted main capability.'};
    const cls = item.registry_class === 'OBSERVABLE_ADVANCED' ? 'EXPOSED_ADVANCED' : item.registry_class === 'INTERNAL_ONLY' ? 'INTERNAL_PROTOCOL' : 'EXPOSED';
    return { class: cls, rule: `registry declares exposure class ${item.registry_class}; reconciliation ${item.reconciliation}` };
  }
  if (item.source === 'web_entry') {
    const p = item.id.split(':')[1];
    if (item.id.startsWith('page:')) return { class: androidPages.has(WEB_TO_ANDROID_PAGE[p] ?? p) ? 'EXPOSED' : 'PARITY_GAP', rule: androidPages.has(WEB_TO_ANDROID_PAGE[p] ?? p) ? 'page exists on both Web and Android nav' : 'Web page with no matching Android page' };
    return { class: 'EXPOSED', rule: 'clickable entry rendered by the Web surface' };
  }
  if (item.source === 'android_entry') {
    const p = item.id.split(':')[1];
    if (item.id.startsWith('page:')) return { class: webPages.has(p) || Object.values(WEB_TO_ANDROID_PAGE).includes(p) ? 'EXPOSED' : 'CURRENT_ENTRY_GAP', rule: 'Android page; web counterpart resolved through the nav map' };
    return { class: 'EXPOSED', rule: 'clickable entry rendered by the Android surface' };
  }
  if (item.source === 'scheduler_user_action') return { class: item.wiring === 'unwired' ? 'CURRENT_ENTRY_GAP' : 'EXPOSED', rule: `ACTION_WIRING kind=${item.wiring}${item.route ? ' route=' + item.route : ''}` };
  if (item.source === 'action_or_room_operation') return { class: 'EXPOSED', rule: 'reachable through the ask/action target catalog' };
  return { class: 'FUTURE_PRODUCT_INTEGRATION', rule: 'not classified by any rule; recorded for the reviewer to decide' };
}
for (const item of items) Object.assign(item, classify(item));

// ---------------------------------------------------------------- summary + write
const byClass = {};
for (const i of items) byClass[i.class] = (byClass[i.class] || 0) + 1;
const bySource = {};
for (const i of items) bySource[i.source] = (bySource[i.source] || 0) + 1;
const outDir = resolve(ROOT, outputRoot);
mkdirSync(outDir, { recursive: true });
const sourcePaths = ['services/dev-gateway/server.mjs','services/dev-gateway/actions.mjs','services/dev-gateway/rooms.mjs','apps/rooms/hub/manifest.mjs', ...webFiles, ...ktFiles.map(f=>join(KT,f))];
const doc = { workbook: 'CEX-790', baseline: revision, working_tree_diff: execFileSync('git',['diff','HEAD','--stat'],{encoding:'utf8'}).trim(), source_hashes: Object.fromEntries(sourcePaths.map(p=>[p.replace(/\\/g,'/'),hash(join(ROOT,p))])), registry_sha: execFileSync('git',['-C',REG_ROOT,'rev-parse','HEAD'],{encoding:'utf8'}).trim(), registry_dirty_state: execFileSync('git',['-C',REG_ROOT,'status','--porcelain'],{encoding:'utf8'}).trim(), registry_hashes: Object.fromEntries(records.map(r=>[r.file,hash(join(regRecordsDir,r.file))])), scope: 'STATIC_DISCOVERY_CANDIDATES_NOT_RUNTIME_VERDICTS', sources: bySource, classes: byClass, registry_records: records.map(r => ({ id: r.id, class: r.cls, wire: r.wire, reach: r.reach, recon: r.recon, platforms: r.platforms })), items };
writeFileSync(join(outDir, 'capability-inventory.json'), JSON.stringify(doc, null, 1));

console.log('SOURCES ' + JSON.stringify(bySource));
console.log('CLASSES ' + JSON.stringify(byClass));
console.log('TOTAL ' + items.length);
console.log('--- CURRENT_ENTRY_GAP / PARITY_GAP items ---');
for (const i of items.filter(x => x.class === 'CURRENT_ENTRY_GAP' || x.class === 'PARITY_GAP')) console.log(`${i.class} | ${i.source} | ${i.id} | ${i.rule}`);
console.log('--- registry reconciliation states ---');
for (const r of records) console.log(`${r.id} | class=${r.cls} | wire=${r.wire} | reach=${r.reach} | recon=${r.recon}`);
