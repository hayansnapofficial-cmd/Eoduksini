import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccessStore } from '../studio/access-store.mjs';
import { resolveOrchestrationAssignment } from '../studio/orchestration.mjs';

const now=Date.UTC(2026,8,9,12),capabilities={agent_version:'0.1.0',os:'linux',arch:'x64',cpu_logical:8,memory_bytes:8*1024**3,
  gpu_status:'unavailable',gpu_devices:[],adapters:['openai']};

async function fixture() {
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-dispatch-')),root=join(parent,'access'),store=createAccessStore(root);
  await store.upsertIdentity({github_id:'42',login:'operator',avatar_url:null});
  const organization_id='org-42',connection=(await store.createProviderConnection({organization_id,provider_id:'openai',display_name:'Customer OpenAI'})).connection;
  const makeModel=async(role)=>(await store.createModel({organization_id,connection_id:connection.connection_id,provider_model_id:`provider-${role}`,
    display_name:`${role} model`,role_capabilities:[role]})).model;
  const models={};for(const role of ['head','planner','coder','reviewer','validator'])models[role]=await makeModel(role);
  const credentials={};const makeNode=async(name,cpu)=>{const {token}=await store.createNodeEnrollment({organization_id,display_name:name,now}),
    enrolled=await store.enrollNode({token,capabilities:{...capabilities,cpu_logical:cpu},now});credentials[enrolled.node.node_id]=enrolled.credential;return enrolled.node};
  const nodes=[await makeNode('Primary',16),await makeNode('Review',8)];
  const profile=await store.saveOrchestrationProfile({organization_id,mode:'automatic',head_model_id:models.head.model_id,
    assignments:{planner:null,coder:null,reviewer:null,validator:null}});
  const task_id='TASK-1',roles=['planner','coder','reviewer','validator'];
  const assignment=resolveOrchestrationAssignment({organization_id,task_id,expected_profile_revision:profile.revision,roles,profile,
    connections:store.providerConnections(organization_id),models:store.models(organization_id),nodes:store.nodes(organization_id),now});
  const createInput=patch=>({organization_id,task_id,objective:'Implement one bounded customer task.',profile_revision:profile.revision,roles,
    assignment,created_by:'42',idempotency_key:'create-1',now,...patch});
  return {parent,root,store,organization_id,profile,assignment,models,nodes,credentials,createInput};
}
const clean=value=>rmSync(value.parent,{recursive:true,force:true});
const H1='1'.repeat(64),H2='2'.repeat(64);
async function approved(value) {
  const created=await value.store.createDispatchTask(value.createInput());
  await value.store.approveDispatchTask({organization_id:value.organization_id,task_id:'TASK-1',expected_task_digest:created.task.task_digest,
    approval_id:'APPROVAL-1',approved_by:'42',ttl_ms:60_000,idempotency_key:'approve-1',now:now+1000});
  return created.task;
}

test('v7 migrates through v9 without changing existing registry data',async()=>{
  const value=await fixture();try{const file=join(value.root,'access.json'),before=JSON.parse(readFileSync(file,'utf8'));
    before.schema_version=7;for(const key of ['dispatch_epochs','dispatch_tasks','dispatch_approvals','dispatch_attempts','dispatch_idempotency'])delete before[key];
    writeFileSync(file,JSON.stringify(before));const migratedStore=createAccessStore(value.root),after=JSON.parse(readFileSync(file,'utf8'));
    assert.equal(after.schema_version,9);assert.deepEqual(after.dispatch_recoveries,{});assert.equal(migratedStore.dispatchEpoch(value.organization_id),1);
    assert.equal(migratedStore.models(value.organization_id).length,5);assert.deepEqual(await migratedStore.dispatchTasks(value.organization_id,now),[])
  }finally{clean(value)}});

test('v8 approvals migrate without changing their historical digest',async()=>{
  const value=await fixture();try{await approved(value);const file=join(value.root,'access.json'),before=JSON.parse(readFileSync(file,'utf8')),
    digest=Object.values(before.dispatch_approvals)[0].approval_digest;before.schema_version=8;delete before.dispatch_recoveries;
    for(const approval of Object.values(before.dispatch_approvals))delete approval.recovery_digest;writeFileSync(file,JSON.stringify(before));
    const migrated=createAccessStore(value.root),after=JSON.parse(readFileSync(file,'utf8'));assert.equal(after.schema_version,9);
    assert.equal(Object.values(after.dispatch_approvals)[0].approval_digest,digest);assert.equal(Object.values(after.dispatch_approvals)[0].recovery_digest,null);
    assert.equal((await migrated.dispatchTasks(value.organization_id,now+1000))[0].status,'QUEUED')
  }finally{clean(value)}});

