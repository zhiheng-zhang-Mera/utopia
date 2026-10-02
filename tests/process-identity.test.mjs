// Process identity resolution for the recovery pilot's kill step.
//
// The regression under test was reproduced on this host before the fix existed: the inline
// implementation JSON.parsed the PowerShell output unconditionally, and a PID that was no longer live
// produced EMPTY output with exit code 0, so JSON.parse('') threw "Unexpected end of JSON input".
// A stale PID therefore crashed the run. These tests pin that, and pin the three cases apart.

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {commandLineFromJson,imageNameFromTasklist,resolveProcessIdentity,shouldKill,isFatalIdentity,cimArgs,tasklistArgs} from '../scripts/lib/process-identity.mjs';

const NODE_EXE='C:\\Program Files\\nodejs\\node.exe';
const NODE='agents/reference-node/main.mjs';
const GW='services/dev-gateway/main.mjs';
const cim=(commandLine)=>JSON.stringify({CommandLine:commandLine});

/** exec stub: keyed by executable, values are strings to return or Errors to throw. */
const stub=(map)=>(file)=>{
  const v=map[file];
  if(v===undefined)throw Error(`unexpected exec of ${file}`);
  if(v instanceof Error)throw v;
  return v;
};

test('the old inline implementation throws on empty output, which is the regression', () => {
  // Reproduces the replaced line exactly. This is the defect, not a description of it.
  assert.throws(()=>JSON.parse(''),{name:'SyntaxError',message:'Unexpected end of JSON input'});
});

test('empty output is read as "already gone", not as an unparseable error', () => {
  const r=resolveProcessIdentity({pid:999999,expected:NODE,exec:stub({'powershell.exe':''})});
  assert.equal(r.status,'already-gone');
  assert.equal(r.verified,false);
  assert.equal(r.via,'cim');
  // A process that is already gone must NOT be killed and must NOT abort the run.
  assert.equal(isFatalIdentity(r.status),false);
  assert.equal(shouldKill(r.status),false);
});

test('"null" from ConvertTo-Json is also treated as already gone', () => {
  const r=resolveProcessIdentity({pid:5,expected:NODE,exec:stub({'powershell.exe':'null'})});
  assert.equal(r.status,'already-gone');
});

test('a live, matching process verifies through CIM', () => {
  const r=resolveProcessIdentity({pid:42,expected:NODE,exec:stub({'powershell.exe':cim(`"${NODE_EXE}" ${NODE}`)})});
  assert.equal(r.status,'verified');
  assert.equal(r.verified,true);
  assert.equal(r.via,'cim');
  assert.equal(shouldKill(r.status),true);
});

test('a live process running something else is a FATAL mismatch, as it was before', () => {
  // The original safety intent is preserved: a recycled PID must not be killed silently.
  const r=resolveProcessIdentity({pid:42,expected:NODE,exec:stub({'powershell.exe':cim('"C:\\Windows\\explorer.exe"')})});
  assert.equal(r.status,'mismatch');
  assert.equal(isFatalIdentity(r.status),true);
});

test('a quoting-safe array result is handled as well as a single object', () => {
  const raw=JSON.stringify([{CommandLine:`"${NODE_EXE}" ${NODE}`}]);
  assert.equal(resolveProcessIdentity({pid:1,expected:NODE,exec:stub({'powershell.exe':raw})}).status,'verified');
});

test('a missing CommandLine field is not mistaken for a match', () => {
  const r=resolveProcessIdentity({pid:1,expected:NODE,exec:stub({'powershell.exe':JSON.stringify({Name:'x'})})});
  assert.equal(r.verified,false);
  assert.notEqual(r.status,'verified');
});

