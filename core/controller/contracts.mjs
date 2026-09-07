import { isAbsolute, resolve } from 'node:path';
import { canonical, digest, projectContract, bindTask, bindTaskV2, harnessRevisionContract, overlayTaskV1, safePath } from '../contracts.mjs';
import { baselineContract, scope } from '../governor.mjs';
import { normalizeResourceQuota, normalizeResourceRequest } from '../reuse.mjs';
import { semanticFootprintContract } from '../semantic.mjs';

const MAX_JSON_BYTES=256*1024;
const HASH=/^[0-9a-f]{64}$/;
const GIT_SHA=/^[0-9a-f]{40}$/;
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMAND_KEY=/^[a-z][a-z0-9_-]*$/;
const SCOPE_FIELDS=['write_paths','symbols','api_routes','request_contracts','response_contracts','database_objects','migration_objects','rls_policies','environment_keys','generated_types','runtime_services'];

function check(condition,reason) { if(!condition) throw new Error(reason); }
const positive=value=>Number.isSafeInteger(value) && value>0;
const nonnegative=value=>Number.isSafeInteger(value) && value>=0;
const identifier=value=>typeof value==='string' && ID.test(value);
const hash=value=>typeof value==='string' && HASH.test(value);
const text=value=>typeof value==='string' && value.length>0 && !/[\x00-\x1f]/.test(value);
const same=(left,right)=>canonical(left)===canonical(right);

function validUnicode(value) {
  for(let index=0;index<value.length;index++) {
    const code=value.charCodeAt(index);
    if(code>=0xd800 && code<=0xdbff) {
      const next=value.charCodeAt(++index);
      if(!(next>=0xdc00 && next<=0xdfff)) return false;
    } else if(code>=0xdc00 && code<=0xdfff) return false;
  }
  return true;
}

function inspectJson(value,seen) {
  if(value===null || typeof value==='boolean') return;
  if(typeof value==='string') { check(validUnicode(value),'INVALID_JSON_INPUT'); return; }
  if(typeof value==='number') { check(Number.isFinite(value),'INVALID_JSON_INPUT'); return; }
  check(typeof value==='object','INVALID_JSON_INPUT');
  check(!seen.has(value),'INVALID_JSON_INPUT'); seen.add(value);
  const array=Array.isArray(value);
  check(Object.getPrototypeOf(value)===(array?Array.prototype:Object.prototype),'INVALID_JSON_INPUT');
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  check(keys.every(key=>typeof key==='string'),'INVALID_JSON_INPUT');
  if(array) {
    check(keys.length===value.length+1 && keys.includes('length'),'INVALID_JSON_INPUT');
    for(let index=0;index<value.length;index++) check(Object.hasOwn(descriptors,String(index)),'INVALID_JSON_INPUT');
  }
  for(const key of keys) {
    if(array && key==='length') continue;
    check(validUnicode(key) && !['__proto__','prototype','constructor'].includes(key),'INVALID_JSON_INPUT');
    const descriptor=descriptors[key];
    check(Object.hasOwn(descriptor,'value') && descriptor.enumerable===true,'INVALID_JSON_INPUT');
    inspectJson(descriptor.value,seen);
  }
  seen.delete(value);
}

function publicJson(value) {
  inspectJson(value,new Set());
  check(Buffer.byteLength(canonical(value),'utf8')<=MAX_JSON_BYTES,'JSON_INPUT_TOO_LARGE');
}

function exact(value,keys,reason) {
  check(value!==null && typeof value==='object' && !Array.isArray(value) &&
    Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key)),reason);
}

function resourceContract(value,reason) {
  exact(value,['cpu_threads','memory_gib','allow_burst'],reason);
  let normalized;
  try { normalized=normalizeResourceRequest(value); } catch { throw new Error(reason); }
  check(normalized.workloadClass==='LIGHT' && normalized.gpuCount===0 && normalized.vramGiB===0 && normalized.allowBurst===false,reason);
  return structuredClone(value);
}

function limitsContract(value,reason) {
  exact(value,['timeout_ms','max_output_bytes','max_commands','approval_ttl_ms'],reason);
  check(positive(value.timeout_ms) && value.timeout_ms<=60_000 &&
    positive(value.max_output_bytes) && value.max_output_bytes<=1_048_576 &&
    positive(value.max_commands) && value.max_commands<=16 &&
    positive(value.approval_ttl_ms) && value.approval_ttl_ms<=3_600_000,reason);
  return structuredClone(value);
}

function normalizedScope(value,reason) {
  try { return scope(value); } catch { throw new Error(reason); }
}

function exactNormalizedScope(value,reason) {
  exact(value,SCOPE_FIELDS,reason);
  const normalized=normalizedScope(value,reason);
  check(same(normalized,value),reason);
  return normalized;
}

