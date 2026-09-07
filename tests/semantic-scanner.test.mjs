import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createController } from '../core/controller/controller.mjs';
import { requestDigest } from '../core/controller/contracts.mjs';
import { withStore } from '../core/controller/store.mjs';
import { compareSemanticFootprints, scanSemanticFootprint } from '../core/semantic.mjs';
import { makeFixture } from './helpers/controller-fixture.mjs';

const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function fixture(t) { const value=makeFixture(); t.after(value.cleanup); return value; }
function add(f,path,content) {
  const full=join(f.repo,...path.split('/')); mkdirSync(join(full,'..'),{recursive:true}); writeFileSync(full,content);
}
function commit(f,message='semantic fixtures') { git(f.repo,['add','.']); git(f.repo,['commit','-m',message]); }

test('different files that name the same API contracts overlap semantically',t=>{
  const f=fixture(t);
  add(f,'src/one.ts','export interface CreateOrderRequest { id: string }\nexport type CreateOrderResponse = { ok: true };\n');
  add(f,'src/two.ts','export type CreateOrderRequest = { id: string };\nexport interface CreateOrderResponse { ok: boolean }\n');
  commit(f);
  const one=scanSemanticFootprint(f.repo,{write_paths:['src/one.ts']}),two=scanSemanticFootprint(f.repo,{write_paths:['src/two.ts']});
  const result=compareSemanticFootprints(one,two);
  assert.equal(result.status,'SEMANTIC_CONFLICT');
  assert.deepEqual(result.conflicts.filter(item=>item.field.endsWith('_contracts')).map(item=>item.field),
    ['request_contracts','response_contracts']);
});

test('different migrations touching the same table and column overlap',t=>{
  const f=fixture(t);
  add(f,'migrations/001.sql','ALTER TABLE accounts ADD COLUMN status text;\n');
  add(f,'migrations/002.sql','ALTER TABLE accounts ALTER COLUMN status TYPE varchar(32);\n');
  commit(f);
  const left=scanSemanticFootprint(f.repo,{write_paths:['migrations/001.sql']}),right=scanSemanticFootprint(f.repo,{write_paths:['migrations/002.sql']});
  const result=compareSemanticFootprints(left,right);
  assert.equal(result.status,'SEMANTIC_CONFLICT');
  assert(result.conflicts.some(item=>item.field==='migration_objects' && item.left==='column:accounts.status'));
});

test('independent footprints are non-overlapping while dynamic analysis is explicit uncertainty',t=>{
  const f=fixture(t);
  add(f,'src/alpha.ts','export function alpha() { return 1; }\n');
  add(f,'src/beta.ts','export function beta() { return 2; }\n');
  add(f,'src/dynamic.ts','const key = getKey(); export const value = process.env[key];\n');
  commit(f);
  const alpha=scanSemanticFootprint(f.repo,{write_paths:['src/alpha.ts']}),beta=scanSemanticFootprint(f.repo,{write_paths:['src/beta.ts']});
  assert.equal(compareSemanticFootprints(alpha,beta).status,'NON_OVERLAPPING');
  const dynamic=scanSemanticFootprint(f.repo,{write_paths:['src/dynamic.ts']});
  assert.deepEqual(dynamic.uncertainty,[{subject:'src/dynamic.ts',reason:'DYNAMIC_ENVIRONMENT_KEY',confidence:0}]);
  assert.equal(compareSemanticFootprints(dynamic,beta).status,'MANUAL_DECISION_REQUIRED');
});

test('scanner bounds become explicit uncertainty instead of silently truncating analysis',t=>{
  const f=fixture(t);
  for(let index=0;index<257;index+=1)
    add(f,`many/file-${String(index).padStart(3,'0')}.ts`,`export const value${index} = ${index};\n`);
  commit(f);
  const footprint=scanSemanticFootprint(f.repo,{write_paths:['many/**']});
  assert(footprint.uncertainty.some(item=>item.reason==='TRACKED_FILE_LIMIT_EXCEEDED'));
  assert.equal(compareSemanticFootprints(footprint,scanSemanticFootprint(f.repo,{write_paths:['other/fixture.txt']})).status,
    'MANUAL_DECISION_REQUIRED');
});

