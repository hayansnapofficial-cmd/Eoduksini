import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { runCommand } from '../../core/controller/runner.mjs';

// TEST ONLY, called serially inside Node's isolated runner-test process. Keep
// real file creation and real child exit/close; fail only the evidence fd.
export async function runWithEvidenceFault(operation,command,options) {
  const original={openSync:fs.openSync,writeSync:fs.writeSync,fsyncSync:fs.fsyncSync,closeSync:fs.closeSync,spawn:childProcess.spawn};
  let evidence;
  fs.openSync=(path,...args)=>{const fd=original.openSync(path,...args);if(path===options.transcript_path) evidence=fd;return fd;};
  fs.writeSync=(fd,...args)=>{
    if(operation==='write' && fd===evidence) throw new Error('injected evidence write failure');
    return original.writeSync(fd,...args);
  };
  fs.fsyncSync=fd=>{
    if(operation==='fsync' && fd===evidence) throw new Error('injected evidence fsync failure');
    return original.fsyncSync(fd);
  };
  fs.closeSync=fd=>{
    const result=original.closeSync(fd); // Dispose the real fd even when reporting an injected close error.
    if(operation==='close' && fd===evidence) throw new Error('injected evidence close failure');
    return result;
  };
  if(operation==='write') childProcess.spawn=(...args)=>{
    const child=original.spawn(...args),buffered=[];let exited=false;
    for(const stream of [child.stdout,child.stderr]) {
      const emit=stream.emit;
      stream.emit=function(event,...eventArgs) {
        if(event==='data' && !exited) {buffered.push(()=>emit.call(this,event,...eventArgs));return true;}
        return emit.call(this,event,...eventArgs);
      };
    }
    // Delay the small fixture's output observation until its native zero exit.
    // This deterministically exercises evidence failure precedence over success
    // without replacing exit/close events or turning the child into a fake.
    child.once('exit',()=>{exited=true;for(const emit of buffered) emit();});
    return child;
  };
  syncBuiltinESMExports();
  try {return await runCommand(command,options);}
  finally {
    for(const key of ['openSync','writeSync','fsyncSync','closeSync']) fs[key]=original[key];
    childProcess.spawn=original.spawn;syncBuiltinESMExports();
  }
}
