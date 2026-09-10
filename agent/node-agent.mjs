import { cpus, totalmem, platform, arch } from 'node:os';
import { mkdirSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isProviderId } from '../studio/provider-catalog.mjs';
import { digest as canonicalDigest } from '../core/contracts.mjs';
import { executionPromptDigest, executionReceiptContract } from '../studio/model-execution.mjs';
import { invokeConfiguredModel, ollamaConfig } from './model-runtime.mjs';

const fail=reason=>{throw new Error(reason)};
const origin=value=>{const url=new URL(value);if(url.origin!==value||!['http:','https:'].includes(url.protocol)||
  (url.protocol==='http:'&&!['127.0.0.1','[::1]'].includes(url.hostname)))fail('INVALID_CONTROL_PLANE_ORIGIN');return value};
const stateFile=root=>{if(!isAbsolute(root)||resolve(root)!==root)fail('AGENT_STATE_ROOT_MUST_BE_ABSOLUTE');const parent=lstatSync(dirname(root),{throwIfNoEntry:false});
  if(!parent?.isDirectory()||parent.isSymbolicLink())fail('UNSAFE_AGENT_STATE_PARENT');const current=lstatSync(root,{throwIfNoEntry:false});
  if(current&&!current.isDirectory()||current?.isSymbolicLink())fail('UNSAFE_AGENT_STATE_ROOT');if(!current)mkdirSync(root,{mode:0o700});return join(root,'agent.json')};
const adapters=()=>{const values=(process.env.EODUKSINI_AGENT_ADAPTERS??'').split(',').map(value=>value.trim()).filter(Boolean);
  if(values.length>32||new Set(values).size!==values.length||!values.every(isProviderId))fail('INVALID_AGENT_ADAPTERS');return values};
export const capabilities=()=>({agent_version:'0.1.0',os:platform(),arch:arch(),cpu_logical:cpus().length,memory_bytes:totalmem(),
  gpu_status:'unavailable',gpu_devices:[],adapters:adapters()});
const request=async(url,options)=>{const response=await fetch(url,{...options,signal:AbortSignal.timeout(15_000)}),value=await response.json();
  if(!response.ok)fail(value.code??'CONTROL_PLANE_REQUEST_FAILED');return value};
const safeKey=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const observed=value=>typeof value==='string'&&value.length<=32&&Number.isFinite(Date.parse(value));
const hash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const dispatchContext=value=>{if(!value||typeof value!=='object'||!value.envelope||!value.attempt||typeof value.envelope.dispatch_id!=='string'||
  !Number.isSafeInteger(value.envelope.dispatch_epoch)||typeof value.attempt.attempt_id!=='string'||!Number.isSafeInteger(value.attempt.event_sequence))
  fail('INVALID_DISPATCH_RECEIPT');if(value.envelope.authority?.model_execution===true&&!value.envelope.execution_binding)fail('INVALID_DISPATCH_RECEIPT');return value};
const agentPost=async(stateRoot,path,payload)=>{const value=load(stateFile(stateRoot));return request(value.origin+path,{method:'POST',
  headers:{Authorization:`Bearer ${value.agent_credential}`,'Content-Type':'application/json'},body:JSON.stringify(payload)})};
const withEnvelope=(prior,value)=>({...value,envelope:prior.envelope});
const save=(file,value)=>{const existing=lstatSync(file,{throwIfNoEntry:false});if(existing)fail('AGENT_ALREADY_ENROLLED');const temporary=join(dirname(file),`.agent-${randomUUID()}.tmp`);
  writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});renameSync(temporary,file)};
const load=file=>{const item=lstatSync(file,{throwIfNoEntry:false});if(!item?.isFile()||item.isSymbolicLink()||item.size>16*1024)fail('INVALID_AGENT_STATE');
  const value=JSON.parse(readFileSync(file,'utf8'));if(!value||Object.keys(value).length!==3||typeof value.agent_credential!=='string'||
    typeof value.node_id!=='string')fail('INVALID_AGENT_STATE');origin(value.origin);return value};
const providerFile=root=>{stateFile(root);return join(root,'providers.json')};
const loadProviders=root=>{const file=providerFile(root),item=lstatSync(file,{throwIfNoEntry:false});if(!item)return {schema_version:1,connections:{}};
  if(!item.isFile()||item.isSymbolicLink()||item.size>64*1024)fail('INVALID_PROVIDER_CONFIG');const value=JSON.parse(readFileSync(file,'utf8'));
  if(value?.schema_version!==1||!value.connections||typeof value.connections!=='object'||Array.isArray(value.connections)||Object.keys(value.connections).length>32)
    fail('INVALID_PROVIDER_CONFIG');for(const [id,entry] of Object.entries(value.connections)){if(!entry||Object.keys(entry).length!==5||id!==entry.connection_id||
      !safeKey(id)||entry.provider_id!=='ollama'||entry.adapter_version!=='1'||!hash(entry.config_digest))fail('INVALID_PROVIDER_CONFIG');
    const config=ollamaConfig(entry.endpoint);if(canonicalDigest(config)!==entry.config_digest)fail('INVALID_PROVIDER_CONFIG')}return value};
