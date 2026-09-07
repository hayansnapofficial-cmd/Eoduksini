import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, sep } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { makeFixture } from './helpers/controller-fixture.mjs';
import { createController } from '../core/controller/controller.mjs';
import { requestDigest } from '../core/controller/contracts.mjs';

// Removing fresh admission after preparation or at spawn must launch the real
// counter child here. Only the observed clock changes; filesystem work is real.
for(const boundary of ['initial-capacity','command-capacity','intent-sync','evidence-open']) {
  for(const [change,offset,reason] of [
    ['exclusive expiry',60000,'APPROVAL_EXPIRED'],
    ['insufficient deadline',55001,'APPROVAL_DEADLINE_INSUFFICIENT'],
    ['clock rollback',99,'CLOCK_ROLLBACK']
  ]) {
    test(`${change} at ${boundary} prevents launch and preserves consumption`,async t=>{
      const f=makeFixture({startCounter:true});
      const issued=Date.now();let now=issued,observations=0,armed=false;
      const advance=()=>{now=issued+offset;};
      const real={open:fs.openSync,write:fs.writeSync,sync:fs.fsyncSync};
      const intents=new Set();
      const api=createController({now:()=>now,capacity:()=>{
        observations++;
        if((boundary==='initial-capacity' && observations===1) ||
          (boundary==='command-capacity' && observations===2)) advance();
        return {cpuThreads:8,memoryGiB:16,availableMemoryGiB:16};
      }});
      try {
        api.init(f.stateRoot,f.repo,f.project,f.policy);
        const request=api.prepare(f.stateRoot,{attempt_id:'temporal-attempt',task:f.task});
        const input={request,expected_digest:requestDigest(request)};
        assert.equal((await api.approve(f.stateRoot,{...input,approval_id:'approval',ttl_ms:60000})).status,'APPROVED');
        const evidencePrefix=fs.realpathSync.native(join(f.stateRoot,'evidence'))+sep;
        now=issued+100;
        t.mock.method(fs,'openSync',(path,...args)=>{
          const fd=real.open(path,...args);
          if(armed && boundary==='evidence-open' && String(path).startsWith(evidencePrefix)) advance();
          return fd;
        });
        t.mock.method(fs,'writeSync',(fd,bytes,...args)=>{
          if(armed && boundary==='intent-sync') {
            try {if(JSON.parse(bytes.toString()).type==='COMMAND_PREPARED') intents.add(fd);} catch {}
          }
          return real.write(fd,bytes,...args);
        });
        t.mock.method(fs,'fsyncSync',fd=>{
          const result=real.sync(fd);
          if(intents.delete(fd)) advance();
          return result;
        });
        syncBuiltinESMExports();armed=true;
        const result=await api.run(f.stateRoot,input);
        assert.equal(result.status,boundary==='initial-capacity'?'BLOCKED':'RECOVERY_REQUIRED');
        assert.equal(result.reason,reason);assert.equal(result.execution_started,false);
        assert.equal(fs.existsSync(join(f.repo,'fixture-output/starts')),false);
        const state=api.status(f.stateRoot).state;
        if(boundary==='initial-capacity') {
          assert.equal(Object.hasOwn(state.attempts,'temporal-attempt'),false);
          assert.equal(state.reservation,null);
        } else {
          assert.equal(state.attempts['temporal-attempt'].status,'RECOVERY_REQUIRED');
          assert.notEqual(state.reservation,null);assert.equal(state.recovery_required,true);
          const before=fs.readFileSync(join(f.stateRoot,'events.jsonl'),'utf8');
          now=issued+200; // Even a subsequently valid observation cannot replay consumed approval.
          const replay=await api.run(f.stateRoot,input);
          assert.equal(replay.status,'RECOVERY_REQUIRED');assert.equal(replay.execution_started,false);
          assert.equal(fs.readFileSync(join(f.stateRoot,'events.jsonl'),'utf8'),before);
          const next=api.prepare(f.stateRoot,{attempt_id:'next-attempt',task:f.task});
          const denied=await api.run(f.stateRoot,{request:next,expected_digest:requestDigest(next)});
          assert.equal(denied.reason,'RECOVERY_REQUIRED');
          assert.equal(fs.existsSync(join(f.repo,'fixture-output/starts')),false);
        }
      } finally {armed=false;t.mock.restoreAll();syncBuiltinESMExports();f.cleanup();}
    });
  }
}
