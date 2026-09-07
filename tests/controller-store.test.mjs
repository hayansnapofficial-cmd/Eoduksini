import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { digest } from '../core/contracts.mjs';
import { policyContract, requestContract, requestDigest } from '../core/controller/contracts.mjs';
import { initialState, reduce } from '../core/controller/state.mjs';
import { initializeStore, readStore, withStore } from '../core/controller/store.mjs';
import { makeFixture, requestFixture } from './helpers/controller-fixture.mjs';

function fixture(t) {
  const f=makeFixture(); t.after(f.cleanup);
  f.policy=policyContract(f.policy);
  f.request=requestContract(requestFixture(f));
  f.approval={approval_id:'APPROVAL-1',request_digest:requestDigest(f.request),issued_at:100,expires_at:60100,control_epoch:1};
  return f;
}
function init(f) { return initializeStore(f.stateRoot,{repo_root:f.repo,project:f.project,policy:f.policy}); }
function approve(s,f) { s.append('APPROVED',{request:f.request,approval:f.approval}); }
function prepare(s,f) { s.append('PREPARED',{attempt_id:'ATTEMPT-1',request_digest:f.approval.request_digest,reservation:{cpuThreads:1,memoryGiB:2,activeTasks:1}}); }
function event(seq,type,payload,control_epoch=1,prev_digest=null) {
  const body={schema_version:1,seq,prev_digest,control_epoch,type,payload}; return {...body,digest:digest(body)};
}
function result(f,status='SUCCEEDED') {
  return {status,reason:status,exit_code:status==='SUCCEEDED'?0:1,signal:null,pid:1234,output_bytes:0,saved_bytes:0,
    output_digest:'e'.repeat(64),transcript_path:join(f.stateRoot,'evidence','ATTEMPT-1','0.bin'),close_observed:true};
}
function finishCommand(s,f,status='SUCCEEDED') {
  s.append('COMMAND_PREPARED',{attempt_id:'ATTEMPT-1',index:0});
  s.append('COMMAND_STARTED',{attempt_id:'ATTEMPT-1',index:0,pid:1234});
  s.append('COMMAND_FINISHED',{attempt_id:'ATTEMPT-1',index:0,result:result(f,status)});
}

test('INIT creates a new private store and read status never changes bytes',t=>{
  const f=fixture(t); assert.equal(initialState(),null); init(f);
  const path=join(f.stateRoot,'events.jsonl'),before=fs.readFileSync(path);
  const read=readStore(f.stateRoot);
  assert.equal(read.seq,1); assert.equal(read.state.control_epoch,1);
  assert.deepEqual(read.state.attempts,{}); assert.deepEqual(read.state.approvals,{});
  assert.equal(read.state.reservation,null); assert.equal(read.state.recovery_required,false);
  assert.equal(read.state.repo_root,fs.realpathSync.native(f.repo)); assert.equal(read.owner_present,false);
  assert.equal(read.bytes,before.length); assert.match(read.last_digest,/^[a-f0-9]{64}$/);
  assert.match(JSON.stringify(read.durability),/process-crash/);
  assert.deepEqual(fs.readFileSync(path),before); assert.throws(()=>init(f),/STATE_EXISTS/);
  if(process.platform!=='win32') { assert.equal(fs.statSync(f.stateRoot).mode&0o777,0o700); assert.equal(fs.statSync(path).mode&0o777,0o600); }
});

test('second writer cannot acquire a live owner lock and status observes owner',async t=>{
  const f=fixture(t); init(f);
  await withStore(f.stateRoot,async()=>{
    assert.equal(readStore(f.stateRoot).owner_present,true);
    await assert.rejects(withStore(f.stateRoot,async()=>assert.fail('second owner')),/OWNER_PRESENT/);
  });
  assert.equal(readStore(f.stateRoot).owner_present,false);
});

