import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createStudioSnapshot, unconfiguredSnapshot } from '../studio/snapshot.mjs';
import { createStudioServer } from '../studio/server.mjs';
import { createAccessStore } from '../studio/access-store.mjs';
import { createAuth } from '../studio/auth.mjs';
import { createBilling } from '../studio/billing.mjs';
import { adminEntitlement, planFeatures, subscriptionEntitlement } from '../studio/plans.mjs';

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
  const memberOrganization={organization_id:'org-1',name:'member Workspace',slug:'github-1',created_at:'2026-09-08T00:00:00.000Z',updated_at:'2026-09-08T00:00:00.000Z',role:'owner'};
  const subscriber={user:{github_id:'1',login:'member',avatar_url:null},organization:memberOrganization,organizations:[memberOrganization],
    entitlement:subscriptionEntitlement({status:'active',plan_id:'pro'}),admin:false};
  const coreSubscriber={...subscriber,entitlement:subscriptionEntitlement({status:'active',plan_id:'core'})};
  const inactive={...subscriber,entitlement:subscriptionEntitlement()};
  const administrator={...subscriber,user:{...subscriber.user,login:'owner'},entitlement:adminEntitlement(),admin:true};
  const auth={configured:true,session:request=>request.headers['x-test-role']==='admin'?administrator:
    request.headers['x-test-role']==='subscriber'?subscriber:request.headers['x-test-role']==='core'?coreSubscriber:
      request.headers['x-test-role']==='inactive'?inactive:null,begin:()=>'',complete:async()=>{},logout:()=>'',isAdminId:id=>id==='9'};
  const organizationFor=id=>[{organization_id:`org-${id}`,name:`${id} Workspace`,slug:`github-${id}`,created_at:'2026-09-08T00:00:00.000Z',updated_at:'2026-09-08T00:00:00.000Z',role:'owner'}];
  const store={users:()=>[{github_id:'1',login:'member',avatar_url:null,billing_provider:'payapp',subscription_status:'active',plan_id:'pro',current_period_end:null,updated_at:'2026-09-08T01:00:00.000Z'},
    {github_id:'2',login:'waiting-user',avatar_url:null,billing_provider:null,subscription_status:null,plan_id:null,current_period_end:null,updated_at:'2026-09-08T00:00:00.000Z'},
    {github_id:'9',login:'owner',avatar_url:null,billing_provider:null,subscription_status:null,plan_id:null,current_period_end:null,updated_at:'2026-09-08T02:00:00.000Z'}],
    organizations:()=>['1','2','9'].map(id=>organizationFor(id)[0]),organizationsForUser:organizationFor};
  const server=createStudioServer({stateRoot:resolve('fixture-state'),snapshot:()=>expected,auth,store});
  await new Promise((accept,reject)=>server.listen(0,'127.0.0.1',accept).once('error',reject));
  const {port}=server.address(),url=`http://127.0.0.1:${port}`;
  try {
    const page=await fetch(url+'/');assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/default-src 'self'/);
    assert.match(await page.text(),/어둑시니/);
    const plans=await fetch(url+'/api/plans').then(value=>value.json());assert.deepEqual(plans.plans.map(plan=>[plan.id,plan.price_usd]),[['core',30],['pro',50]]);
    assert.equal((await fetch(url+'/studio',{redirect:'manual'})).status,303);
    assert.equal((await fetch(url+'/studio',{headers:{'X-Test-Role':'inactive'},redirect:'manual'})).headers.get('location'),
      '/?access=SUBSCRIPTION_REQUIRED');
    const response=await fetch(url+'/api/snapshot',{headers:{'X-Test-Role':'subscriber'}});assert.equal(response.status,200);const proSnapshot=await response.json();
    assert.deepEqual(proSnapshot.access,{plan_id:'pro',unlimited:false});assert.deepEqual(proSnapshot.capabilities,planFeatures('pro'));assert.deepEqual(proSnapshot.economics,expected.economics);
    const coreSnapshot=await fetch(url+'/api/snapshot',{headers:{'X-Test-Role':'core'}}).then(value=>value.json());assert.equal(coreSnapshot.economics,null);
    assert.equal(coreSnapshot.totals.observed_input_tokens,null);assert.deepEqual(coreSnapshot.attempts[0].metering,{execution_duration_ms:1000});
    const organization=await fetch(url+'/api/organization',{headers:{'X-Test-Role':'subscriber'}}).then(value=>value.json());
    assert.equal(organization.organization.organization_id,'org-1');assert.equal(organization.organizations.length,1);
    assert.equal((await fetch(url+'/admin',{headers:{'X-Test-Role':'subscriber'},redirect:'manual'})).status,303);
    assert.equal((await fetch(url+'/api/admin/summary',{headers:{'X-Test-Role':'admin'}})).status,200);
    assert.equal((await fetch(url+'/api/admin/customers')).status,401);
    assert.equal((await fetch(url+'/api/admin/customers',{headers:{'X-Test-Role':'subscriber'}})).status,403);
    const customers=await fetch(url+'/api/admin/customers?q=waiting&status=none&limit=25&offset=0',{headers:{'X-Test-Role':'admin'}});
    assert.equal(customers.status,200);const customerPage=await customers.json();assert.equal(customerPage.total,1);
    assert.deepEqual(customerPage.customers[0],{github_id:'2',login:'waiting-user',avatar_url:null,billing_provider:null,role:'customer',
      subscription:subscriptionEntitlement(),organizations:[{organization_id:'org-2',name:'2 Workspace',role:'owner'}],updated_at:'2026-09-08T00:00:00.000Z'});
    const adminCustomer=await fetch(url+'/api/admin/customers?q=owner',{headers:{'X-Test-Role':'admin'}}).then(value=>value.json());
    assert.equal(adminCustomer.customers[0].role,'admin');assert.equal(adminCustomer.customers[0].subscription.unlimited,true);
    assert.equal(JSON.stringify(customerPage).includes('billing_subscription_id'),false);
    assert.equal((await fetch(url+'/api/admin/customers?limit=1000',{headers:{'X-Test-Role':'admin'}})).status,400);
    assert.equal((await fetch(url+'/api/snapshot',{method:'POST',headers:{'X-Test-Role':'subscriber',Origin:'http://127.0.0.1:4317',
      'X-Eoduksini-Request':'1'}})).status,405);
    assert.equal((await fetch(url+'/..%2fpackage.json')).status,404);
  } finally {await new Promise(resolveClose=>server.close(resolveClose));}
});

