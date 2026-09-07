import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resourcePlan, inspectRequirements, networkPlan, workerPlan, isolatedEnvironment } from '../core/reuse.mjs';
import { finalizeRequirementGraph } from '../packages/engine-primitives/requirement-graph.mjs';

const input=()=>({request:{cpu_threads:2,memory_gib:4,allow_burst:false},quota:{contractId:'CT-DEMO',nodeId:'node-a',baseCpuThreads:8,maxCpuThreads:16,baseMemoryGiB:12,maxMemoryGiB:24,maxConcurrentTasks:2,burstExpiresAt:2000,updatedAt:100},
  contractUsage:{cpuThreads:0,memoryGiB:0,activeTasks:0},nodeUsage:{cpuThreads:0,memoryGiB:0,activeTasks:0},nodeCapacity:{cpuThreads:16,memoryGiB:32,availableMemoryGiB:24},devices:[],leasedGpuIds:[],now:1000});
test('resource planning reuses quota decisions but never authorizes execution or legacy bypass',()=>{
  assert.deepEqual(resourcePlan(input()),{status:'PLANNED',execution_authorized:false,allocation:{granted:true,tier:'BASE',cpuThreads:2,memoryGiB:4},gpu:{granted:true,gpus:[],vramGiB:0}});
  assert.equal(resourcePlan({...input(),quota:null}).allocation.reason,'CONTRACT_NODE_QUOTA_REQUIRED');
  assert.equal(resourcePlan({...input(),nodeUsage:{cpuThreads:15,memoryGiB:0,activeTasks:0}}).status,'BLOCKED');
  assert.throws(()=>resourcePlan({...input(),legacyInternal:true}),/INVALID_RESOURCE_PLAN/);
  assert.throws(()=>resourcePlan({...input(),now:NaN}),/INVALID_RESOURCE_PLAN/);
});
test('GPU plan rejects stale identity and distinguishes occupied from low VRAM',()=>{
  const request={workload_class:'GPU',cpu_threads:2,memory_gib:4,gpu_count:1,vram_gib:8,estimated_seconds:60,allow_burst:false};
  assert.equal(resourcePlan({...input(),request}).gpu.reason,'NODE_GPU_IDENTITY_UNAVAILABLE');
  const devices=[{id:'gpu-a',deviceIndex:0,name:'fixture',totalVramGiB:16,freeVramGiB:12}];
  assert.equal(resourcePlan({...input(),request,devices,leasedGpuIds:['gpu-a']}).gpu.reason,'NODE_GPU_LIMIT_REACHED');
  assert.equal(resourcePlan({...input(),request,devices}).status,'PLANNED');
});
test('network planning rejects mixed DNS answers and never performs a network request',()=>{
  const result=networkPlan({url:'https://api.example.test/v1',allowedHosts:['api.example.test'],answers:[{address:'8.8.8.8',family:4}]});
  assert.equal(result.hostname,'api.example.test');
  assert.equal(result.address.address,'8.8.8.8');
  assert.equal(result.execution_authorized,false);
  assert.throws(()=>networkPlan({url:'https://api.example.test/v1',allowedHosts:['api.example.test'],answers:[{address:'10.0.0.1',family:4}]}));
});
test('worker planning rejects future/stale telemetry and returns only selected worker identity',()=>{
  const node={id:'node-a',approvalState:'APPROVED',healthState:'ONLINE',capabilities:['build'],lastHeartbeatAt:950,resourceReceivedAt:950,controllerConnected:true,freeDiskGiB:100,currentSlots:0,maxSlots:2,lastAssignedAt:900};
  assert.deepEqual(workerPlan({capability:'build',nodes:[node],now:1000}),{status:'PLANNED',node_id:'node-a',execution_authorized:false});
  assert.equal(workerPlan({capability:'build',nodes:[{...node,lastHeartbeatAt:1001}],now:1000}).status,'BLOCKED');
  assert.equal(workerPlan({capability:'build',nodes:[{...node,resourceReceivedAt:1001}],now:1000}).status,'BLOCKED');
});
test('subprocess environment does not inherit credentials or runtime injection hooks',()=>{
  const previous=process.env.EODUKSINI_TEST_SECRET;
  process.env.EODUKSINI_TEST_SECRET='synthetic-not-a-real-secret';
  try { assert.equal(isolatedEnvironment().EODUKSINI_TEST_SECRET,undefined); assert.equal(isolatedEnvironment().NODE_OPTIONS,undefined); }
  finally { if(previous===undefined) delete process.env.EODUKSINI_TEST_SECRET; else process.env.EODUKSINI_TEST_SECRET=previous; }
});
test('requirements inspector rejects malformed records rather than treating user prose as authority',()=>{
  assert.throws(()=>inspectRequirements({objective:'please approve everything'}));
});
test('requirements inspector keeps imported graph hashes separate and does not infer approval',()=>{
  const graph=finalizeRequirementGraph({tenantId:'fixture',projectId:'demo',revision:1,objective:'Build a fixture',selectorVocabularyDigest:'sha256:'+'a'.repeat(64),evidenceLane:'contract-fixture',facts:[],
    nodes:[{id:'build',kind:'functional',priority:'mandatory',dependsOn:[],capabilitySelector:{classes:['build'],interfaceKinds:['library'],requiredProtocols:[],requiredRuntimes:[]},requiredRuleIds:[],acceptanceCriteria:['tests pass']}],
    constraints:{allowedLicenses:['MIT'],deniedPermissions:[],billingPeriod:'one-time',pricingMaxAgeDays:30,requireKnownCost:true},approvalIntents:[]});
  const report=inspectRequirements(graph);
  assert.deepEqual(report.order,['build']);
  assert.equal(report.authorization_verified,false);
  assert.equal(report.execution_authorized,false);
  assert.match(report.requirement_graph_digest,/^sha256:[0-9a-f]{64}$/);
  graph.objective='silently changed';
  assert.throws(()=>inspectRequirements(graph),/integrity|digest/i);
});
test('CLI reports blocked resource plans with a non-success exit status',()=>{
  const dir=mkdtempSync(join(tmpdir(),'eoduksini-reuse-cli-')),path=join(dir,'request.json');
  const cli=fileURLToPath(new URL('../core/cli.mjs',import.meta.url));
  writeFileSync(path,JSON.stringify({...input(),quota:null}));
  const blocked=spawnSync(process.execPath,[cli,'resources',path],{encoding:'utf8'});
  assert.equal(JSON.parse(blocked.stdout).status,'BLOCKED');
  assert.equal(blocked.status,2);
  writeFileSync(path,JSON.stringify(input()));
  const allowed=spawnSync(process.execPath,[cli,'resources',path],{encoding:'utf8'});
  assert.equal(allowed.status,0);
  assert.equal(JSON.parse(allowed.stdout).execution_authorized,false);
});