test('PREPARED atomically consumes approval and retains reservation across reopening',async t=>{
  const f=fixture(t); init(f);
  await withStore(f.stateRoot,async s=>{
    approve(s,f); prepare(s,f);
    assert.deepEqual(s.state.attempts['ATTEMPT-1'],{request_digest:f.approval.request_digest,status:'PREPARED',next_index:0,active_index:null,command_results:[],reason:null});
    assert.deepEqual(s.state.reservation,{cpuThreads:1,memoryGiB:2,activeTasks:1});
    assert.throws(()=>prepare(s,f),/ATTEMPT|TRANSITION/);
  });
  const read=readStore(f.stateRoot);
  assert.equal(read.state.attempts['ATTEMPT-1'].status,'PREPARED');
  assert.deepEqual(read.state.reservation,{cpuThreads:1,memoryGiB:2,activeTasks:1});
  await withStore(f.stateRoot,async s=>{
    assert.throws(()=>s.append('COMMAND_PREPARED',{attempt_id:'ATTEMPT-1',index:0}),/RECOVERY_REQUIRED/);
    assert.throws(()=>s.append('FINISHED',{attempt_id:'ATTEMPT-1',status:'SUCCEEDED',reason:'forged'}),/RECOVERY_REQUIRED/);
  });
});

test('duplicate approval IDs and attempt IDs and wrong approval binding fail without writes',async t=>{
  const f=fixture(t); init(f);
  await withStore(f.stateRoot,async s=>{
    const bad={...f.approval,request_digest:'f'.repeat(64)};
    assert.throws(()=>s.append('APPROVED',{request:f.request,approval:bad}),/BINDING|DIGEST/);
    approve(s,f); const before=fs.readFileSync(join(f.stateRoot,'events.jsonl'));
    assert.throws(()=>approve(s,f),/DUPLICATE/);
    const request={...f.request,attempt_id:'ATTEMPT-2'},approval={...f.approval,request_digest:requestDigest(request)};
    assert.throws(()=>s.append('APPROVED',{request,approval}),/DUPLICATE/);
    assert.deepEqual(fs.readFileSync(join(f.stateRoot,'events.jsonl')),before);
    assert.throws(()=>s.append('PREPARED',{attempt_id:'ATTEMPT-1',request_digest:f.approval.request_digest,reservation:{cpuThreads:0,memoryGiB:0,activeTasks:1}}),/RESERVATION/);
  });
});

test('command indices advance only after observed success and FINISHED requires every result',async t=>{
  const f=fixture(t); init(f);
  await withStore(f.stateRoot,async s=>{
    approve(s,f); prepare(s,f);
    assert.throws(()=>s.append('FINISHED',{attempt_id:'ATTEMPT-1',status:'SUCCEEDED',reason:'forged'}),/TRANSITION/);
    assert.throws(()=>s.append('COMMAND_PREPARED',{attempt_id:'ATTEMPT-1',index:1}),/TRANSITION/);
    s.append('COMMAND_PREPARED',{attempt_id:'ATTEMPT-1',index:0});
    assert.equal(s.state.attempts['ATTEMPT-1'].active_index,0);
    assert.throws(()=>s.append('COMMAND_PREPARED',{attempt_id:'ATTEMPT-1',index:0}),/TRANSITION/);
    s.append('COMMAND_STARTED',{attempt_id:'ATTEMPT-1',index:0,pid:1234});
    assert.equal(s.state.attempts['ATTEMPT-1'].status,'RUNNING');
    assert.throws(()=>s.append('COMMAND_STARTED',{attempt_id:'ATTEMPT-1',index:0,pid:1234}),/TRANSITION/);
    s.append('COMMAND_FINISHED',{attempt_id:'ATTEMPT-1',index:0,result:result(f)});
    assert.equal(s.state.attempts['ATTEMPT-1'].next_index,1);
    assert.equal(s.state.attempts['ATTEMPT-1'].active_index,null);
    assert.throws(()=>s.append('COMMAND_FINISHED',{attempt_id:'ATTEMPT-1',index:0,result:result(f)}),/TRANSITION/);
    s.append('FINISHED',{attempt_id:'ATTEMPT-1',status:'SUCCEEDED',reason:'all commands verified'});
    assert.equal(s.state.reservation,null);
    assert.throws(()=>s.append('FINISHED',{attempt_id:'ATTEMPT-1',status:'SUCCEEDED',reason:'duplicate'}),/TRANSITION/);
  });
  const read=readStore(f.stateRoot);
  assert.equal(read.state.attempts['ATTEMPT-1'].status,'SUCCEEDED');
  assert.equal(read.seq,7); assert.equal(read.state.recovery_required,false);
});

