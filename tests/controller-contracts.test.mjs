import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { digest } from '../core/contracts.mjs';
import { policyContract,requestContract,approvalContract,resultContract,localTask,validateGovernorLock,scopeForPlatform,requestDigest } from '../core/controller/contracts.mjs';
import { makeFixture,requestFixture } from './helpers/controller-fixture.mjs';

const withFixture=fn=>()=>{const fixture=makeFixture(); try{return fn(fixture);} finally{fixture.cleanup();}};
const governorBaseline=()=>({git_sha:'a'.repeat(40),harness_revision:1,task_graph_revision:1,migration_head:'none',
  dependency_lock_digest:'b'.repeat(64),api_contract_digest:'c'.repeat(64),policy_digest:'d'.repeat(64),control_epoch:1});
function governorLock(overrides={}) {
  const now=Date.now(),baseline=governorBaseline();
  return {lock_id:'LOCK-1',project_id:'demo',owner_role:'HIGH_ASSURANCE_GOVERNOR',provider_binding:'provider-a',
    baseline,baseline_digest:digest(baseline),scope:{write_paths:['src/orders/**'],symbols:[],api_routes:[],request_contracts:[],
      response_contracts:[],database_objects:[],migration_objects:[],rls_policies:[],environment_keys:[],generated_types:[],runtime_services:[]},
    issued_at:now-1000,expires_at:now+60000,
    heartbeat_interval_ms:5000,last_heartbeat_at:now-500,status:'GOVERNOR_LOCKED',...overrides};
}

test('policy validation is closed, bounded, and returns detached normalized data',withFixture(f=>{
  const validated=policyContract(f.policy);
  assert.deepEqual(validated.resources,f.policy.resources);
  assert.deepEqual(validated.commands.unit.scope.write_paths,['scripts/**']);
  assert.deepEqual(validated.commands.unit.scope.api_routes,[]);
  validated.commands.unit.prefix_argv.push('--changed');
  assert.deepEqual(f.policy.commands.unit.prefix_argv,[]);
  const authority={reviewer_ids:['reviewer-1'],adoption_actor_ids:['owner-1'],price_basis_ids:['price-1'],
    energy_source_ids:['meter-1'],tariff_basis_ids:['tariff-1']};
  assert.deepEqual(policyContract({...f.policy,post_run_authority:authority}).post_run_authority,authority);
  assert.throws(()=>policyContract({...f.policy,post_run_authority:{...authority,reviewer_ids:['reviewer-1','reviewer-1']}}),
    /INVALID_POLICY/);
  assert.throws(()=>policyContract({...f.policy,implicit_approval:true}),/INVALID_POLICY/);
  assert.throws(()=>policyContract({...f.policy,quota:{...f.policy.quota,baseCpuThreads:0}}),/QUOTA|POLICY/);
  assert.throws(()=>policyContract({...f.policy,resources:{...f.policy.resources,allow_burst:true}}),/INVALID_POLICY/);
  assert.throws(()=>policyContract({...f.policy,resources:{workload_class:'LIGHT',cpu_threads:1,memory_gib:2,gpu_count:0,vram_gib:0,estimated_seconds:null,allow_burst:false}}),/INVALID_POLICY/);
  assert.throws(()=>policyContract({...f.policy,resources:{workload_class:'GPU',cpu_threads:1,memory_gib:2,gpu_count:1,vram_gib:4,estimated_seconds:10,allow_burst:false}}),/INVALID_POLICY/);
  const {runtime_services,...partialScope}=f.policy.commands.unit.scope;
  assert.throws(()=>policyContract({...f.policy,commands:{unit:{...f.policy.commands.unit,scope:partialScope}}}),/INVALID_POLICY/);
  for(const [key,value] of [['timeout_ms',0],['timeout_ms',-1],['timeout_ms',60001],['max_output_bytes',1048577],['max_commands',17],['approval_ttl_ms',3600001]])
    assert.throws(()=>policyContract({...f.policy,limits:{...f.policy.limits,[key]:value}}),/INVALID_POLICY/);
}));

