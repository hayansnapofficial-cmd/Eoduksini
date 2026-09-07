import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resultContract } from '../core/controller/contracts.mjs';
import { runCommand } from '../core/controller/runner.mjs';
import { isolatedEnvironment } from '../core/reuse.mjs';
import { runWithEvidenceFault } from './helpers/controller-evidence-fault.mjs';

const childFixture=fileURLToPath(new URL('./helpers/controller-runner-child.mjs',import.meta.url));
const sha256=value=>createHash('sha256').update(value).digest('hex');

function makeFixture() {
  const root=mkdtempSync(join(tmpdir(),'eoduksini-runner-'));
  const repo=join(root,'repo'); mkdirSync(repo);
  return {root,repo,transcript:name=>join(root,`${name}.out`),cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

const command=(fixture,mode,...args)=>({executable:process.execPath,argv:[childFixture,mode,...args],cwd:fixture.repo});
const options=(fixture,name,overrides={})=>({environment:isolatedEnvironment(),timeout_ms:2_000,max_output_bytes:65_536,
  transcript_path:fixture.transcript(name),onStarted:()=>{},...overrides});

test('successful child returns durable bounded evidence without raw output in the result',async()=>{
  const fixture=makeFixture();
  try {
    let startedPid=null;
    const result=await runCommand(command(fixture,'success'),options(fixture,'success',{onStarted:pid=>{startedPid=pid;}}));
    const transcript=readFileSync(result.transcript_path);
    assert.equal(resultContract(result).status,'SUCCEEDED');
    assert.equal(result.exit_code,0); assert.equal(result.signal,null); assert.equal(result.close_observed,true);
    assert.equal(result.pid,startedPid); assert.equal(result.output_bytes,transcript.length); assert.equal(result.saved_bytes,transcript.length);
    assert.equal(result.output_digest,sha256(transcript));
    assert.equal(transcript.includes(Buffer.from('fixture stdout\n')),true);
    assert.equal(transcript.includes(Buffer.from('fixture stderr\n')),true);
    assert.equal(JSON.stringify(result).includes('fixture stdout'),false);
  } finally { fixture.cleanup(); }
});

test('observed nonzero close is FAILED and preserves its exit code',async()=>{
  const fixture=makeFixture();
  try {
    const result=await runCommand(command(fixture,'nonzero'),options(fixture,'nonzero'));
    assert.equal(result.status,'FAILED'); assert.equal(result.exit_code,23); assert.equal(result.close_observed,true);
  } finally { fixture.cleanup(); }
});

test('silent child timeout uses a bounded termination wait and requires recovery',async()=>{
  const fixture=makeFixture(),realNow=Date.now; let wallSamples=0;
  try {
    Date.now=()=>wallSamples++===0?1_000:1_000_000_000;
    const started=performance.now();
    const result=await runCommand(command(fixture,'silent'),options(fixture,'timeout',{timeout_ms:100}));
    assert.equal(result.status,'RECOVERY_REQUIRED'); assert.equal(result.reason,'COMMAND_TIMED_OUT');
    const elapsed=performance.now()-started;
    assert.ok(elapsed>=75,`wall-clock advance shortened monotonic timeout to ${elapsed}ms`);
    assert.ok(elapsed<2_500); assert.ok(result.pid>0);
  } finally { Date.now=realNow; fixture.cleanup(); }
});

test('output limit cannot turn a noisy child into success',async()=>{
  const fixture=makeFixture();
  try {
    const result=await runCommand(command(fixture,'noisy'),options(fixture,'bounded',{max_output_bytes:1_024}));
    assert.equal(result.status,'RECOVERY_REQUIRED'); assert.equal(result.reason,'OUTPUT_LIMIT_EXCEEDED');
    assert.ok(statSync(result.transcript_path).size<=1_024); assert.equal(result.saved_bytes,statSync(result.transcript_path).size);
    assert.ok(result.output_bytes>1_024); assert.match(result.output_digest,/^[0-9a-f]{64}$/);
    assert.notEqual(result.output_digest,sha256(readFileSync(result.transcript_path)));
  } finally { fixture.cleanup(); }
});

test('missing executable is recovery evidence instead of an unhandled child error',async()=>{
  const fixture=makeFixture();
  try {
    const missing=join(fixture.root,'missing-node-executable');
    const result=await runCommand({executable:missing,argv:[],cwd:fixture.repo},options(fixture,'missing'));
    assert.equal(result.status,'RECOVERY_REQUIRED'); assert.equal(result.reason,'SPAWN_FAILED'); assert.equal(result.pid,null);
    assert.equal(existsSync(result.transcript_path),true); assert.equal(result.output_digest,sha256(Buffer.alloc(0)));
  } finally { fixture.cleanup(); }
});

test('runner passes only the supplied environment and drops inherited injection variables',async()=>{
  const fixture=makeFixture(),savedSecret=process.env.EODUKSINI_RUNNER_SECRET,savedOptions=process.env.NODE_OPTIONS;
  try {
    process.env.EODUKSINI_RUNNER_SECRET='must-not-leak'; process.env.NODE_OPTIONS='--no-warnings';
    const result=await runCommand(command(fixture,'environment'),options(fixture,'environment'));
    assert.equal(result.status,'SUCCEEDED');
    assert.deepEqual(JSON.parse(readFileSync(result.transcript_path,'utf8')),{secret:null,node_options:null});
  } finally {
    if(savedSecret===undefined) delete process.env.EODUKSINI_RUNNER_SECRET; else process.env.EODUKSINI_RUNNER_SECRET=savedSecret;
    if(savedOptions===undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS=savedOptions;
    fixture.cleanup();
  }
});

test('terminal close delay returns bounded unknown-close recovery around a real child',async t=>{
  const fixture=makeFixture(),realSpawn=childProcess.spawn;
  try {
    t.mock.method(childProcess,'spawn',(...args)=>{
      const child=realSpawn(...args),realEmit=child.emit;
      child.emit=function(event,...eventArgs) {
        return event==='close'?true:realEmit.call(this,event,...eventArgs);
      };
      return child;
    });
    syncBuiltinESMExports();
    const started=performance.now();
    const result=await runCommand(command(fixture,'success'),options(fixture,'close-delay'));
    assert.equal(result.status,'RECOVERY_REQUIRED'); assert.equal(result.reason,'CHILD_CLOSE_UNOBSERVED');
    assert.equal(result.close_observed,false); assert.ok(performance.now()-started<2_500);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fixture.cleanup(); }
});

test('failing onStarted callback terminates the owned child and requires recovery',async()=>{
  const fixture=makeFixture();
  try {
    let observedPid=null;
    const result=await runCommand(command(fixture,'silent'),options(fixture,'callback',{onStarted:pid=>{observedPid=pid; throw new Error('journal unavailable');}}));
    assert.equal(result.status,'RECOVERY_REQUIRED'); assert.equal(result.reason,'ON_STARTED_FAILED'); assert.equal(result.pid,observedPid);
  } finally { fixture.cleanup(); }
});

test('a reported signal event around a real child always requires recovery',async t=>{
  const fixture=makeFixture(),realSpawn=childProcess.spawn;
  try {
    t.mock.method(childProcess,'spawn',(...args)=>{
      const child=realSpawn(...args),realEmit=child.emit;
      child.emit=function(event,...eventArgs) {
        return realEmit.call(this,event,...(['exit','close'].includes(event)?[null,'SIGTERM']:eventArgs));
      };
      return child;
    });
    syncBuiltinESMExports();
    const result=await runCommand(command(fixture,'success'),options(fixture,'signal'));
    assert.equal(result.status,'RECOVERY_REQUIRED'); assert.equal(result.reason,'COMMAND_SIGNALED');
    assert.equal(result.exit_code,null); assert.notEqual(result.signal,null); assert.equal(result.close_observed,true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); fixture.cleanup(); }
});

test('native POSIX child signal requires recovery',{
  skip:process.platform==='win32'?'Windows reports external PID termination as exit code 1 without an observed signal':false
},async()=>{
  const fixture=makeFixture();
  try {
    const result=await runCommand(command(fixture,'native-signal'),options(fixture,'native-signal'));
    assert.equal(result.status,'RECOVERY_REQUIRED'); assert.equal(result.reason,'COMMAND_SIGNALED');
    assert.equal(result.exit_code,null); assert.equal(result.signal,'SIGTERM'); assert.equal(result.close_observed,true);
  } finally { fixture.cleanup(); }
});

test('observed wall-clock rollback around a real child requires recovery',async()=>{
  const fixture=makeFixture(),realNow=Date.now; let calls=0;
  try {
    Date.now=()=>calls++===0?2_000:1_000;
    const result=await runCommand(command(fixture,'success'),options(fixture,'rollback'));
    assert.equal(result.status,'RECOVERY_REQUIRED'); assert.equal(result.reason,'WALL_CLOCK_ROLLBACK');
  } finally { Date.now=realNow; fixture.cleanup(); }
});

test('evidence path is created exclusively before a child can start',async()=>{
  const fixture=makeFixture(),transcriptPath=fixture.transcript('existing');
  try {
    writeFileSync(transcriptPath,'operator-owned'); let starts=0;
    const result=await runCommand(command(fixture,'success'),options(fixture,'existing',{onStarted:()=>{starts++;}}));
    assert.equal(result.status,'RECOVERY_REQUIRED'); assert.equal(result.reason,'EVIDENCE_CREATE_FAILED');
    assert.equal(starts,0); assert.equal(readFileSync(transcriptPath,'utf8'),'operator-owned');
  } finally { fixture.cleanup(); }
});

// A callback must refuse launch synchronously, including after evidence setup.
for(const [name,beforeSpawn,reason] of [
  ['synchronous refusal',()=>{throw new Error('APPROVAL_EXPIRED');},'APPROVAL_EXPIRED'],
  ['resolved Promise',()=>Promise.resolve(),'INVALID_BEFORE_SPAWN_CALLBACK'],
  ['rejected Promise',()=>Promise.reject(new Error('late rejection')),'INVALID_BEFORE_SPAWN_CALLBACK']
]) {
  test(`pre-spawn ${name} closes evidence and never launches the real child`,async()=>{
    const fixture=makeFixture(),marker=join(fixture.repo,'started');
    try {
      const result=await runCommand({executable:process.execPath,cwd:fixture.repo,
        argv:['--input-type=module','-e',"import{writeFileSync}from'node:fs';writeFileSync('started','yes');"]},
      options(fixture,'pre-spawn',{beforeSpawn}));
      assert.equal(result.status,'RECOVERY_REQUIRED');assert.equal(result.reason,reason);
      assert.equal(result.pid,null);assert.equal(result.close_observed,false);assert.equal(existsSync(marker),false);
      assert.equal(statSync(result.transcript_path).size,0);
    } finally {fixture.cleanup();}
  });
}

// Catch loss of the evidence-error precedence over an observed zero exit code.
for(const operation of ['write','fsync','close']) {
  test(`injected evidence ${operation} failure cannot mask a real successful child as success`,async()=>{
    const fixture=makeFixture();
    try {
      const result=await runWithEvidenceFault(operation,command(fixture,'success'),options(fixture,operation));
      assert.equal(result.exit_code,0); assert.equal(result.signal,null); assert.equal(result.close_observed,true);
      assert.equal(result.status,'RECOVERY_REQUIRED'); assert.equal(result.reason,'EVIDENCE_FAILED');
      assert.ok(result.pid>0); assert.ok(result.output_bytes>0);
      assert.equal(result.saved_bytes,statSync(result.transcript_path).size);
      assert.equal(result.saved_bytes,operation==='write'?0:result.output_bytes);
    } finally {fixture.cleanup();}
  });
}
