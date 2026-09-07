import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { init, prepare, approve, run, status, economics, recover, recordReview, recordAdoption, recordCost, recordEnergy } from './controller.mjs';

function json(path) {
  const fd=openSync(path,'r');
  try {
    const stat=fstatSync(fd);
    if(!stat.isFile() || stat.size<=0 || stat.size>256*1024) throw new Error('INVALID_JSON_FILE_SIZE');
    const bytes=Buffer.alloc(stat.size+1);let count=0;
    while(count<bytes.length) {const read=readSync(fd,bytes,count,bytes.length-count,null);if(!read) break;count+=read;}
    if(count!==stat.size || fstatSync(fd).size!==stat.size) throw new Error('JSON_FILE_CHANGED');
    return JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes.subarray(0,count)));
  } finally {closeSync(fd);}
}
export async function controllerMain(args) {
  if(!Array.isArray(args) || args.some(arg=>typeof arg!=='string' || !arg || arg.startsWith('--'))) throw new Error('INVALID_CONTROLLER_ARGUMENTS');
  const [command,...rest]=args;
  let result;
  if(command==='init' && (rest.length===4 || rest.length===5)) result=init(rest[0],rest[1],json(rest[2]),json(rest[3]),rest[4]?json(rest[4]):null);
  else if(command==='prepare' && rest.length===3) result=prepare(rest[0],{task:json(rest[1]),attempt_id:rest[2]});
  else if(command==='approve' && rest.length===5) {
    if(!/^[1-9][0-9]*$/.test(rest[4])) throw new Error('INVALID_APPROVAL_TTL');
    result=await approve(rest[0],{request:json(rest[1]),expected_digest:rest[2],approval_id:rest[3],ttl_ms:Number(rest[4])});
  }
  else if(command==='run' && rest.length===3) result=await run(rest[0],{request:json(rest[1]),expected_digest:rest[2]});
  else if(command==='status' && rest.length===1) result=status(rest[0]);
  else if(command==='economics' && rest.length===1) result=economics(rest[0]);
  else if(command==='recover' && rest.length===1) result=await recover(rest[0]);
  else if(command==='review' && rest.length===2) result=await recordReview(rest[0],json(rest[1]));
  else if(command==='adopt' && rest.length===2) result=await recordAdoption(rest[0],json(rest[1]));
  else if(command==='cost' && rest.length===2) result=await recordCost(rest[0],json(rest[1]));
  else if(command==='energy' && rest.length===2) result=await recordEnergy(rest[0],json(rest[1]));
  else throw new Error('Usage: controller init <state-dir> <repo> <project.json> <policy.json> [harness-revision.json] | prepare <state-dir> <task.json> <attempt-id> | approve <state-dir> <request.json> <request-digest> <approval-id> <ttl-ms> | run <state-dir> <request.json> <request-digest> | review/adopt/cost/energy <state-dir> <event.json> | status/economics/recover <state-dir>');
  if(['BLOCKED','FAILED','MANUAL_DECISION_REQUIRED','RECOVERY_REQUIRED','OWNER_RECOVERY_REQUIRED','JOURNAL_CORRUPT','PREPARED','RUNNING'].includes(result.status)) process.exitCode=2;
  return result;
}
