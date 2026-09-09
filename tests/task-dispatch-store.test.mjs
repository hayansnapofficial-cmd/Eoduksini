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