function snapshotContract(value,project,reason) {
  exact(value,['schema_version','project_id','adapter_digest','head','hashes'],reason);
  check(value.schema_version===1 && value.project_id===project.project_id && hash(value.adapter_digest) && GIT_SHA.test(value.head),reason);
  check(value.hashes && typeof value.hashes==='object' && !Array.isArray(value.hashes),reason);
  const paths=Object.keys(value.hashes);
  check(paths.length===project.watch_paths.length && project.watch_paths.every(path=>Object.hasOwn(value.hashes,path)),reason);
  for(const path of paths) {
    try { safePath(path); } catch { throw new Error(reason); }
    check(value.hashes[path]===null || hash(value.hashes[path]),reason);
  }
  return structuredClone(value);
}

export function scopeForPlatform(value,platform=process.platform) {
  publicJson(value);
  const normalized=scope(value);
  return scope({...normalized,write_paths:normalized.write_paths.map(path=>platform==='win32'?path.toLowerCase():path)});
}

function governorLockContract(value,fresh) {
  publicJson(value);
  const baseKeys=['lock_id','project_id','owner_role','provider_binding','baseline','baseline_digest','scope','issued_at','expires_at','heartbeat_interval_ms','last_heartbeat_at','status'];
  const unlocked=value?.status==='UNLOCKED';
  exact(value,unlocked?[...baseKeys,'decision_digest','verification_digest']:baseKeys,'INVALID_GOVERNOR_LOCK');
  check(identifier(value.lock_id) && identifier(value.project_id) && identifier(value.provider_binding) &&
    value.owner_role==='HIGH_ASSURANCE_GOVERNOR' && ['GOVERNOR_LOCKED','LOCK_RECOVERY','UNLOCKED'].includes(value.status),
  'INVALID_GOVERNOR_LOCK');
  let baseline;
  try { baseline=baselineContract(value.baseline); } catch { throw new Error('INVALID_GOVERNOR_LOCK'); }
  check(hash(value.baseline_digest) && value.baseline_digest===digest(baseline),'GOVERNOR_BASELINE_MISMATCH');
  const lockedScope=exactNormalizedScope(value.scope,'INVALID_GOVERNOR_LOCK');
  check(nonnegative(value.issued_at) && positive(value.expires_at) && positive(value.heartbeat_interval_ms) &&
    nonnegative(value.last_heartbeat_at) && value.issued_at<value.expires_at &&
    value.heartbeat_interval_ms<=(value.expires_at-value.issued_at) &&
    value.last_heartbeat_at>=value.issued_at && value.last_heartbeat_at<=value.expires_at,'INVALID_GOVERNOR_LOCK');
  if(fresh) {
    const now=Date.now();
    check(value.issued_at<=now && value.last_heartbeat_at<=now,'INVALID_GOVERNOR_LOCK');
  }
  if(unlocked) check(hash(value.decision_digest) && hash(value.verification_digest),'INVALID_GOVERNOR_LOCK');
  return structuredClone({...value,baseline,scope:lockedScope});
}

export function validateGovernorLock(value) { return governorLockContract(value,true); }

