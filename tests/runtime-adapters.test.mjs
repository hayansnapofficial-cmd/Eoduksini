import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGnuTime } from '../packages/runtime-adapters/observability/linux-gnu-time.mjs';
import { raplEnergyDelta, raplSnapshotContract } from '../packages/runtime-adapters/observability/linux-rapl.mjs';
import { ollamaReceiptContract } from '../packages/runtime-adapters/providers/ollama.mjs';

const worker=fileURLToPath(new URL('../packages/runtime-adapters/providers/ollama-worker.mjs',import.meta.url));
const artifactWorker=fileURLToPath(new URL('../packages/runtime-adapters/providers/ollama-artifact-worker.mjs',import.meta.url));

test('GNU time parser preserves CPU seconds and converts KiB peak to bytes',()=>{
  assert.deepEqual(parseGnuTime('EODUKSINI_GNU_TIME_V1\t1.25\t0.50\t2048\n'),
    {cpu_user_seconds:1.25,cpu_system_seconds:0.5,memory_peak_bytes:2097152});
  assert.throws(()=>parseGnuTime('EODUKSINI_GNU_TIME_V1\t1\t2\t3\nextra'),/INVALID_GNU_TIME_EVIDENCE/);
});

test('RAPL package delta handles one counter wrap without claiming whole-node energy',()=>{
  const start={schema_version:1,observed_at:'2026-09-07T01:00:00.000Z',boot_id:'boot-1',zones:[
    {zone_id:'intel-rapl:0',name:'package-0',energy_uj:'900',max_energy_range_uj:'1000'},
    {zone_id:'intel-rapl:1',name:'package-1',energy_uj:'100',max_energy_range_uj:'1000'}]};
  const end={schema_version:1,observed_at:'2026-09-07T01:00:01.000Z',boot_id:'boot-1',zones:[
    {zone_id:'intel-rapl:0',name:'package-0',energy_uj:'100',max_energy_range_uj:'1000'},
    {zone_id:'intel-rapl:1',name:'package-1',energy_uj:'400',max_energy_range_uj:'1000'}]};
  assert.deepEqual(raplSnapshotContract(start),start);
  const delta=raplEnergyDelta(start,end);
  assert.equal(delta.observed_energy_uj,'500');assert.equal(delta.observed_energy_kwh,500/3_600_000_000_000);
  assert.equal(delta.measurement_scope,'COMPONENT_INTERVAL');assert.match(delta.component_note,/excludes GPU/);
  assert.throws(()=>raplEnergyDelta(start,{...end,boot_id:'boot-2'}),/RAPL_SNAPSHOT_MISMATCH/);
});

test('Ollama worker records only the terminal streaming usage chunk',async t=>{
  const server=createServer((request,response)=>{
    if(request.url==='/api/tags') {
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({models:[{name:'fixture-model',digest:'a'.repeat(64)}]}));return;
    }
    assert.equal(request.url,'/api/generate');
    response.writeHead(200,{'content-type':'application/x-ndjson'});
    response.write(JSON.stringify({response:'EODUKSINI_',done:false,prompt_eval_count:999,eval_count:999})+'\n');
    response.end(JSON.stringify({response:'M2_OK',done:true,prompt_eval_count:3,eval_count:4,total_duration:100,
      load_duration:10,prompt_eval_duration:20,eval_duration:70})+'\n');
  });
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  t.after(()=>server.close());
  const port=server.address().port,child=spawn(process.execPath,[worker,'--endpoint',`http://127.0.0.1:${port}`,
    '--model','fixture-model','--invocation-id','INVOCATION-1','--node-id','fixture-node'],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0,stderr);const receipt=ollamaReceiptContract(JSON.parse(stdout));
  assert.equal(receipt.invocation.prompt_eval_count,3);assert.equal(receipt.invocation.eval_count,4);
  assert.equal(receipt.invocation.model_digest_or_revision,'a'.repeat(64));assert.equal(receipt.invocation.inference_location,'LOCAL');
  assert.equal(receipt.invocation.response_complete,true);assert.match(receipt.response_digest,/^[0-9a-f]{64}$/);
});

test('Ollama worker keeps interrupted usage missing instead of reporting zero tokens',async t=>{
  const server=createServer((request,response)=>{
    if(request.url==='/api/tags') {
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({models:[{name:'fixture-model',digest:'b'.repeat(64)}]}));return;
    }
    response.writeHead(200,{'content-type':'application/x-ndjson'});
    response.end(JSON.stringify({response:'partial',done:false,prompt_eval_count:99,eval_count:99})+'\n');
  });
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  t.after(()=>server.close());
  const port=server.address().port,child=spawn(process.execPath,[worker,'--endpoint',`http://127.0.0.1:${port}`,
    '--model','fixture-model','--invocation-id','INVOCATION-2','--node-id','fixture-node'],{stdio:['ignore','pipe','pipe']});
  let stdout='';child.stdout.setEncoding('utf8');child.stdout.on('data',chunk=>stdout+=chunk);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,7);const receipt=ollamaReceiptContract(JSON.parse(stdout));
  assert.equal(receipt.invocation.response_complete,false);assert.equal(receipt.invocation.usage_status,'MISSING');
  assert.equal(receipt.invocation.prompt_eval_count,null);assert.equal(receipt.invocation.eval_count,null);
  assert.equal(receipt.invocation.usage_missing_reason,'FINAL_USAGE_MISSING');
});

test('Ollama artifact worker binds an immutable prompt to a create-once artifact digest',async t=>{
  const root=mkdtempSync(join(tmpdir(),'eoduksini-artifact-worker-')),prompt=join(root,'prompt.md'),artifact=join(root,'artifact.md');
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(prompt,'Produce a bounded audit.\n');
  const server=createServer((request,response)=>{
    if(request.url==='/api/tags') {
      response.writeHead(200,{'content-type':'application/json'});
      response.end(JSON.stringify({models:[{name:'fixture-model',digest:'c'.repeat(64)}]}));return;
    }
    let body='';request.setEncoding('utf8');request.on('data',chunk=>body+=chunk);request.on('end',()=>{
      assert.equal(JSON.parse(body).prompt,'Produce a bounded audit.\n');
      response.writeHead(200,{'content-type':'application/x-ndjson'});
      response.write(JSON.stringify({response:'# Audit\n',done:false})+'\n');
      response.end(JSON.stringify({response:'PASS\n',done:true,prompt_eval_count:5,eval_count:4,total_duration:100,
        load_duration:10,prompt_eval_duration:20,eval_duration:70})+'\n');
    });
  });
  await new Promise((resolve,reject)=>server.listen(0,'127.0.0.1',error=>error?reject(error):resolve()));
  t.after(()=>server.close());
  const port=server.address().port,child=spawn(process.execPath,[artifactWorker,'--endpoint',`http://127.0.0.1:${port}`,
    '--model','fixture-model','--invocation-id','INVOCATION-3','--node-id','fixture-node','--prompt-file',prompt,
    '--artifact-file',artifact],{stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);
  const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  assert.equal(code,0,stderr);const receipt=ollamaReceiptContract(JSON.parse(stdout));
  assert.equal(readFileSync(artifact,'utf8'),'# Audit\nPASS\n');
  assert.equal(receipt.response_digest,createHash('sha256').update(readFileSync(artifact)).digest('hex'));
  assert.equal(receipt.invocation.prompt_eval_count,5);assert.equal(receipt.invocation.eval_count,4);
});