test('Studio exposes a bounded form-only PayApp feedback endpoint and returns exact SUCCESS',async()=>{
  let received=null;const billing={configured:true,checkout:async()=>'',feedback:async payload=>{received=payload.toString('utf8')}};
  const server=createStudioServer({billing});await new Promise((accept,reject)=>server.listen(0,'127.0.0.1',accept).once('error',reject));
  const {port}=server.address(),url=`http://127.0.0.1:${port}/api/payapp/feedback`;
  try {const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'pay_state=4'});
    assert.equal(response.status,200);assert.equal(await response.text(),'SUCCESS');assert.equal(received,'pay_state=4');
    assert.equal((await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,400);
  } finally {await new Promise(resolveClose=>server.close(resolveClose))}
});

test('Access store persists identity and applies webhook events idempotently',async()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-access-parent-')),root=join(parent,'access');
  try {const store=createAccessStore(root);await store.upsertIdentity({github_id:'42',login:'operator',avatar_url:null});
    assert.equal(store.entitlement('42').active,false);
    assert.equal(store.organizationsForUser('42').length,1);assert.equal(store.organizationsForUser('42')[0].role,'owner');
    assert.deepEqual(await store.applySubscription({event_id:'evt_1',provider:'payapp',github_id:'42',customer_id:'merchant',subscription_id:'sub_1',
      status:'active',current_period_end:123,plan_id:'core'}),{changed:true});
    assert.deepEqual(await store.applySubscription({event_id:'evt_1',provider:'payapp',github_id:'42',customer_id:'merchant',subscription_id:'sub_1',
      status:'active',current_period_end:123,plan_id:'core'}),{changed:false});assert.equal(store.entitlement('42').active,true);
    assert.equal(store.entitlement('42').plan_id,'core');
  } finally {rmSync(parent,{recursive:true,force:true})}
});

