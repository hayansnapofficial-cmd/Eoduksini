import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createStudioSnapshot, unconfiguredSnapshot } from '../studio/snapshot.mjs';
import { createStudioServer } from '../studio/server.mjs';
import { createAccessStore } from '../studio/access-store.mjs';
import { createAuth } from '../studio/auth.mjs';
import { createBilling } from '../studio/billing.mjs';

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

test('Studio server gates Studio by subscription and admin by role',async()=>{
  const expected=createStudioSnapshot(statusResult,economicsResult,0);
  const subscriber={user:{github_id:'1',login:'member',avatar_url:null},entitlement:{active:true,status:'active',current_period_end:null},admin:false};
  const inactive={...subscriber,entitlement:{active:false,status:'none',current_period_end:null}};
  const administrator={...subscriber,user:{...subscriber.user,login:'owner'},admin:true};
  const auth={configured:true,session:request=>request.headers['x-test-role']==='admin'?administrator:
    request.headers['x-test-role']==='subscriber'?subscriber:request.headers['x-test-role']==='inactive'?inactive:null,
    begin:()=>'',complete:async()=>{},logout:()=>''};
  const store={users:()=>[{subscription_status:'active'},{subscription_status:null}]};
  const server=createStudioServer({stateRoot:resolve('fixture-state'),snapshot:()=>expected,auth,store});
  await new Promise((accept,reject)=>server.listen(0,'127.0.0.1',accept).once('error',reject));
  const {port}=server.address(),url=`http://127.0.0.1:${port}`;
  try {
    const page=await fetch(url+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/default-src 'self'/);
    assert.match(await page.text(),/어둑시니/);
    assert.equal((await fetch(url+'/studio',{redirect:'manual'})).status,303);
    assert.equal((await fetch(url+'/studio',{headers:{'X-Test-Role':'inactive'},redirect:'manual'})).headers.get('location'),
      '/?access=SUBSCRIPTION_REQUIRED');
    const response=await fetch(url+'/api/snapshot',{headers:{'X-Test-Role':'subscriber'}});assert.equal(response.status,200);assert.deepEqual(await response.json(),expected);
    assert.equal((await fetch(url+'/admin',{headers:{'X-Test-Role':'subscriber'},redirect:'manual'})).status,303);
    assert.equal((await fetch(url+'/api/admin/summary',{headers:{'X-Test-Role':'admin'}})).status,200);
    assert.equal((await fetch(url+'/api/snapshot',{method:'POST',headers:{'X-Test-Role':'subscriber',Origin:'http://127.0.0.1:4317',
      'X-Eoduksini-Request':'1'}})).status,405);
    assert.equal((await fetch(url+'/..%2fpackage.json')).status,404);
  } finally {await new Promise(resolveClose=>server.close(resolveClose));}
});

test('Access store persists identity and applies webhook events idempotently',async()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-access-parent-')),root=join(parent,'access');
  try {const store=createAccessStore(root);await store.upsertIdentity({github_id:'42',login:'operator',avatar_url:null});
    assert.equal(store.entitlement('42').active,false);
    assert.deepEqual(await store.applySubscription({event_id:'evt_1',github_id:'42',customer_id:'cus_1',subscription_id:'sub_1',
      status:'active',current_period_end:123}),{changed:true});
    assert.deepEqual(await store.applySubscription({event_id:'evt_1',github_id:'42',customer_id:'cus_1',subscription_id:'sub_1',
      status:'active',current_period_end:123}),{changed:false});assert.equal(store.entitlement('42').active,true);
  } finally {rmSync(parent,{recursive:true,force:true})}
});

test('GitHub callback creates an opaque server session and never exposes the provider token',async()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-auth-parent-')),store=createAccessStore(join(parent,'access'));
  const responses=[new Response(JSON.stringify({access_token:'provider-secret'}),{status:200}),
    new Response(JSON.stringify({id:42,login:'operator',avatar_url:null}),{status:200})];
  try {const auth=createAuth({clientId:'client',clientSecret:'secret',origin:'http://127.0.0.1:4317',store,
      adminIds:['42'],fetchImpl:async()=>responses.shift(),now:()=>1000});
    const authorize=new URL(auth.begin()),stateValue=authorize.searchParams.get('state');
    assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
    const completed=await auth.complete({code:'temporary-code',state:stateValue});assert.doesNotMatch(completed.cookie,/provider-secret/);
    const request={headers:{cookie:completed.cookie.split(';')[0]}},session=auth.session(request);
    assert.equal(session.user.login,'operator');assert.equal(session.admin,true);assert.equal(session.entitlement.active,false);
  } finally {rmSync(parent,{recursive:true,force:true})}
});

test('Stripe checkout binds the GitHub identity and webhook grants the resulting subscription',async()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-billing-parent-')),store=createAccessStore(join(parent,'access'));
  await store.upsertIdentity({github_id:'42',login:'operator',avatar_url:null});let checkoutInput;
  const subscription={id:'sub_1',customer:'cus_1',status:'active',current_period_end:999,metadata:{github_user_id:'42'}};
  const stripeClient={checkout:{sessions:{create:async input=>{checkoutInput=input;return {url:'https://checkout.stripe.test/session'}}}},
    billingPortal:{sessions:{create:async()=>({url:'https://billing.stripe.test/portal'})}},subscriptions:{retrieve:async()=>subscription},
    webhooks:{constructEvent:()=>({id:'evt_1',type:'customer.subscription.updated',data:{object:subscription}})}};
  try {const billing=createBilling({secretKey:'sk_test',webhookSecret:'whsec_test',priceId:'price_1',origin:'http://127.0.0.1:4317',store,stripeClient});
    const session={user:{github_id:'42'}};assert.match(await billing.checkout(session),/^https:\/\/checkout/);
    assert.equal(checkoutInput.mode,'subscription');assert.equal(checkoutInput.subscription_data.metadata.github_user_id,'42');
    await billing.webhook(Buffer.from('{}'),'signature');assert.equal(store.entitlement('42').active,true);
  } finally {rmSync(parent,{recursive:true,force:true})}
});