test('scanner collects static route, contract, environment, dependency, generated type, and service facts',t=>{
  const f=fixture(t);
  add(f,'package.json',JSON.stringify({dependencies:{ajv:'1.0.0'}}));
  add(f,'package-lock.json',JSON.stringify({packages:{'node_modules/ajv':{},'node_modules/@scope/tool':{}}}));
  add(f,'app/api/orders/[id]/route.ts',"import helper from 'left-pad';\nexport interface OrderRequest { id: string }\nexport type OrderResponse = { ok: true };\nexport const token = process.env.ORDER_TOKEN;\n");
  add(f,'generated/client.generated.ts','export interface GeneratedOrder { id: string }\n');
  add(f,'schema/model.prisma','datasource db { url = env("DATABASE_URL") }\nmodel Order {\n  id String\n}\n');
  add(f,'.env.example','PUBLIC_ORIGIN=https://example.invalid\n');
  add(f,'Dockerfile','FROM node:22 AS application\n');
  commit(f);
  const footprint=scanSemanticFootprint(f.repo,{write_paths:['package.json','package-lock.json','app/**','generated/**','schema/**','.env.example','Dockerfile']});
  assert.deepEqual(footprint.api_routes,['/api/orders/:id']);
  assert.deepEqual(footprint.request_contracts,['OrderRequest']); assert.deepEqual(footprint.response_contracts,['OrderResponse']);
  assert.deepEqual(footprint.environment_keys,['DATABASE_URL','ORDER_TOKEN','PUBLIC_ORIGIN']);
  assert.deepEqual(footprint.dependencies,['@scope/tool','ajv','left-pad']);
  assert.deepEqual(footprint.database_objects,['Order']); assert.deepEqual(footprint.migration_objects,['field:Order.id']);
  assert.deepEqual(footprint.generated_types,['GeneratedOrder']); assert.deepEqual(footprint.runtime_services,['application']);
  assert.deepEqual(footprint.uncertainty,[]);
});

test('Controller journals a clear assessment atomically with approval',async t=>{
  const f=fixture(t),api=createController(); api.init(f.stateRoot,f.repo,f.project,f.policy);
  const request=api.prepare(f.stateRoot,{attempt_id:'semantic-clear',task:f.task}),expected_digest=requestDigest(request);
  const approved=await api.approve(f.stateRoot,{request,expected_digest,approval_id:'semantic-clear-approval',ttl_ms:60000});
  assert.equal(approved.status,'APPROVED');
  const events=readFileSync(join(f.stateRoot,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event=>event.type),['INIT','APPROVED']);
  assert.equal(events[1].payload.semantic_assessment.status,'NON_OVERLAPPING');
  assert.equal(events[1].control_epoch,1);
});

test('scanner uncertainty is journaled, advances epoch, and cannot mint approval',async t=>{
  const f=fixture(t),api=createController(); api.init(f.stateRoot,f.repo,f.project,f.policy);
  const task={...f.task,in_scope_paths:['future/**']};
  const request=api.prepare(f.stateRoot,{attempt_id:'semantic-uncertain',task}),expected_digest=requestDigest(request);
  assert.equal(request.semantic_footprint.uncertainty[0].reason,'NO_TRACKED_WRITE_PATH_MATCH');
  const result=await api.approve(f.stateRoot,{request,expected_digest,approval_id:'uncertain-approval',ttl_ms:60000});
  assert.equal(result.status,'BLOCKED'); assert.equal(result.reason,'MANUAL_DECISION_REQUIRED');
  assert.equal(result.assessment.status,'MANUAL_DECISION_REQUIRED'); assert.equal(result.control_epoch,2);
  const status=api.status(f.stateRoot);
  assert.equal(status.status,'MANUAL_DECISION_REQUIRED'); assert.equal(status.state.control_epoch,2);
  assert.deepEqual(status.state.approvals,{});
  assert.equal((await api.run(f.stateRoot,{request,expected_digest})).reason,'MANUAL_DECISION_REQUIRED');
});

