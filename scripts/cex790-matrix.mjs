// CEX-790 — render the human-readable entry matrix from the machine-readable inventory, and hand-curate the
// exceptions the automated rules cannot decide. The curated verdict for each exception is recorded with its reason so
// the opposite-host reviewer can disagree with a specific line rather than with a black box.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const inv = JSON.parse(readFileSync(join(ROOT, 'evidence/raw/mission-book/CEX-790/capability-inventory.json'), 'utf8'));

// Hand curation. left: the automated class; right: the audited class and why.
const curation = [
  { id: 'GET /api/v0/capabilities', audited: 'CURRENT_ENTRY_GAP', kind: 'REGISTRY_GAP', why: 'The Web Services page and the Android Services panel both list and invoke capabilities, so the surface is user-reachable, but NO capability record names this route or the bridge behind it. Recorded as a registry gap: the capability-bridge invocation surface needs a CAP record, not a new UI.' },
  { id: 'GET /api/v0/capabilities/:id', audited: 'CURRENT_ENTRY_GAP', kind: 'REGISTRY_GAP', why: 'Same surface as GET /api/v0/capabilities: reachable from the Services page detail, unnamed by any record.' },
  { id: 'POST /api/v0/capabilities/:id/invoke', audited: 'CURRENT_ENTRY_GAP', kind: 'REGISTRY_GAP', why: 'The invoke path is the destructive/mutating half of the same unnamed surface. It keeps its confirmation and authority on the existing routes; what is missing is the registry entry that would let an auditor find it.' },
  { id: 'GET /api/v0/capability-invocations', audited: 'CURRENT_ENTRY_GAP', kind: 'REGISTRY_GAP', why: 'The invocation history the Services surface reads. Same unnamed capability bridge.' },
  { id: 'GET /api/v0/capability-invocations/:id', audited: 'CURRENT_ENTRY_GAP', kind: 'REGISTRY_GAP', why: 'Invocation detail. Same unnamed capability bridge.' },
  { id: 'POST /api/v0/host/join', audited: 'PARITY_GAP', kind: 'PARITY_GAP', why: 'A browser may switch this host between PRIMARY and MEMBER; the Android surface has no equivalent, and the route is deliberately restricted to a local host-owner request. Recorded as a real first-class-surface parity gap, not as a missing entry.' },
  { id: 'GET /api/v0/host/join/status', audited: 'PARITY_GAP', kind: 'PARITY_GAP', why: 'The status half of the same host-role flow; Web only by design (the request is refused for a non-local caller).' },
  { id: 'POST /api/v0/tasks/:id/cancel', audited: 'EXPOSED', kind: 'FALSE_POSITIVE', why: 'The automated rule could not see it: the Web reaches cancel through the scheduler ACTION_WIRING table (CANCEL -> route cancel) rather than through a path-shaped string. Both surfaces have it.' },
  { id: 'POST /api/v0/tasks/:id/provider-choice', audited: 'EXPOSED', kind: 'FALSE_POSITIVE', why: 'Same as cancel: the Web reaches it through ACTION_WIRING (CHOOSE_PROVIDER -> providerChoice) and the Android panel has a choose control.' },
  { id: 'page:Actions', audited: 'EXPOSED', kind: 'FALSE_POSITIVE', why: 'The Android advanced nav names the same page "Action" (singular), which the nav map did not cover. Both surfaces have the page.' },
  { id: 'CONFIRM', audited: 'CURRENT_ENTRY_GAP', kind: 'BY_DESIGN', why: 'ACTION_WIRING declares CONFIRM kind=unwired with no route. This is the honest-unwired control the CEX-702 review accepted: it must NOT be wired until a canonical route with proven-identical semantics exists.' },
];
const curatedById = new Map(curation.map(c => [c.id, c]));

const gapItems = inv.items.filter(i => i.class === 'CURRENT_ENTRY_GAP' || i.class === 'PARITY_GAP');
const rows = inv.items
  .slice()
  .sort((a, b) => (a.class + a.source + a.id).localeCompare(b.class + b.source + b.id))
  .map(i => `| ${i.class} | ${i.source} | \`${i.id}\` | ${(i.capability ? i.capability + ' — ' : '')}${i.rule.replace(/\|/g, '/')} |`);

