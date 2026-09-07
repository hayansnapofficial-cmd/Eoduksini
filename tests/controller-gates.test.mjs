import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from '../core/contracts.mjs';
import { scope } from '../core/governor.mjs';
import { requestDigest } from '../core/controller/contracts.mjs';
import { reduce } from '../core/controller/state.mjs';
import { prepareRequest, checkDispatch, localCapacity } from '../core/controller/gates.mjs';
import { makeFixture } from './helpers/controller-fixture.mjs';

const capacity={cpuThreads:8,memoryGiB:8,availableMemoryGiB:8};
const options={now:200,capacity};
const fixtureTest=fn=>()=>{const f=makeFixture(); try {return fn(f);} finally {f.cleanup();}};
const git=(f,args)=>execFileSync('git',args,{cwd:f.repo,stdio:'pipe'});
function event(state,type,payload) {
  const body={schema_version:1,seq:state===null?1:2,prev_digest:state===null?null:'a'.repeat(64),
    control_epoch:1,type,payload};
  return reduce(state,{...body,digest:digest(body)});
}
function initialized(f) {
  return event(null,'INIT',{repo_root:realpathSync.native(f.repo),project:f.project,policy:f.policy});
}
function approved(f) {
  let state=initialized(f);
  const request=prepareRequest(state,{attempt_id:'ATTEMPT-1',task:f.task});
  const approval={approval_id:'APPROVAL-1',request_digest:requestDigest(request),issued_at:100,expires_at:60100,control_epoch:1};
  state=event(state,'APPROVED',{request,approval});
  return {state,request,approval};
}
function lock({write_paths=['scripts/**'],...overrides}={}) {
  const baseline={git_sha:'a'.repeat(40),harness_revision:1,task_graph_revision:1,migration_head:'none',
    dependency_lock_digest:'b'.repeat(64),api_contract_digest:'c'.repeat(64),policy_digest:'d'.repeat(64),control_epoch:1};
  return {lock_id:'LOCK-1',project_id:'demo',owner_role:'HIGH_ASSURANCE_GOVERNOR',provider_binding:'provider-a',
    baseline,baseline_digest:digest(baseline),scope:scope({write_paths}),issued_at:100,expires_at:60100,
    heartbeat_interval_ms:500,last_heartbeat_at:100,status:'GOVERNOR_LOCKED',...overrides};
}

test('prepare binds clean repository, executable bytes, policy prefix and ordered semantic union without launching',fixtureTest(f=>{
  f.policy.commands.unit.prefix_argv=['--no-warnings'];
  f.policy.commands.unit.scope=scope({write_paths:['generated/**'],api_routes:['GET /fixture']});
  f.task.in_scope_paths=['scripts/**','src/**'];
  const before=JSON.stringify(f),{state,request,approval}=approved(f);
  assert.equal(request.repo_root,realpathSync.native(f.repo));
  assert.deepEqual(request.commands[0].declared_argv,['node','scripts/fixture-test.mjs']);
  assert.deepEqual(request.commands[0].argv,['--no-warnings','scripts/fixture-test.mjs']);
  assert.equal(request.commands[0].executable_digest,createHash('sha256').update(readFileSync(process.execPath)).digest('hex'));
  assert.deepEqual(request.scope.write_paths,['generated/**','scripts/**','src/**']);
  assert.deepEqual(request.scope.api_routes,['GET /fixture']);
  assert.equal(request.baseline.head,f.head);
  assert.equal(request.baseline.hashes['scripts/fixture-test.mjs'],createHash('sha256').update("console.log('fixture pass');\n").digest('hex'));
  assert.deepEqual(checkDispatch(state,request,approval,options),{reservation:{cpuThreads:1,memoryGiB:2,activeTasks:1},request_digest:approval.request_digest});
  assert.equal(JSON.stringify(f),before);
  assert.equal(existsSync(f.stateRoot),false);
  assert.equal(existsSync(join(f.repo,'fixture-output')),false);
}));

for(const [name,mutate,reason] of [
  ['watched bytes',f=>writeFileSync(join(f.repo,'scripts/fixture-test.mjs'),'changed'),/DRIFT|DIRTY/],
  ['untracked file',f=>writeFileSync(join(f.repo,'untracked.txt'),'changed'),/DIRTY/],
  ['HEAD',f=>git(f,['-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','fixture drift']),/DRIFT/],
  ['policy prefix',(_f,s)=>s.policy.commands.unit.prefix_argv.push('--no-warnings'),/DRIFT|DIGEST/],
  ['Adapter argv',(_f,s)=>s.project.commands.unit.argv.push('--changed'),/DRIFT|DIGEST/],
  ['policy resources',(_f,s)=>{s.policy.resources.cpu_threads=2;},/DRIFT|DIGEST/],
  ['epoch',(_f,s)=>{s.control_epoch=2;},/EPOCH/],
]) test(`${name} changed after approval blocks dispatch`,fixtureTest(f=>{
  const {state,request,approval}=approved(f); mutate(f,state);
  assert.throws(()=>checkDispatch(state,request,approval,options),reason);
}));

