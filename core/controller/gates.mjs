import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { availableParallelism, totalmem, freemem } from 'node:os';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { canonical, digest, projectContract } from '../contracts.mjs';
import { contained, drift, planTask, repository } from '../project.mjs';
import { scope, writerGate } from '../governor.mjs';
import { isolatedEnvironment, resourcePlan } from '../reuse.mjs';
import { scanSemanticFootprint } from '../semantic.mjs';
import { approvalContract, localTask, policyContract, requestContract, requestDigest, scopeForPlatform } from './contracts.mjs';

const check=(condition,reason)=>{if(!condition) throw new Error(reason);};
const same=(left,right)=>canonical(left)===canonical(right);
const incomplete=attempt=>['PREPARED','RUNNING'].includes(attempt.status);

// Check every component before canonicalization so an alias cannot hide a link.
function noSymlinkPath(path) {
  check(typeof path==='string' && isAbsolute(path),'ABSOLUTE_PATH_REQUIRED');
  const absolute=resolve(path),root=parse(absolute).root;
  let current=root;
  check(!lstatSync(current).isSymbolicLink(),'SYMLINK_REJECTED');
  for(const part of relative(root,absolute).split(/[\\/]/).filter(Boolean)) {
    current=join(current,part);
    check(!lstatSync(current).isSymbolicLink(),'SYMLINK_REJECTED');
  }
  return realpathSync.native(absolute);
}

function capacityContract(value) {
  check(value && Object.keys(value).length===3 &&
    Number.isSafeInteger(value.cpuThreads) && value.cpuThreads>0 && value.cpuThreads<=4096 &&
    Number.isFinite(value.memoryGiB) && value.memoryGiB>0 && value.memoryGiB<=1048576 &&
    Number.isFinite(value.availableMemoryGiB) && value.availableMemoryGiB>=0 && value.availableMemoryGiB<=value.memoryGiB,
  'INVALID_LOCAL_CAPACITY');
  return value;
}

export function localCapacity() {
  return capacityContract({cpuThreads:availableParallelism(),memoryGiB:totalmem()/1024**3,availableMemoryGiB:freemem()/1024**3});
}

// Read-only planning. Filesystem authority always comes from initialized state.
export function prepareRequest(state,{attempt_id,task}) {
  const policy=policyContract(state.policy);
  const bound=localTask(task,state.project,state.harness_revision??null),project=projectContract(state.project);
  const repo_root=repository(noSymlinkPath(state.repo_root));
  const plan=planTask(repo_root,project,bound.task,{harness_revision:state.harness_revision??null});
  check(plan.commands.length<=policy.limits.max_commands,'COMMAND_LIMIT_EXCEEDED');
  const scopes=[scope({write_paths:bound.task.in_scope_paths})];
  const commands=plan.commands.map(command=>{
    check(Object.hasOwn(policy.commands,command.name),'COMMAND_NOT_ALLOWED');
    const allowed=policy.commands[command.name];
    const executable=noSymlinkPath(allowed.executable);
    check(lstatSync(executable).isFile(),'INVALID_EXECUTABLE');
    const cwd=contained(repo_root,command.cwd);
    check(lstatSync(cwd).isDirectory(),'INVALID_COMMAND_CWD');
    scopes.push(allowed.scope);
    return {key:command.name,declared_argv:[...command.argv],executable,
      executable_digest:createHash('sha256').update(readFileSync(executable)).digest('hex'),
      argv:[...allowed.prefix_argv,...command.argv.slice(1)],cwd};
  });
  const combined=Object.fromEntries(Object.keys(scopes[0]).map(field=>[field,scopes.flatMap(value=>value[field])]));
  const requestedScope=scope(combined);
  const semantic_footprint=scanSemanticFootprint(repo_root,{write_paths:bound.task.in_scope_paths,declared_scope:requestedScope});
  return requestContract({schema_version:state.harness_revision?2:1,attempt_id,repo_root,project_id:project.project_id,project,task:bound.task,
    baseline:plan.baseline,policy_digest:digest(policy),control_epoch:state.control_epoch,commands,scope:requestedScope,semantic_footprint,
    resources:policy.resources,limits:policy.limits,environment:isolatedEnvironment(),
    ...(state.harness_revision?{harness_revision:state.harness_revision}:{})});
}

