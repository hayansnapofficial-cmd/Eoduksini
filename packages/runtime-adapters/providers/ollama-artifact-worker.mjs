import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

// Provider-specific transport stays outside project-neutral Core. The prompt is
// immutable task input; the artifact is created once outside the controlled repo.

const args=process.argv.slice(2);
const option=name=>{const index=args.indexOf(name);if(index<0 || index===args.length-1) throw new Error('INVALID_ARGUMENTS');return args[index+1];};
const endpoint=option('--endpoint'),model=option('--model'),invocation_id=option('--invocation-id'),node_id=option('--node-id');
const promptPath=option('--prompt-file'),artifactPath=option('--artifact-file');
if(args.length!==12 || !isAbsolute(promptPath) || !isAbsolute(artifactPath)) throw new Error('INVALID_ARGUMENTS');
const providerUrl=new URL(endpoint);
if(providerUrl.protocol!=='http:' || providerUrl.hostname!=='127.0.0.1' || providerUrl.username || providerUrl.password ||
  !/^\d{1,5}$/.test(providerUrl.port) || Number(providerUrl.port)>65535 || providerUrl.pathname!=='/' ||
  providerUrl.search || providerUrl.hash || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model) ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(invocation_id) || node_id.length<1 || node_id.length>128 ||
  /[\x00-\x1f]/.test(node_id)) throw new Error('INVALID_ARGUMENTS');

const promptStat=lstatSync(promptPath);
if(!promptStat.isFile() || promptStat.isSymbolicLink() || promptStat.size<=0 || promptStat.size>64*1024 ||
  realpathSync(promptPath)!==resolve(promptPath)) throw new Error('INVALID_PROMPT_FILE');
const prompt=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(readFileSync(promptPath));
if(prompt.charCodeAt(0)===0xfeff || !prompt.trim()) throw new Error('INVALID_PROMPT_FILE');
const artifactParent=dirname(artifactPath),parentStat=lstatSync(artifactParent);
if(!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(artifactParent)!==resolve(artifactParent) || existsSync(artifactPath))
  throw new Error('INVALID_ARTIFACT_PATH');

let modelDigest=null,final=null,missingReason=null,responseText='',artifactCreated=false;
const responseDigest=createHash('sha256');
const base=()=>({invocation_id,provider_kind:'OLLAMA',provider_endpoint_ref:'LOOPBACK_OLLAMA',inference_node_id:node_id,
  model_name:model,model_digest_or_revision:modelDigest??'UNVERIFIED',inference_location:modelDigest?'LOCAL':'UNKNOWN'});
async function boundedText(response,maximum) {
  if(!response.body) throw new Error('PROVIDER_BODY_MISSING');
  const reader=response.body.getReader(),decoder=new TextDecoder();let text='',bytes=0;
  while(true) {const {done,value}=await reader.read();if(done) break;bytes+=value.byteLength;
    if(bytes>maximum) throw new Error('PROVIDER_RESPONSE_LIMIT');text+=decoder.decode(value,{stream:true});}
  return text+decoder.decode();
}
function acceptChunk(chunk) {
  if(final!==null) throw new Error('DATA_AFTER_FINAL_CHUNK');
  if(typeof chunk.thinking==='string' && chunk.thinking.length>0) throw new Error('UNEXPECTED_THINKING_OUTPUT');
  if(typeof chunk.response==='string') {
    responseText+=chunk.response;
    if(Buffer.byteLength(responseText,'utf8')>64*1024) throw new Error('ARTIFACT_RESPONSE_LIMIT');
    responseDigest.update(chunk.response);
  }
  if(chunk.done===true) final=chunk;
}
try {
  const tagsResponse=await fetch(endpoint+'/api/tags',{signal:AbortSignal.timeout(5000)});
  if(!tagsResponse.ok) throw new Error('LOCAL_MODEL_INVENTORY_FAILED');
  const tags=JSON.parse(await boundedText(tagsResponse,1_048_576));
  const installed=Array.isArray(tags?.models)?tags.models.find(item=>item?.name===model):null;
  if(!installed || typeof installed.digest!=='string' || !/^[0-9a-f]{64}$/.test(installed.digest))
    throw new Error('LOCAL_MODEL_NOT_INSTALLED');
  modelDigest=installed.digest;
  const response=await fetch(endpoint+'/api/generate',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({model,prompt,stream:true,think:false,options:{temperature:0,num_predict:2048,seed:20260907}}),
    signal:AbortSignal.timeout(120000)});
  if(!response.ok || !response.body) throw new Error('PROVIDER_HTTP_FAILED');
  const decoder=new TextDecoder(),reader=response.body.getReader();let pending='',bytes=0;
  while(true) {
    const {done,value}=await reader.read();if(done) break;bytes+=value.byteLength;
    if(bytes>2_097_152) throw new Error('PROVIDER_RESPONSE_LIMIT');pending+=decoder.decode(value,{stream:true});
    const lines=pending.split('\n');pending=lines.pop();
    for(const line of lines) {if(line.trim()) acceptChunk(JSON.parse(line));}
  }
  pending+=decoder.decode();if(pending.trim()) acceptChunk(JSON.parse(pending));
  if(final===null) throw new Error('FINAL_USAGE_MISSING');
  if(Object.hasOwn(final,'model') && final.model!==model) throw new Error('FINAL_MODEL_MISMATCH');
  for(const key of ['prompt_eval_count','eval_count','total_duration','load_duration','prompt_eval_duration','eval_duration'])
    if(!Number.isSafeInteger(final[key]) || final[key]<0) throw new Error('FINAL_USAGE_INVALID');
  if(!responseText.trim()) throw new Error('EMPTY_ARTIFACT');
  const fd=openSync(artifactPath,'wx',0o600);
  try {writeSync(fd,responseText,null,'utf8');fsyncSync(fd);if(fstatSync(fd).size!==Buffer.byteLength(responseText,'utf8')) throw new Error('ARTIFACT_WRITE_INCOMPLETE');}
  finally {closeSync(fd);}
  artifactCreated=true;
} catch(error) {
  missingReason=String(error?.message??error).replace(/[^A-Z0-9_]/gi,'_').slice(0,128)||'PROVIDER_FAILED';
  final=null;
  if(artifactCreated || existsSync(artifactPath)) {try {unlinkSync(artifactPath);} catch {missingReason='ARTIFACT_CLEANUP_FAILED';}}
}

const invocation=final?{...base(),prompt_eval_count:final.prompt_eval_count,eval_count:final.eval_count,
  total_duration_ns:String(final.total_duration),load_duration_ns:String(final.load_duration),
  prompt_eval_duration_ns:String(final.prompt_eval_duration),eval_duration_ns:String(final.eval_duration),
  response_complete:true,usage_status:'OBSERVED',usage_missing_reason:null}:
  {...base(),prompt_eval_count:null,eval_count:null,total_duration_ns:null,load_duration_ns:null,prompt_eval_duration_ns:null,
    eval_duration_ns:null,response_complete:false,usage_status:'MISSING',usage_missing_reason:missingReason};
process.stdout.write(JSON.stringify({invocation,response_digest:responseDigest.digest('hex')})+'\n');
if(final===null) process.exitCode=7;