test('Access store migrates legacy Stripe-shaped records to provider-neutral billing fields',()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-access-migration-')),root=join(parent,'access');mkdirSync(root);
  const legacy={schema_version:1,users:{'42':{github_id:'42',login:'operator',avatar_url:null,stripe_customer_id:null,
    stripe_subscription_id:null,subscription_status:null,current_period_end:null,updated_at:'2026-09-08T00:00:00.000Z'}},processed_webhook_ids:[]};
  writeFileSync(join(root,'access.json'),JSON.stringify(legacy));
  try {const store=createAccessStore(root),user=store.user('42');assert.equal(user.billing_provider,null);
    assert.equal(user.billing_subscription_id,null);assert.equal(user.plan_id,null);assert.equal(store.organizationsForUser('42')[0].organization_id,'org-42');
    const migrated=JSON.parse(readFileSync(join(root,'access.json'),'utf8'));assert.equal(migrated.schema_version,8);
    assert.deepEqual(migrated.provider_connections,{});assert.deepEqual(migrated.models,{});assert.deepEqual(migrated.nodes,{});
  } finally {rmSync(parent,{recursive:true,force:true})}
});

test('Access store migrates active v2 subscriptions and pending requests to Core',()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-access-v2-')),root=join(parent,'access');mkdirSync(root);
  const v2={schema_version:2,users:{'42':{github_id:'42',login:'operator',avatar_url:null,billing_provider:'payapp',
    billing_customer_id:'merchant',billing_subscription_id:'91',subscription_status:'active',current_period_end:null,
    updated_at:'2026-09-08T00:00:00.000Z'}},processed_webhook_ids:[],billing_requests:{request:{request_id:'request',github_id:'42',
    provider:'payapp',expected_price:42000,subscription_id:'91',status:'active',created_at:'2026-09-08T00:00:00.000Z',
    updated_at:'2026-09-08T00:00:00.000Z'}}};writeFileSync(join(root,'access.json'),JSON.stringify(v2));
  try {const store=createAccessStore(root);assert.equal(store.entitlement('42').plan_id,'core');assert.equal(store.billingRequest('request').plan_id,'core');
    assert.equal(store.organizationsForUser('42')[0].role,'owner')}
  finally {rmSync(parent,{recursive:true,force:true})}
});

test('Access store upgrades the live v4 shape without changing organization records',()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-access-v4-')),root=join(parent,'access');mkdirSync(root);
  const v4={schema_version:4,users:{},organizations:{},memberships:{},processed_webhook_ids:[],billing_requests:{}};
  writeFileSync(join(root,'access.json'),JSON.stringify(v4));
  try {createAccessStore(root);const migrated=JSON.parse(readFileSync(join(root,'access.json'),'utf8'));assert.equal(migrated.schema_version,8);
    assert.deepEqual(migrated.provider_connections,{});assert.deepEqual(migrated.models,{});assert.deepEqual(migrated.node_enrollments,{});assert.deepEqual(migrated.nodes,{})}
  finally {rmSync(parent,{recursive:true,force:true})}
});

test('Access store upgrades the deployed v5 shape with empty node collections',()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-access-v5-')),root=join(parent,'access');mkdirSync(root);
  const v5={schema_version:5,users:{},organizations:{},memberships:{},processed_webhook_ids:[],billing_requests:{},provider_connections:{},models:{}};
  writeFileSync(join(root,'access.json'),JSON.stringify(v5));
  try {createAccessStore(root);const migrated=JSON.parse(readFileSync(join(root,'access.json'),'utf8'));assert.equal(migrated.schema_version,8);
    assert.deepEqual(migrated.node_enrollments,{});assert.deepEqual(migrated.nodes,{});assert.deepEqual(migrated.orchestration_profiles,{})}
  finally {rmSync(parent,{recursive:true,force:true})}
});

test('Access store upgrades the deployed v6 shape with empty orchestration profiles',()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-access-v6-')),root=join(parent,'access');mkdirSync(root);
  const v6={schema_version:6,users:{},organizations:{},memberships:{},processed_webhook_ids:[],billing_requests:{},provider_connections:{},models:{},node_enrollments:{},nodes:{}};
  writeFileSync(join(root,'access.json'),JSON.stringify(v6));try{createAccessStore(root);const migrated=JSON.parse(readFileSync(join(root,'access.json'),'utf8'));
    assert.equal(migrated.schema_version,8);assert.deepEqual(migrated.orchestration_profiles,{});assert.deepEqual(migrated.dispatch_tasks,{})}finally{rmSync(parent,{recursive:true,force:true})}
});

