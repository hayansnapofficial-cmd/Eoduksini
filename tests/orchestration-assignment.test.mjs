import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrchestrationAssignment } from '../studio/orchestration.mjs';

const now=Date.UTC(2026,8,9,1),organization_id='org-42',seen=new Date(now-1000).toISOString();
const connection={connection_id:'pc-a',organization_id,provider_id:'openai',status:'pending_agent'};
const model=(model_id,role_capabilities)=>({model_id,organization_id,connection_id:'pc-a',status:'active',role_capabilities});
const node=(node_id,cpu_logical)=>({node_id,organization_id,status:'active',last_seen_at:seen,adapters:['openai'],cpu_logical,memory_bytes:16*1024**3});
const blank={planner:null,coder:null,reviewer:null,validator:null};

test('automatic assignment binds profile revision, live capability evidence, and independent review',()=>{
  const profile={organization_id,revision:3,mode:'automatic',head_model_id:'model-head',assignments:blank};
  const input={organization_id,task_id:'TASK-1',expected_profile_revision:3,roles:['coder','reviewer'],profile,connections:[connection],
    models:[model('model-head',['head']),model('model-code',['coder']),model('model-review',['reviewer'])],nodes:[node('node-fast',16),node('node-review',8)],now};
  const decision=resolveOrchestrationAssignment(input),repeated=resolveOrchestrationAssignment(input);
  assert.equal(decision.status,'READY');assert.equal(decision.assignments.coder.model_id,'model-code');
  assert.equal(decision.assignments.coder.node_id,'node-fast');assert.equal(decision.assignments.reviewer.model_id,'model-review');
  assert.equal(decision.assignments.reviewer.node_id,'node-review');assert.equal(decision.profile_revision,3);
  assert.equal(decision.decision_digest,repeated.decision_digest);assert.equal(decision.authority.model_execution,false);
  assert.deepEqual(decision.optimization_limits,['COST_POLICY_NOT_CONFIGURED','PRIVACY_POLICY_NOT_CONFIGURED']);
});

test('manual assignment fails closed when a fixed node is stale or reviewer is not independent',()=>{
  const profile={organization_id,revision:2,mode:'manual',head_model_id:'model-head',assignments:{...blank,
    coder:{model_id:'model-code',node_id:'node-one'},reviewer:{model_id:'model-review',node_id:'node-one'}}};
  const decision=resolveOrchestrationAssignment({organization_id,task_id:'TASK-2',expected_profile_revision:2,roles:['coder','reviewer'],profile,
    connections:[connection],models:[model('model-head',['head']),model('model-code',['coder']),model('model-review',['reviewer'])],nodes:[node('node-one',8)],now});
  assert.equal(decision.status,'MANUAL_REVIEW_REQUIRED');assert.equal(decision.assignments.reviewer,null);
  assert.equal(decision.issues.some(value=>value.code==='INDEPENDENT_ASSIGNMENT_REQUIRED'),true);
  const stale={...node('node-one',8),last_seen_at:new Date(now-90_001).toISOString()};
  const unavailable=resolveOrchestrationAssignment({organization_id,task_id:'TASK-3',expected_profile_revision:2,roles:['coder'],profile,
    connections:[connection],models:[model('model-head',['head']),model('model-code',['coder'])],nodes:[stale],now});
  assert.equal(unavailable.assignments.coder,null);assert.equal(unavailable.issues.some(value=>value.code==='MANUAL_ASSIGNMENT_UNAVAILABLE'),true);
});

test('assignment rejects stale profile revision and tenant-crossing candidates',()=>{
  const profile={organization_id,revision:4,mode:'automatic',head_model_id:'model-head',assignments:blank};
  assert.throws(()=>resolveOrchestrationAssignment({organization_id,task_id:'TASK-4',expected_profile_revision:3,roles:['planner'],profile,
    connections:[connection],models:[model('model-head',['head'])],nodes:[node('node-one',8)],now}),/ORCHESTRATION_PROFILE_CHANGED/);
  const decision=resolveOrchestrationAssignment({organization_id,task_id:'TASK-5',expected_profile_revision:4,roles:['planner'],profile,
    connections:[{...connection,organization_id:'org-99'}],models:[model('model-head',['head']),model('model-plan',['planner'])],nodes:[node('node-one',8)],now});
  assert.equal(decision.status,'MANUAL_REVIEW_REQUIRED');assert.equal(decision.assignments.planner,null);
});