test('fresh environment binding rejects changed, missing and forged allowed variables',fixtureTest(f=>{
  const saved=process.env.LC_ALL;
  try {
    process.env.LC_ALL='C';
    const {state,request,approval}=approved(f);
    process.env.LC_ALL='POSIX';
    assert.throws(()=>checkDispatch(state,request,approval,options),/DRIFT|DIGEST/);
    delete process.env.LC_ALL;
    assert.throws(()=>checkDispatch(state,request,approval,options),/DRIFT|DIGEST/);
    request.environment={};
    const forged={...approval,request_digest:requestDigest(request)};
    state.approvals[request.attempt_id]={request,approval:forged};
    assert.throws(()=>checkDispatch(state,request,forged,options),/DRIFT|DIGEST/);
  } finally {if(saved===undefined) delete process.env.LC_ALL; else process.env.LC_ALL=saved;}
}));

test('runtime hooks and credentials never enter the prepared environment',fixtureTest(f=>{
  const saved=process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS='--require=untrusted-hook';
    const state={repo_root:f.repo,project:f.project,policy:f.policy,control_epoch:1};
    const request=prepareRequest(state,{attempt_id:'ATTEMPT-1',task:f.task});
    assert.equal(Object.hasOwn(request.environment,'NODE_OPTIONS'),false);
    assert.ok(Object.keys(request.environment).every(key=>['PATH','LANG','LC_ALL','LC_CTYPE','ComSpec','SystemRoot','PATHEXT'].includes(key)));
  } finally {if(saved===undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS=saved;}
}));

test('executable bytes changed after approval block dispatch',fixtureTest(f=>{
  const executable=join(f.root,'fixture-tool.exe'); writeFileSync(executable,'original');
  f.policy.commands.unit.executable=executable;
  const {state,request,approval}=approved(f);
  writeFileSync(executable,'changed');
  assert.throws(()=>checkDispatch(state,request,approval,options),/DRIFT|DIGEST/);
}));

test('executable resolution rejects relative paths, directories, missing files and symlink chains',fixtureTest(f=>{
  for(const executable of ['node',f.root,join(f.root,'missing.exe')]) {
    f.policy.commands.unit.executable=executable;
    assert.throws(()=>prepareRequest(initialized(f),{attempt_id:'A',task:f.task}),/POLICY|EXECUTABLE|ENOENT/);
  }
  const target=join(f.root,'tools'),alias=join(f.root,'alias'); mkdirSync(target);
  writeFileSync(join(target,'tool.exe'),'fixture'); symlinkSync(target,alias,process.platform==='win32'?'junction':'dir');
  f.policy.commands.unit.executable=join(alias,'tool.exe');
  assert.throws(()=>prepareRequest(initialized(f),{attempt_id:'A',task:f.task}),/SYMLINK/);
}));

test('Adapter cwd is inside the repository and cannot traverse a symlink',fixtureTest(f=>{
  f.project.commands.unit.cwd='../';
  assert.throws(()=>prepareRequest(initialized(f),{attempt_id:'A',task:f.task}),/PATH|PROJECT|SCHEMA/);
  const target=join(f.root,'outside'); mkdirSync(target);
  symlinkSync(target,join(f.repo,'linked'),process.platform==='win32'?'junction':'dir');
  // Ignore the link entry itself; a directory-only pattern misses POSIX symlinks.
  writeFileSync(join(f.repo,'.gitignore'),'fixture-output/\n/linked\n');
  git(f,['add','.gitignore']); git(f,['commit','-m','fixture ignore link']);
  f.task.base_sha=execFileSync('git',['rev-parse','HEAD'],{cwd:f.repo,encoding:'utf8'}).trim();
  f.project.commands.unit.cwd='linked';
  assert.equal(lstatSync(join(f.repo,'linked')).isSymbolicLink(),true);
  assert.equal(git(f,['status','--porcelain=v1','--untracked-files=all']).toString().trim(),'');
  assert.throws(()=>prepareRequest(initialized(f),{attempt_id:'A',task:f.task}),/SYMLINK/);
}));