test('Node enrollment is single use and heartbeat stores bounded capabilities without bearer credentials',async()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-node-enrollment-')),store=createAccessStore(join(parent,'access')),
    capabilities={agent_version:'0.1.0',os:'linux',arch:'x64',cpu_logical:16,memory_bytes:34359738368,gpu_status:'unavailable',gpu_devices:[],adapters:['ollama']};
  try {await store.upsertIdentity({github_id:'42',login:'owner',avatar_url:null});await store.upsertIdentity({github_id:'43',login:'other',avatar_url:null});
    const issued=await store.createNodeEnrollment({organization_id:'org-42',display_name:'Build node',now:1000});assert.match(issued.token,/^enr_/);
    let serialized=readFileSync(join(parent,'access','access.json'),'utf8');assert.equal(serialized.includes(issued.token),false);
    await assert.rejects(()=>store.enrollNode({token:'enr_invalid',capabilities,now:2000}),/INVALID_ENROLLMENT_TOKEN/);
    const enrolled=await store.enrollNode({token:issued.token,capabilities,now:2000});assert.match(enrolled.credential,/^agt_/);
    assert.equal(enrolled.node.organization_id,'org-42');assert.equal(store.nodes('org-42').length,1);assert.equal(store.nodes('org-43').length,0);
    await assert.rejects(()=>store.enrollNode({token:issued.token,capabilities,now:3000}),/INVALID_ENROLLMENT_TOKEN/);
    await assert.rejects(()=>store.heartbeatNode({credential:'agt_invalid',capabilities,now:3000}),/INVALID_AGENT_CREDENTIAL/);
    const heartbeat=await store.heartbeatNode({credential:enrolled.credential,capabilities:{...capabilities,cpu_logical:24},now:3000});
    assert.equal(heartbeat.cpu_logical,24);assert.equal(heartbeat.last_seen_at,new Date(3000).toISOString());
    serialized=readFileSync(join(parent,'access','access.json'),'utf8');assert.equal(serialized.includes(enrolled.credential),false);
  } finally {rmSync(parent,{recursive:true,force:true})}
});

test('Orchestration profiles validate head authority, role capability, node adapter, and tenant ownership',async()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-profile-')),store=createAccessStore(join(parent,'access')),
    capabilities={agent_version:'0.1.0',os:'linux',arch:'x64',cpu_logical:8,memory_bytes:8589934592,gpu_status:'unavailable',gpu_devices:[],adapters:['ollama']};
  try{await store.upsertIdentity({github_id:'42',login:'owner',avatar_url:null});await store.upsertIdentity({github_id:'43',login:'other',avatar_url:null});
    const connection=(await store.createProviderConnection({organization_id:'org-42',provider_id:'ollama',display_name:'Local'})).connection;
    const model=(await store.createModel({organization_id:'org-42',connection_id:connection.connection_id,provider_model_id:'local-model',
      display_name:'General model',role_capabilities:['head','general']})).model;
    const token=await store.createNodeEnrollment({organization_id:'org-42',display_name:'Node'}),node=(await store.enrollNode({token:token.token,capabilities})).node;
    const blank={planner:null,coder:null,reviewer:null,validator:null};const automatic=await store.saveOrchestrationProfile({organization_id:'org-42',mode:'automatic',head_model_id:model.model_id,assignments:blank});
    assert.equal(automatic.revision,1);const manual=await store.saveOrchestrationProfile({organization_id:'org-42',mode:'manual',head_model_id:model.model_id,
      assignments:{...blank,coder:{model_id:model.model_id,node_id:node.node_id}}});assert.equal(manual.revision,2);assert.equal(store.orchestrationProfile('org-42').assignments.coder.node_id,node.node_id);
    await assert.rejects(()=>store.saveOrchestrationProfile({organization_id:'org-43',mode:'automatic',head_model_id:model.model_id,assignments:blank}),/INVALID_ORCHESTRATION_PROFILE/);
  }finally{rmSync(parent,{recursive:true,force:true})}
});

