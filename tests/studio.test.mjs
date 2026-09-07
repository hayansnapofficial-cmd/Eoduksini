import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { createStudioSnapshot, unconfiguredSnapshot } from '../studio/snapshot.mjs';
import { createStudioServer } from '../studio/server.mjs';

const state={repo_root:'C:/sensitive/repository',project:{project_id:'demo'},control_epoch:4,
  policy:{quota:{nodeId:'node-2'},secret:'never expose'},approvals:{'attempt-1':{request:{
    environment:{TOKEN:'secret'},commands:[{executable:'sensitive.exe'}],task:{task_id:'DEMO-1'}}}},
  attempts:{'attempt-1':{status:'SUCCEEDED',reason:'COMMANDS_SUCCEEDED',command_results:[{transcript_path:'secret.log'}],metering:{
    node_id:'node-2',worker_started_at_utc:'2026-09-07T00:00:00.000Z',worker_finished_at_utc:'2026-09-07T00:00:01.000Z',
    execution_duration_ms:1000,worker_cpu_user_seconds:0.4,worker_cpu_system_seconds:0.1,worker_memory_peak_bytes:1048576,
    model_usage_status:'OBSERVED',model_input_tokens:10,model_output_tokens:5,
    routing_decision:{reason_code:'LOCAL_CAPACITY_AVAILABLE',chosen_provider_kind:'OLLAMA',decision_source:'private'},
    execution_status:'SUCCEEDED',test_status:'PASS',review_status:'PASS',integration_status:'MERGED',adoption_status:'ADOPTED',
    api_cost_status:'ESTIMATED',estimated_api_avoided_cost:0.02,estimated_api_avoided_currency:'USD',
    energy_status:'OBSERVED',energy_kwh:0.01,energy_cost:3,energy_currency:'KRW',measurement_completeness:'COMPLETE'}}},
  semantic_assessments:{},recovery_required:false,semantic_review_required:false};
const statusResult={status:'READY',state,seq:9,bytes:2048,owner_present:false,last_digest:'a'.repeat(64)};
const economicsResult={status:'COMPLETE',unique_task_count:1,incomplete_attempt_count:0,review_counts:{PASS:1},adoption_counts:{ADOPTED:1},
  observed_model_usage:{attempt_count:1,input_tokens:10,output_tokens:5},estimated_api_counterfactual:{by_currency:{USD:0.02}},
  observed_energy:{attempt_count:1,kwh:0.01},energy_cost:{by_currency:{KRW:3}}};

test('Studio snapshot is useful but excludes controller secrets and execution inputs',()=>{
  const snapshot=createStudioSnapshot(statusResult,economicsResult,Date.UTC(2026,8,7));
  assert.equal(snapshot.controller.status,'READY');assert.equal(snapshot.attempts[0].metering.worker_cpu_seconds,0.5);
  assert.equal(snapshot.totals.observed_input_tokens,10);
  const serialized=JSON.stringify(snapshot);
  for(const secret of ['C:/sensitive/repository','TOKEN','sensitive.exe','secret.log','never expose','decision_source'])
    assert.equal(serialized.includes(secret),false,secret);
});

test('Unconfigured snapshot has an explicit empty state',()=>{
  const snapshot=unconfiguredSnapshot(0);
  assert.equal(snapshot.configured,false);assert.equal(snapshot.controller.status,'UNCONFIGURED');assert.deepEqual(snapshot.attempts,[]);
});

test('Studio server exposes only allowlisted read-only routes with security headers',async()=>{
  const expected=createStudioSnapshot(statusResult,economicsResult,0);
  const server=createStudioServer({stateRoot:resolve('fixture-state'),snapshot:()=>expected});
  await new Promise((accept,reject)=>server.listen(0,'127.0.0.1',accept).once('error',reject));
  const {port}=server.address(),url=`http://127.0.0.1:${port}`;
  try {
    const page=await fetch(url+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/default-src 'self'/);
    assert.match(await page.text(),/어둑시니/);
    const response=await fetch(url+'/api/snapshot');assert.equal(response.status,200);assert.deepEqual(await response.json(),expected);
    assert.equal((await fetch(url+'/api/snapshot',{method:'POST'})).status,405);
    assert.equal((await fetch(url+'/..%2fpackage.json')).status,404);
  } finally {await new Promise(resolveClose=>server.close(resolveClose));}
});
