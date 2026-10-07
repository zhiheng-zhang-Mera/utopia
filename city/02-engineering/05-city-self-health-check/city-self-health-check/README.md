# City self-health check / 城市只读自检

CHK-101/201/301/401/990 implements an explicit, bounded read-only command, not a periodic service. It reads Git-tracked repository source, canonical workbooks and JSON/YAML capability records. Relative import/API/export analysis is heuristic; findings require owner reconciliation. A runtime snapshot is an offline input bound to the current full implementation SHA, never live execution evidence.

本模块只读源码与记录，输出对账、可查询 self model、多假设诊断、hash-linked append-only case revisions、BLG-001～006 结论与 candidate routing receipts。缺失观测保持 UNKNOWN / NOT_MEASURED / NOT_RUN。没有调度、维修、自动晋升或执行权限。Owner 最新裁定允许本系列在单分支全量开发；独立第二机验收仍 NOT_RUN。

```powershell
node scripts/city-health-check.mjs --utopia D:/utopia --city D:/Digital-City --mode full --out D:/chk-evidence/run-001 --max-duration-ms 120000
node scripts/chk-second-host.mjs --utopia D:/utopia --city D:/Digital-City --implementation-sha <40-char-sha> --city-sha <40-char-sha> --out D:/chk-evidence/independent-001
```

Outputs must be new directories outside both inspected repositories. Outputs include report JSON/Markdown, source SHA256 manifest and artifact checksums. Default small scan: 500 files / 8 MB / 30 s; full: 12,000 files / 80 MB / 30 s. Absolute safety ceilings: 100,000 files / 200 MB / 120 s. Credential-like paths and symlink files are excluded. Skipped/budget-limited coverage cannot produce HEALTHY.

Optional `--runtime-snapshot <json>` schema: `{ "implementation_sha": "<full-sha>", "captured_at": "<ISO-time>", "capabilities": [{ "capability_id": "CAP-...", "state": "ONLINE|OFFLINE|DEGRADED|UNKNOWN" }] }`. Other fields are discarded. Runtime state is UNKNOWN when identity does not match. The snapshot is not independent acceptance.

Optional `--quarterly-input <json>` supplies `caseHistory`, `candidates` and `bossObservations` to `quarterlyReview`. Case revisions are appended with `appendCaseRevision(history, entry)`; the prior chain is validated before append. Persist all returned revisions in a new artifact; do not replace historical artifacts. Candidates require traceable case IDs/evidence and route to REX/RIV/DGX/URA/capability-linked Mission/GAI engineering/Boss legacy diff. CHK stores receipts; destination owners retain actual lifecycle truth and promotion/rollback authority.

The second-host runner verifies both exact heads and clean state, runs all twelve framework scenarios plus boundary tests and small/full checks, and writes checksummed replay logs. It never marks the series accepted. A reviewer must assess the actual outputs, unknown coverage and registry/runtime reconciliation before any freeze or future scheduling authorization.