const saveProviders=(root,value)=>{const file=providerFile(root),temporary=join(root,`.providers-${randomUUID()}.tmp`);
  writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});renameSync(temporary,file)};

export async function enroll(controlPlane,stateRoot,enrollmentToken=process.env.EODUKSINI_ENROLLMENT_TOKEN){const file=stateFile(stateRoot),base=origin(controlPlane);
  if(typeof enrollmentToken!=='string'||!enrollmentToken.startsWith('enr_'))fail('ENROLLMENT_TOKEN_REQUIRED');const value=await request(base+'/api/agent/enroll',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:enrollmentToken,capabilities:capabilities()})});
  save(file,{origin:base,node_id:value.node.node_id,agent_credential:value.agent_credential});return value.node}
export async function heartbeat(stateRoot){const value=load(stateFile(stateRoot));return (await request(value.origin+'/api/agent/heartbeat',{method:'POST',
  headers:{Authorization:`Bearer ${value.agent_credential}`,'Content-Type':'application/json'},body:JSON.stringify({capabilities:capabilities()})})).node}
export async function configureOllama(stateRoot,connectionId,endpoint,idempotencyKey){if(!safeKey(connectionId)||!safeKey(idempotencyKey))fail('INVALID_PROVIDER_CONFIG');
  const config=ollamaConfig(endpoint),config_digest=canonicalDigest(config),providers=loadProviders(stateRoot),existing=providers.connections[connectionId];
  if(existing&&existing.config_digest!==config_digest)fail('PROVIDER_CONFIG_ALREADY_EXISTS');providers.connections[connectionId]={...config,connection_id:connectionId,config_digest};
  if(!existing)saveProviders(stateRoot,providers);const result=await agentPost(stateRoot,`/api/agent/provider-connections/${encodeURIComponent(connectionId)}/ready`,{
    provider_id:'ollama',config_digest,adapter_version:config.adapter_version,idempotency_key:idempotencyKey});return result.connection}
export async function claimDispatch(stateRoot,idempotencyKey){if(!safeKey(idempotencyKey))fail('INVALID_DISPATCH_IDEMPOTENCY_KEY');
  return dispatchContext(await agentPost(stateRoot,'/api/agent/tasks/claim',{idempotency_key:idempotencyKey}))}
export async function startDispatch(stateRoot,receipt,idempotencyKey,observedAt=new Date().toISOString()){receipt=dispatchContext(receipt);
  if(!safeKey(idempotencyKey)||!observed(observedAt))fail('INVALID_DISPATCH_EVENT');const value=await agentPost(stateRoot,
    `/api/agent/dispatches/${encodeURIComponent(receipt.envelope.dispatch_id)}/started`,{attempt_id:receipt.attempt.attempt_id,
      expected_epoch:receipt.envelope.dispatch_epoch,event_sequence:receipt.attempt.event_sequence+1,observed_started_at:observedAt,idempotency_key:idempotencyKey});
  return dispatchContext(withEnvelope(receipt,value))}
export async function progressDispatch(stateRoot,receipt,idempotencyKey,observedAt=new Date().toISOString()){receipt=dispatchContext(receipt);
  if(!safeKey(idempotencyKey)||!observed(observedAt))fail('INVALID_DISPATCH_EVENT');const value=await agentPost(stateRoot,
    `/api/agent/dispatches/${encodeURIComponent(receipt.envelope.dispatch_id)}/progress`,{attempt_id:receipt.attempt.attempt_id,
      expected_epoch:receipt.envelope.dispatch_epoch,event_sequence:receipt.attempt.event_sequence+1,observed_at:observedAt,idempotency_key:idempotencyKey});
  return dispatchContext(withEnvelope(receipt,value))}
export async function finishDispatch(stateRoot,receipt,idempotencyKey,status,resultDigest,evidenceDigest,observedAt=new Date().toISOString(),executionReceipt=null){
  receipt=dispatchContext(receipt);if(!safeKey(idempotencyKey)||!['SUCCEEDED','FAILED'].includes(status)||!hash(resultDigest)||!hash(evidenceDigest)||
    !observed(observedAt))fail('INVALID_DISPATCH_EVENT');const value=await agentPost(stateRoot,
    `/api/agent/dispatches/${encodeURIComponent(receipt.envelope.dispatch_id)}/finished`,{attempt_id:receipt.attempt.attempt_id,
      expected_epoch:receipt.envelope.dispatch_epoch,event_sequence:receipt.attempt.event_sequence+1,status,result_digest:resultDigest,
      evidence_digest:evidenceDigest,observed_finished_at:observedAt,idempotency_key:idempotencyKey,
      ...(executionReceipt===null?{}:{execution_receipt:executionReceipt})});return dispatchContext(withEnvelope(receipt,value))}
