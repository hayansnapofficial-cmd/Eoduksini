import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture } from './helpers/controller-fixture.mjs';
import { startRecoveryWorker, waitBoundary, stopWorker, removeOwnedOwner, crashWorkerWithLiveChild } from './helpers/controller-recovery-process.mjs';
import { attachLiveChild } from './helpers/controller-live-child.mjs';
import { createController } from '../core/controller/controller.mjs';
import { requestDigest } from '../core/controller/contracts.mjs';
import { checkDispatch } from '../core/controller/gates.mjs';

const starts=f=>existsSync(join(f.repo,'fixture-output/starts'))?readFileSync(join(f.repo,'fixture-output/starts'),'utf8'):null;
async function setup(t,{live=false}={}) {
  const f=makeFixture({startCounter:true}); f.workers=[];
  t.after(async()=>{for(const worker of f.workers) await stopWorker(worker);await f.liveControl?.cleanup();f.cleanup();});
  if(live) f.liveControl=await attachLiveChild(f);
  f.policy.resources.memory_gib=0.01;
  const api=createController(); api.init(f.stateRoot,f.repo,f.project,f.policy);
  const inputs=[];
  for(const attempt_id of ['crash-attempt','other-attempt']) {
    const task=attempt_id==='other-attempt'?{...f.task,in_scope_paths:['other/**']}:f.task;
    const request=api.prepare(f.stateRoot,{attempt_id,task});
    const input={request,expected_digest:requestDigest(request)};
    assert.equal((await api.approve(f.stateRoot,{...input,approval_id:attempt_id,ttl_ms:60000})).status,'APPROVED');
    inputs.push(input);
  }
  return {f,api,input:inputs[0],other:inputs[1]};
}

// These catch rerunning a consumed approval, releasing uncertain reservations,
// or collapsing command-result durability into terminal attempt durability.
for(const [phase,wantStarts,wantResults,wantLast] of [
  ['after-prepared',null,0,'PREPARED'], ['after-started','1',0,'COMMAND_STARTED'],
  ['after-started-live','1',0,'COMMAND_STARTED'],
  ['before-command-finished','1',0,'COMMAND_STARTED'], ['before-finished','1',1,'COMMAND_FINISHED']
]) {
  test(`process crash ${phase} preserves consumed approval and held recovery`,async t=>{
    const live=phase==='after-started-live';
    const {f,api,input,other}=await setup(t,{live});
    const worker=await startRecoveryWorker(f,input,phase);
    const boundary=await waitBoundary(worker);
    assert.equal(boundary.phase,phase);
    if(live) await crashWorkerWithLiveChild(worker);
    assert.equal(starts(f),wantStarts);
    // The after-started cut holds the runner's onStarted callback until the real
    // foreground child closes; no runner result has returned to Controller yet.
    if(wantStarts!==null && !live) { assert.equal(boundary.child_closed,true); assert.equal(boundary.child_exit_code,0); }
    if(live) assert.equal(boundary.child_closed,false);
    const before=api.status(f.stateRoot),token=readFileSync(join(f.stateRoot,'owner/token'),'utf8');
    assert.equal(before.owner_present,true); assert.equal(before.state.control_epoch,1);
    const last=JSON.parse(readFileSync(join(f.stateRoot,'events.jsonl'),'utf8').trim().split('\n').at(-1));
    assert.equal(last.type,wantLast);
    assert.equal(before.state.attempts['crash-attempt'].status,phase==='after-prepared'?'PREPARED':'RUNNING');
    assert.equal(before.state.attempts['crash-attempt'].command_results.length,wantResults);
    assert.notEqual(before.state.reservation,null);
    await stopWorker(worker);
    assert.equal(api.status(f.stateRoot).status,'OWNER_RECOVERY_REQUIRED');
    assert.equal((await api.recover(f.stateRoot)).status,'OWNER_RECOVERY_REQUIRED');
    assert.equal(readFileSync(join(f.stateRoot,'owner/token'),'utf8'),token);
    if(live) await f.liveControl.fence();
    removeOwnedOwner(worker,token); // Only this closed worker's exact fixture token.
    const recovered=await api.recover(f.stateRoot);
    assert.equal(recovered.status,'RECOVERY_REQUIRED'); assert.equal(recovered.state.recovery_required,true);
    assert.equal(recovered.state.control_epoch,2); assert.notEqual(recovered.state.reservation,null);
    assert.deepEqual(recovered.state.reservation,before.state.reservation);
    assert.equal(recovered.state.attempts['crash-attempt'].command_results.length,wantResults);
    const replay=await api.run(f.stateRoot,input);
    assert.equal(replay.status,'RECOVERY_REQUIRED'); assert.equal(replay.execution_started,false);
    const denied=await api.run(f.stateRoot,other);
    assert.equal(denied.status,'BLOCKED'); assert.equal(denied.reason,'RECOVERY_REQUIRED');
    assert.equal(starts(f),wantStarts);
    const journal=readFileSync(join(f.stateRoot,'events.jsonl'),'utf8');
    await api.recover(f.stateRoot); api.status(f.stateRoot);
    assert.equal(readFileSync(join(f.stateRoot,'events.jsonl'),'utf8'),journal);
  });
}

test('two real Controllers contend under an observed owner, then stale approval stays fenced',async t=>{
  const {f,api,input,other}=await setup(t);
  const winner=await startRecoveryWorker(f,input,'after-started');
  await waitBoundary(winner); // Synchronize on durable ownership plus one real launch, never a sleep race.
  const token=readFileSync(join(f.stateRoot,'owner/token'),'utf8');
  const loser=await startRecoveryWorker(f,other,'none');
  const result=await loser.result;
  assert.equal(result.status,'BLOCKED'); assert.equal(result.reason,'OWNER_RECOVERY_REQUIRED');
  assert.equal(result.execution_started,false); assert.equal(starts(f),'1');
  assert.equal(readFileSync(join(f.stateRoot,'owner/token'),'utf8'),token);
  await stopWorker(winner);
  assert.equal((await api.recover(f.stateRoot)).status,'OWNER_RECOVERY_REQUIRED');
  removeOwnedOwner(winner,token);
  const recovered=await api.recover(f.stateRoot),state=recovered.state;
  assert.equal(state.control_epoch,2); assert.equal(state.recovery_required,true);
  assert.equal(state.approvals['other-attempt'].approval.control_epoch,1);
  const denied=await api.run(f.stateRoot,other);
  assert.equal(denied.status,'BLOCKED'); assert.equal(denied.reason,'RECOVERY_REQUIRED');
  // Exercise the independent epoch gate on a detached copy only. The durable
  // recovery hold is never cleared, and no command is run with this copy.
  assert.throws(()=>checkDispatch({...state,recovery_required:false},other.request,
    state.approvals['other-attempt'].approval),/STALE_CONTROL_EPOCH/);
  assert.equal((await api.run(f.stateRoot,input)).status,'RECOVERY_REQUIRED');
  assert.equal(api.status(f.stateRoot).state.recovery_required,true); assert.equal(starts(f),'1');
});
