import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeFixture } from './helpers/controller-fixture.mjs';
import { requestDigest } from '../core/controller/contracts.mjs';
import { readStore, withStore } from '../core/controller/store.mjs';
import { checkDispatch } from '../core/controller/gates.mjs';
import { runCommand } from '../core/controller/runner.mjs';
import { main } from '../core/cli.mjs';

const cliPath=resolve('core/cli.mjs'),controller=()=>import('../core/controller/controller.mjs');
const cli=(...args)=>{
  const child=spawnSync(process.execPath,[cliPath,'controller',...args],{encoding:'utf8',timeout:30000});
  assert.ifError(child.error);return {code:child.status,json:JSON.parse(child.stdout||child.stderr)};
};
const jsonFile=(f,name,value)=>{const path=join(f.root,name+'.json');writeFileSync(path,JSON.stringify(value));return path;};
const starts=f=>existsSync(join(f.repo,'fixture-output/starts'))?Number(readFileSync(join(f.repo,'fixture-output/starts'),'utf8')):0;
const journal=f=>readFileSync(join(f.stateRoot,'events.jsonl'),'utf8');
function fixture(t,{mode='',two=false}={}) {
  const f=makeFixture({startCounter:true});t.after(f.cleanup);f.policy.resources.memory_gib=0.01;
  if(mode.includes('dirty')) {
    // This test alone installs a deliberate dirtying command; the reusable counter writes only ignored output.
    const script=join(f.repo,'scripts/fixture-test.mjs');
    writeFileSync(script,readFileSync(script,'utf8')+"writeFileSync('untracked-change','preserved');\n");
    const git=args=>execFileSync('git',args,{cwd:f.repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
    git(['add','scripts/fixture-test.mjs']);git(['commit','-m','fixture dirty command']);
    f.head=git(['rev-parse','HEAD']);f.project.repository.reference_sha=f.head;f.task.base_sha=f.head;
  }
  if(mode) f.project.commands.unit.argv.push(mode);
  if(two) {
    f.project.commands.second={argv:['node','scripts/fixture-test.mjs'],cwd:'.'};
    f.policy.commands.second=structuredClone(f.policy.commands.unit);
    f.task.required_tests.push('second');f.policy.limits.max_commands=2;
  }
  return f;
}
async function prepared(f,api) {
  api??=await controller();api.init(f.stateRoot,f.repo,f.project,f.policy);
  const request=api.prepare(f.stateRoot,{attempt_id:'attempt-1',task:f.task});
  return {api,request,expected_digest:requestDigest(request)};
}
async function approved(f,api) {
  const p=await prepared(f,api);
  await p.api.approve(f.stateRoot,{request:p.request,expected_digest:p.expected_digest,approval_id:'approval-1',ttl_ms:60000});return p;
}
const runInput=p=>({request:p.request,expected_digest:p.expected_digest});

test('repository path aliases bind one canonical identity through approval and replay',async t=>{
  const f=fixture(t),api=await controller();
  const supplied=process.platform==='win32'?f.repo.toUpperCase():f.repo;
  const canonicalRepo=realpathSync.native(f.repo);
  const initial=api.init(f.stateRoot,supplied,f.project,f.policy),before=journal(f);
  assert.equal(initial.state.repo_root,canonicalRepo);
  assert.equal(JSON.parse(before.trim()).payload.repo_root,canonicalRepo);
  const request=api.prepare(f.stateRoot,{attempt_id:'canonical-1',task:f.task});
  assert.equal(request.repo_root,canonicalRepo);
  const expected_digest=requestDigest(request),input={request,expected_digest};
  assert.equal((await api.approve(f.stateRoot,{...input,approval_id:'canonical-approval',ttl_ms:60000})).status,'APPROVED');
  assert.equal((await api.run(f.stateRoot,input)).status,'SUCCEEDED');
  assert.equal((await api.run(f.stateRoot,input)).execution_started,false);
  assert.equal(starts(f),1);
  assert.equal(readStore(f.stateRoot).state.repo_root,canonicalRepo);
  assert.ok(journal(f).startsWith(before));
});

test('CLI consumes stored approval exactly once and reports invocation-local execution',t=>{
  const f=fixture(t),project=jsonFile(f,'project',f.project),policy=jsonFile(f,'policy',f.policy),task=jsonFile(f,'task',f.task);
  assert.equal(cli('init',f.stateRoot,f.repo,project,policy).code,0);
  const before=journal(f),prepared=cli('prepare',f.stateRoot,task,'attempt-1');
  assert.equal(prepared.code,0);assert.equal(journal(f),before);
  const request=prepared.json,path=jsonFile(f,'request',request),hash=requestDigest(request);
  assert.equal(cli('run',f.stateRoot,path,hash).code,2);assert.equal(starts(f),0);
  assert.equal(cli('approve',f.stateRoot,path,hash,'approval-1','60000').code,0);
  const result=cli('run',f.stateRoot,path,hash),replay=cli('run',f.stateRoot,path,hash);
  assert.equal(result.code,0);assert.equal(result.json.status,'SUCCEEDED');assert.equal(result.json.execution_started,true);
  assert.equal(replay.code,0);assert.equal(replay.json.execution_started,false);
  assert.deepEqual(replay.json.command_results,result.json.command_results);assert.equal(starts(f),1);
  assert.equal(readStore(f.stateRoot).state.reservation,null);
  const after=journal(f);assert.equal(cli('status',f.stateRoot).code,0);assert.equal(journal(f),after);
  assert.equal(Object.hasOwn(result.json,'reviewer_passed'),false);assert.equal(Object.hasOwn(result.json,'release_authorized'),false);
});
test('prepare and status remain read-only and old main remains synchronous',async t=>{
  const f=fixture(t),{api}=await prepared(f),before=journal(f);
  api.prepare(f.stateRoot,{attempt_id:'attempt-2',task:f.task});api.status(f.stateRoot);
  assert.equal(journal(f),before);assert.equal(starts(f),0);
  const result=main(['plan',f.repo,jsonFile(f,'project',f.project),jsonFile(f,'task',f.task)]);
  assert.equal(result.execution_authorized,false);assert.equal(typeof result.then,'undefined');
});
test('forged approval flags and wrong digests never execute',async t=>{
  const f=fixture(t),p=await prepared(f);
  await assert.rejects(()=>p.api.run(f.stateRoot,{request:{...p.request,approved:true},expected_digest:p.expected_digest}));
  await assert.rejects(()=>p.api.run(f.stateRoot,{request:p.request,expected_digest:'0'.repeat(64)}),/DIGEST/);
  assert.equal((await p.api.run(f.stateRoot,runInput(p))).status,'BLOCKED');assert.equal(starts(f),0);
});
test('closed CLI grammar and strict bounded JSON reject invalid public inputs',async t=>{
  const f=fixture(t),p=await prepared(f),valid=jsonFile(f,'request',p.request);
  for(const args of [['status',f.stateRoot,'--force'],['unknown',f.stateRoot],['run',f.stateRoot,valid,p.expected_digest,'--approve'],
    ['approve',f.stateRoot,valid,p.expected_digest,'approval-1','1e3'],['approve',f.stateRoot,valid,p.expected_digest,'approval-1','60001']])
    assert.equal(cli(...args).code,1);
  const malformed=join(f.root,'bad.json');
  for(const bytes of [Buffer.from([0x7b,0x22,0xff,0x22,0x3a,0x31,0x7d]),Buffer.alloc(256*1024+1,32),Buffer.from('{"__proto__":{}}')]) {
    writeFileSync(malformed,bytes);assert.equal(cli('run',f.stateRoot,malformed,p.expected_digest).code,1);
  }
  assert.equal(starts(f),0);
});
for(const [mode,status,count] of [['','SUCCEEDED',2],['fail','FAILED',1],['dirty','RECOVERY_REQUIRED',1],['dirty-fail','RECOVERY_REQUIRED',1]]) {
  test(`command sequence ${mode||'clean'} finishes ${status} with ${count} starts`,async t=>{
    const f=fixture(t,{mode,two:true}),p=await approved(f),receipt=await p.api.run(f.stateRoot,runInput(p));
    assert.equal(receipt.status,status);assert.equal(receipt.command_results.length,count);assert.equal(starts(f),count);
    assert.equal(readStore(f.stateRoot).state.attempts['attempt-1'].status,status);
    if(mode.includes('dirty')) assert.equal(readFileSync(join(f.repo,'untracked-change'),'utf8'),'preserved');
    const replay=await p.api.run(f.stateRoot,runInput(p));
    assert.equal(replay.status,status);assert.equal(replay.execution_started,false);assert.equal(starts(f),count);
  });
}
test('expiry after first command preserves partial evidence and requires recovery',async t=>{
  const f=fixture(t,{two:true}),{createController}=await controller();let now=Date.now();
  const api=createController({now:()=>now,runCommand:async(...args)=>{const result=await runCommand(...args);now+=60000;return result;}});
  const p=await approved(f,api),receipt=await api.run(f.stateRoot,runInput(p));
  assert.equal(receipt.status,'RECOVERY_REQUIRED');assert.match(receipt.reason,/APPROVAL_EXPIRED/);
  assert.equal(receipt.command_results.length,1);assert.equal(starts(f),1);assert.notEqual(readStore(f.stateRoot).state.reservation,null);
});
test('final close does not require another full command deadline',async t=>{
  const f=fixture(t),{createController}=await controller();let now=Date.now();
  const api=createController({now:()=>now,runCommand:async(...args)=>{const result=await runCommand(...args);now+=59000;return result;}});
  const p=await approved(f,api);assert.equal((await api.run(f.stateRoot,runInput(p))).status,'SUCCEEDED');
});
test('incomplete prior attempt never resumes and explicit recover advances epoch',async t=>{
  const f=fixture(t),p=await approved(f);
  await withStore(f.stateRoot,session=>{
    const {reservation}=checkDispatch(session.state,p.request,session.state.approvals['attempt-1'].approval);
    session.append('PREPARED',{attempt_id:'attempt-1',request_digest:p.expected_digest,reservation});
  });
  const before=journal(f),replay=await p.api.run(f.stateRoot,runInput(p));
  assert.equal(replay.status,'PREPARED');assert.equal(replay.execution_started,false);assert.equal(journal(f),before);
  const next=p.api.prepare(f.stateRoot,{attempt_id:'attempt-2',task:f.task});
  assert.equal((await p.api.run(f.stateRoot,{request:next,expected_digest:requestDigest(next)})).status,'BLOCKED');
  await p.api.recover(f.stateRoot);assert.equal(readStore(f.stateRoot).state.control_epoch,2);
  assert.equal((await p.api.run(f.stateRoot,runInput(p))).status,'RECOVERY_REQUIRED');assert.equal(starts(f),0);
});
test('owner remnants are visible and recover never removes them',async t=>{
  const f=fixture(t),p=await prepared(f);mkdirSync(join(f.stateRoot,'owner'));
  const before=journal(f);assert.equal(p.api.status(f.stateRoot).status,'OWNER_RECOVERY_REQUIRED');
  assert.equal(cli('recover',f.stateRoot).code,2);assert.equal(journal(f),before);assert.equal(existsSync(join(f.stateRoot,'owner')),true);
});
test('result recording failure cannot claim success and preserves observed evidence',async t=>{
  const f=fixture(t),{createController}=await controller();
  const api=createController({runCommand:async(...args)=>{
    const result=await runCommand(...args);writeFileSync(join(f.stateRoot,'events.jsonl'),'broken\n',{flag:'a'});return result;
  }});
  const p=await approved(f,api),receipt=await api.run(f.stateRoot,runInput(p));
  assert.equal(receipt.status,'RECOVERY_REQUIRED');assert.equal(receipt.execution_started,true);
  assert.equal(receipt.command_results.length,1);assert.equal(starts(f),1);assert.throws(()=>readStore(f.stateRoot),/JOURNAL_CORRUPT/);
});

test('new attempt denied by an owner is BLOCKED with zero starts',async t=>{
  const f=fixture(t),p=await approved(f);
  await withStore(f.stateRoot,async()=>{
    const result=await p.api.run(f.stateRoot,runInput(p));
    assert.equal(result.status,'BLOCKED');assert.equal(result.reason,'OWNER_RECOVERY_REQUIRED');
    assert.equal(result.execution_started,false);assert.equal(starts(f),0);
  });
});
test('dirty preparation and approval are gate blocks with CLI exit 2',async t=>{
  const f=fixture(t),p=await prepared(f),request=jsonFile(f,'request',p.request),task=jsonFile(f,'task',f.task);
  writeFileSync(join(f.repo,'dirty'),'preserved');
  const before=journal(f);
  for(const result of [cli('prepare',f.stateRoot,task,'attempt-2'),cli('approve',f.stateRoot,request,p.expected_digest,'approval-1','60000')]) {
    assert.equal(result.code,2);assert.equal(result.json.status,'BLOCKED');assert.match(result.json.reason,/DIRTY/);
  }
  assert.equal(journal(f),before);assert.equal(starts(f),0);
});
test('expired initial approval is unconsumed and changed replay binding is rejected',async t=>{
  const f=fixture(t),{createController}=await controller();let now=Date.now();
  const api=createController({now:()=>now}),p=await approved(f,api);now+=60000;
  assert.equal((await api.run(f.stateRoot,runInput(p))).status,'BLOCKED');
  assert.equal(Object.hasOwn(readStore(f.stateRoot).state.attempts,'attempt-1'),false);assert.equal(starts(f),0);
  const changed=structuredClone(p.request);changed.task.goal='A changed goal';
  await assert.rejects(()=>api.run(f.stateRoot,{request:changed,expected_digest:requestDigest(changed)}),/DIGEST/);
});
test('public wrapper accessors are rejected before evaluation',async t=>{
  const f=fixture(t),p=await prepared(f);let evaluated=false;
  const input={expected_digest:p.expected_digest,get request(){evaluated=true;return p.request;}};
  await assert.rejects(()=>p.api.run(f.stateRoot,input),/INVALID_JSON_INPUT/);
  assert.equal(evaluated,false);assert.equal(starts(f),0);
});
