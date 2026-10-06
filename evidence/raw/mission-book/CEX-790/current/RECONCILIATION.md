# CEX-790 current-main integration reconciliation

Source: `65f86f91a3d404cdbcb8f2fa43ceb9da8e994600`; base main: `213f9f9f7087ac4cbfe371a5e273a834cfd8f3ef`; historical Mech audit: `04ecb7dd22ffd7296e00320b63681f7d9729181d`. Registry source SHA and input-content hashes are in `capability-inventory.json`. This is a bounded code/contract audit, not physical-device acceptance.

An independent technical reviewer inspected dispatch branches in either operand order, websocket upgrades, authoritative catalog exports and `buildTargets`, then compared identities against the historical JSON. The Alien integrator separately resolved conflicts and ran real Gateway/browser probes. The reviewer is a same-host technical subagent, not a second physical host; the original developer was Mech.

| Source | Independent reconstruction | Current generated discovery |
|---|---:|---:|
| Method-specific HTTP dispatch | 59 | 59 |
| Method-free health (represented as GET) | 1 | 1 |
| Websocket transports | 2 | 2 |
| Action route kinds | 4 | 4 |
| Ask targets: Room / capability / task | 5 / 6 / 5 | 5 / 6 / 5 |
| Active / retired Room identities | 10 / 10 | 10 / 10 |
| Registry records | 17 | 17 |
| Extracted Web / Android entries | 47 / 35 | 47 / 35 |
| Scheduler action kinds | 4 | 4 |

The 205 generated items are discovery candidates, not 205 verified capabilities. Historical automation mixed five Room operations with four Room names, missed reversed-order experiment collection routes, and overclassified owner sharing/join approvals as internal. These defects are repaired and pinned by `tests/cex790-current-inventory.test.mjs`. Historical evidence and its renderer remain explicitly bound to the old union.

## Classified differences

| Difference | Classification and disposition |
|---|---|
| Eleven HTTP additions, zero removals | Post-audit features: trace; GET/POST execution profile; monitor; node descriptor; six experiment routes. Existing main behaviour is preserved. |
| Six Web, three Android entry additions | Post-audit surfaces. Research manifest entry is Web-only; REX-807 owns further Android research parity. No device observation claimed. |
| Capability bridge's five historical registry gaps | Closed by CAP-CAPABILITY-BRIDGE-001; Services remains wired on Web/Android. Historical gaps are not reopened by copying the old matrix. |
| Cancel/provider-choice; Actions vs Android Action | Classifier false positives. Canonical scheduler wiring and both user surfaces remain. |
| Host join/status Web-only | Intentional local-host-owner control; explicit surface-only parity difference. Android does not become a Windows host controller. |
| Generic CONFIRM | Future seam: remains unwired until identical canonical semantics exist. No fake button action added. |
| Execution-profile GET/POST | Post-audit entry integration debt owned by WBC-604: backend defaults to standard devices; future WORKER_POOL/HYBRID activation has no normal product control in this tree. Recorded, not falsely marked exposed. |
| Five Registry records with absent paths | Branch-scoped pending integrations: host lifecycle, MON-002, MON-003, research campaign, research faults. Not accepted main runtime capabilities. Their record/source identities remain available to their owning programmes. |
| GENERAL_AI | Reserved typed-unavailable future integration; no executor invented. |
| Retired Room identities | Deprecated catalog history, not callable current Rooms. |
| Storage-unavailable startup failures | Genuine defects, independently reproduced and fixed below. |

## Repairs and evidence

Five merge-conflicted files were reconciled. Main's Android enrollment/session renewal/leave and research trace survived; the widened native typed-refusal set was united. Duplicate Web terminal/Devices renders were removed, retaining credential fencing and scheduler busy state.

Two independently provided repair branches were adopted as explicit file diffs: `repair/capability-bridge-mech-artifact-store-guard` and `repair/REX-801-mech-store-guard`. Seven pre-fix store probes failed (EEXIST/ENOTDIR and missing diagnostics), all seven passed after repair. Failed construction also left test resources pending; that owned red-run process was terminated after evidence capture. No real City process was terminated. Stores now degrade individually and answer typed failures; valid-but-unfiled manifest receipts carry `persisted:false` and the reason. The Web dropped-field defect was reproduced with a real browser (empty degradation notice before fix), then repaired and verified.

Initial full Gateway/Web regression before added guards: 1350 pass, zero fail. Final affected-suite checks: 11 pass, zero fail. Rooms: 69 pass. City: 1969 pass, zero fail, 15 explicit skips. Bilingual and ten promotion-history checks passed. Final-head hosted CI is reported by the control-plane integration report, not inferred here. No Android physical-device or external-provider validation is claimed.

This closes integration of the CEX-701..705 entry programme and its audit evidence; the named post-audit programme debts retain their actual status. An audit classification is not a new capability acceptance.