test('normal nonzero releases reservation but ambiguous result permanently holds it',async t=>{
  for(const status of ['FAILED','RECOVERY_REQUIRED']) {
    const f=fixture(t); init(f);
    await withStore(f.stateRoot,async s=>{
      approve(s,f); prepare(s,f); finishCommand(s,f,status);
      assert.throws(()=>s.append('FINISHED',{attempt_id:'ATTEMPT-1',status:'SUCCEEDED',reason:'forged'}),/TRANSITION/);
      s.append('FINISHED',{attempt_id:'ATTEMPT-1',status,reason:'command outcome'});
      assert.equal(s.state.attempts['ATTEMPT-1'].status,status);
      assert.equal(s.state.recovery_required,status==='RECOVERY_REQUIRED');
      assert.deepEqual(s.state.reservation,status==='FAILED'?null:{cpuThreads:1,memoryGiB:2,activeTasks:1});
      assert.throws(()=>s.append('COMMAND_PREPARED',{attempt_id:'ATTEMPT-1',index:1}),/TRANSITION/);
    });
  }
});

test('RECOVERED holds incomplete attempts once and invalidates previous epochs',async t=>{
  const f=fixture(t); init(f);
  await withStore(f.stateRoot,async s=>{ approve(s,f); prepare(s,f); });
  await withStore(f.stateRoot,async s=>{
    s.append('RECOVERED',{attempt_ids:['ATTEMPT-1'],reason:'interrupted owner'});
    assert.equal(s.state.control_epoch,2); assert.equal(s.state.recovery_required,true);
    assert.equal(s.state.attempts['ATTEMPT-1'].status,'RECOVERY_REQUIRED');
    assert.deepEqual(s.state.reservation,{cpuThreads:1,memoryGiB:2,activeTasks:1});
    assert.throws(()=>s.append('RECOVERED',{attempt_ids:['ATTEMPT-1'],reason:'again'}),/TRANSITION/);
    const e=event(5,'FINISHED',{attempt_id:'ATTEMPT-1',status:'SUCCEEDED',reason:'old epoch'});
    assert.throws(()=>reduce(s.state,e),/EPOCH/);
  });
  assert.equal(readStore(f.stateRoot).state.control_epoch,2);
});

test('partial journal tail fails closed without truncating',t=>{
  const f=fixture(t); init(f); const path=join(f.stateRoot,'events.jsonl');
  fs.appendFileSync(path,'{"seq":'); const before=fs.readFileSync(path);
  assert.throws(()=>readStore(f.stateRoot),/JOURNAL_CORRUPT/); assert.deepEqual(fs.readFileSync(path),before);
});

test('replay rejects empty, missing INIT, hash, sequence, epoch, type, UTF-8, and oversized logs',t=>{
  const f=fixture(t); init(f); const path=join(f.stateRoot,'events.jsonl');
  const original=JSON.parse(fs.readFileSync(path,'utf8'));
  const variations=[Buffer.alloc(0),Buffer.from([0xff,0x0a]),Buffer.from('x'.repeat(16*1024*1024+1))];
  for(const change of [{seq:2},{prev_digest:'a'.repeat(64)},{control_epoch:2},{type:'UNKNOWN'},{type:'FINISHED',payload:{attempt_id:'A',status:'SUCCEEDED',reason:'forged'}},{schema_version:2},{extra:true}]) {
    const body={...original,...change}; delete body.digest; variations.push(Buffer.from(JSON.stringify({...body,digest:digest(body)})+'\n'));
  }
  variations.push(Buffer.from(JSON.stringify({...original,digest:'0'.repeat(64)})+'\n'));
  variations.push(Buffer.from(JSON.stringify({...original,payload:{...original.payload,padding:'x'.repeat(256*1024)}})+'\n'));
  for(const bytes of variations) { fs.writeFileSync(path,bytes); assert.throws(()=>readStore(f.stateRoot),/JOURNAL_CORRUPT/); assert.deepEqual(fs.readFileSync(path),bytes); }
});

test('strict event input rejects getters, prototype keys, invalid Unicode, and unknown fields before effects',async t=>{
  const f=fixture(t); init(f);
  await withStore(f.stateRoot,async s=>{
    let evaluated=false;
    const payload={}; Object.defineProperty(payload,'request',{enumerable:true,get(){ evaluated=true; return f.request; }});
    const before=fs.readFileSync(join(f.stateRoot,'events.jsonl'));
    for(const bad of [payload,JSON.parse('{"__proto__":{}}'),{reason:'\ud800'},{request:f.request,approval:f.approval,extra:true}]) {
      assert.throws(()=>s.append('APPROVED',bad),/INVALID|JSON/);
    }
    assert.equal(evaluated,false); assert.deepEqual(fs.readFileSync(join(f.stateRoot,'events.jsonl')),before);
  });
});