test('create persists a server-built tenant graph and replays one idempotency key',async()=>{
  const value=await fixture();try{const first=await value.store.createDispatchTask(value.createInput()),replay=await value.store.createDispatchTask(value.createInput());
    assert.deepEqual(replay,first);assert.equal(first.task.organization_id,value.organization_id);assert.equal(first.task.status,'AWAITING_APPROVAL');
    assert.deepEqual(first.task.dispatches.map(item=>item.role),['head','planner','coder','reviewer','validator']);
    await assert.rejects(value.store.createDispatchTask(value.createInput({objective:'Different body.'})),/IDEMPOTENCY_CONFLICT/);
    await assert.rejects(value.store.createDispatchTask(value.createInput({assignment:{...value.assignment,organization_id:'org-99'},idempotency_key:'create-2'})),
      /ASSIGNMENT_BINDING_MISMATCH/)
  }finally{clean(value)}});

test('approval binds current digest profile and epoch but does not consume authority',async()=>{
  const value=await fixture();try{const created=await value.store.createDispatchTask(value.createInput()),approved=await value.store.approveDispatchTask({
    organization_id:value.organization_id,task_id:'TASK-1',expected_task_digest:created.task.task_digest,approval_id:'APPROVAL-1',approved_by:'42',
    ttl_ms:60_000,idempotency_key:'approve-1',now:now+1000});
    assert.equal(approved.task.status,'QUEUED');assert.equal(approved.task.dispatches[0].status,'QUEUED');
    assert.deepEqual(approved.task.dispatches.slice(1).map(item=>item.status),['WAITING_DEPENDENCY','WAITING_DEPENDENCY','WAITING_DEPENDENCY','WAITING_DEPENDENCY']);
    assert.equal(approved.approval.consumed_at,null);assert.deepEqual(await value.store.approveDispatchTask({organization_id:value.organization_id,
      task_id:'TASK-1',expected_task_digest:created.task.task_digest,approval_id:'APPROVAL-1',approved_by:'42',ttl_ms:60_000,
      idempotency_key:'approve-1',now:now+1000}),approved);
    await assert.rejects(value.store.approveDispatchTask({organization_id:value.organization_id,task_id:'TASK-1',expected_task_digest:'f'.repeat(64),
      approval_id:'APPROVAL-2',approved_by:'42',ttl_ms:60_000,idempotency_key:'approve-2',now:now+1000}),/TASK_DIGEST_MISMATCH/)
  }finally{clean(value)}});

test('only the assigned head node consumes approval and creates one attempt',async()=>{
  const value=await fixture();try{await approved(value);const headNode=value.assignment.head_assignment.node_id,
    otherNode=value.nodes.find(node=>node.node_id!==headNode).node_id;
    await assert.rejects(value.store.claimDispatch({node_id:otherNode,idempotency_key:'claim-wrong',now:now+2000}),/NO_ELIGIBLE_DISPATCH/);
    const claim=await value.store.claimDispatch({node_id:headNode,idempotency_key:'claim-head',now:now+2000});
    assert.equal(claim.envelope.role,'head');assert.equal(claim.attempt.event_sequence,0);assert.equal(claim.attempt.lease_expires_at,now+122_000);
    assert.equal(claim.envelope.task_digest.length,64);assert.equal(claim.envelope.role_graph_digest.length,64);
    assert.equal(claim.envelope.assignment_digest,value.assignment.decision_digest);assert.equal(claim.envelope.profile_revision,value.profile.revision);
    assert.equal(claim.envelope.dispatch_epoch,value.store.dispatchEpoch(value.organization_id));
    assert.match(claim.activation_receipt,/^[0-9a-f]{64}$/);assert.deepEqual(await value.store.claimDispatch({node_id:headNode,
      idempotency_key:'claim-head',now:now+5000}),claim);
    await assert.rejects(value.store.claimDispatch({node_id:headNode,idempotency_key:'claim-again',now:now+5000}),/NO_ELIGIBLE_DISPATCH/)
  }finally{clean(value)}});