test('Provider and model registry is tenant scoped, idempotent, and stores no credentials',async()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-registry-')),store=createAccessStore(join(parent,'access'));
  try {await store.upsertIdentity({github_id:'42',login:'owner',avatar_url:null});await store.upsertIdentity({github_id:'43',login:'member',avatar_url:null});
    const first=await store.createProviderConnection({organization_id:'org-42',provider_id:'openai',display_name:'Engineering OpenAI'});
    assert.equal(first.changed,true);assert.equal(first.connection.status,'pending_agent');assert.equal(first.connection.secret_location,'customer_agent');
    const repeated=await store.createProviderConnection({organization_id:'org-42',provider_id:'openai',display_name:'Engineering OpenAI'});
    assert.equal(repeated.changed,false);assert.equal(repeated.connection.connection_id,first.connection.connection_id);
    const model=await store.createModel({organization_id:'org-42',connection_id:first.connection.connection_id,provider_model_id:'customer-model-1',
      display_name:'Planning model',role_capabilities:['head','planner']});assert.equal(model.changed,true);
    assert.equal(store.providerConnections('org-42').length,1);assert.equal(store.providerConnections('org-43').length,0);
    assert.equal(store.models('org-42').length,1);assert.equal(store.models('org-43').length,0);
    await assert.rejects(()=>store.createModel({organization_id:'org-43',connection_id:first.connection.connection_id,provider_model_id:'cross-tenant',
      display_name:'Cross tenant',role_capabilities:['general']}),/INVALID_MODEL/);
    const serialized=readFileSync(join(parent,'access','access.json'),'utf8');assert.equal(serialized.includes('api_key'),false);
  } finally {rmSync(parent,{recursive:true,force:true})}
});