test('state paths reject existing roots, missing parents, nesting, UNC, symlink roots and ancestors',t=>{
  const f=fixture(t);
  for(const stateRoot of [join(f.repo,'state'),f.root,join(f.root,'missing','state'),'\\\\server\\share\\state']) {
    assert.throws(()=>initializeStore(stateRoot,{repo_root:f.repo,project:f.project,policy:f.policy}),/PATH|STATE/);
  }
  const linked=join(f.root,'linked'); fs.symlinkSync(f.repo,linked,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>initializeStore(join(linked,'state'),{repo_root:f.repo,project:f.project,policy:f.policy}),/PATH/);
  assert.throws(()=>initializeStore(f.stateRoot,{repo_root:linked,project:f.project,policy:f.policy}),/PATH/);
  fs.symlinkSync(f.repo,f.stateRoot,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>init(f),/PATH|STATE/); assert.throws(()=>readStore(f.stateRoot),/PATH/);
});

test('journal and evidence symlinks are rejected without touching their targets',async t=>{
  const f=fixture(t); init(f); const path=join(f.stateRoot,'events.jsonl'),target=join(f.root,'target');
  fs.renameSync(path,target);
  // Windows file symlinks require Developer Mode; directory junctions exercise the same lstat rejection everywhere.
  fs.symlinkSync(f.repo,path,process.platform==='win32'?'junction':'dir');
  assert.throws(()=>readStore(f.stateRoot),/PATH|JOURNAL_CORRUPT/);
  fs.rmSync(path); fs.renameSync(target,path);
  await withStore(f.stateRoot,async s=>{
    approve(s,f); prepare(s,f);
    const evidence=join(f.stateRoot,'evidence'); fs.rmdirSync(evidence);
    fs.symlinkSync(f.repo,evidence,process.platform==='win32'?'junction':'dir');
    assert.throws(()=>s.evidencePath('ATTEMPT-1',0),/PATH/);
    assert.throws(()=>s.evidencePath('../escape',0),/INVALID/);
  });
});

test('multi-command attempts preserve strict ordering and cannot skip or repeat a command',async t=>{
  const f=fixture(t);
  f.project.commands.build={argv:['node','scripts/fixture-test.mjs'],cwd:'.'};
  f.policy.commands.build=structuredClone(f.policy.commands.unit); f.policy.limits.max_commands=2;
  f.task.required_tests=['unit','build'];
  const request=requestFixture(f); request.limits.max_commands=2;
  request.commands.push({...request.commands[0],key:'build'});
  f.request=requestContract(request); f.approval.request_digest=requestDigest(f.request); init(f);
  await withStore(f.stateRoot,async s=>{
    approve(s,f); prepare(s,f); finishCommand(s,f);
    assert.throws(()=>s.append('FINISHED',{attempt_id:'ATTEMPT-1',status:'SUCCEEDED',reason:'only first completed'}),/TRANSITION/);
    assert.throws(()=>s.append('COMMAND_PREPARED',{attempt_id:'ATTEMPT-1',index:0}),/TRANSITION/);
    s.append('COMMAND_PREPARED',{attempt_id:'ATTEMPT-1',index:1});
    s.append('COMMAND_STARTED',{attempt_id:'ATTEMPT-1',index:1,pid:1234});
    s.append('COMMAND_FINISHED',{attempt_id:'ATTEMPT-1',index:1,result:{...result(f),transcript_path:join(f.stateRoot,'evidence','ATTEMPT-1','1.bin')}});
    s.append('FINISHED',{attempt_id:'ATTEMPT-1',status:'SUCCEEDED',reason:'both verified'});
    assert.equal(s.state.attempts['ATTEMPT-1'].next_index,2); assert.equal(s.state.reservation,null);
  });
  assert.equal(readStore(f.stateRoot).state.attempts['ATTEMPT-1'].command_results.length,2);
});

