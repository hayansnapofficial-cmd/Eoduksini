import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildExecutionBindings, executionReceiptContract } from '../studio/model-execution.mjs';
import { createAccessStore } from '../studio/access-store.mjs';
import { createStudioServer } from '../studio/server.mjs';
import { subscriptionEntitlement } from '../studio/plans.mjs';
import { configureOllama, enroll, executeDispatch, executeNextDispatch, fetchArtifact, heartbeat } from '../agent/node-agent.mjs';

const H=value=>createHash('sha256').update(value).digest('hex');
const task={organization_id:'org-42',task_id:'TASK-1',task_digest:H('task'),role_graph_digest:H('graph'),assignment_digest:H('assignment'),
  profile_revision:1,dispatch_epoch:1,dispatches:[{dispatch_id:'TASK-1:head',role:'head',model_id:'model-1',node_id:'node-1',provider_id:'ollama'}]};
const models=[{model_id:'model-1',organization_id:'org-42',connection_id:'pc-1',provider_model_id:'qwen3:8b',status:'active'}];
const connections=[{connection_id:'pc-1',organization_id:'org-42',provider_id:'ollama',status:'ready',agent_id:'node-1',
  config_digest:H('config'),adapter_version:'1'}];

test('execution bindings are server-derived and require an exact ready Agent connection',()=>{
  const bindings=buildExecutionBindings({task,models,connections});assert.equal(bindings.length,1);
  assert.deepEqual(bindings[0],{dispatch_id:'TASK-1:head',role:'head',node_id:'node-1',model_id:'model-1',connection_id:'pc-1',
    provider_id:'ollama',provider_model_id:'qwen3:8b',config_digest:H('config'),adapter_version:'1'});
  assert.throws(()=>buildExecutionBindings({task,models,connections:[{...connections[0],agent_id:'node-other'}]}),/EXECUTION_CONNECTION_NOT_READY/);
  assert.throws(()=>buildExecutionBindings({task,models:[{...models[0],organization_id:'org-99'}],connections}),/EXECUTION_MODEL_BINDING_INVALID/);
});

test('execution receipt binds exact claim, provider result and observed token usage',()=>{
  const binding=buildExecutionBindings({task,models,connections})[0],receipt=executionReceiptContract({schema_version:1,
    organization_id:'org-42',task_id:'TASK-1',dispatch_id:'TASK-1:head',attempt_id:'attempt-1',dispatch_epoch:1,
    activation_receipt:H('activation'),binding,prompt_digest:H('prompt'),response_digest:H('response'),model_revision:H('model-revision'),
    artifact_id:`artifact-${H('ciphertext')}`,status:'SUCCEEDED',failure_reason:null,
    input_tokens:12,output_tokens:7,usage_status:'OBSERVED',started_at:'2026-09-10T10:00:00.000Z',finished_at:'2026-09-10T10:00:01.000Z'});
  assert.match(receipt.evidence_digest,/^[0-9a-f]{64}$/);assert.equal(receipt.output_tokens,7);
  assert.throws(()=>executionReceiptContract({...receipt,output_tokens:8}),/EXECUTION_EVIDENCE_MISMATCH/);
  assert.throws(()=>executionReceiptContract({...receipt,binding:{...binding,node_id:'node-other'}}),/EXECUTION_EVIDENCE_MISMATCH/);
  const legacyInput={...receipt,artifact_id:null};delete legacyInput.evidence_digest;const legacy=executionReceiptContract(legacyInput);
  assert.equal(executionReceiptContract(legacy).artifact_id,null);
  const accessor={...receipt};Object.defineProperty(accessor,'output_tokens',{enumerable:true,get:()=>7});
  assert.throws(()=>executionReceiptContract(accessor),/INVALID_EXECUTION_RECEIPT/);
});

