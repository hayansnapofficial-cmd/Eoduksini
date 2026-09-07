import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../core/contracts.mjs';
import { issueLock, writerGate, heartbeat, providerFailed, lockState, validateDecision, unlock, scopeOverlap } from '../core/governor.mjs';
const base={git_sha:'a'.repeat(40),harness_revision:1,task_graph_revision:1,migration_head:'none',
  dependency_lock_digest:'b'.repeat(64),api_contract_digest:'c'.repeat(64),policy_digest:'d'.repeat(64),control_epoch:5};
const args={lockId:'LOCK-1',projectId:'demo',provider:'high-reasoning',approvedProviders:['high-reasoning'],
  baseline:base,scope:{write_paths:['src/orders/**'],api_routes:['PATCH /orders'],database_objects:['public.orders']},
  now:1000,ttlMs:10000,heartbeatMs:1000};
function decision(lock) { return {decision_id:'DEC-1',lock_id:lock.lock_id,provider_binding:lock.provider_binding,
  control_epoch:5,baseline_digest:lock.baseline_digest,task_actions:[{task_id:'DEMO-1',action:'REBASE'}],
  required_tests:['contract-test'],evidence_ids:['EV-1']}; }
test('semantic lock checkpoints only related scopes, including different files sharing an API',()=>{
  const lock=issueLock(args);
  assert.equal(writerGate([lock],{projectId:'demo',scope:{write_paths:['web/edit.js'],api_routes:['PATCH /orders']},now:1100}).allowed,false);
  assert.equal(writerGate([lock],{projectId:'demo',scope:{write_paths:['src/gallery/a.js'],api_routes:['GET /gallery']},now:1100}).allowed,true);
  assert.equal(writerGate([lock],{projectId:'other',scope:args.scope,now:1100}).allowed,true);
  assert.throws(()=>issueLock({...args,lockId:'LOCK-2',activeLocks:[lock]}),/ALREADY_LOCKED/);
});
test('scope matching covers glob overlap and database object conflict',()=>{
  assert.ok(scopeOverlap({write_paths:['src/*/a.js']},{write_paths:['src/orders/**']}).length);
  assert.ok(scopeOverlap({database_objects:['public.orders']},{database_objects:['public.orders']}).length);
  assert.deepEqual(scopeOverlap({write_paths:['src/orders/**']},{write_paths:['src/gallery/**']}),[]);
  assert.throws(()=>writerGate([],{projectId:'demo',scope:{},now:1000}),/EMPTY_SCOPE/);
});
test('provider stays pinned and cannot silently downgrade',()=>{
  const lock=issueLock(args),d=decision(lock);
  assert.throws(()=>validateDecision(lock,{...d,provider_binding:'cheap'},{canonical:base,now:1100}),/PROVIDER_LOCKED/);
  assert.throws(()=>issueLock({...args,provider:'cheap'}),/NOT_APPROVED/);
  const failed=providerFailed(lock);
  assert.equal(lockState(failed,1200),'LOCK_RECOVERY');
  assert.equal(writerGate([failed],{projectId:'demo',scope:args.scope,now:1200}).allowed,false);
});
test('expired or heartbeat-lost locks hold writes for recovery rather than unlocking',()=>{
  const lock=issueLock(args);
  assert.equal(lockState(lock,2001),'LOCK_HEARTBEAT_LOST');
  assert.equal(lockState(lock,11000),'LOCK_EXPIRED');
  assert.equal(writerGate([lock],{projectId:'demo',scope:args.scope,now:11000}).allowed,false);
  assert.throws(()=>heartbeat(lock,{provider:'high-reasoning',controlEpoch:5,now:2001,ttlMs:5000}),/RECOVERY_REQUIRED/);
  const renewed=heartbeat(lock,{provider:'high-reasoning',controlEpoch:5,now:1500,ttlMs:5000});
  assert.equal(renewed.expires_at,6500);
  assert.equal(lock.expires_at,11000);
});
test('baseline and epoch changes reject decisions while preserving originals',()=>{
  const lock=issueLock(args),d=decision(lock);
  assert.throws(()=>validateDecision(lock,d,{canonical:{...base,control_epoch:6},now:1100}),/STALE_GOVERNOR_DECISION/);
  assert.throws(()=>validateDecision(lock,d,{canonical:{...base,harness_revision:2},now:1100}),/BASELINE_DRIFT/);
  assert.throws(()=>validateDecision(lock,{...d,extra:true},{canonical:base,now:1100}),/INVALID_CONTRACT/);
  assert.equal(lock.status,'GOVERNOR_LOCKED');
  assert.throws(()=>{lock.baseline.git_sha='b'.repeat(40);},TypeError);
});
test('unlock needs decision-bound independent evidence and every required test',()=>{
  const lock=issueLock(args),d=decision(lock);
  const verification={decision_digest:digest(d),verifier_id:'independent-reviewer',independent:true,
    tests:[{name:'contract-test',result:'PASS'}],evidence_ids:['EV-REVIEW']};
  assert.throws(()=>unlock(lock,d,{canonical:base,now:1100,verification:{...verification,independent:false}}),/INDEPENDENT/);
  assert.throws(()=>unlock(lock,d,{canonical:base,now:1100,verification:{...verification,tests:[]}}),/REVERIFICATION/);
  const released=unlock(lock,d,{canonical:base,now:1100,verification});
  assert.equal(writerGate([released],{projectId:'demo',scope:args.scope,now:1200}).allowed,true);
  assert.equal(lock.status,'GOVERNOR_LOCKED');
});
