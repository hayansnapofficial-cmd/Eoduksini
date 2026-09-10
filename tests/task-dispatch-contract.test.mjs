import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDispatchTask, dispatchApproval, dispatchRecoveryAssessment, dispatchRecoveryApproval, dispatchTaskDigest,
  prepareRecoveredDispatchTask } from '../studio/task-dispatch.mjs';

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

test('manual recovery binds termination evidence to one failed attempt and a new epoch',()=>{
  const task=createDispatchTask(input()),attempt={schema_version:1,attempt_id:'attempt-11111111-1111-4111-8111-111111111111',
    organization_id,task_id:task.task_id,dispatch_id:'TASK-1:head',role:'head',node_id:'node-head',dispatch_epoch:1,
    status:'RECOVERY_REQUIRED',recovery_reason:'LEASE_EXPIRED'};
  task.status='RECOVERY_REQUIRED';task.dispatches[0].status='RECOVERY_REQUIRED';task.dispatches[0].attempt_id=attempt.attempt_id;
  task.dispatches[0].recovery_reason='LEASE_EXPIRED';for(const item of task.dispatches.slice(1))item.status='BLOCKED';
  const recovery=dispatchRecoveryAssessment({recovery_id:'RECOVERY-1',task,attempt,disposition:'RETRY_CONFIRMED_TERMINATED',
    evidence_digest:sha('termination evidence'),verified_by:'319284410',target_dispatch_epoch:2,now});
  assert.equal(recovery.attempt_id,attempt.attempt_id);assert.equal(recovery.previous_dispatch_epoch,1);
  assert.equal(recovery.target_dispatch_epoch,2);assert.equal(recovery.recovery_reason,'LEASE_EXPIRED');
  assert.match(recovery.recovery_digest,/^[0-9a-f]{64}$/);
  const resumed=prepareRecoveredDispatchTask({task,recovery,now:now+1000});
  assert.equal(resumed.dispatch_epoch,2);assert.equal(resumed.status,'AWAITING_RECOVERY_APPROVAL');
  assert.equal(resumed.dispatches[0].status,'WAITING_RECOVERY_APPROVAL');assert.equal(resumed.dispatches[0].attempt_id,null);
  assert.deepEqual(resumed.dispatches.slice(1).map(item=>item.status),['BLOCKED','BLOCKED','BLOCKED']);
  const approval=dispatchRecoveryApproval({approval_id:'RECOVERY-APPROVAL-1',task:resumed,recovery,approved_by:'319284410',ttl_ms:60_000,now:now+2000});
  assert.equal(approval.recovery_digest,recovery.recovery_digest);assert.equal(approval.dispatch_epoch,2);
  assert.equal(approval.task_digest,resumed.task_digest);
  assert.throws(()=>dispatchRecoveryAssessment({recovery_id:'RECOVERY-2',task,attempt:{...attempt,status:'RUNNING'},
    disposition:'RETRY_CONFIRMED_TERMINATED',evidence_digest:sha('evidence'),verified_by:'319284410',target_dispatch_epoch:2,now}),
  /RECOVERY_ATTEMPT_NOT_RECOVERABLE/);
});
