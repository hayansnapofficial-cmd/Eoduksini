import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs';
import { resultContract } from './contracts.mjs';
import { observedCommandMeasurement } from '../metering.mjs';

const MAX_TIMEOUT_MS=60_000;
const MAX_OUTPUT_BYTES=1_048_576;
const CLOSE_GRACE_MS=1_000;
const EMPTY_DIGEST=createHash('sha256').digest('hex');

const validLimit=(value,maximum)=>Number.isSafeInteger(value) && value>0 && value<=maximum;
const elapsedMilliseconds=started=>Number(process.hrtime.bigint()-started)/1e6;

function baseResult(transcript_path,reason) {
  return resultContract({status:'RECOVERY_REQUIRED',reason,exit_code:null,signal:null,pid:null,
    output_bytes:0,saved_bytes:0,output_digest:EMPTY_DIGEST,transcript_path,close_observed:false});
}

async function executeCommand(command,{environment,timeout_ms,max_output_bytes,transcript_path,onStarted,beforeSpawn,
  node_id='unregistered-node',boot_id=null,command_index=0}) {
  let startedAt=null,startedNs=null,finishedAt=null,finishedNs=null;
  const complete=result=>({result:resultContract(result),measurement:observedCommandMeasurement({command_index,node_id,boot_id,
    started_at:startedAt,started_ns:startedNs,finished_at:finishedAt,finished_ns:finishedNs})});
  let evidence;
  try { evidence=openSync(transcript_path,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY,0o600); }
  catch { return complete(baseResult(transcript_path,'EVIDENCE_CREATE_FAILED')); }

  if(!validLimit(timeout_ms,MAX_TIMEOUT_MS) || !validLimit(max_output_bytes,MAX_OUTPUT_BYTES) || typeof onStarted!=='function') {
    try { fsyncSync(evidence); } catch {}
    try { closeSync(evidence); } catch {}
    return complete(baseResult(transcript_path,'INVALID_RUNNER_OPTIONS'));
  }

  const startedMonotonic=process.hrtime.bigint();
  const outputHash=createHash('sha256');
  let lastWallClock=Date.now();

  return await new Promise(resolve=>{
    let child=null,pid=null,outputBytes=0,savedBytes=0,exitCode=null,signal=null;
    let closeObserved=false,callbackPending=false,recoveryReason=null,finished=false;
    let deadlineTimer=null,graceTimer=null;

    const recordRecovery=reason=>{ if(recoveryReason===null) recoveryReason=reason; };
    const observeWallClock=()=>{
      const observed=Date.now();
      if(observed<lastWallClock) recordRecovery('WALL_CLOCK_ROLLBACK');
      else lastWallClock=observed;
      return observed;
    };
    const terminateDirectChild=()=>{
      if(!child || closeObserved || child.exitCode!==null || child.signalCode!==null) return;
      try { child.kill(); } catch { recordRecovery('CHILD_TERMINATION_FAILED'); }
    };
    const clearTimers=()=>{
      if(deadlineTimer!==null) clearTimeout(deadlineTimer);
      if(graceTimer!==null) clearTimeout(graceTimer);
    };
    const finish=()=>{
      if(finished) return;
      finished=true; clearTimers(); observeWallClock();
      child?.stdout?.removeAllListeners('data'); child?.stderr?.removeAllListeners('data');
      child?.stdout?.destroy(); child?.stderr?.destroy();
      // An uncertain surviving child must not keep the invoking CLI alive after
      // bounded recovery. This releases only a loop reference, never its hold.
      if(!closeObserved) child?.unref();
      try { fsyncSync(evidence); } catch { recordRecovery('EVIDENCE_FAILED'); }
      try { closeSync(evidence); } catch { recordRecovery('EVIDENCE_FAILED'); }

      if(signal!==null) recordRecovery('COMMAND_SIGNALED');
      if(closeObserved && signal===null && exitCode===null) recordRecovery('UNKNOWN_CLOSE');
      const status=recoveryReason!==null?'RECOVERY_REQUIRED':exitCode===0?'SUCCEEDED':'FAILED';
      const reason=recoveryReason??(status==='SUCCEEDED'?'COMMAND_SUCCEEDED':'COMMAND_FAILED');
      resolve(complete({status,reason,exit_code:exitCode,signal,pid,output_bytes:outputBytes,saved_bytes:savedBytes,
        output_digest:outputHash.digest('hex'),transcript_path,close_observed:closeObserved}));
    };
    const startGrace=()=>{
      if(graceTimer!==null || finished) return;
      graceTimer=setTimeout(()=>{
        if(!closeObserved) recordRecovery('CHILD_CLOSE_UNOBSERVED');
        finish();
      },CLOSE_GRACE_MS);
    };
    const requireRecovery=(reason,{terminate=true}={})=>{
      recordRecovery(reason);
      if(terminate) terminateDirectChild();
      startGrace();
    };
    const maybeFinish=()=>{
      if(closeObserved && !callbackPending) finish();
    };
    const handleOutput=chunk=>{
      if(finished) return;
      observeWallClock();
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);
      outputHash.update(bytes); outputBytes+=bytes.length;
      const remaining=Math.max(0,max_output_bytes-savedBytes);
      if(remaining>0) {
        const saved=bytes.subarray(0,remaining);
        try {
          let offset=0;
          while(offset<saved.length) {
            const written=writeSync(evidence,saved,offset,saved.length-offset);
            if(written<=0) throw new Error('evidence write made no progress');
            offset+=written; savedBytes+=written;
          }
        }
        catch { requireRecovery('EVIDENCE_FAILED'); }
      }
      if(outputBytes>max_output_bytes) requireRecovery('OUTPUT_LIMIT_EXCEEDED');
      if(recoveryReason==='WALL_CLOCK_ROLLBACK') requireRecovery('WALL_CLOCK_ROLLBACK');
    };
    const scheduleDeadline=()=>{
      const remaining=timeout_ms-elapsedMilliseconds(startedMonotonic);
      if(remaining<=0) { requireRecovery('COMMAND_TIMED_OUT'); return; }
      deadlineTimer=setTimeout(scheduleDeadline,Math.max(1,Math.ceil(remaining)));
    };

    // Trusted Controller hook only: awaiting here would reopen the admission
    // gap. Refuse Promise-returning callbacks and consume their rejection.
    try {
      if(beforeSpawn!==undefined) {
        if(typeof beforeSpawn!=='function') throw new Error('INVALID_BEFORE_SPAWN_CALLBACK');
        const returned=beforeSpawn();
        if(returned!==undefined) {
          Promise.resolve(returned).catch(()=>{});
          throw new Error('INVALID_BEFORE_SPAWN_CALLBACK');
        }
      }
    } catch(error) {
      recordRecovery(String(error?.message??error).replace(/[\x00-\x1f]/g,' ').slice(0,2000)||'BEFORE_SPAWN_FAILED');
      finish();return;
    }
    try {
      child=spawn(command.executable,command.argv,{
        cwd:command.cwd,env:environment,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']
      });
    } catch {
      recordRecovery('SPAWN_FAILED'); finish(); return;
    }

    child.stdout.on('data',handleOutput); child.stderr.on('data',handleOutput);
    child.once('spawn',()=>{
      startedAt=observeWallClock();startedNs=process.hrtime.bigint().toString();
      pid=Number.isSafeInteger(child.pid) && child.pid>0?child.pid:null;
      callbackPending=true;
      const startedMeasurement=observedCommandMeasurement({command_index,node_id,boot_id,started_at:startedAt,started_ns:startedNs});
      Promise.resolve().then(()=>onStarted(pid,startedMeasurement)).then(()=>{
        callbackPending=false; maybeFinish();
      },()=>{
        callbackPending=false; requireRecovery('ON_STARTED_FAILED'); maybeFinish();
      });
      if(recoveryReason==='WALL_CLOCK_ROLLBACK') requireRecovery('WALL_CLOCK_ROLLBACK');
    });
    child.once('error',()=>{
      observeWallClock(); recordRecovery('SPAWN_FAILED'); startGrace();
    });
    child.once('exit',(code,observedSignal)=>{
      observeWallClock(); exitCode=code; signal=observedSignal;
      if(signal!==null) recordRecovery('COMMAND_SIGNALED');
      if(recoveryReason==='WALL_CLOCK_ROLLBACK') terminateDirectChild();
      startGrace();
    });
    child.once('close',(code,observedSignal)=>{
      finishedAt=observeWallClock();finishedNs=process.hrtime.bigint().toString();
      closeObserved=true; exitCode=code; signal=observedSignal;
      if(graceTimer!==null) { clearTimeout(graceTimer); graceTimer=null; }
      if(signal!==null) recordRecovery('COMMAND_SIGNALED');
      maybeFinish();
    });
    scheduleDeadline();
  });
}

export async function runCommandMetered(command,options) { return executeCommand(command,options); }

export async function runCommand(command,options) { return (await executeCommand(command,options)).result; }