function validatePolicy(value,fresh) {
  publicJson(value);
  const hasRouting=Object.hasOwn(value??{},'routing');
  const hasPostRun=Object.hasOwn(value??{},'post_run_authority');
  exact(value,['schema_version','commands','quota','resources','limits','governor_locks',...(hasRouting?['routing']:[]),
    ...(hasPostRun?['post_run_authority']:[])],'INVALID_POLICY');
  check(value.schema_version===1 && value.commands && typeof value.commands==='object' && !Array.isArray(value.commands),'INVALID_POLICY');
  const commandNames=Object.keys(value.commands);
  check(commandNames.length>0 && commandNames.every(name=>COMMAND_KEY.test(name)),'INVALID_POLICY');
  const commands={};
  for(const name of commandNames) {
    const command=value.commands[name]; exact(command,['executable','prefix_argv','scope'],'INVALID_POLICY');
    check(typeof command.executable==='string' && isAbsolute(command.executable) && Array.isArray(command.prefix_argv) &&
      command.prefix_argv.every(text),'INVALID_POLICY');
    commands[name]={executable:command.executable,prefix_argv:[...command.prefix_argv],scope:exactNormalizedScope(command.scope,'INVALID_POLICY')};
  }
  let quota; try { quota=normalizeResourceQuota(value.quota); } catch { throw new Error('INVALID_POLICY_QUOTA'); }
  const resources=resourceContract(value.resources,'INVALID_POLICY');
  const limits=limitsContract(value.limits,'INVALID_POLICY');
  let routing;
  if(hasRouting) {
    routing=value.routing;
    exact(routing,['reason_code','chosen_provider_kind','decision_source'],'INVALID_POLICY');
    check(['LOCAL_COST_POLICY','CLOUD_UNAVAILABLE','PRIVACY_RESTRICTED','PRESERVE_SUBSCRIPTION_CAPACITY',
      'VERIFIED_LOCAL_CAPABILITY','DETERMINISTIC_TOOL_PREFERRED','USER_PINNED','PILOT_EXPERIMENT','RESOURCE_AVAILABLE']
      .includes(routing.reason_code) && identifier(routing.chosen_provider_kind) && identifier(routing.decision_source),
    'INVALID_POLICY');
    routing=structuredClone(routing);
  }
  let post_run_authority;
  if(hasPostRun) {
    post_run_authority=value.post_run_authority;
    exact(post_run_authority,['reviewer_ids','adoption_actor_ids','price_basis_ids','energy_source_ids','tariff_basis_ids'],
      'INVALID_POLICY');
    for(const key of ['reviewer_ids','adoption_actor_ids','price_basis_ids','energy_source_ids','tariff_basis_ids']) {
      const values=post_run_authority[key];
      check(Array.isArray(values) && values.every(identifier) && new Set(values).size===values.length,'INVALID_POLICY');
    }
    post_run_authority=structuredClone(post_run_authority);
  }
  check(Array.isArray(value.governor_locks),'INVALID_POLICY');
  const governor_locks=value.governor_locks.map(lock=>governorLockContract(lock,fresh));
  check(new Set(governor_locks.map(lock=>lock.lock_id)).size===governor_locks.length,'INVALID_POLICY');
  return {schema_version:1,commands,quota,resources,limits,governor_locks,...(routing?{routing}: {}),
    ...(post_run_authority?{post_run_authority}:{})};
}

export function policyContract(value) { return validatePolicy(value,true); }

// Journal replay checks immutable structure; admission still uses policyContract above.
export function replayPolicyContract(value) { return validatePolicy(value,false); }

export function localTask(task,project,harnessRevision=null) {
  publicJson(task); publicJson(project);
  let bound;
  if(harnessRevision!==null) {
    const revision=harnessRevisionContract(harnessRevision);
    check(revision.activation_profile==='FOUNDATION_NOW','UNSUPPORTED_ACTIVATION_PROFILE');
    bound=task?.schema_version===2?bindTaskV2(task,project,revision):
      bindTaskV2(overlayTaskV1(task,project,revision),project,revision);
  } else {
    check(task?.schema_version!==2,'HARNESS_REVISION_REQUIRED');
    bound=bindTask(task,project);
  }
  const normalized=bound.task;
  check(normalized.data_risk==='LOW' && normalized.schema_change===false &&
    (normalized.release_impact===undefined || normalized.release_impact==='NONE') &&
    (!normalized.dependencies || normalized.dependencies.length===0) && (!normalized.failure_tests || normalized.failure_tests.length===0) &&
    (!normalized.shared_file_leases || normalized.shared_file_leases.length===0),'UNSUPPORTED_LOCAL_TASK');
  check(new Set(normalized.required_tests).size===normalized.required_tests.length,'DUPLICATE_REQUIRED_TEST');
  return structuredClone(bound);
}

function commandContract(command,key,projectCommand,repoRoot,reason) {
  exact(command,['key','declared_argv','executable','executable_digest','argv','cwd'],reason);
  check(Array.isArray(command.declared_argv) && command.declared_argv.every(text) &&
    typeof command.executable==='string' && isAbsolute(command.executable) && hash(command.executable_digest) &&
    Array.isArray(command.argv) && command.argv.every(text) && typeof command.cwd==='string' && isAbsolute(command.cwd),'INVALID_REQUEST');
  check(command.key===key && same(command.declared_argv,projectCommand.argv) &&
    command.argv.length>=command.declared_argv.length-1 &&
    same(command.argv.slice(command.argv.length-(command.declared_argv.length-1)),command.declared_argv.slice(1)) &&
    command.cwd===resolve(repoRoot,projectCommand.cwd),reason);
  return structuredClone(command);
}

