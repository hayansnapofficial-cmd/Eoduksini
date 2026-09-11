import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../core/contracts.mjs';
import { createAccessStore } from '../studio/access-store.mjs';
import { resolveOrchestrationAssignment } from '../studio/orchestration.mjs';
import { executionPromptDigest, executionReceiptContract } from '../studio/model-execution.mjs';
import { encryptArtifact } from '../agent/artifact-crypto.mjs';

const now=Date.UTC(2026,8,11,12),capabilities={agent_version:'1',os:'linux',arch:'x64',cpu_logical:4,memory_bytes:8*1024**3,
  gpu_status:'unavailable',gpu_devices:[],adapters:['ollama']};
const read=value=>JSON.parse(readFileSync(join(value.root,'access.json'),'utf8'));
const clean=value=>rmSync(value.parent,{recursive:true,force:true});

async function fixture() {
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-artifact-gates-')),root=join(parent,'access'),store=createAccessStore(root),
    organization_id='org-42';
  await store.upsertIdentity({github_id:'42',login:'operator',avatar_url:null});
  const connection=(await store.createProviderConnection({organization_id,provider_id:'ollama',display_name:'Fixture Ollama'})).connection,
    model=(await store.createModel({organization_id,connection_id:connection.connection_id,provider_model_id:'fixture-model',
      display_name:'Fixture model',role_capabilities:['general']})).model,
    {token}=await store.createNodeEnrollment({organization_id,display_name:'Customer Agent',now}),
    {node,credential}=await store.enrollNode({token,capabilities,now});
  await store.bindProviderConnection({node_id:node.node_id,connection_id:connection.connection_id,provider_id:'ollama',
    config_digest:'a'.repeat(64),adapter_version:'1',idempotency_key:'bind',now});
  const profile=await store.saveOrchestrationProfile({organization_id,mode:'automatic',head_model_id:model.model_id,
    assignments:{planner:null,coder:null,reviewer:null,validator:null}});
  return {parent,root,store,organization_id,node,credential,profile};
}

async function claimTask(value,task_id='TASK-1',{model_execution=true,offset=0,start=true}={}) {
  const {store,organization_id,profile,node}=value,time=now+offset,roles=['planner'],
    assignment=resolveOrchestrationAssignment({organization_id,task_id,expected_profile_revision:profile.revision,roles,profile,
      connections:store.providerConnections(organization_id),models:store.models(organization_id),nodes:store.nodes(organization_id),now:time}),
    {task}=await store.createDispatchTask({organization_id,task_id,objective:'Return a bounded role result.',profile_revision:profile.revision,
      roles,assignment,created_by:'42',idempotency_key:task_id+':create',now:time});
  await store.approveDispatchTask({organization_id,task_id,expected_task_digest:task.task_digest,approval_id:task_id+':approval',
    approved_by:'42',ttl_ms:60_000,model_execution,idempotency_key:task_id+':approve',now:time});
  const claim=await store.claimDispatch({node_id:node.node_id,idempotency_key:task_id+':claim',now:time+1});
  if(start)await store.startDispatch({node_id:node.node_id,dispatch_id:claim.envelope.dispatch_id,attempt_id:claim.attempt.attempt_id,
    expected_epoch:claim.envelope.dispatch_epoch,event_sequence:1,idempotency_key:task_id+':start',
    observed_started_at:new Date(time+2).toISOString(),now:time+2});
  return claim;
}

function artifactFor(claim,text='Bounded Head result') {
  const priorKey=process.env.EODUKSINI_ARTIFACT_KEY,priorId=process.env.EODUKSINI_ARTIFACT_KEY_ID;
  process.env.EODUKSINI_ARTIFACT_KEY=Buffer.alloc(32,13).toString('base64url');
  process.env.EODUKSINI_ARTIFACT_KEY_ID='gate-fixture';
  try{return encryptArtifact(text,{...claim.envelope,attempt_id:claim.attempt.attempt_id})}
  finally{if(priorKey===undefined)delete process.env.EODUKSINI_ARTIFACT_KEY;else process.env.EODUKSINI_ARTIFACT_KEY=priorKey;
    if(priorId===undefined)delete process.env.EODUKSINI_ARTIFACT_KEY_ID;else process.env.EODUKSINI_ARTIFACT_KEY_ID=priorId}
}

