import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAccessStore } from '../studio/access-store.mjs';
import { createStudioServer } from '../studio/server.mjs';
import { subscriptionEntitlement } from '../studio/plans.mjs';

const H1='1'.repeat(64),H2='2'.repeat(64);

test('tenant task routes separate create, approval, claim and ordered Agent evidence',async()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-dispatch-api-')),store=createAccessStore(join(parent,'access'));
  await store.upsertIdentity({github_id:'42',login:'owner',avatar_url:null});const organization=store.organizationsForUser('42')[0];
  const connection=(await store.createProviderConnection({organization_id:organization.organization_id,provider_id:'openai',display_name:'Customer OpenAI'})).connection;
  const model=(await store.createModel({organization_id:organization.organization_id,connection_id:connection.connection_id,provider_model_id:'customer-model',
    display_name:'Head and planner',role_capabilities:['head','planner']})).model;
  const {token}=await store.createNodeEnrollment({organization_id:organization.organization_id,display_name:'Customer node'}),capabilities={agent_version:'0.1.0',
    os:'linux',arch:'x64',cpu_logical:8,memory_bytes:8*1024**3,gpu_status:'unavailable',gpu_devices:[],adapters:['openai']},
    enrolled=await store.enrollNode({token,capabilities});
  const profile=await store.saveOrchestrationProfile({organization_id:organization.organization_id,mode:'automatic',head_model_id:model.model_id,
    assignments:{planner:null,coder:null,reviewer:null,validator:null}}),entitlement=subscriptionEntitlement({status:'active',plan_id:'pro'});
  const session=role=>({user:{github_id:'42',login:'owner',avatar_url:null},organization:{...organization,role},organizations:[{...organization,role}],entitlement,admin:false});
  const auth={configured:true,session:request=>request.headers['x-test-role']==='member'?session('member'):
    request.headers['x-test-role']==='owner'?session('owner'):null,begin:()=>'',complete:async()=>{},logout:()=>'',isAdminId:()=>false};
  const server=createStudioServer({auth,store});await new Promise((accept,reject)=>server.listen(0,'127.0.0.1',accept).once('error',reject));
  const url=`http://127.0.0.1:${server.address().port}`,headers={'X-Test-Role':'owner',Origin:'http://127.0.0.1:4317',
    'X-Eoduksini-Request':'1','Content-Type':'application/json'},post=(path,payload,extra={})=>fetch(url+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(payload)});
  try {const payload={task_id:'CUSTOMER-TASK-1',objective:'Produce a bounded plan.',profile_revision:profile.revision,roles:['planner'],idempotency_key:'create-1'};
    assert.equal((await post('/api/organization/tasks',payload,{'X-Test-Role':'member'})).status,403);
    assert.equal((await post('/api/organization/tasks',{...payload,organization_id:'org-99'})).status,400);
    const createdResponse=await post('/api/organization/tasks',payload);assert.equal(createdResponse.status,201);const created=await createdResponse.json();
    assert.equal(created.task.organization_id,organization.organization_id);assert.equal(created.task.status,'AWAITING_APPROVAL');
    assert.equal(JSON.stringify(created).includes('credential'),false);
    const approvedResponse=await post('/api/organization/tasks/CUSTOMER-TASK-1/approve',{expected_task_digest:created.task.task_digest,
      approval_id:'APPROVAL-1',ttl_ms:60_000,idempotency_key:'approve-1'});assert.equal(approvedResponse.status,200);
    const approved=await approvedResponse.json();assert.equal(approved.task.status,'QUEUED');assert.equal(approved.approval.consumed_at,null);
    const agentHeaders={Authorization:`Bearer ${enrolled.credential}`,'Content-Type':'application/json'};
    const claimResponse=await fetch(url+'/api/agent/tasks/claim',{method:'POST',headers:agentHeaders,body:JSON.stringify({idempotency_key:'claim-1'})});
    assert.equal(claimResponse.status,200);const claim=await claimResponse.json();assert.equal(claim.envelope.role,'head');
    const event={attempt_id:claim.attempt.attempt_id,expected_epoch:claim.envelope.dispatch_epoch,event_sequence:1,
      observed_started_at:new Date().toISOString(),idempotency_key:'start-1'};
    const startedResponse=await fetch(url+`/api/agent/dispatches/${encodeURIComponent(claim.envelope.dispatch_id)}/started`,{
      method:'POST',headers:agentHeaders,body:JSON.stringify(event)}),startedBody=await startedResponse.json();
    assert.equal(startedResponse.status,200,JSON.stringify(startedBody));
    const finished={attempt_id:claim.attempt.attempt_id,expected_epoch:claim.envelope.dispatch_epoch,event_sequence:2,status:'SUCCEEDED',
      result_digest:H1,evidence_digest:H2,observed_finished_at:new Date().toISOString(),idempotency_key:'finish-1'};
    assert.equal((await fetch(url+`/api/agent/dispatches/${encodeURIComponent(claim.envelope.dispatch_id)}/finished`,{
      method:'POST',headers:agentHeaders,body:JSON.stringify(finished)})).status,200);
    const tasks=await fetch(url+'/api/organization/tasks',{headers:{'X-Test-Role':'owner'}}).then(value=>value.json());
    assert.equal(tasks.tasks[0].dispatches[1].status,'QUEUED');assert.equal(tasks.tasks[0].dispatches[1].predecessor_result_digest,H1)
  }finally{await new Promise(resolveClose=>server.close(resolveClose));rmSync(parent,{recursive:true,force:true})}
});