test('local tasks reject every unsupported first-version capability',withFixture(f=>{
  assert.equal(localTask(f.task,f.project).task.data_risk,'LOW');
  assert.throws(()=>localTask({...f.task,data_risk:'HIGH'},f.project),/UNSUPPORTED_LOCAL_TASK/);
  assert.throws(()=>localTask({...f.task,schema_change:true,owner_role:f.project.schema_owner_role},f.project),/UNSUPPORTED_LOCAL_TASK/);
  assert.throws(()=>localTask({...f.task,dependencies:['DEMO-OTHER']},f.project),/UNSUPPORTED_LOCAL_TASK/);
  assert.throws(()=>localTask({...f.task,failure_tests:['failure']},f.project),/UNSUPPORTED_LOCAL_TASK/);
  assert.throws(()=>localTask({...f.task,shared_file_leases:['scripts/a.mjs']},f.project),/UNSUPPORTED_LOCAL_TASK/);
  assert.throws(()=>localTask({...f.task,release_impact:'APP_ONLY'},f.project),/UNSUPPORTED_LOCAL_TASK/);
  assert.throws(()=>localTask({...f.task,required_tests:['unit','unit']},f.project),/DUPLICATE/);
  assert.throws(()=>localTask({...f.task,required_tests:['unknown']},f.project),/UNDECLARED/);
}));

test('Windows scope comparisons normalize only copied write paths',()=>{
  const held={write_paths:['src/orders/**'],api_routes:['GET /Orders']};
  assert.deepEqual(scopeForPlatform(held,'win32').write_paths,['src/orders/**']);
  assert.deepEqual(scopeForPlatform({write_paths:['SRC/ORDERS/a.js']},'win32').write_paths,['src/orders/a.js']);
  assert.equal(held.api_routes[0],'GET /Orders');
  assert.deepEqual(scopeForPlatform({write_paths:['SRC/A.js']},'linux').write_paths,['SRC/A.js']);
});

test('Governor lock imports bind baseline, status, lease times, owner, and unlock evidence',()=>{
  const lock=governorLock(),copy=validateGovernorLock(lock); copy.scope.write_paths.push('other/**');
  assert.deepEqual(lock.scope.write_paths,['src/orders/**']);
  assert.throws(()=>validateGovernorLock({...lock,extra:true}),/INVALID_GOVERNOR_LOCK/);
  assert.throws(()=>validateGovernorLock({...lock,owner_role:'worker'}),/INVALID_GOVERNOR_LOCK/);
  assert.throws(()=>validateGovernorLock({...lock,status:'LOCK_EXPIRED'}),/INVALID_GOVERNOR_LOCK/);
  assert.throws(()=>validateGovernorLock({...lock,baseline_digest:'e'.repeat(64)}),/BASELINE/);
  assert.throws(()=>validateGovernorLock({...lock,last_heartbeat_at:lock.expires_at+1}),/INVALID_GOVERNOR_LOCK/);
  assert.throws(()=>validateGovernorLock({...lock,issued_at:Date.now()+60000,last_heartbeat_at:Date.now()+60000,expires_at:Date.now()+120000}),/INVALID_GOVERNOR_LOCK/);
  assert.throws(()=>validateGovernorLock({...lock,status:'UNLOCKED'}),/INVALID_GOVERNOR_LOCK/);
  assert.equal(validateGovernorLock({...lock,status:'UNLOCKED',decision_digest:'e'.repeat(64),verification_digest:'f'.repeat(64)}).status,'UNLOCKED');
});

test('execution requests bind project, task, baseline, command order, and declared argv',withFixture(f=>{
  const request=requestFixture(f),validated=requestContract(request);
  validated.task.goal='mutated'; assert.notEqual(request.task.goal,'mutated');
  assert.equal(requestDigest(request),digest(requestContract(request)));
  assert.notEqual(requestDigest(request),requestDigest({...request,control_epoch:2}));
  assert.throws(()=>requestContract({...request,project_id:'other'}),/REQUEST_PROJECT_MISMATCH/);
  assert.throws(()=>requestContract({...request,task:{...request.task,base_sha:'c'.repeat(40)}}),/REQUEST_BASELINE_MISMATCH/);
  assert.throws(()=>requestContract({...request,baseline:{...request.baseline,adapter_digest:'d'.repeat(64)}}),/REQUEST_BASELINE_MISMATCH/);
  assert.throws(()=>requestContract({...request,commands:[{...request.commands[0],key:'unknown'}]}),/REQUEST_COMMAND_MISMATCH/);
  assert.throws(()=>requestContract({...request,commands:[{...request.commands[0],declared_argv:['node','different.mjs']}]}),/REQUEST_COMMAND_MISMATCH/);
  assert.throws(()=>requestContract({...request,commands:[{...request.commands[0],cwd:'relative'}]}),/INVALID_REQUEST/);
  assert.throws(()=>requestContract({...request,commands:[{...request.commands[0],executable:'node'}]}),/INVALID_REQUEST/);
  assert.throws(()=>requestContract({...request,environment:{PATH:'fixture',SECRET:'no'}}),/INVALID_REQUEST/);
  assert.throws(()=>requestContract({...request,resources:{workload_class:'LIGHT',cpu_threads:1,memory_gib:2,gpu_count:0,vram_gib:0,estimated_seconds:null,allow_burst:false}}),/INVALID_REQUEST/);
  assert.throws(()=>requestContract({...request,resources:{workload_class:'GPU',cpu_threads:1,memory_gib:2,gpu_count:1,vram_gib:4,estimated_seconds:10,allow_burst:false}}),/INVALID_REQUEST/);
  const {runtime_services,...partialScope}=request.scope;
  assert.throws(()=>requestContract({...request,scope:partialScope}),/INVALID_REQUEST/);
  assert.throws(()=>requestContract({...request,limits:{...request.limits,timeout_ms:-1}}),/INVALID_REQUEST/);
}));

