# V0.3 run ledger

PAIR_STATUS: SYNCHRONIZED
FACT: FINAL_WINDOWS_CASES=26
FACT: FINAL_ANDROID_CASES=25
FACT: MATCHED_CANONICAL_RESULTS=18

Raw JSON preserves failures and reinspections. Final cases use the last observation; record counts include retries and UI reinspection of the same invocation.

| Phase | Final cases | Records | Status | Evidence |
| --- | ---: | ---: | --- | --- |
| documents | 6 | 6 | PASS | [JSON](../../evidence/raw/v0.3/android-documents.json) |
| knowledge | 2 | 2 | PASS | [JSON](../../evidence/raw/v0.3/android-knowledge.json) |
| skills | 10 | 12 | PASS | [JSON](../../evidence/raw/v0.3/android-skills.json) |
| evidence-theme | 3 | 3 | PASS | [JSON](../../evidence/raw/v0.3/android-evidence-theme.json) |
| document-errors | 3 | 3 | PASS | [JSON](../../evidence/raw/v0.3/android-document-errors.json) |
| knowledge-temporary | 1 | 3 | PASS | [JSON](../../evidence/raw/v0.3/android-knowledge-temporary.json) |

All 26 Windows cases pass. Records include runId, codeSha, apkSha256, client, capabilityId, operationId, inputClass, inputBytes, startedAt, finishedAt, latencyMs, status, errorCode and resultDigest. startedAt/finishedAt map to workbook startAt/finishAt. inputBytes measures serialized invocation-input UTF-8 bytes; native oversize preflight explicitly records file bytes instead. Uncollected historical values remain null; enriched times come from actual persisted invocations. Latency is server execution, excluding operator and transport time.

Evidence Review additionally records integrityRoot, claimStatusCounts, decision and tamperResult. Exact bytes of the six public samples and a SHA-256 manifest of all published files are retained; no private documents, credentials or device serials are included.

Replay the published fixture-sample.* bytes using the original file name sample.*; the canonical document result includes the file name.