test('approval must be journaled, match exact request, and remain valid for a complete command deadline',fixtureTest(f=>{
  const {state,request,approval}=approved(f);
  assert.throws(()=>checkDispatch({...state,approvals:{}},request,approval,options),/APPROVAL/);
  assert.throws(()=>checkDispatch(state,{...request,task:{...request.task,goal:'A changed valid fixture goal.'}},approval,options),/DIGEST|APPROVAL/);
  assert.throws(()=>checkDispatch(state,request,{...approval,approval_id:'OTHER'},options),/APPROVAL/);
  assert.throws(()=>checkDispatch(state,request,approval,{...options,now:99}),/CLOCK/);
  assert.throws(()=>checkDispatch(state,request,approval,{...options,now:60100}),/EXPIRED/);
  assert.throws(()=>checkDispatch(state,request,approval,{...options,now:55101}),/DEADLINE/);
  assert.doesNotThrow(()=>checkDispatch(state,request,approval,{...options,now:55100}));
  assert.throws(()=>checkDispatch(state,request,approval,{...options,now:NaN}),/TIME/);
  assert.throws(()=>checkDispatch({...state,recovery_required:true},request,approval,options),/RECOVERY/);
}));

test('preparation rejects unsupported task capabilities, duplicate commands and policy omissions',fixtureTest(f=>{
  const state=initialized(f);
  for(const patch of [{data_risk:'HIGH'},{schema_change:true,owner_role:f.project.schema_owner_role},
    {dependencies:['DEMO-OTHER']},{failure_tests:['failure']},{shared_file_leases:['scripts/a.mjs']},{release_impact:'APP_ONLY'},
    {required_tests:['unit','unit']}])
    assert.throws(()=>prepareRequest(state,{attempt_id:'A',task:{...f.task,...patch}}),/UNSUPPORTED|DUPLICATE/);
  state.policy.commands={other:state.policy.commands.unit};
  assert.throws(()=>prepareRequest(state,{attempt_id:'A',task:f.task}),/COMMAND/);
}));

for(const status of ['GOVERNOR_LOCKED','LOCK_RECOVERY']) test(`${status} blocks overlapping scope and preserves the imported record`,fixtureTest(f=>{
  f.policy.governor_locks=[lock({status,expires_at:1000})]; const original=JSON.stringify(f.policy.governor_locks);
  const {state,request,approval}=approved(f);
  for(const now of [200,601,1000]) assert.throws(()=>checkDispatch(state,request,approval,{...options,now}),/GOVERNOR_HOLD/);
  assert.equal(JSON.stringify(f.policy.governor_locks),original);
  assert.equal(JSON.stringify(state.policy.governor_locks),original);
}));

for(const platform of ['win32','linux']) test(`${platform}: src/orders/** hold versus SRC/ORDERS/a.js uses platform path case rules`,fixtureTest(f=>{
  const descriptor=Object.getOwnPropertyDescriptor(process,'platform');
  try {
    Object.defineProperty(process,'platform',{value:platform});
    f.policy.governor_locks=[lock({write_paths:['src/orders/**']})];
    f.task.in_scope_paths=['SRC/ORDERS/a.js'];
    const original=JSON.stringify(f.policy.governor_locks),{state,request,approval}=approved(f);
    if(platform==='win32') assert.throws(()=>checkDispatch(state,request,approval,options),/GOVERNOR_HOLD/);
    else assert.doesNotThrow(()=>checkDispatch(state,request,approval,options));
    assert.equal(JSON.stringify(state.policy.governor_locks),original);
  } finally {Object.defineProperty(process,'platform',descriptor);}
}));

test('unknown Governor baseline fields are rejected, never synthesized from the repository',fixtureTest(f=>{
  const held=lock(); delete held.baseline.harness_revision;
  f.policy.governor_locks=[held]; const before=JSON.stringify(held);
  assert.throws(()=>prepareRequest({repo_root:f.repo,project:f.project,policy:f.policy,control_epoch:1},{attempt_id:'A',task:f.task}),/GOVERNOR/);
  assert.equal(JSON.stringify(held),before);
}));

test('CPU, memory pressure, quota and occupied journal reservations fail closed',fixtureTest(f=>{
  const {state,request,approval}=approved(f);
  for(const poor of [{...capacity,cpuThreads:0},{...capacity,memoryGiB:1,availableMemoryGiB:1},{...capacity,availableMemoryGiB:1}])
    assert.throws(()=>checkDispatch(state,request,approval,{...options,capacity:poor}),/RESOURCE|CAPACITY/);
  state.reservation={cpuThreads:1,memoryGiB:2,activeTasks:1};
  assert.throws(()=>checkDispatch(state,request,approval,options),/RESERVATION/);
  assert.throws(()=>checkDispatch(state,request,approval,{...options,existingReservation:true}),/RESERVATION/);
  f.policy.resources.cpu_threads=3;
  const quota=approved(f);
  assert.throws(()=>checkDispatch(quota.state,quota.request,quota.approval,options),/RESOURCE/);
}));

