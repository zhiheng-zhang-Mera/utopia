import test from 'node:test';
import assert from 'node:assert/strict';
import {createPcfGovernancePort} from '../services/dev-gateway/governance-pcf-port.mjs';
test('DGX002 PCF adapter cannot treat caller JSON as approved permission/budget/deadline',()=>{
 const p=createPcfGovernancePort();assert.throws(()=>p.compileExecutionCapsule({task_ref:'task:one',approved_spec:{permission_ref:'fake'}},{stop_condition:'stop'}),/APPROVED_EXECUTION_SPEC_UNAVAILABLE/);
});
test('DGX002 PCF adapter refuses a returned permission for another task',()=>{
 const p=createPcfGovernancePort({readApprovedExecutionSpec:()=>({task_ref:'task:other'})});assert.throws(()=>p.compileExecutionCapsule({task_ref:'task:one'},{}),/APPROVED_EXECUTION_IDENTITY_MISMATCH/);
});
test('DGX002 PCF approval cannot use a stale shared fact version',()=>{
 const refs=Object.fromEntries(['task_ref','action_ref','parent_ref','stage_ref','origin_device_ref','parent_session_ref','execution_device_ref','boot_ref','provider_ref','session_ref','user_ref'].map(k=>[k,k+':one']));Object.assign(refs,{attempt:1,epoch:1,base_sha:'a'.repeat(40),candidate_sha:'b'.repeat(40)});
 const semantic={fact_version:2,input_refs:['e:one'],output_contract:'structured',stop_condition:'missing evidence',independence_floor_ref:'n1'};
 const p=createPcfGovernancePort({readApprovedExecutionSpec:()=>({...refs,...semantic,fact_version:1,write_scope:[],permission_ref:'permission:one',budget_ref:'budget:one',expires_at:'2099-01-01'})});
 assert.throws(()=>p.compileExecutionCapsule(refs,semantic),/APPROVED_FACT_VERSION_MISMATCH/);
});