test('PREPARED requires 64 KiB headroom and rejects oversize append without modifying journal',async t=>{
  const f=fixture(t); init(f); const path=join(f.stateRoot,'events.jsonl');
  await withStore(f.stateRoot,async s=>approve(s,f));
  // JSON whitespace is hash-neutral: a valid large INIT plus valid approvals fill the real file.
  const original=fs.readFileSync(path,'utf8').trimEnd().split('\n');
  const first=JSON.parse(original[0]),second=JSON.parse(original[1]);
  let previous=second.digest,seq=2;
  const lines=[original[0],original[1]];
  const target=16*1024*1024-65536+1;
  let total=Buffer.byteLength(lines.join('\n')+'\n');
  while(total<target) {
    const request={...f.request,attempt_id:'FILL-'+seq},approval={...f.approval,approval_id:'FILL-'+seq,request_digest:requestDigest(request)};
    const next=event(++seq,'APPROVED',{request,approval},1,previous); previous=next.digest;
    let line=JSON.stringify(next); const remaining=target-total;
    if(remaining>Buffer.byteLength(line)+1) line+=' '.repeat(Math.min(256*1024-Buffer.byteLength(line)-1,remaining-Buffer.byteLength(line)-1));
    lines.push(line); total+=Buffer.byteLength(line)+1;
  }
  assert.equal(first.seq,1); fs.writeFileSync(path,lines.join('\n')+'\n');
  await withStore(f.stateRoot,async s=>{
    const before=fs.readFileSync(path);
    assert.throws(()=>prepare(s,f),/JOURNAL_LIMIT/);
    assert.deepEqual(s.state.attempts,{}); assert.deepEqual(fs.readFileSync(path),before);
  });
});

test('oversize lifecycle append invalidates the active session while PREPARED reservation survives',async t=>{
  const f=fixture(t); init(f);
  await withStore(f.stateRoot,async s=>{
    approve(s,f); prepare(s,f);
    assert.throws(()=>s.append('FINISHED',{attempt_id:'ATTEMPT-1',status:'RECOVERY_REQUIRED',reason:'x'.repeat(256*1024)}),/TOO_LARGE/);
    assert.throws(()=>s.append('COMMAND_PREPARED',{attempt_id:'ATTEMPT-1',index:0}),/SESSION_INVALID/);
  });
  assert.deepEqual(readStore(f.stateRoot).state.reservation,{cpuThreads:1,memoryGiB:2,activeTasks:1});
});

test('replay is independent of LC_ALL disappearance and clock rollback; fresh INIT rejects future locks',async t=>{
  const previousLocale=process.env.LC_ALL,clock=Date.now;
  t.after(()=>{ if(previousLocale===undefined) delete process.env.LC_ALL; else process.env.LC_ALL=previousLocale; Date.now=clock; });
  process.env.LC_ALL='C'; Date.now=()=>10000;
  const f=fixture(t),baseline={git_sha:'a'.repeat(40),harness_revision:1,task_graph_revision:1,migration_head:'none',
    dependency_lock_digest:'b'.repeat(64),api_contract_digest:'c'.repeat(64),policy_digest:'d'.repeat(64),control_epoch:1};
  f.policy.governor_locks=[{lock_id:'LOCK-1',project_id:'demo',owner_role:'HIGH_ASSURANCE_GOVERNOR',provider_binding:'provider-a',
    baseline,baseline_digest:digest(baseline),scope:structuredClone(f.policy.commands.unit.scope),issued_at:9000,expires_at:20000,
    heartbeat_interval_ms:5000,last_heartbeat_at:9500,status:'GOVERNOR_LOCKED'}];
  f.request.policy_digest=digest(f.policy); f.request.environment.LC_ALL='C'; f.approval.request_digest=requestDigest(f.request);
  init(f); await withStore(f.stateRoot,async s=>approve(s,f));
  delete process.env.LC_ALL; Date.now=()=>100;
  assert.equal(readStore(f.stateRoot).state.approvals['ATTEMPT-1'].request.environment.LC_ALL,'C');
  assert.throws(()=>initializeStore(join(f.root,'future-state'),{repo_root:f.repo,project:f.project,policy:f.policy}),/INVALID_GOVERNOR_LOCK/);
  assert.equal(fs.existsSync(join(f.root,'future-state')),false);
});

test('reserved object-key identifiers cannot poison approval replay',async t=>{
  const f=fixture(t); init(f);
  await withStore(f.stateRoot,async s=>{
    const request={...f.request,attempt_id:'constructor'},approval={...f.approval,request_digest:requestDigest(request)};
    assert.throws(()=>s.append('APPROVED',{request,approval}),/INVALID/);
    assert.deepEqual(s.state.approvals,{});
  });
  assert.equal(readStore(f.stateRoot).seq,1);
});