// Reusable temporal admission for fresh synchronous checks after slow setup.
// Callers own observation ordering; this does not replace the complete gate.
export function checkApprovalTime(request,approval,now) {
  check(Number.isSafeInteger(now) && now>=0,'INVALID_TIME');
  check(now>=approval.issued_at,'CLOCK_ROLLBACK');
  check(now<approval.expires_at,'APPROVAL_EXPIRED');
  check(approval.expires_at-now>=request.limits.timeout_ms,'APPROVAL_DEADLINE_INSUFFICIENT');
}

export function checkDispatch(state,request,approval,{now=Date.now(),capacity=localCapacity(),existingReservation=false}={}) {
  request=requestContract(request); approval=approvalContract(approval);
  check(Number.isSafeInteger(now) && now>=0,'INVALID_TIME');
  check(typeof existingReservation==='boolean','INVALID_RESERVATION');
  check(!state.recovery_required,'RECOVERY_REQUIRED');
  check(!state.semantic_review_required,'MANUAL_DECISION_REQUIRED');
  const request_digest=requestDigest(request),id=request.attempt_id;
  const stored=Object.hasOwn(state.approvals??{},id)?state.approvals[id]:null;
  check(stored && same(approvalContract(stored.approval),approval) && requestDigest(stored.request)===request_digest,
    'APPROVAL_NOT_RECORDED');
  check(approval.request_digest===request_digest,'REQUEST_DIGEST_MISMATCH');
  check(request.control_epoch===state.control_epoch && approval.control_epoch===state.control_epoch,'STALE_CONTROL_EPOCH');
  checkApprovalTime(request,approval,now);
  check(approval.expires_at-approval.issued_at<=state.policy.limits.approval_ttl_ms,'APPROVAL_TTL_EXCEEDED');

  const current=prepareRequest(state,{attempt_id:id,task:request.task});
  check(drift(request.baseline,current.baseline).status==='UNCHANGED','REPOSITORY_DRIFT');
  check(requestDigest(current)===request_digest,'REQUEST_DRIFT');
  // Fresh admission also checks the caller's observed wall clock, not replay time.
  for(const lock of state.policy.governor_locks)
    check(lock.issued_at<=now && lock.last_heartbeat_at<=now,'CLOCK_ROLLBACK');
  const locks=state.policy.governor_locks.map(lock=>({...lock,scope:scopeForPlatform(lock.scope)}));
  check(writerGate(locks,{projectId:request.project_id,scope:scopeForPlatform(request.scope),now}).allowed,'GOVERNOR_HOLD');

  const reservation={cpuThreads:request.resources.cpu_threads,memoryGiB:request.resources.memory_gib,activeTasks:1};
  const pending=Object.entries(state.attempts??{}).filter(([,attempt])=>incomplete(attempt));
  const used=state.reservation;
  if(existingReservation) {
    check(used && same(used,reservation) && pending.length===1 && pending[0][0]===id &&
      pending[0][1].request_digest===request_digest,'RESERVATION_IDENTITY_MISMATCH');
  } else {
    check(!Object.hasOwn(state.attempts??{},id),'APPROVAL_CONSUMED');
    check(used===null && pending.length===0,'RESERVATION_OCCUPIED');
  }
  // Re-admit the already owned allocation once; only its journal-bound amount
  // is removed from usage. Store owns the separate same-session continuation fence.
  const usage={cpuThreads:(used?.cpuThreads??0)-(existingReservation?reservation.cpuThreads:0),
    memoryGiB:(used?.memoryGiB??0)-(existingReservation?reservation.memoryGiB:0),
    activeTasks:(used?.activeTasks??0)-(existingReservation?1:0)};
  const resources=resourcePlan({request:request.resources,quota:state.policy.quota,
    contractUsage:usage,nodeUsage:usage,nodeCapacity:capacityContract(capacity),devices:[],leasedGpuIds:[],now});
  check(resources.status==='PLANNED','RESOURCE_BLOCKED: '+(resources.allocation.reason??resources.gpu?.reason??'UNKNOWN'));
  return {reservation:{...reservation},request_digest};
}
