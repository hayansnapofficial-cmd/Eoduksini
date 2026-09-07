// TEST ONLY: narrow builtin interception in an isolated Controller process.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { createController } from '../../core/controller/controller.mjs';
import { runCommand } from '../../core/controller/runner.mjs';

const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const original={write:fs.writeSync,sync:fs.fsyncSync,open:fs.openSync,close:fs.closeSync,spawn:childProcess.spawn};
let ownedChild=null,childClosed=false,childExitCode=null,closePromise;
childProcess.spawn=(...args)=>{
  ownedChild=original.spawn(...args);
  closePromise=new Promise(resolve=>ownedChild.once('close',code=>{childClosed=true;childExitCode=code;resolve();}));
  return ownedChild;
};
function park() {
  const bytes=Buffer.from(JSON.stringify({phase:config.phase,child_pid:ownedChild?.pid??null,
    child_closed:childClosed,child_exit_code:childExitCode,owner_token:fs.readFileSync(join(config.stateRoot,'owner/token'),'utf8')}));
  const fd=original.open(config.boundary,'wx');
  try { original.write(fd,bytes); original.sync(fd); } finally { original.close(fd); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
}
const pending=new Map();
fs.writeSync=(fd,bytes,...rest)=>{
  let event;
  try {event=JSON.parse(Buffer.isBuffer(bytes)?bytes.toString('utf8'):bytes);} catch {}
  if(event?.schema_version===1 && event.seq && event.type) {
    if((config.phase==='before-command-finished' && event.type==='COMMAND_FINISHED') ||
      (config.phase==='before-finished' && event.type==='FINISHED')) park();
    pending.set(fd,event.type);
  }
  return original.write(fd,bytes,...rest);
};
fs.fsyncSync=fd=>{
  const result=original.sync(fd),type=pending.get(fd);pending.delete(fd);
  if(config.phase==='after-prepared' && type==='PREPARED') park();
  return result;
};
syncBuiltinESMExports();
const api=createController({runCommand:async(command,options)=>runCommand(command,{...options,onStarted:async pid=>{
  options.onStarted(pid); // The real Controller performs its durable synchronous append first.
  if(config.phase==='after-started-live') park();
  if(config.phase==='after-started') {await closePromise;park();}
}})});
process.on('message',async message=>{
  if(message.type==='stop') {
    if(ownedChild && !childClosed) {ownedChild.kill();await closePromise;}
    process.exit(0);
  }
  if(message.type==='run') {
    try {const result=await api.run(config.stateRoot,config.input);process.send({type:'result',result},()=>process.disconnect());}
    catch(error) {process.send({type:'result',result:{worker_error:error.stack}},()=>process.disconnect());}
  }
});
process.send({type:'ready'});