test('semantic conflict with a live approval fences both requests',async t=>{
  const f=fixture(t),api=createController(); api.init(f.stateRoot,f.repo,f.project,f.policy);
  const first=api.prepare(f.stateRoot,{attempt_id:'writer-one',task:f.task}),firstDigest=requestDigest(first);
  assert.equal((await api.approve(f.stateRoot,{request:first,expected_digest:firstDigest,approval_id:'writer-one-approval',ttl_ms:60000})).status,'APPROVED');
  const second=api.prepare(f.stateRoot,{attempt_id:'writer-two',task:f.task}),secondDigest=requestDigest(second);
  const denied=await api.approve(f.stateRoot,{request:second,expected_digest:secondDigest,approval_id:'writer-two-approval',ttl_ms:60000});
  assert.equal(denied.reason,'MANUAL_DECISION_REQUIRED'); assert.equal(denied.assessment.status,'SEMANTIC_CONFLICT');
  assert(denied.assessment.conflicts.some(item=>item.field==='write_paths' && item.other_attempt_id==='writer-one'));
  const state=api.status(f.stateRoot).state;
  assert.equal(state.control_epoch,2); assert.equal(state.semantic_review_required,true);
  assert.equal(Object.hasOwn(state.approvals,'writer-two'),false);
  assert.equal((await api.run(f.stateRoot,{request:first,expected_digest:firstDigest})).reason,'MANUAL_DECISION_REQUIRED');
});

test('journal reducer rejects a forged clear assessment when active semantics overlap',async t=>{
  const f=fixture(t),api=createController(),now=Date.now(); api.init(f.stateRoot,f.repo,f.project,f.policy);
  const first=api.prepare(f.stateRoot,{attempt_id:'real-writer',task:f.task}),firstDigest=requestDigest(first);
  assert.equal((await api.approve(f.stateRoot,{request:first,expected_digest:firstDigest,approval_id:'real-approval',ttl_ms:60000})).status,'APPROVED');
  const request=api.prepare(f.stateRoot,{attempt_id:'forged-writer',task:f.task}),request_digest=requestDigest(request);
  const approval={approval_id:'forged-approval',request_digest,issued_at:now,expires_at:now+60000,control_epoch:1};
  const semantic_assessment={status:'NON_OVERLAPPING',compared_attempt_ids:[],conflicts:[],uncertainty:[]};
  await assert.rejects(withStore(f.stateRoot,session=>session.append('APPROVED',{request,approval,semantic_assessment})),
    /SEMANTIC_ASSESSMENT_MISMATCH/);
  assert.equal(Object.hasOwn(api.status(f.stateRoot).state.approvals,'forged-writer'),false);
});

test('a pre-upgrade approval replays safely but cannot execute without a footprint assessment',async t=>{
  const f=fixture(t),api=createController(),now=Date.now(); api.init(f.stateRoot,f.repo,f.project,f.policy);
  const request=api.prepare(f.stateRoot,{attempt_id:'legacy-approved',task:f.task}); delete request.semantic_footprint;
  const expected_digest=requestDigest(request),approval={approval_id:'legacy-approval',request_digest:expected_digest,
    issued_at:now,expires_at:now+60000,control_epoch:1};
  await withStore(f.stateRoot,session=>session.append('APPROVED',{request,approval}));
  const result=await api.run(f.stateRoot,{request,expected_digest});
  assert.equal(result.status,'BLOCKED'); assert.equal(result.reason,'MANUAL_DECISION_REQUIRED');
  const state=api.status(f.stateRoot).state;
  assert.equal(state.control_epoch,2); assert.equal(state.semantic_review_required,true);
  assert.equal(state.semantic_assessments['legacy-approved'].assessment.uncertainty[0].reason,
    'LEGACY_SEMANTIC_FOOTPRINT_MISSING');
});