export function requestContract(value) {
  publicJson(value);
  const v2=value?.schema_version===2;
  const hasSemantic=Object.hasOwn(value??{},'semantic_footprint');
  exact(value,[...['schema_version','attempt_id','repo_root','project_id','project','task','baseline','policy_digest','control_epoch','commands','scope',
    ...(hasSemantic?['semantic_footprint']:[]),'resources','limits','environment'],...(v2?['harness_revision']:[])],'INVALID_REQUEST');
  check((value.schema_version===1 || v2) && identifier(value.attempt_id) && typeof value.repo_root==='string' && isAbsolute(value.repo_root) &&
    identifier(value.project_id) && hash(value.policy_digest) && positive(value.control_epoch),'INVALID_REQUEST');
  let project; try { project=projectContract(value.project); } catch { throw new Error('INVALID_REQUEST'); }
  check(value.project_id===project.project_id,'REQUEST_PROJECT_MISMATCH');
  let revision=null,bound;
  try {
    if(v2) {
      revision=harnessRevisionContract(value.harness_revision);
      check(revision.project_id===project.project_id && revision.policy_digest===value.policy_digest,'REQUEST_HARNESS_MISMATCH');
      check(value.task?.schema_version===2,'INVALID_REQUEST');
    }
    bound=localTask(value.task,project,revision);
  } catch(error) { if(/UNSUPPORTED|DUPLICATE|UNDECLARED|HARNESS|TASK_V2|STALE/.test(error.message)) throw error; throw new Error('INVALID_REQUEST'); }
  const baseline=snapshotContract(value.baseline,project,'INVALID_REQUEST');
  check(baseline.adapter_digest===bound.adapter_digest && baseline.head===bound.task.base_sha,'REQUEST_BASELINE_MISMATCH');
  check(Array.isArray(value.commands) && value.commands.length===bound.task.required_tests.length,'REQUEST_COMMAND_MISMATCH');
  const commands=value.commands.map((command,index)=>commandContract(command,bound.task.required_tests[index],project.commands[bound.task.required_tests[index]],value.repo_root,'REQUEST_COMMAND_MISMATCH'));
  const limits=limitsContract(value.limits,'INVALID_REQUEST');
  check(commands.length<=limits.max_commands,'INVALID_REQUEST');
  const resources=resourceContract(value.resources,'INVALID_REQUEST');
  const requestedScope=exactNormalizedScope(value.scope,'INVALID_REQUEST');
  let semantic_footprint;
  if(hasSemantic) {
    try { semantic_footprint=semanticFootprintContract(value.semantic_footprint); }
    catch { throw new Error('INVALID_REQUEST'); }
  }
  check(value.environment && typeof value.environment==='object' && !Array.isArray(value.environment),'INVALID_REQUEST');
  // The vocabulary is stable across hosts/restarts; dispatch gates bind current values.
  const allowedEnvironment=new Set(['PATH','LANG','LC_ALL','LC_CTYPE','ComSpec','SystemRoot','PATHEXT']);
  check(Object.keys(value.environment).every(key=>allowedEnvironment.has(key) && typeof value.environment[key]==='string'),'INVALID_REQUEST');
  return {schema_version:value.schema_version,attempt_id:value.attempt_id,repo_root:value.repo_root,project_id:value.project_id,project,
    task:structuredClone(bound.task),baseline,policy_digest:value.policy_digest,control_epoch:value.control_epoch,commands,
    scope:requestedScope,...(hasSemantic?{semantic_footprint}:{}),resources,limits,environment:structuredClone(value.environment),
    ...(v2?{harness_revision:revision}:{})};
}

export function requestDigest(request) { return digest(requestContract(request)); }

export function approvalContract(value) {
  publicJson(value);
  exact(value,['approval_id','request_digest','issued_at','expires_at','control_epoch'],'INVALID_APPROVAL');
  check(identifier(value.approval_id) && hash(value.request_digest) && nonnegative(value.issued_at) && positive(value.expires_at) &&
    value.expires_at>value.issued_at && value.expires_at-value.issued_at<=3_600_000 && positive(value.control_epoch),'INVALID_APPROVAL');
  return structuredClone(value);
}

export function resultContract(value) {
  publicJson(value);
  exact(value,['status','reason','exit_code','signal','pid','output_bytes','saved_bytes','output_digest','transcript_path','close_observed'],'INVALID_RESULT');
  check(['SUCCEEDED','FAILED','RECOVERY_REQUIRED'].includes(value.status) && text(value.reason) &&
    (value.exit_code===null || Number.isSafeInteger(value.exit_code)) && (value.signal===null || text(value.signal)) &&
    (value.pid===null || positive(value.pid)) && nonnegative(value.output_bytes) && nonnegative(value.saved_bytes) &&
    value.saved_bytes<=value.output_bytes && hash(value.output_digest) && typeof value.transcript_path==='string' &&
    isAbsolute(value.transcript_path) && typeof value.close_observed==='boolean','INVALID_RESULT');
  if(value.status==='SUCCEEDED') check(value.exit_code===0 && value.signal===null && value.close_observed,'INVALID_RESULT');
  if(value.status==='FAILED') check(value.close_observed && (value.signal!==null || (value.exit_code!==null && value.exit_code!==0)),'INVALID_RESULT');
  return structuredClone(value);
}
