import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enroll, claimDispatch, startDispatch, progressDispatch, finishDispatch } from '../agent/node-agent.mjs';

const attempt=id=>({attempt_id:'attempt-123e4567-e89b-42d3-a456-426614174000',dispatch_id:'TASK-1:head',role:'head',node_id:'node-1',
  status:'CLAIMED',event_sequence:id,lease_started_at:1000,lease_expires_at:121000}),envelope={dispatch_id:'TASK-1:head',dispatch_epoch:1,role:'head'};

test('Agent dispatch transport keeps credentials in headers and advances receipt sequence',async()=>{
  const calls=[],server=createServer(async(request,response)=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
    calls.push({path:request.url,authorization:request.headers.authorization,body});let value;
    if(request.url==='/api/agent/enroll')value={agent_credential:'agt_secret',node:{node_id:'node-1',display_name:'Node'}};
    else if(request.url==='/api/agent/tasks/claim')value={envelope,attempt:attempt(0),activation_receipt:'a'.repeat(64)};
    else value={task:{task_id:'TASK-1'},attempt:{...attempt(body.event_sequence),status:request.url.endsWith('/finished')?'SUCCEEDED':'RUNNING'}};
    const bytes=Buffer.from(JSON.stringify(value));response.writeHead(200,{'Content-Type':'application/json','Content-Length':bytes.length});response.end(bytes)});
  await new Promise((accept,reject)=>server.listen(0,'127.0.0.1',accept).once('error',reject));const origin=`http://127.0.0.1:${server.address().port}`,
    parent=mkdtempSync(join(tmpdir(),'eoduksini-agent-dispatch-')),root=join(parent,'agent'),observed='2026-09-09T12:00:00.000Z';
  try{await enroll(origin,root,'enr_token');const claim=await claimDispatch(root,'claim-1'),started=await startDispatch(root,claim,'start-1',observed),
    progressed=await progressDispatch(root,started,'progress-1',observed),finished=await finishDispatch(root,progressed,'finish-1','SUCCEEDED','1'.repeat(64),'2'.repeat(64),observed);
    assert.equal(finished.attempt.status,'SUCCEEDED');assert.deepEqual(calls.slice(1).map(value=>value.path),['/api/agent/tasks/claim',
      '/api/agent/dispatches/TASK-1%3Ahead/started','/api/agent/dispatches/TASK-1%3Ahead/progress','/api/agent/dispatches/TASK-1%3Ahead/finished']);
    assert.equal(calls.slice(1).every(value=>value.authorization==='Bearer agt_secret'),true);
    assert.deepEqual(calls.slice(1).map(value=>value.body.event_sequence??0),[0,1,2,3]);
    assert.equal(JSON.stringify([claim,started,progressed,finished]).includes('agt_secret'),false)
  }finally{await new Promise(resolveClose=>server.close(resolveClose));rmSync(parent,{recursive:true,force:true})}
});