test('same incomplete attempt reuses exactly its journal reservation without double allocation',fixtureTest(f=>{
  const {state,request,approval}=approved(f);
  const reservation={cpuThreads:1,memoryGiB:2,activeTasks:1};
  const prepared=event(state,'PREPARED',{attempt_id:request.attempt_id,request_digest:approval.request_digest,reservation});
  const ownOptions={now:200,capacity:{cpuThreads:1,memoryGiB:2,availableMemoryGiB:2},existingReservation:true};
  assert.deepEqual(checkDispatch(prepared,request,approval,ownOptions).reservation,reservation);
  assert.throws(()=>checkDispatch(prepared,request,approval,options),/CONSUMED|PREPARED|RESERVATION/);
  for(const mutate of [s=>{s.attempts[request.attempt_id].request_digest='a'.repeat(64);},
    s=>{s.attempts[request.attempt_id].status='SUCCEEDED';},s=>{s.reservation.cpuThreads=2;},
    s=>{s.attempts.OTHER=structuredClone(s.attempts[request.attempt_id]);}]) {
    const changed=structuredClone(prepared); mutate(changed);
    assert.throws(()=>checkDispatch(changed,request,approval,ownOptions),/RESERVATION|CONSUMED/);
  }
  assert.throws(()=>checkDispatch(prepared,request,approval,{...ownOptions,capacity:{cpuThreads:1,memoryGiB:2,availableMemoryGiB:1}}),/RESOURCE/);
}));

test('local capacity exposes finite CPU and GiB observations usable for admission',()=>{
  const result=localCapacity();
  assert.deepEqual(Object.keys(result).sort(),['availableMemoryGiB','cpuThreads','memoryGiB']);
  assert.ok(Number.isSafeInteger(result.cpuThreads) && result.cpuThreads>0);
  assert.ok(Number.isFinite(result.memoryGiB) && result.memoryGiB>0);
  assert.ok(Number.isFinite(result.availableMemoryGiB) && result.availableMemoryGiB>=0 && result.availableMemoryGiB<=result.memoryGiB);
});

test('watched byte drift is detected even when Git dirty status hides a tracked change',fixtureTest(f=>{
  const {state,request,approval}=approved(f);
  git(f,['update-index','--assume-unchanged','scripts/fixture-test.mjs']);
  writeFileSync(join(f.repo,'scripts/fixture-test.mjs'),'changed but hidden from status');
  assert.throws(()=>checkDispatch(state,request,approval,options),/REPOSITORY_DRIFT/);
}));

test('prepared command order follows task order and the policy command-count ceiling is enforced',fixtureTest(f=>{
  f.project.commands.build={argv:['node','scripts/fixture-test.mjs','build'],cwd:'scripts'};
  f.policy.commands.build={...f.policy.commands.unit,prefix_argv:['--no-warnings']};
  f.policy.limits.max_commands=2; f.task.required_tests=['build','unit'];
  const {request}=approved(f);
  assert.deepEqual(request.commands.map(c=>c.key),['build','unit']);
  assert.deepEqual(request.commands[0].argv,['--no-warnings','scripts/fixture-test.mjs','build']);
  assert.equal(request.commands[0].cwd,join(realpathSync.native(f.repo),'scripts'));
  f.policy.limits.max_commands=1;
  assert.throws(()=>prepareRequest(initialized(f),{attempt_id:'A',task:f.task}),/COMMAND_LIMIT/);
}));

test('a structurally replayable future Governor heartbeat is rejected by fresh dispatch',fixtureTest(f=>{
  f.policy.governor_locks=[lock({write_paths:['unrelated/**'],last_heartbeat_at:300})];
  const {state,request,approval}=approved(f);
  assert.throws(()=>checkDispatch(state,request,approval,options),/CLOCK_ROLLBACK/);
}));

test('entire recomputation rejects a journal-shaped forged argv or changed environment',fixtureTest(f=>{
  const original=approved(f);
  for(const mutate of [r=>{r.commands[0].argv.unshift('--no-warnings');},r=>{r.environment.LANG='forged';}]) {
    const {state,request,approval}=structuredClone(original); mutate(request);
    approval.request_digest=requestDigest(request); state.approvals[request.attempt_id]={request,approval};
    assert.throws(()=>checkDispatch(state,request,approval,options),/REQUEST_DRIFT/);
  }
}));