export async function executeDispatch(stateRoot,receipt,idempotencyPrefix,providerCall=invokeConfiguredModel){receipt=dispatchContext(receipt);
  if(!safeKey(idempotencyPrefix)||receipt.envelope.authority?.model_execution!==true)fail('MODEL_EXECUTION_NOT_AUTHORIZED');const binding=receipt.envelope.execution_binding,
    local=loadProviders(stateRoot).connections[binding.connection_id];if(!local||local.provider_id!==binding.provider_id||local.config_digest!==binding.config_digest||
      local.adapter_version!==binding.adapter_version)fail('EXECUTION_CONFIG_MISMATCH');const startedAt=new Date().toISOString();
  let current=await startDispatch(stateRoot,receipt,`${idempotencyPrefix}:start`,startedAt),result,status='SUCCEEDED',failure_reason=null;
  try{result=await providerCall({config:local,binding,envelope:receipt.envelope})}catch(error){status='FAILED';failure_reason=String(error?.message??error).replace(/[^A-Z0-9_]/gi,'_').slice(0,128)||'PROVIDER_FAILED';
    result={text:'',input_tokens:null,output_tokens:null,model_revision:null}}
  const finishedAt=new Date().toISOString(),response_digest=createHash('sha256').update(result.text).digest('hex'),execution=executionReceiptContract({schema_version:1,
    organization_id:receipt.envelope.organization_id,task_id:receipt.envelope.task_id,dispatch_id:receipt.envelope.dispatch_id,
    attempt_id:receipt.attempt.attempt_id,dispatch_epoch:receipt.envelope.dispatch_epoch,activation_receipt:receipt.activation_receipt,binding,
    prompt_digest:executionPromptDigest(receipt.envelope),response_digest,model_revision:result.model_revision,status,failure_reason,input_tokens:result.input_tokens,
    output_tokens:result.output_tokens,
    usage_status:status==='SUCCEEDED'?'OBSERVED':'MISSING',started_at:startedAt,finished_at:finishedAt});
  current=await finishDispatch(stateRoot,current,`${idempotencyPrefix}:finish`,status,response_digest,execution.evidence_digest,finishedAt,execution);
  return {status,response_text:status==='SUCCEEDED'?result.text:null,receipt:current}}
export async function executeNextDispatch(stateRoot,idempotencyPrefix,providerCall=invokeConfiguredModel){const receipt=await claimDispatch(stateRoot,`${idempotencyPrefix}:claim`);
  return executeDispatch(stateRoot,receipt,idempotencyPrefix,providerCall)}
export async function run(stateRoot,intervalMs=30_000){if(!Number.isSafeInteger(intervalMs)||intervalMs<10_000||intervalMs>300_000)fail('INVALID_HEARTBEAT_INTERVAL');
  for(;;){const node=await heartbeat(stateRoot);console.log(JSON.stringify({status:'HEARTBEAT_OK',node_id:node.node_id,last_seen_at:node.last_seen_at}));
    await new Promise(resolveWait=>setTimeout(resolveWait,intervalMs))}}

async function main(argv){const [command,...args]=argv;if(command==='enroll'&&args.length===2){const node=await enroll(args[0],args[1]);
    console.log(JSON.stringify({status:'ENROLLED',node_id:node.node_id,display_name:node.display_name}));return}
  if(command==='heartbeat'&&args.length===1){const node=await heartbeat(args[0]);console.log(JSON.stringify({status:'HEARTBEAT_OK',node_id:node.node_id,last_seen_at:node.last_seen_at}));return}
  if(command==='configure-ollama'&&args.length===4){const connection=await configureOllama(args[0],args[1],args[2],args[3]);console.log(JSON.stringify({status:'PROVIDER_READY',
    connection_id:connection.connection_id,provider_id:connection.provider_id,node_id:connection.agent_id}));return}
  if(command==='claim'&&args.length===2){console.log(JSON.stringify(await claimDispatch(args[0],args[1])));return}
  if(command==='execute'&&args.length===2){console.log(JSON.stringify(await executeNextDispatch(args[0],args[1])));return}
  if(command==='run'&&args.length===1){await run(args[0]);return}fail('USAGE: enroll <origin> <absolute-state-root> | heartbeat <absolute-state-root> | configure-ollama <absolute-state-root> <connection-id> <loopback-endpoint> <idempotency-key> | claim <absolute-state-root> <idempotency-key> | execute <absolute-state-root> <idempotency-prefix> | run <absolute-state-root>')}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1});