test('success opens exactly the next assigned role with predecessor digests',async()=>{
  const value=await fixture();try{await approved(value);const headNode=value.assignment.head_assignment.node_id,
    claim=await value.store.claimDispatch({node_id:headNode,idempotency_key:'claim-head',now:now+2000});
    const wrongNode=value.nodes.find(node=>node.node_id!==headNode).node_id,event={dispatch_id:claim.envelope.dispatch_id,
      attempt_id:claim.attempt.attempt_id,observed_started_at:new Date(now+2500).toISOString(),idempotency_key:'invalid-start',now:now+3000};
    await assert.rejects(value.store.startDispatch({...event,node_id:wrongNode,expected_epoch:1,event_sequence:1}),/DISPATCH_EVENT_NOT_FOUND/);
    await assert.rejects(value.store.startDispatch({...event,node_id:headNode,expected_epoch:2,event_sequence:1}),/DISPATCH_EPOCH_CHANGED/);
    await assert.rejects(value.store.startDispatch({...event,node_id:headNode,expected_epoch:1,event_sequence:2}),/DISPATCH_EVENT_SEQUENCE_MISMATCH/);
    await value.store.startDispatch({node_id:headNode,dispatch_id:claim.envelope.dispatch_id,attempt_id:claim.attempt.attempt_id,
      expected_epoch:1,event_sequence:1,observed_started_at:new Date(now+2500).toISOString(),idempotency_key:'start-head',now:now+3000});
    await value.store.finishDispatch({node_id:headNode,dispatch_id:claim.envelope.dispatch_id,attempt_id:claim.attempt.attempt_id,
      expected_epoch:1,event_sequence:2,status:'SUCCEEDED',result_digest:H1,evidence_digest:H2,
      observed_finished_at:new Date(now+3500).toISOString(),idempotency_key:'finish-head',now:now+4000});
    const plannerNode=value.assignment.assignments.planner.node_id,next=await value.store.claimDispatch({node_id:plannerNode,
      idempotency_key:'claim-planner',now:now+5000});
    assert.equal(next.envelope.role,'planner');assert.equal(next.envelope.predecessor_result_digest,H1);
    assert.equal(next.envelope.predecessor_evidence_digest,H2);const [task]=await value.store.dispatchTasks(value.organization_id,now+5000);
    assert.equal(task.dispatches.filter(item=>['CLAIMED','QUEUED','RUNNING'].includes(item.status)).length,1)
  }finally{clean(value)}});

test('expired claimed work fences the organization and never opens a successor',async()=>{
  const value=await fixture();try{await approved(value);const headNode=value.assignment.head_assignment.node_id,
    claim=await value.store.claimDispatch({node_id:headNode,idempotency_key:'claim-head',now:now+2000});
    await value.store.reconcileDispatches({organization_id:value.organization_id,now:claim.attempt.lease_expires_at});
    const [task]=await value.store.dispatchTasks(value.organization_id,claim.attempt.lease_expires_at);
    assert.equal(task.status,'RECOVERY_REQUIRED');assert.equal(task.dispatches[0].status,'RECOVERY_REQUIRED');
    assert.deepEqual(task.dispatches.slice(1).map(item=>item.status),['BLOCKED','BLOCKED','BLOCKED','BLOCKED']);
    assert.equal(value.store.dispatchEpoch(value.organization_id),2);
    await value.store.reconcileDispatches({organization_id:value.organization_id,now:claim.attempt.lease_expires_at+1000});
    assert.equal(value.store.dispatchEpoch(value.organization_id),2);
    await assert.rejects(value.store.progressDispatch({node_id:headNode,dispatch_id:claim.envelope.dispatch_id,attempt_id:claim.attempt.attempt_id,
      expected_epoch:1,event_sequence:1,observed_at:new Date(now+3000).toISOString(),idempotency_key:'late-progress',now:now+125_000}),
    /DISPATCH_EPOCH_CHANGED/)
  }finally{clean(value)}});