test('Registry API derives organization from the session and restricts writes to organization admins',async()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-registry-api-')),store=createAccessStore(join(parent,'access'));
  await store.upsertIdentity({github_id:'42',login:'owner',avatar_url:null});await store.upsertIdentity({github_id:'43',login:'member',avatar_url:null});
  const organization=(id,role)=>({...store.organizationsForUser(id)[0],role});
  const entitlement=subscriptionEntitlement({status:'active',plan_id:'pro'}),auth={configured:true,begin:()=>'',complete:async()=>{},logout:()=>'',isAdminId:()=>false,
    session:request=>request.headers['x-test-role']==='owner'?{user:{github_id:'42',login:'owner',avatar_url:null},organization:organization('42','owner'),organizations:[organization('42','owner')],entitlement,admin:false}:
      request.headers['x-test-role']==='member'?{user:{github_id:'43',login:'member',avatar_url:null},organization:organization('43','member'),organizations:[organization('43','member')],entitlement,admin:false}:null};
  const server=createStudioServer({auth,store});await new Promise((accept,reject)=>server.listen(0,'127.0.0.1',accept).once('error',reject));
  const url=`http://127.0.0.1:${server.address().port}`,headers={'X-Test-Role':'owner',Origin:'http://127.0.0.1:4317','X-Eoduksini-Request':'1','Content-Type':'application/json'};
  try {const catalog=await fetch(url+'/api/provider-catalog').then(value=>value.json());assert.equal(catalog.providers.some(value=>value.id==='openai'),true);
    const createdResponse=await fetch(url+'/api/organization/providers',{method:'POST',headers,body:JSON.stringify({provider_id:'openai',display_name:'Primary'})});
    assert.equal(createdResponse.status,200);const created=await createdResponse.json();assert.equal(created.connection.organization_id,'org-42');
    const injected=await fetch(url+'/api/organization/providers',{method:'POST',headers,body:JSON.stringify({organization_id:'org-43',provider_id:'openai',display_name:'Injected'})});
    assert.equal(injected.status,400);
    const secret=await fetch(url+'/api/organization/providers',{method:'POST',headers,body:JSON.stringify({provider_id:'openai',display_name:'Secret',api_key:'never-store'})});
    assert.equal(secret.status,400);assert.equal(readFileSync(join(parent,'access','access.json'),'utf8').includes('never-store'),false);
    const memberWrite=await fetch(url+'/api/organization/providers',{method:'POST',headers:{...headers,'X-Test-Role':'member'},body:JSON.stringify({provider_id:'deepseek',display_name:'Denied'})});
    assert.equal(memberWrite.status,403);assert.equal((await memberWrite.json()).code,'ORGANIZATION_ADMIN_REQUIRED');
    const memberList=await fetch(url+'/api/organization/providers',{headers:{'X-Test-Role':'member'}}).then(value=>value.json());assert.deepEqual(memberList.connections,[]);
    const modelResponse=await fetch(url+'/api/organization/models',{method:'POST',headers,body:JSON.stringify({connection_id:created.connection.connection_id,
      provider_model_id:'customer-model-1',display_name:'Head',role_capabilities:['head']})});assert.equal(modelResponse.status,200);
    assert.equal((await fetch(url+'/api/organization/models',{headers:{'X-Test-Role':'owner'}}).then(value=>value.json())).models.length,1);
    const deniedEnrollment=await fetch(url+'/api/organization/node-enrollments',{method:'POST',headers:{...headers,'X-Test-Role':'member'},
      body:JSON.stringify({display_name:'Denied node'})});assert.equal(deniedEnrollment.status,403);
    const enrollment=await fetch(url+'/api/organization/node-enrollments',{method:'POST',headers,body:JSON.stringify({display_name:'Build node'})}).then(value=>value.json());
    const capabilities={agent_version:'0.1.0',os:'linux',arch:'x64',cpu_logical:8,memory_bytes:17179869184,gpu_status:'unavailable',gpu_devices:[],adapters:['ollama']};
    const enrolledResponse=await fetch(url+'/api/agent/enroll',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token:enrollment.token,capabilities})});assert.equal(enrolledResponse.status,200);const enrolled=await enrolledResponse.json();
    assert.equal(enrolled.node.organization_id,'org-42');assert.equal(enrolled.node.connectivity,'online');
    const heartbeat=await fetch(url+'/api/agent/heartbeat',{method:'POST',headers:{Authorization:`Bearer ${enrolled.agent_credential}`,'Content-Type':'application/json'},
      body:JSON.stringify({capabilities:{...capabilities,cpu_logical:12}})});assert.equal(heartbeat.status,200);
    const nodes=await fetch(url+'/api/organization/nodes',{headers:{'X-Test-Role':'owner'}}).then(value=>value.json());assert.equal(nodes.nodes.length,1);
    assert.equal(nodes.nodes[0].cpu_logical,12);assert.equal(JSON.stringify(nodes).includes('credential'),false);
    const assignments={planner:null,coder:null,reviewer:null,validator:null},profilePayload={mode:'automatic',head_model_id:(await modelResponse.clone().json()).model.model_id,assignments};
    const deniedProfile=await fetch(url+'/api/organization/orchestration-profile',{method:'POST',headers:{...headers,'X-Test-Role':'member'},body:JSON.stringify(profilePayload)});
    assert.equal(deniedProfile.status,403);const savedProfile=await fetch(url+'/api/organization/orchestration-profile',{method:'POST',headers,body:JSON.stringify(profilePayload)});
    assert.equal(savedProfile.status,200);const profile=await fetch(url+'/api/organization/orchestration-profile',{headers:{'X-Test-Role':'owner'}}).then(value=>value.json());
    assert.equal(profile.profile.mode,'automatic');assert.equal(profile.profile.organization_id,'org-42');
    const assignmentPayload={task_id:'CUSTOMER-TASK-1',expected_profile_revision:profile.profile.revision,roles:['planner']};
    const assignmentResponse=await fetch(url+'/api/organization/orchestration-assignment',{method:'POST',headers,body:JSON.stringify(assignmentPayload)});
    assert.equal(assignmentResponse.status,200);const assignment=await assignmentResponse.json();assert.equal(assignment.organization_id,'org-42');
    assert.equal(assignment.profile_revision,profile.profile.revision);assert.equal(assignment.authority.model_execution,false);
    const staleAssignment=await fetch(url+'/api/organization/orchestration-assignment',{method:'POST',headers,
      body:JSON.stringify({...assignmentPayload,expected_profile_revision:profile.profile.revision+1})});assert.equal(staleAssignment.status,409);
    const injectedAssignment=await fetch(url+'/api/organization/orchestration-assignment',{method:'POST',headers,
      body:JSON.stringify({...assignmentPayload,organization_id:'org-43'})});assert.equal(injectedAssignment.status,400);
    const deniedAssignment=await fetch(url+'/api/organization/orchestration-assignment',{method:'POST',headers:{...headers,'X-Test-Role':'member'},
      body:JSON.stringify(assignmentPayload)});assert.equal(deniedAssignment.status,403);
  } finally {await new Promise(resolveClose=>server.close(resolveClose));rmSync(parent,{recursive:true,force:true})}
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
    assert.equal(session.user.login,'operator');assert.equal(session.admin,true);assert.equal(session.entitlement.active,true);
    assert.equal(session.entitlement.plan_id,'admin');assert.equal(session.entitlement.unlimited,true);assert.equal(session.organization.role,'owner');
  } finally {rmSync(parent,{recursive:true,force:true})}
});

