import test from 'node:test';
import assert from 'node:assert/strict';
import {createPcfGovernancePort} from '../services/dev-gateway/governance-pcf-port.mjs';
test('DGX002 PCF adapter cannot treat caller JSON as approved permission/budget/deadline',()=>{
 const p=createPcfGovernancePort();assert.throws(()=>p.compileExecutionCapsule({task_ref:'task:one',approved_spec:{permission_ref:'fake'}},{stop_condition:'stop'}),/APPROVED_EXECUTION_SPEC_UNAVAILABLE/);
});
test('DGX002 PCF adapter refuses a returned permission for another task',()=>{
 const p=createPcfGovernancePort({readApprovedExecutionSpec:()=>({task_ref:'task:other'})});assert.throws(()=>p.compileExecutionCapsule({task_ref:'task:one'},{}),/APPROVED_EXECUTION_IDENTITY_MISMATCH/);
});