test('evidence assessment and separate approval retry only the exact fenced role',async()=>{
  const value=await fixture();try{await approved(value);const headNode=value.assignment.head_assignment.node_id,
    claim=await value.store.claimDispatch({node_id:headNode,idempotency_key:'claim-head',now:now+2000}),expired=claim.attempt.lease_expires_at;
    await value.store.reconcileDispatches({organization_id:value.organization_id,now:expired});const [fenced]=await value.store.dispatchTasks(value.organization_id,expired);
    const assessed=await value.store.assessDispatchRecovery({organization_id:value.organization_id,task_id:'TASK-1',attempt_id:claim.attempt.attempt_id,
      expected_task_digest:fenced.task_digest,recovery_id:'RECOVERY-1',disposition:'RETRY_CONFIRMED_TERMINATED',evidence_digest:H1,
      verified_by:'42',idempotency_key:'recover-assess-1',now:expired+1000});
    assert.equal(assessed.task.status,'RECOVERY_REQUIRED');assert.equal(assessed.recovery.target_dispatch_epoch,2);
    await assert.rejects(value.store.approveDispatchRecovery({organization_id:value.organization_id,task_id:'TASK-1',recovery_id:'RECOVERY-1',
      expected_recovery_digest:H2,approval_id:'RECOVERY-APPROVAL-1',approved_by:'42',ttl_ms:60_000,idempotency_key:'recover-approve-bad',now:expired+2000}),
    /RECOVERY_DIGEST_MISMATCH/);
    const approvedRecovery=await value.store.approveDispatchRecovery({organization_id:value.organization_id,task_id:'TASK-1',recovery_id:'RECOVERY-1',
      expected_recovery_digest:assessed.recovery.recovery_digest,approval_id:'RECOVERY-APPROVAL-1',approved_by:'42',ttl_ms:60_000,
      idempotency_key:'recover-approve-1',now:expired+2000});
    assert.equal(approvedRecovery.task.dispatch_epoch,2);assert.equal(approvedRecovery.task.dispatches[0].status,'QUEUED');
    assert.deepEqual(approvedRecovery.task.dispatches.slice(1).map(item=>item.status),['BLOCKED','BLOCKED','BLOCKED','BLOCKED']);
    await value.store.heartbeatNode({credential:value.credentials[headNode],capabilities:{...capabilities,cpu_logical:16},now:expired+2500});
    const retry=await value.store.claimDispatch({node_id:headNode,idempotency_key:'claim-recovery',now:expired+3000});
    assert.equal(retry.envelope.role,'head');assert.equal(retry.envelope.dispatch_epoch,2);assert.notEqual(retry.attempt.attempt_id,claim.attempt.attempt_id);
    assert.equal(retry.attempt.approval_id,'RECOVERY-APPROVAL-1');const [current]=await value.store.dispatchTasks(value.organization_id,expired+3000);
    assert.equal(current.recoveries.length,1);assert.equal(current.attempts.length,2);
    await assert.rejects(value.store.progressDispatch({node_id:headNode,dispatch_id:claim.envelope.dispatch_id,attempt_id:claim.attempt.attempt_id,
      expected_epoch:1,event_sequence:1,observed_at:new Date(expired+3500).toISOString(),idempotency_key:'late-old-attempt',now:expired+3500}),
    /DISPATCH_EPOCH_CHANGED/)
  }finally{clean(value)}});

test('an expired recovery approval returns to explicit reapproval without authorizing a claim',async()=>{
  const value=await fixture();try{await approved(value);const headNode=value.assignment.head_assignment.node_id,
    claim=await value.store.claimDispatch({node_id:headNode,idempotency_key:'claim-head',now:now+2000}),expired=claim.attempt.lease_expires_at;
    await value.store.reconcileDispatches({organization_id:value.organization_id,now:expired});const [fenced]=await value.store.dispatchTasks(value.organization_id,expired),
      assessed=await value.store.assessDispatchRecovery({organization_id:value.organization_id,task_id:'TASK-1',attempt_id:claim.attempt.attempt_id,
        expected_task_digest:fenced.task_digest,recovery_id:'RECOVERY-EXPIRY',disposition:'RETRY_CONFIRMED_TERMINATED',evidence_digest:H2,
        verified_by:'42',idempotency_key:'assess-expiry',now:expired+100});
    await value.store.approveDispatchRecovery({organization_id:value.organization_id,task_id:'TASK-1',recovery_id:'RECOVERY-EXPIRY',
      expected_recovery_digest:assessed.recovery.recovery_digest,approval_id:'RECOVERY-APPROVAL-EXPIRING',approved_by:'42',ttl_ms:1000,
      idempotency_key:'approve-expiring',now:expired+200});
    const [waiting]=await value.store.dispatchTasks(value.organization_id,expired+1200);assert.equal(waiting.status,'AWAITING_RECOVERY_APPROVAL');
    assert.equal(waiting.dispatches[0].status,'WAITING_RECOVERY_APPROVAL');
    const reapproved=await value.store.approveDispatchRecovery({organization_id:value.organization_id,task_id:'TASK-1',recovery_id:'RECOVERY-EXPIRY',
      expected_recovery_digest:assessed.recovery.recovery_digest,approval_id:'RECOVERY-APPROVAL-REISSUED',approved_by:'42',ttl_ms:60_000,
      idempotency_key:'approve-reissued',now:expired+1300});assert.equal(reapproved.task.status,'QUEUED')
  }finally{clean(value)}});
