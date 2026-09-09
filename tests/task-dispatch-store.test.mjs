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
  const makeNode=async(name,cpu)=>{const {token}=await store.createNodeEnrollment({organization_id,display_name:name,now});
    return (await store.enrollNode({token,capabilities:{...capabilities,cpu_logical:cpu},now})).node};
  const nodes=[await makeNode('Primary',16),await makeNode('Review',8)];
  const profile=await store.saveOrchestrationProfile({organization_id,mode:'automatic',head_model_id:models.head.model_id,
    assignments:{planner:null,coder:null,reviewer:null,validator:null}});
  const task_id='TASK-1',roles=['planner','coder','reviewer','validator'];
  const assignment=resolveOrchestrationAssignment({organization_id,task_id,expected_profile_revision:profile.revision,roles,profile,
    connections:store.providerConnections(organization_id),models:store.models(organization_id),nodes:store.nodes(organization_id),now});
  const createInput=patch=>({organization_id,task_id,objective:'Implement one bounded customer task.',profile_revision:profile.revision,roles,
    assignment,created_by:'42',idempotency_key:'create-1',now,...patch});
  return {parent,root,store,organization_id,profile,assignment,models,nodes,createInput};
}
const clean=value=>rmSync(value.parent,{recursive:true,force:true});
const H1='1'.repeat(64),H2='2'.repeat(64);
async function approved(value) {
  const created=await value.store.createDispatchTask(value.createInput());
  await value.store.approveDispatchTask({organization_id:value.organization_id,task_id:'TASK-1',expected_task_digest:created.task.task_digest,
    approval_id:'APPROVAL-1',approved_by:'42',ttl_ms:60_000,idempotency_key:'approve-1',now:now+1000});
  return created.task;
}

test('v7 migrates to v8 without changing existing registry data',async()=>{
  const value=await fixture();try{const file=join(value.root,'access.json'),before=JSON.parse(readFileSync(file,'utf8'));
    before.schema_version=7;for(const key of ['dispatch_epochs','dispatch_tasks','dispatch_approvals','dispatch_attempts','dispatch_idempotency'])delete before[key];
    writeFileSync(file,JSON.stringify(before));const migratedStore=createAccessStore(value.root),after=JSON.parse(readFileSync(file,'utf8'));
    assert.equal(after.schema_version,8);assert.equal(migratedStore.dispatchEpoch(value.organization_id),1);
    assert.equal(migratedStore.models(value.organization_id).length,5);assert.deepEqual(await migratedStore.dispatchTasks(value.organization_id,now),[])
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