test('encrypted artifact moves from a Head Agent to a distinct Planner Agent',async()=>{
  const priorAdapters=process.env.EODUKSINI_AGENT_ADAPTERS,priorKey=process.env.EODUKSINI_ARTIFACT_KEY,priorKeyId=process.env.EODUKSINI_ARTIFACT_KEY_ID;
  process.env.EODUKSINI_AGENT_ADAPTERS='ollama';process.env.EODUKSINI_ARTIFACT_KEY=Buffer.alloc(32,7).toString('base64url');process.env.EODUKSINI_ARTIFACT_KEY_ID='fixture-key-1';
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-execution-')),store=createAccessStore(join(parent,'access'));
  await store.upsertIdentity({github_id:'42',login:'owner',avatar_url:null});const organization=store.organizationsForUser('42')[0],organization_id=organization.organization_id,
    connection=(await store.createProviderConnection({organization_id,provider_id:'ollama',display_name:'Customer Ollama'})).connection,
    model=(await store.createModel({organization_id,connection_id:connection.connection_id,provider_model_id:'head-model',display_name:'Head model',role_capabilities:['head']})).model,
    plannerConnection=(await store.createProviderConnection({organization_id,provider_id:'ollama',display_name:'Planner Ollama'})).connection,
    plannerModel=(await store.createModel({organization_id,connection_id:plannerConnection.connection_id,provider_model_id:'planner-model',display_name:'Planner model',
      role_capabilities:['planner']})).model,entitlement=subscriptionEntitlement({status:'active',plan_id:'pro'}),prompts=[],
    session={user:{github_id:'42',login:'owner'},organization:{...organization,role:'owner'},organizations:[{...organization,role:'owner'}],entitlement,admin:false},
    auth={configured:true,session:request=>request.headers['x-test-role']==='owner'?session:null,begin:()=>'',complete:async()=>{},logout:()=>'',isAdminId:()=>false},
    control=createStudioServer({auth,store}),provider=createServer(async(request,response)=>{if(request.url==='/api/tags'){
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({models:[{name:'head-model',digest:H('head-revision')},
        {name:'planner-model',digest:H('planner-revision')}]}));return}
      let body='';for await(const chunk of request)body+=chunk;const payload=JSON.parse(body);assert.equal(request.url,'/api/generate');
      assert.match(payload.prompt,/TASK-EXEC-1/);prompts.push(payload.prompt);const result=payload.model==='head-model'?'HEAD_RESULT':'PLANNER_RESULT';
      response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify({model:payload.model,response:result,prompt_eval_count:21,eval_count:4}))});
  await Promise.all([new Promise((ok,fail)=>control.listen(0,'127.0.0.1',ok).once('error',fail)),new Promise((ok,fail)=>provider.listen(0,'127.0.0.1',ok).once('error',fail))]);
  const controlOrigin=`http://127.0.0.1:${control.address().port}`,providerOrigin=`http://127.0.0.1:${provider.address().port}`,agentRoot=join(parent,'agent-head'),
    plannerRoot=join(parent,'agent-planner'),
    headers={'X-Test-Role':'owner',Origin:'http://127.0.0.1:4317','X-Eoduksini-Request':'1','Content-Type':'application/json'},
    post=(path,payload)=>fetch(controlOrigin+path,{method:'POST',headers,body:JSON.stringify(payload)});
  try{const node=await enroll(controlOrigin,agentRoot,'enr_missing').catch(()=>null);assert.equal(node,null);
    const {token}=await store.createNodeEnrollment({organization_id,display_name:'Customer Agent'}),enrolled=await enroll(controlOrigin,agentRoot,token);
    const {token:plannerToken}=await store.createNodeEnrollment({organization_id,display_name:'Planner Agent'}),plannerNode=await enroll(controlOrigin,plannerRoot,plannerToken);
    await configureOllama(agentRoot,connection.connection_id,providerOrigin,'bind-1');
    assert.equal((await configureOllama(agentRoot,connection.connection_id,providerOrigin,'bind-1')).status,'ready');
    await configureOllama(plannerRoot,plannerConnection.connection_id,providerOrigin,'bind-2');
    const denied={envelope:{dispatch_id:'X:head',dispatch_epoch:1,
      authority:{model_execution:false}},attempt:{attempt_id:'attempt-denied',event_sequence:0}};
    await assert.rejects(executeDispatch(agentRoot,denied,'denied'),/MODEL_EXECUTION_NOT_AUTHORIZED/);
    const mismatched={envelope:{...denied.envelope,authority:{model_execution:true},execution_binding:{connection_id:connection.connection_id,
      provider_id:'ollama',config_digest:H('wrong'),adapter_version:'1'}},attempt:{attempt_id:'attempt-mismatch',event_sequence:0}};
    await assert.rejects(executeDispatch(agentRoot,mismatched,'mismatch'),/EXECUTION_CONFIG_MISMATCH/);
    const profile=await store.saveOrchestrationProfile({organization_id,mode:'manual',head_model_id:model.model_id,
      assignments:{planner:{model_id:plannerModel.model_id,node_id:plannerNode.node_id},coder:null,reviewer:null,validator:null}}),created=await post('/api/organization/tasks',{
        task_id:'TASK-EXEC-1',objective:'Produce the Head result.',profile_revision:profile.revision,roles:['planner'],idempotency_key:'create-1'}).then(value=>value.json()),
      approvalResponse=await post('/api/organization/tasks/TASK-EXEC-1/approve',{expected_task_digest:created.task.task_digest,approval_id:'APPROVAL-EXEC-1',
        ttl_ms:60_000,model_execution:true,idempotency_key:'approve-1'});assert.equal(approvalResponse.status,200,JSON.stringify(await approvalResponse.clone().json()));
    const executed=await executeNextDispatch(agentRoot,'exec-1');assert.equal(executed.status,'SUCCEEDED',JSON.stringify(executed));assert.equal(executed.response_text,'HEAD_RESULT');
    const [headComplete]=await store.dispatchTasks(organization_id);assert.equal(headComplete.dispatches[0].status,'SUCCEEDED');
    assert.equal(headComplete.dispatches[1].status,'QUEUED');assert.match(headComplete.dispatches[1].predecessor_artifact_id,/^artifact-/);
    await assert.rejects(fetchArtifact(agentRoot,headComplete.dispatches[1].predecessor_artifact_id),/ARTIFACT_NOT_AUTHORIZED/);
    const planned=await executeNextDispatch(plannerRoot,'exec-2');assert.equal(planned.status,'SUCCEEDED',JSON.stringify(planned));assert.equal(planned.response_text,'PLANNER_RESULT');
    const [current]=await store.dispatchTasks(organization_id);assert.equal(current.status,'SUCCEEDED');assert.match(prompts[1],/Predecessor artifact:\nHEAD_RESULT/);
    assert.equal(current.attempts[0].execution_receipt.input_tokens,21);assert.equal(current.attempts[0].execution_receipt.output_tokens,4);
    assert.equal(current.attempts[0].execution_receipt.model_revision,H('head-revision'));
    assert.equal(current.attempts[0].execution_receipt.binding.node_id,enrolled.node_id);assert.equal(JSON.stringify(current).includes(providerOrigin),false);
    assert.equal(JSON.stringify(current).includes('HEAD_RESULT'),false);
    process.env.EODUKSINI_AGENT_ADAPTERS='';await heartbeat(agentRoot);
    const [invalidated]=store.providerConnections(organization_id);assert.equal(invalidated.status,'pending_agent');assert.equal(invalidated.config_digest,null)
  }finally{if(priorAdapters===undefined)delete process.env.EODUKSINI_AGENT_ADAPTERS;else process.env.EODUKSINI_AGENT_ADAPTERS=priorAdapters;
    if(priorKey===undefined)delete process.env.EODUKSINI_ARTIFACT_KEY;else process.env.EODUKSINI_ARTIFACT_KEY=priorKey;
    if(priorKeyId===undefined)delete process.env.EODUKSINI_ARTIFACT_KEY_ID;else process.env.EODUKSINI_ARTIFACT_KEY_ID=priorKeyId;
    await Promise.all([new Promise(resolve=>control.close(resolve)),new Promise(resolve=>provider.close(resolve))]);rmSync(parent,{recursive:true,force:true})}
});