function finishInput(value,claim,{artifact_id=null,result_digest='b'.repeat(64),status='FAILED',at=now+4}={}) {
  const attempt=read(value).dispatch_attempts[claim.attempt.attempt_id],receipt=executionReceiptContract({schema_version:1,
    organization_id:value.organization_id,task_id:claim.envelope.task_id,dispatch_id:claim.envelope.dispatch_id,
    attempt_id:claim.attempt.attempt_id,dispatch_epoch:claim.envelope.dispatch_epoch,activation_receipt:claim.activation_receipt,
    binding:claim.envelope.execution_binding,prompt_digest:executionPromptDigest(claim.envelope),response_digest:result_digest,
    model_revision:status==='SUCCEEDED'?'c'.repeat(64):null,artifact_id,status,failure_reason:status==='FAILED'?'PROVIDER_FAILED':null,
    input_tokens:status==='SUCCEEDED'?21:null,output_tokens:status==='SUCCEEDED'?4:null,
    usage_status:status==='SUCCEEDED'?'OBSERVED':'MISSING',started_at:attempt.observed_started_at,finished_at:new Date(at).toISOString()});
  return {node_id:value.node.node_id,dispatch_id:claim.envelope.dispatch_id,attempt_id:claim.attempt.attempt_id,
    expected_epoch:claim.envelope.dispatch_epoch,event_sequence:2,idempotency_key:claim.envelope.task_id+':finish',
    observed_finished_at:receipt.finished_at,status,result_digest,evidence_digest:receipt.evidence_digest,execution_receipt:receipt,now:at};
}

test('a live approved producer uploads one artifact and replays its idempotency key',async()=>{
  const value=await fixture();try{const claim=await claimTask(value),artifact=artifactFor(claim),
    input={node_id:value.node.node_id,artifact,idempotency_key:'artifact-put',now:now+3},
    uploaded=await value.store.putDispatchArtifact(input),replayed=await value.store.putDispatchArtifact({...input,now:now+4});
    assert.deepEqual(replayed,uploaded);assert.equal(Object.keys(read(value).dispatch_artifacts).length,1);
    assert.equal(uploaded.plaintext_digest,artifact.plaintext_digest);
    const different=artifactFor(claim,'Different result');
    await assert.rejects(value.store.putDispatchArtifact({...input,artifact:different,now:now+5}),/IDEMPOTENCY_CONFLICT/);
    assert.equal(Object.keys(read(value).dispatch_artifacts).length,1)
  }finally{clean(value)}
});

test('ledger-only approval cannot authorize ciphertext storage',async()=>{
  const value=await fixture();try{const claim=await claimTask(value,'TASK-1',{model_execution:false});
    await assert.rejects(value.store.putDispatchArtifact({node_id:value.node.node_id,artifact:artifactFor(claim),
      idempotency_key:'denied-ledger',now:now+3}),/INVALID_ARTIFACT_UPLOAD/);
    assert.deepEqual(read(value).dispatch_artifacts,{})
  }finally{clean(value)}
});

test('an expired producer lease rejects uploads even after a fresh heartbeat',async()=>{
  const value=await fixture();try{const claim=await claimTask(value),at=now+120_003;
    await value.store.heartbeatNode({credential:value.credential,capabilities,now:at});
    assert.equal(read(value).dispatch_attempts[claim.attempt.attempt_id].status,'RUNNING');
    await assert.rejects(value.store.putDispatchArtifact({node_id:value.node.node_id,artifact:artifactFor(claim),
      idempotency_key:'denied-lease',now:at}),/INVALID_ARTIFACT_UPLOAD/);
    assert.deepEqual(read(value).dispatch_artifacts,{})
  }finally{clean(value)}
});

test('a lost producer heartbeat rejects uploads before its lease expires',async()=>{
  const value=await fixture();try{const claim=await claimTask(value),at=now+90_001;
    assert.ok(read(value).dispatch_attempts[claim.attempt.attempt_id].lease_expires_at>at);
    await assert.rejects(value.store.putDispatchArtifact({node_id:value.node.node_id,artifact:artifactFor(claim),
      idempotency_key:'denied-heartbeat',now:at}),/INVALID_ARTIFACT_UPLOAD/);
    assert.deepEqual(read(value).dispatch_artifacts,{})
  }finally{clean(value)}
});

