import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { existsSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const script=fileURLToPath(new URL('./controller-recovery-worker.mjs',import.meta.url));
async function bounded(promise,label) {
  let timer;
  try { return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label)),15000);})]); }
  finally { clearTimeout(timer); }
}
export async function startRecoveryWorker(f,input,phase) {
  const id=input.request.attempt_id,envelope=join(f.root,`${id}-${phase}.json`),boundary=join(f.root,`${id}-${phase}.boundary.json`);
  writeFileSync(envelope,JSON.stringify({stateRoot:f.stateRoot,input,phase,boundary}));
  const child=fork(script,[envelope],{cwd:f.root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  const worker={child,root:f.root,stateRoot:f.stateRoot,boundary,closed:false,output:'',liveControl:f.liveControl};
  f.workers.push(worker);
  child.stdout.on('data',bytes=>{worker.output+=bytes.toString();});
  child.stderr.on('data',bytes=>{worker.output+=bytes.toString();});
  worker.closedPromise=new Promise(resolve=>child.once('close',(code,signal)=>{worker.closed=true;resolve({code,signal});}));
  worker.result=new Promise(resolve=>{
    child.on('message',message=>{if(message.type==='result') resolve(message.result);});
    child.once('error',error=>resolve({worker_error:error.message}));
    child.once('close',()=>resolve({worker_error:worker.output||'closed without result'}));
  });
  const ready=new Promise((resolve,reject)=>{
    child.on('message',message=>{if(message.type==='ready') resolve();});
    child.once('error',reject); child.once('exit',()=>reject(new Error('worker exited before ready: '+worker.output)));
  });
  try { await bounded(ready,'worker ready timeout'); child.send({type:'run'}); }
  catch(error) { await stopWorker(worker); throw error; }
  return worker;
}
export async function waitBoundary(worker) {
  let cancelled=false;
  try {return await bounded((async()=>{
    while(!existsSync(worker.boundary)) {
      if(cancelled) return;
      if(worker.closed) throw new Error('worker closed before boundary: '+worker.output);
      await delay(10);
    }
    // The worker writes then synchronizes a short complete JSON record before parking.
    for(;;) {
      if(cancelled) return;
      try {const value=JSON.parse(readFileSync(worker.boundary,'utf8'));worker.observedBoundary=value;return value;}
      catch(error) {if(!(error instanceof SyntaxError)) throw error;await delay(10);}
    }
  })(),'boundary timeout');} finally {cancelled=true;}
}
export async function stopWorker(worker) {
  if(worker.closed) return;
  if(worker.observedBoundary) {
    if(worker.observedBoundary.phase==='after-started-live') {
      await bounded(worker.liveControl.ready,'live fixture control timeout');
      assert.equal(worker.liveControl.pid,worker.observedBoundary.child_pid);
      await worker.liveControl.fence();
    } else assert.ok(worker.observedBoundary.child_closed || worker.observedBoundary.child_pid===null);
    worker.child.kill('SIGKILL'); // This handle was created here; never use a journal PID.
  } else if(worker.child.connected) worker.child.send({type:'stop'});
  await bounded(worker.closedPromise,'owned worker did not stop; fixture must be preserved');
}
export async function crashWorkerWithLiveChild(worker) {
  assert.equal(worker.observedBoundary.phase,'after-started-live');
  await bounded(worker.liveControl.ready,'live fixture control timeout');
  assert.equal(worker.liveControl.pid,worker.observedBoundary.child_pid);
  assert.equal(worker.liveControl.live,true);
  process.kill(worker.liveControl.pid,0); // Observation only; the proven fixture child is alive at the cut.
  worker.child.kill('SIGKILL');
  await bounded(worker.closedPromise,'Controller crash timeout');
  // Some hosts terminate the child with its parent; others leave it alive.
  // The retained fixture control channel fences survivors in either case.
}
export function removeOwnedOwner(worker,expectedToken) {
  assert.equal(worker.closed,true); assert.ok(worker.observedBoundary);
  assert.equal(worker.stateRoot,join(worker.root,'state'));
  const owner=join(worker.stateRoot,'owner'),token=join(owner,'token');
  assert.equal(expectedToken,worker.observedBoundary.owner_token);
  assert.equal(readFileSync(token,'utf8'),expectedToken);
  unlinkSync(token); rmdirSync(owner); // Nonrecursive, exact fenced fixture owner only.
}