const md = `# CEX-790 — backend → Web/Android entry inventory (development side)

\`\`\`text
BASELINE            dependency SHA union 5c7d46dcbf1b01259b5edaf574b620714beb40b7
                    (CEX-701 a24c0440, CEX-702 3d233ff3, CEX-703 478d4860, CEX-704 d05f5a45, CEX-705 de9185a4)
SOURCES READ        10, as the workbook names them
ITEMS                ${inv.items.length}
CLASSES              ${JSON.stringify(inv.classes)}
REGISTRY RECORDS     ${inv.registry_records.length}
MACHINE-READABLE     utopia:evidence/raw/mission-book/CEX-790/capability-inventory.json
\`\`\`

## 1. Sources actually read

| # | Source the workbook names | How it was read | Items |
|---|---|---|---|
| 1 | Gateway user-facing routes | parsed the request dispatcher in \`services/dev-gateway/server.mjs\`: ${inv.sources.gateway_route} routes, static and pattern, with their methods | ${inv.sources.gateway_route} |
| 2 | Action routes / operations | the operation catalog in \`services/dev-gateway/actions.mjs\` | ${inv.sources.action_or_room_operation} |
| 3 | Ask targets | the same catalog the \`GET /api/v0/ask/targets\` route serves (no second copy) | included above |
| 4 | Room catalog | read from the same catalog module as the Room operations | included above |
| 5 | capability registry | every record under the Digital-City \`capability-registry/records/\` | ${inv.sources.capability_registry_record} |
| 6 | Web clickable entry | \`data-page\`, \`data-terminal\`, \`data-scheduler-action\`, \`data-goto\` and button ids across \`apps/web\` | ${inv.sources.web_entry} |
| 7 | Android clickable entry | nav lists, \`page == "…"\` branches and \`@Composable …Panel\` definitions under \`…/control\` | ${inv.sources.android_entry} |
| 8 | Settings / recovery lifecycle | the device/pairing/join routes plus the Android Settings, recovery and onboarding panels | included in 1 and 7 |
| 9 | scheduler user actions | \`ACTION_WIRING\` in \`apps/web/scheduler.js\` | ${inv.sources.scheduler_user_action} |
| 10 | existing registry records / legacy backfill | the same ${inv.registry_records.length} records, plus \`CAPABILITY_INDEX.yaml\` / \`SURFACE_INDEX.yaml\` which are reconciled in §4 | ${inv.registry_records.length} |

## 2. The gate

The workbook does not require every endpoint to have a button. It requires that every **user-semantically mature**
capability has at least one ordinary entry, first-class surface parity, an explanation when unavailable, correct
confirmation/authority when destructive, and that future/infrastructure surfaces create no false affordance.

After curation the inventory therefore contains **no unclassified user-facing backend capability**, and the residual
gaps are exactly the three kinds below — each named, each explained, none silently dropped.

## 3. Curated exceptions — the audit's real output

${curation.map(c => `### ${c.id}\n\n* automated class: \`${(inv.items.find(i => i.id === c.id) || {}).class ?? 'n/a'}\`\n* audited class: \`${c.audited}\` (${c.kind})\n* reason: ${c.why}\n`).join('\n')}

Summary of the curated exceptions:

\`\`\`text
REGISTRY_GAP      5   the whole capability-bridge invocation surface is user-reachable and unnamed by any record
PARITY_GAP        2   the host PRIMARY/MEMBER role switch is a browser-only first-class surface, by design
FALSE_POSITIVE    3   routes or pages the automated rule could not see (ACTION_WIRING, and Android's "Action" page)
BY_DESIGN         1   generic CONFIRM stays honest-unwired until a canonically identical route exists
\`\`\`

## 4. Capability Registry reconciliation state, read from the control plane

| capability | exposure class | backend wiring | reachability | reconciliation |
|---|---|---|---|---|
${inv.registry_records.map(r => `| \`${r.id}\` | ${r.class} | ${r.wire} | ${r.reach} | ${r.recon} |`).join('\n')}

**One reality mismatch found and recorded, not repaired here:** \`CAP-WORKER-POOL-AGENT-001\` still declares
\`CANDIDATE_RECONCILED_PENDING_FORMAL_REVIEW\`, but WBC-603 — the workbook that owns the worker pool seam — is
\`COMPLETE\` with \`review_complete: true\` and the terminal marker \`WORKER_POOL_AGENT_SEAM_ACCEPTED\` was released by the
opposite-host review on this host. The record also declares no API surface at all, which is consistent with its
\`INTERNAL_ONLY\` class. This is the \`CAPABILITY_REGISTRY_REALITY_MISMATCH\` the workbook's gate forbids, and it is
resolved in §5.

## 5. Registry backfill and reconciliation performed by this task

\`\`\`text
CAP-WORKER-POOL-AGENT-001   reconciliation -> FORMAL_REVIEW_RECONCILED, review evidence bound, known gaps updated
                            (the pending-Formal-Review gap is closed by the WBC-603 review that released the marker)
CAP-CAPABILITY-BRIDGE-001   NEW record for the capability-bridge invocation surface that the audit found unnamed:
                            GET /api/v0/capabilities, GET /api/v0/capabilities/:id, POST /api/v0/capabilities/:id/invoke,
                            GET /api/v0/capability-invocations, GET /api/v0/capability-invocations/:id
                            exposure class DIRECT_CONTROL on both first-class surfaces, user reachability PARTIAL
                            (the Web and Android Services surfaces exist; no E2E intent validation was performed)
CAPABILITY_INDEX.yaml       updated with the new record and the reconciled one
SURFACE_INDEX.yaml          updated with the new record's two surfaces
CAPABILITY_EXPOSURE_MATRIX  refreshed in both languages
\`\`\`

## 6. What this development-side inventory does NOT claim

* It does not claim the automated rules are complete. They produced ${gapItems.length} candidates of which 4 were
  false positives or by-design; the curation that resolved them is recorded above line by line so the reviewer can
  attack the reasoning rather than the classifier.
* It does not claim surface parity where the workbook does not require it: the host role switch is browser-only on
  purpose, and that is recorded as a parity gap rather than as a missing entry.
* It does not claim intent validation. Every backfilled record keeps \`intent_validation_status: NOT_TESTED\` unless an
  independent review said otherwise.
* The reviewer must rebuild this inventory independently from the code and diff the two, which is exactly what the
  workbook's Formal Review section requires and what this file is meant to be diffed against.
`;

const outDir = join(ROOT, 'evidence/raw/mission-book/CEX-790');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'CAPABILITY_ENTRY_INVENTORY.md'), md);
console.log('WROTE ' + join(outDir, 'CAPABILITY_ENTRY_INVENTORY.md'));
console.log('curated exceptions: ' + curation.length + ' | gap candidates: ' + gapItems.length);
console.log('classes: ' + JSON.stringify(inv.classes));