test('when CIM is unusable, tasklist still catches a plainly wrong process', () => {
  const r=resolveProcessIdentity({pid:7,expected:NODE,exec:stub({
    'powershell.exe':Error('powershell.exe not found'),
    'tasklist':'"notepad.exe","1234","Console","1","10,000 K"\r\n',
  })});
  assert.equal(r.status,'weak');
  assert.equal(r.via,'tasklist');
  assert.equal(r.imageName,'notepad.exe');
  // Weak evidence still kills - the PID came from our own processes.json - but it is RECORDED as weak
  // so a reader cannot mistake it for a verified identity.
  assert.equal(shouldKill(r.status),true);
  assert.equal(isFatalIdentity(r.status),false);
});

test('tasklist reporting no match is already-gone rather than unavailable', () => {
  const r=resolveProcessIdentity({pid:7,expected:NODE,exec:stub({
    'powershell.exe':Error('blocked'),
    'tasklist':'INFO: No tasks are running which match the specified criteria.\r\n',
  })});
  assert.equal(r.status,'already-gone');
  assert.equal(imageNameFromTasklist('INFO: No tasks are running which match the specified criteria.'),null);
});

test('both probes failing is unavailable, and is not fatal', () => {
  const r=resolveProcessIdentity({pid:7,expected:NODE,exec:stub({
    'powershell.exe':Error('powershell.exe not found'),
    'tasklist':Error('tasklist not found'),
  })});
  assert.equal(r.status,'unavailable');
  assert.equal(r.verified,false);
  assert.equal(isFatalIdentity(r.status),false);
  assert.ok(r.detail.includes('not found'));
});

test('unparseable-but-non-empty CIM output falls through to the weaker probe instead of claiming absence', () => {
  // Important distinction: garbage output is a probe problem, not evidence the process is gone.
  const r=resolveProcessIdentity({pid:7,expected:NODE,exec:stub({
    'powershell.exe':'Get-CimInstance : Access denied\r\n',
    'tasklist':'"node.exe","7","Console","1","50,000 K"\r\n',
  })});
  assert.equal(r.status,'weak');
  assert.equal(r.imageName,'node.exe');
});

test('a UTF-8 BOM on the output does not break parsing', () => {
  assert.equal(commandLineFromJson('\uFEFF'+cim(`node ${NODE}`)),`node ${NODE}`);
});

test('every returned status is one of the declared statuses', () => {
  const cases=['', 'null', cim(`node ${NODE}`), cim('other.exe'), 'garbage'];
  for(const out of cases){
    const r=resolveProcessIdentity({pid:1,expected:NODE,exec:stub({'powershell.exe':out})});
    assert.ok(['verified','mismatch','already-gone','weak','unavailable'].includes(r.status),r.status);
  }
});

test('a non-numeric PID is fatal and never reaches a command line', () => {
  // Without explicit validation, Number('42; ...') is NaN, the filter reads `ProcessId = NaN`, nothing
  // matches, and the corrupt PID would be misreported as already-gone - a silent skip of the kill.
  const r=resolveProcessIdentity({pid:'42; Remove-Item -Recurse /',expected:NODE,exec:()=>{throw Error('must not be called');}});
  assert.equal(r.status,'invalid-pid');
  assert.equal(isFatalIdentity(r.status),true);
  assert.equal(shouldKill(r.status),false,'an invalid PID must never be killed');
  assert.ok(r.detail.includes('non-numeric'));
});

test('the CIM and tasklist filters refuse a non-numeric PID outright', () => {
  assert.throws(()=>cimArgs('42; Remove-Item -Recurse /'),/invalid pid/);
  assert.throws(()=>tasklistArgs('42; Remove-Item -Recurse /'),/invalid pid/);
  assert.throws(()=>cimArgs('abc'),/invalid pid/);
  assert.throws(()=>cimArgs(0),/invalid pid/);
  assert.throws(()=>cimArgs(-5),/invalid pid/);
  assert.ok(cimArgs('42')[2].includes('ProcessId = 42'));
  assert.ok(tasklistArgs('42').includes('PID eq 42'));
  assert.ok(cimArgs(42)[2].includes('ProcessId = 42'),'numeric input is accepted');
});
