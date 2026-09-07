import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture } from './helpers/controller-fixture.mjs';
import { attachLiveChild } from './helpers/controller-live-child.mjs';
import { createController } from '../core/controller/controller.mjs';
import { requestDigest } from '../core/controller/contracts.mjs';

const script=fileURLToPath(new URL('./helpers/controller-bounded-worker.mjs',import.meta.url));
async function bounded(promise,ms,label) {
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),ms);})]);}
  finally {clearTimeout(timer);}
}

// Promise resolution alone misses the referenced ChildProcess handle regression.
test('Controller process exits after bounded recovery while an unclosed child stays held',async t=>{
  const f=makeFixture({startCounter:true});let control,worker,closed;
  try {
    control=await attachLiveChild(f,{lifetime_ms:10000});
    f.policy.limits.timeout_ms=1000;f.policy.resources.memory_gib=0.01;
    const api=createController();api.init(f.stateRoot,f.repo,f.project,f.policy);
    const request=api.prepare(f.stateRoot,{attempt_id:'bounded-attempt',task:f.task});
    const input={request,expected_digest:requestDigest(request)};
    assert.equal((await api.approve(f.stateRoot,{...input,approval_id:'approval',ttl_ms:60000})).status,'APPROVED');
    const envelope=join(f.root,'bounded.json');writeFileSync(envelope,JSON.stringify({stateRoot:f.stateRoot,input}));
    worker=spawn(process.execPath,[script,envelope],{cwd:f.root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',errors='';
    worker.stderr.on('data',bytes=>{errors+=bytes;});
    closed=new Promise(resolve=>worker.once('close',code=>resolve(code)));
    const reported=new Promise(resolve=>worker.stdout.on('data',bytes=>{
      output+=bytes;
      if(output.endsWith('\n')) resolve(JSON.parse(output));
    }));
    await bounded(control.ready,8000,'fixture child control timeout');
    const {result,elapsed_ms}=await bounded(reported,8000,'Controller result timeout');
    assert.equal(result.status,'RECOVERY_REQUIRED');assert.equal(result.command_results[0].close_observed,false);
    assert.equal(result.command_results[0].pid,control.pid);assert.equal(control.live,true);
    const afterResult=performance.now();
    assert.equal(await bounded(closed,1500,'Controller retained its child handle after bounded recovery'),0,errors);
    const exitDelay=performance.now()-afterResult;
    assert.ok(exitDelay<1500);
    t.diagnostic(`Runner/Controller result ${elapsed_ms.toFixed(1)} ms; process exit ${exitDelay.toFixed(1)} ms after result; fixture control live after exit: ${control.live}`);
    const state=api.status(f.stateRoot).state;
    assert.equal(state.recovery_required,true);assert.notEqual(state.reservation,null);
    assert.equal(readFileSync(join(f.repo,'fixture-output/starts'),'utf8'),'1');
    const replay=await api.run(f.stateRoot,input);
    assert.equal(replay.execution_started,false);assert.equal(replay.status,'RECOVERY_REQUIRED');
    assert.equal(readFileSync(join(f.repo,'fixture-output/starts'),'utf8'),'1');
  } finally {
    // Independently request exit over the exact fixture's retained control channel.
    await control?.cleanup();
    if(closed) await bounded(closed,12000,'owned Controller did not exit; preserve fixture');
    f.cleanup();
  }
});
