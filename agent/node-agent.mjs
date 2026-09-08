import { cpus, totalmem, platform, arch } from 'node:os';
import { mkdirSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isProviderId } from '../studio/provider-catalog.mjs';

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
const save=(file,value)=>{const existing=lstatSync(file,{throwIfNoEntry:false});if(existing)fail('AGENT_ALREADY_ENROLLED');const temporary=join(dirname(file),`.agent-${randomUUID()}.tmp`);
  writeFileSync(temporary,JSON.stringify(value,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});renameSync(temporary,file)};
const load=file=>{const item=lstatSync(file,{throwIfNoEntry:false});if(!item?.isFile()||item.isSymbolicLink()||item.size>16*1024)fail('INVALID_AGENT_STATE');
  const value=JSON.parse(readFileSync(file,'utf8'));if(!value||Object.keys(value).length!==3||typeof value.agent_credential!=='string'||
    typeof value.node_id!=='string')fail('INVALID_AGENT_STATE');origin(value.origin);return value};

export async function enroll(controlPlane,stateRoot,enrollmentToken=process.env.EODUKSINI_ENROLLMENT_TOKEN){const file=stateFile(stateRoot),base=origin(controlPlane);
  if(typeof enrollmentToken!=='string'||!enrollmentToken.startsWith('enr_'))fail('ENROLLMENT_TOKEN_REQUIRED');const value=await request(base+'/api/agent/enroll',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:enrollmentToken,capabilities:capabilities()})});
  save(file,{origin:base,node_id:value.node.node_id,agent_credential:value.agent_credential});return value.node}
export async function heartbeat(stateRoot){const value=load(stateFile(stateRoot));return (await request(value.origin+'/api/agent/heartbeat',{method:'POST',
  headers:{Authorization:`Bearer ${value.agent_credential}`,'Content-Type':'application/json'},body:JSON.stringify({capabilities:capabilities()})})).node}
export async function run(stateRoot,intervalMs=30_000){if(!Number.isSafeInteger(intervalMs)||intervalMs<10_000||intervalMs>300_000)fail('INVALID_HEARTBEAT_INTERVAL');
  for(;;){const node=await heartbeat(stateRoot);console.log(JSON.stringify({status:'HEARTBEAT_OK',node_id:node.node_id,last_seen_at:node.last_seen_at}));
    await new Promise(resolveWait=>setTimeout(resolveWait,intervalMs))}}

async function main(argv){const [command,...args]=argv;if(command==='enroll'&&args.length===2){const node=await enroll(args[0],args[1]);
    console.log(JSON.stringify({status:'ENROLLED',node_id:node.node_id,display_name:node.display_name}));return}
  if(command==='heartbeat'&&args.length===1){const node=await heartbeat(args[0]);console.log(JSON.stringify({status:'HEARTBEAT_OK',node_id:node.node_id,last_seen_at:node.last_seen_at}));return}
  if(command==='run'&&args.length===1){await run(args[0]);return}fail('USAGE: enroll <origin> <absolute-state-root> | heartbeat <absolute-state-root> | run <absolute-state-root>')}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main(process.argv.slice(2)).catch(error=>{console.error(error.message);process.exitCode=1});