test('another task advancing the organization epoch fences a still-running producer upload',async()=>{
  const value=await fixture();try{await claimTask(value,'TASK-OLDER');
    await value.store.heartbeatNode({credential:value.credential,capabilities,now:now+60_000});
    const claim=await claimTask(value,'TASK-NEWER',{offset:60_000}),at=now+120_003;
    await value.store.heartbeatNode({credential:value.credential,capabilities,now:at});
    await value.store.reconcileDispatches({organization_id:value.organization_id,now:at});
    assert.equal(value.store.dispatchEpoch(value.organization_id),2);
    const attempt=read(value).dispatch_attempts[claim.attempt.attempt_id];assert.equal(attempt.status,'RUNNING');
    assert.ok(attempt.lease_expires_at>at);assert.equal(attempt.dispatch_epoch,1);
    await assert.rejects(value.store.putDispatchArtifact({node_id:value.node.node_id,artifact:artifactFor(claim),
      idempotency_key:'denied-epoch',now:at}),/INVALID_ARTIFACT_UPLOAD/);
    assert.deepEqual(read(value).dispatch_artifacts,{})
  }finally{clean(value)}
});

test('a claimed successor loses artifact download access when its heartbeat becomes stale',async()=>{
  const value=await fixture();try{const claim=await claimTask(value),artifact=artifactFor(claim),
    uploaded=await value.store.putDispatchArtifact({node_id:value.node.node_id,artifact,idempotency_key:'artifact-put',now:now+3});
    await value.store.finishDispatch(finishInput(value,claim,{artifact_id:uploaded.artifact_id,result_digest:artifact.plaintext_digest,status:'SUCCEEDED'}));
    const successor=await value.store.claimDispatch({node_id:value.node.node_id,idempotency_key:'planner-claim',now:now+5});
    assert.equal(successor.envelope.role,'planner');
    assert.deepEqual(value.store.dispatchArtifact({node_id:value.node.node_id,artifact_id:uploaded.artifact_id,now:now+6}),artifact);
    const at=now+90_001;assert.ok(successor.attempt.lease_expires_at>at);
    assert.throws(()=>value.store.dispatchArtifact({node_id:value.node.node_id,artifact_id:uploaded.artifact_id,now:at}),/ARTIFACT_NOT_AUTHORIZED/);
    assert.equal(Object.keys(read(value).dispatch_artifacts).length,1)
  }finally{clean(value)}
});

test('v10 migration normalizes cached claim and finish receipts without rewriting historical digests',async()=>{
  const value=await fixture();try{const claimed=await claimTask(value,'TASK-CLAIMED',{start:false}),
    finished=await claimTask(value,'TASK-FINISHED'),input=finishInput(value,finished);
    await value.store.finishDispatch(input);
    const before=read(value),approvalDigests=Object.values(before.dispatch_approvals).map(item=>item.approval_digest),
      evidenceDigest=input.evidence_digest,oldFinishInput=structuredClone(input);
    delete oldFinishInput.execution_receipt.artifact_id;
    const oldRequestDigest=digest(Object.fromEntries(Object.entries(oldFinishInput).filter(([key])=>key!=='now')));
    before.schema_version=10;delete before.dispatch_artifacts;
    const stripArtifactFields=item=>{if(!item||typeof item!=='object')return;delete item.predecessor_artifact_id;delete item.artifact_id;
      for(const child of Object.values(item))stripArtifactFields(child)};
    stripArtifactFields(before);
    const cachedFinish=Object.values(before.dispatch_idempotency).find(item=>item.scope===value.node.node_id+':finished');
    cachedFinish.request_digest=oldRequestDigest;
    writeFileSync(join(value.root,'access.json'),JSON.stringify(before));
    const migrated=createAccessStore(value.root),replayedClaim=await migrated.claimDispatch({node_id:value.node.node_id,
      idempotency_key:'TASK-CLAIMED:claim',now:now+10});
    assert.equal(replayedClaim.attempt.attempt_id,claimed.attempt.attempt_id);
    assert.equal(replayedClaim.envelope.predecessor_artifact_id,null);
    const replayedFinish=await migrated.finishDispatch({...oldFinishInput,now:now+11});
    assert.equal(replayedFinish.attempt.execution_receipt.artifact_id,null);
    assert.equal(replayedFinish.attempt.execution_receipt.evidence_digest,evidenceDigest);
    assert.ok(replayedFinish.task.dispatches.every(item=>item.predecessor_artifact_id===null));
    const after=read(value);assert.equal(after.schema_version,11);
    assert.deepEqual(Object.values(after.dispatch_approvals).map(item=>item.approval_digest),approvalDigests);
    assert.equal(after.dispatch_attempts[finished.attempt.attempt_id].execution_receipt.evidence_digest,evidenceDigest);
    assert.equal(Object.values(after.dispatch_idempotency).find(item=>item.scope===value.node.node_id+':finished').request_digest,oldRequestDigest)
  }finally{clean(value)}
});
