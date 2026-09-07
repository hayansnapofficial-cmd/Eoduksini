import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// A fixture-only control channel retained by the test parent survives its
// Controller's death. No production process cleanup API or PID-based kill.
export async function attachLiveChild(f,{lifetime_ms}={}) {
  const token=randomUUID(),slash=String.fromCharCode(92);
  const pipe=process.platform==='win32'?[slash+slash+'.','pipe','eoduksini-test-'+token].join(slash):join(f.root,'child.sock');
  let socket=null,pid=null,closed=false,readyResolve;
  const ready=new Promise(resolve=>{readyResolve=resolve;});
  const server=createServer(connection=>{
    let data='';
    connection.on('error',()=>{});
    connection.on('data',bytes=>{
      data+=bytes.toString('utf8');
      if(!data.endsWith('\n')) return;
      const message=JSON.parse(data);
      if(socket || message.token!==token || !Number.isSafeInteger(message.pid) || message.pid<=0) {connection.destroy();return;}
      socket=connection;pid=message.pid;connection.once('close',()=>{closed=true;});readyResolve();
    });
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(pipe,resolve);});
  const script=join(f.repo,'scripts/fixture-test.mjs');
  writeFileSync(script,readFileSync(script,'utf8')+[
    "import { createConnection } from 'node:net';",
    `const control=createConnection(${JSON.stringify(pipe)});`,
    `control.on('connect',()=>control.write(JSON.stringify({token:${JSON.stringify(token)},pid:process.pid})+'\\n'));`,
    "control.on('data',bytes=>{if(bytes.toString('utf8')==='stop\\n') process.exit(0);});",
    "control.on('error',()=>process.exit(70));",
    ...(lifetime_ms===undefined?[]:[`setTimeout(()=>process.exit(0),${lifetime_ms});`]),''
  ].join('\n'));
  const git=args=>execFileSync('git',args,{cwd:f.repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  git(['add','scripts/fixture-test.mjs']);git(['commit','-m','fixture owned live child control']);
  f.head=git(['rev-parse','HEAD']);f.project.repository.reference_sha=f.head;f.task.base_sha=f.head;
  let fenced=false;
  return {
    ready,get pid(){return pid;},get live(){return socket!==null && !closed;},
    async fence() {
      if(fenced) return;
      assert.ok(socket,'cannot fence an unobserved fixture child');
      if(!closed) socket.write('stop\n');
      const deadline=Date.now()+10000;
      for(;;) {
        let absent=false;
        try {process.kill(pid,0);} catch(error) {if(error.code==='ESRCH') absent=true;else throw error;}
        if(closed && absent) {fenced=true;return;}
        assert.ok(Date.now()<deadline,'fixture child did not exit; preserve fixture for inspection');
        await delay(10);
      }
    },
    async cleanup() {
      if(socket && !fenced) await this.fence();
      await new Promise(resolve=>server.close(resolve));
    }
  };
}
