// A PACKAGE MUST CARRY THE RECORDS IT POINTS AT.
//
// raw-pointers.json publishes `trace:<eventId>` for every trace record the export scoped in. Until this change the
// BYTES were not in the package, so a reproducer had to fetch them back from the City - which only works while the
// City still holds them, and the City's trace retention is bounded (a 256-record window over 2 MiB and ONE previous
// generation). Measured: the dev study's 206 pointers resolved 206/206 from the durable store on the morning of
// 2026-10-08 and 0/206 the same afternoon, the City's backup predated the study, and the evidence was therefore gone
// from every store while the package went on publishing the pointers as if they were retrievable.
//
// So the property is: every pointer the package publishes is backed by a record the package carries, and the package
// says how many that is. Checked here against the real builder rather than remembered.
import test from 'node:test';
import assert from 'node:assert/strict';
import {buildArtifact, artifactFiles, checksumsFor} from '../services/dev-gateway/research/artifact.mjs';

const record = i => ({eventId: `ev-${i}`, type: 'TASK_CREATED', timestamp: new Date(Date.UTC(2026, 9, 8, 0, 0, i)).toISOString(),
  canonicalRefs: {}, dimensions: {}, metrics: {}, missingFields: [], annotations: []});
const receipt = {campaignId: 'campaign-a', state: 'COMPLETED', scenarioId: 'WAIT', runs: [
  {index: 0, state: 'MEASURED', measured: true, warmup: false, result: {taskRef: 'Q-1', state: 'COMPLETED', assignedNodeId: 'node-a'}}],
  summary: {planned: 1, accounted: 1, measured: 1, terminalAccountingComplete: true}};
const task = {id: 'Q-1', state: 'COMPLETED', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:01.000Z'};
const build = traceRecords => buildArtifact({cityId: 'city-a', generatedAt: '2026-10-08T00:00:00.000Z', receipts: [receipt],
  tasks: [task], events: [], experiments: [], traceRecords});

test('ARTIFACT-TRACE 1: every published trace pointer is backed by a record the package carries',()=>{
  const artifact=build([record(1),record(2),record(3)]);
  const files=artifactFiles(artifact);
  assert.ok(files['trace-records.jsonl'],'the package must carry the records it points at');
  assert.ok(files['trace-coverage.json'],'and must declare how many it carries');
  const carried=files['trace-records.jsonl'].split('\n').filter(Boolean).map(line=>JSON.parse(line).eventId);
  const pointers=artifact.rawPointers.traceRecords.map(p=>String(p).replace(/^trace:/,''));
  assert.deepEqual(carried.sort(),pointers.sort(),'the carried records and the published pointers must be the same set');
  const coverage=JSON.parse(files['trace-coverage.json']);
  assert.equal(coverage.listed,pointers.length);
  assert.equal(coverage.captured,pointers.length,'coverage is by construction, so it must be complete for what is published');
  assert.equal(coverage.source,'CITY_TRACE_AT_EXPORT');
  // And the new files are covered by the package's own checksums like every other file.
  const checksums=checksumsFor(files);
  assert.ok(checksums['trace-records.jsonl']?.sha256,'checksums must cover the trace records');
  assert.ok(checksums['trace-coverage.json']?.sha256,'checksums must cover the coverage declaration');
  assert.equal(Object.keys(checksums).length,Object.keys(files).length,'every file must be checksummed');
});

test('ARTIFACT-TRACE 2: the bytes are deterministic, so the same records always give the same file',()=>{
  // A reproducer compares bytes. If the exporter emitted the records in arrival order, two exports of the same
  // evidence would differ and every checksum comparison would look like tampering.
  const forwards=artifactFiles(build([record(1),record(2),record(3)]))['trace-records.jsonl'];
  const backwards=artifactFiles(build([record(3),record(2),record(1)]))['trace-records.jsonl'];
  assert.equal(forwards,backwards,'the record file must be sorted, not arrival-ordered');
  assert.equal(forwards.trimEnd().split('\n').length,3);
  // An export with no trace records still emits the files, so a reader never has to guess whether they are absent or
  // empty - the coverage declaration says 0 and the file is empty.
  const none=artifactFiles(build([]));
  assert.equal(none['trace-records.jsonl'],'');
  assert.equal(JSON.parse(none['trace-coverage.json']).captured,0);
});
