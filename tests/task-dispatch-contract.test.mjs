import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDispatchTask, dispatchApproval, dispatchTaskDigest } from '../studio/task-dispatch.mjs';

const now=Date.UTC(2026,8,9,12),organization_id='org-42';
const sha=value=>createHash('sha256').update(value).digest('hex');
const authority={model_execution:false,remote_worker_execution:false,repository_write:false,approval:false,git_publish:false,deployment:false};
const assigned=(role,node)=>({model_id:`model-${role}`,node_id:`node-${node}`,provider_id:'openai',source:'automatic',
  reason_codes:['ROLE_CAPABILITY_EXACT','NODE_ONLINE','ADAPTER_AVAILABLE'],evidence:{node_last_seen_at:new Date(now-1000).toISOString(),cpu_logical:8,memory_bytes:1024}});
const decision=()=>({schema_version:1,organization_id,task_id:'TASK-1',profile_revision:3,mode:'automatic',head_assignment:assigned('head','head'),
  assignments:{planner:assigned('planner','work'),coder:assigned('coder','work'),reviewer:assigned('reviewer','review'),validator:assigned('validator','review')},
  status:'READY',issues:[],optimization_limits:['COST_POLICY_NOT_CONFIGURED','PRIVACY_POLICY_NOT_CONFIGURED'],authority,
  decision_digest:sha('decision'),evaluated_at:new Date(now).toISOString()});
const input=patch=>({organization_id,task_id:'TASK-1',objective:'Implement one bounded customer task.',profile_revision:3,
  roles:['validator','coder','planner'],assignment:decision(),dispatch_epoch:1,created_by:'319284410',now,...patch});

test('task graph is head first and binds every selected assignment',()=>{
  const task=createDispatchTask(input());
  assert.deepEqual(task.roles,['planner','coder','validator']);
  assert.deepEqual(task.dispatches.map(item=>item.role),['head','planner','coder','validator']);
  assert.equal(task.dispatches[0].status,'WAITING_APPROVAL');
  assert.deepEqual(task.dispatches.slice(1).map(item=>item.status),['WAITING_DEPENDENCY','WAITING_DEPENDENCY','WAITING_DEPENDENCY']);
  assert.deepEqual(task.dispatches.map(item=>item.predecessor_dispatch_id),[null,'TASK-1:head','TASK-1:planner','TASK-1:coder']);
  assert.equal(task.dispatches[2].node_id,'node-work');
  assert.match(task.role_graph_digest,/^[0-9a-f]{64}$/);
  assert.equal(task.task_digest,dispatchTaskDigest(task));
  assert.deepEqual(task.authority,authority);
});

test('task digest ignores mutable lifecycle state but detects graph mutation',()=>{
  const task=createDispatchTask(input()),changed=structuredClone(task);
  changed.status='ACTIVE';changed.updated_at=new Date(now+1000).toISOString();changed.dispatches[0].status='RUNNING';
  assert.equal(dispatchTaskDigest(changed),task.task_digest);
  changed.dispatches[0].model_id='model-other';
  assert.notEqual(dispatchTaskDigest(changed),task.task_digest);
});

test('task graph rejects non-ready, cross-boundary, malformed and authority-escalating input',()=>{
  assert.throws(()=>createDispatchTask(input({assignment:{...decision(),status:'MANUAL_REVIEW_REQUIRED'}})),/ASSIGNMENT_NOT_READY/);
  assert.throws(()=>createDispatchTask(input({assignment:{...decision(),organization_id:'org-99'}})),/ASSIGNMENT_BINDING_MISMATCH/);
  assert.throws(()=>createDispatchTask(input({objective:'bad\u0000objective'})),/INVALID_DISPATCH_TASK/);
  assert.throws(()=>createDispatchTask(input({roles:['head']})),/INVALID_DISPATCH_TASK/);
  assert.throws(()=>createDispatchTask(input({assignment:{...decision(),authority:{...authority,model_execution:true}}})),/ASSIGNMENT_AUTHORITY_ESCALATION/);
});

test('approval binds the immutable task graph and uses exclusive expiry',()=>{
  const task=createDispatchTask(input()),approval=dispatchApproval({approval_id:'APPROVAL-1',task,approved_by:'319284410',ttl_ms:60_000,now});
  assert.equal(approval.task_digest,task.task_digest);
  assert.equal(approval.role_graph_digest,task.role_graph_digest);
  assert.equal(approval.dispatch_epoch,1);
  assert.equal(approval.issued_at,now);
  assert.equal(approval.expires_at,now+60_000);
  assert.equal(approval.consumed_at,null);
  assert.match(approval.approval_digest,/^[0-9a-f]{64}$/);
  assert.throws(()=>dispatchApproval({approval_id:'A',task,approved_by:'319284410',ttl_ms:999,now}),/INVALID_DISPATCH_APPROVAL/);
});