test('replay rejects a validly hashed terminal success forged before command results',async t=>{
  const f=fixture(t); init(f);
  await withStore(f.stateRoot,async s=>{ approve(s,f); prepare(s,f); });
  const read=readStore(f.stateRoot),path=join(f.stateRoot,'events.jsonl');
  fs.appendFileSync(path,JSON.stringify(event(4,'FINISHED',{attempt_id:'ATTEMPT-1',status:'SUCCEEDED',reason:'forged'},1,read.last_digest))+'\n');
  assert.throws(()=>readStore(f.stateRoot),/JOURNAL_CORRUPT/);
});

test('owner token changes invalidate append and never delete replacement owner',async t=>{
  const f=fixture(t); init(f); const tokenPath=join(f.stateRoot,'owner','token');
  await assert.rejects(withStore(f.stateRoot,async s=>{
    fs.writeFileSync(tokenPath,'replacement');
    assert.throws(()=>approve(s,f),/OWNER_LOST/);
  }),/OWNER_LOST/);
  assert.equal(fs.readFileSync(tokenPath,'utf8'),'replacement');
  await assert.rejects(withStore(f.stateRoot,async()=>{}),/OWNER_PRESENT/);
});

test('owner token creation failure retains owner directory for manual recovery',async t=>{
  const f=fixture(t); init(f); const original=fs.openSync;
  fs.openSync=(path,...args)=>{ if(String(path).endsWith(join('owner','token'))) throw new Error('injected owner create failure'); return original(path,...args); };
  syncBuiltinESMExports();
  try { await assert.rejects(withStore(f.stateRoot,async()=>assert.fail('unowned callback')),/injected owner create failure/); }
  finally { fs.openSync=original; syncBuiltinESMExports(); }
  assert.equal(readStore(f.stateRoot).owner_present,true);
  await assert.rejects(withStore(f.stateRoot,async()=>{}),/OWNER_PRESENT/);
});

test('partial append or failed fsync invalidates session and does not publish candidate state',async t=>{
  for(const failure of ['partial','sync','zero']) {
    const f=fixture(t); init(f);
    await withStore(f.stateRoot,async s=>{
      approve(s,f); const write=fs.writeSync,sync=fs.fsyncSync; let calls=0;
      if(failure==='sync') fs.fsyncSync=()=>{ throw new Error('injected sync failure'); };
      else fs.writeSync=(fd,bytes,offset,length,...rest)=>{
        if(failure==='zero') return 0;
        if(calls++===0) return write(fd,bytes,offset,Math.min(7,length),...rest);
        throw new Error('injected partial failure');
      };
      syncBuiltinESMExports();
      try { assert.throws(()=>prepare(s,f),/WRITE|injected/); }
      finally { fs.writeSync=write; fs.fsyncSync=sync; syncBuiltinESMExports(); }
      assert.deepEqual(s.state.attempts,{}); assert.equal(s.state.reservation,null);
      assert.throws(()=>prepare(s,f),/SESSION_INVALID/);
    });
    if(failure==='partial') assert.throws(()=>readStore(f.stateRoot),/JOURNAL_CORRUPT/);
    if(failure==='sync') assert.equal(readStore(f.stateRoot).state.attempts['ATTEMPT-1'].status,'PREPARED');
  }
});

test('published state is detached and closed sessions cannot append or create evidence',async t=>{
  const f=fixture(t); init(f); let saved;
  await withStore(f.stateRoot,async s=>{
    saved=s; approve(s,f); const snapshot=s.state; snapshot.control_epoch=50;
    assert.equal(s.state.control_epoch,1); prepare(s,f);
    const path=s.evidencePath('ATTEMPT-1',0); assert.equal(path,join(fs.realpathSync.native(f.stateRoot),'evidence','ATTEMPT-1','0.bin'));
    assert.throws(()=>s.evidencePath('ATTEMPT-2',0),/ATTEMPT|INVALID/);
    assert.throws(()=>s.evidencePath('ATTEMPT-1',16),/INVALID/);
  });
  assert.throws(()=>saved.append('RECOVERED',{attempt_ids:['ATTEMPT-1'],reason:'late'}),/SESSION_INVALID/);
  assert.throws(()=>saved.evidencePath('ATTEMPT-1',0),/SESSION_INVALID/);
});