test('PayApp checkout binds the GitHub identity and verified feedback grants the subscription',async()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-billing-parent-')),store=createAccessStore(join(parent,'access'));
  await store.upsertIdentity({github_id:'42',login:'operator',avatar_url:null});let requestBody;
  const fetchImpl=async(_url,options)=>{requestBody=Object.fromEntries(options.body);return new Response(
    'state=1&errorMessage=&errno=00000&rebill_no=91&payurl=https%3A%2F%2Fpayapp.kr%2Frequest-token',{status:200})};
  try {const billing=createBilling({userId:'merchant',linkKey:'key',linkValue:'value',priceKrwByPlan:{core:42000,pro:70000},planName:'Studio',cycleDay:'90',
      expiresOn:'2030-12-31',origin:'https://studio.example.test',store,fetchImpl,requestId:()=> '11111111-1111-4111-8111-111111111111'});
    const session={user:{github_id:'42'}};await assert.rejects(()=>billing.checkout(session,{phone:'010-1234-5678',plan_id:'enterprise'}),/INVALID_PLAN/);
    await assert.rejects(()=>billing.checkout({...session,admin:true,entitlement:adminEntitlement()},{phone:'010-1234-5678',plan_id:'core'}),/SUBSCRIPTION_ALREADY_ACTIVE/);
    assert.equal(await billing.checkout(session,{phone:'010-1234-5678',plan_id:'core'}),'https://payapp.kr/request-token');
    assert.equal(requestBody.cmd,'rebillRegist');assert.equal(requestBody.var1,'42');assert.equal(requestBody.var2,'11111111-1111-4111-8111-111111111111');
    assert.equal(requestBody.recvphone,'01012345678');assert.equal(requestBody.goodprice,'42000');assert.equal(requestBody.goodname,'Studio Core');
    const feedback=new URLSearchParams({userid:'merchant',linkkey:'key',linkval:'value',price:'42000',var1:'42',
      var2:'11111111-1111-4111-8111-111111111111',mul_no:'501',rebill_no:'91',pay_state:'4'});
    await billing.feedback(Buffer.from(feedback.toString()));assert.equal(store.entitlement('42').active,true);
    assert.equal(store.entitlement('42').plan_id,'core');
    await billing.feedback(Buffer.from(feedback.toString()));assert.equal(store.entitlement('42').active,true);
    feedback.set('pay_state','70');await billing.feedback(Buffer.from(feedback.toString()));assert.equal(store.entitlement('42').status,'past_due');
  } finally {rmSync(parent,{recursive:true,force:true})}
});

test('PayApp feedback rejects a forged value, price, or unbound request',async()=>{
  const parent=mkdtempSync(join(tmpdir(),'eoduksini-billing-forgery-')),store=createAccessStore(join(parent,'access'));
  try {await store.upsertIdentity({github_id:'42',login:'operator',avatar_url:null});
    const billing=createBilling({userId:'merchant',linkKey:'key',linkValue:'value',priceKrw:9900,expiresOn:'2030-12-31',
      origin:'https://studio.example.test',store});
    const base={userid:'merchant',linkkey:'key',linkval:'forged',price:'9900',var1:'42',
      var2:'11111111-1111-4111-8111-111111111111',mul_no:'501',rebill_no:'91',pay_state:'4'};
    await assert.rejects(()=>billing.feedback(Buffer.from(new URLSearchParams(base).toString())),/INVALID_PAYAPP_FEEDBACK/);
    await assert.rejects(()=>billing.feedback(Buffer.from(new URLSearchParams({...base,linkval:'value'}).toString()+'&price=9900')),
      /DUPLICATE_PAYAPP_FIELD/);
    assert.equal(store.entitlement('42').active,false);
  } finally {rmSync(parent,{recursive:true,force:true})}
});