test('request environment shape uses a stable vocabulary independent of current host variables',withFixture(f=>{
  const request=requestFixture(f),saved=process.env.LC_ALL;
  try {
    delete process.env.LC_ALL;
    const environment={PATH:'p',LANG:'C',LC_ALL:'C',LC_CTYPE:'C',ComSpec:'cmd.exe',SystemRoot:'C:/Windows',PATHEXT:'.EXE'};
    assert.deepEqual(requestContract({...request,environment}).environment,environment);
    assert.throws(()=>requestContract({...request,environment:{NODE_OPTIONS:'--require malicious'}}),/INVALID_REQUEST/);
  } finally { if(saved===undefined) delete process.env.LC_ALL; else process.env.LC_ALL=saved; }
}));

test('controller fixture leaves its sibling state root uninitialized',withFixture(f=>{
  assert.equal(existsSync(f.stateRoot),false);
  assert.equal(dirname(f.stateRoot),f.root);
  assert.equal(dirname(f.repo),f.root);
}));

test('approval and result contracts reject invalid ranges, statuses, and numeric bounds',withFixture(f=>{
  const request=requestFixture(f),request_digest=requestDigest(request);
  const approval={approval_id:'APPROVAL-1',request_digest,issued_at:1000,expires_at:2000,control_epoch:1};
  assert.deepEqual(approvalContract(approval),approval);
  assert.throws(()=>approvalContract({...approval,expires_at:1000}),/INVALID_APPROVAL/);
  assert.throws(()=>approvalContract({...approval,expires_at:1000+3600001}),/INVALID_APPROVAL/);
  assert.throws(()=>approvalContract({...approval,control_epoch:0}),/INVALID_APPROVAL/);
  const result={status:'SUCCEEDED',reason:'command completed',exit_code:0,signal:null,pid:123,output_bytes:12,saved_bytes:12,
    output_digest:'e'.repeat(64),transcript_path:dirname(f.repo)+'\\transcript.log',close_observed:true};
  assert.equal(resultContract(result).status,'SUCCEEDED');
  assert.throws(()=>resultContract({...result,status:'UNKNOWN'}),/INVALID_RESULT/);
  assert.throws(()=>resultContract({...result,pid:0}),/INVALID_RESULT/);
  assert.throws(()=>resultContract({...result,saved_bytes:13}),/INVALID_RESULT/);
}));

test('public contract inputs reject accessors, sparse arrays, prototype-shaped keys, and oversized JSON before evaluation',withFixture(f=>{
  let evaluated=false; const accessor={...f.policy};
  Object.defineProperty(accessor,'quota',{enumerable:true,get(){evaluated=true; return f.policy.quota;}});
  assert.throws(()=>policyContract(accessor),/INVALID_JSON_INPUT/); assert.equal(evaluated,false);
  const sparse={...f.policy,governor_locks:new Array(1)};
  assert.throws(()=>policyContract(sparse),/INVALID_JSON_INPUT/);
  const shaped=structuredClone(f.policy); Object.defineProperty(shaped.commands.unit,'constructor',{value:'bad',enumerable:true});
  assert.throws(()=>policyContract(shaped),/INVALID_JSON_INPUT/);
  assert.throws(()=>policyContract({...f.policy,padding:'x'.repeat(262144)}),/JSON_INPUT_TOO_LARGE|INVALID_JSON_INPUT/);
}));
