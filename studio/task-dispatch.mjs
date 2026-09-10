import { canonical, digest } from '../core/contracts.mjs';
import { executionBindingContract } from './model-execution.mjs';

export const DISPATCH_ROLES=Object.freeze(['head','planner','coder','reviewer','validator']);
const REQUEST_ROLES=DISPATCH_ROLES.slice(1),HASH=/^[0-9a-f]{64}$/;
const AUTHORITY_KEYS=['model_execution','remote_worker_execution','repository_write','approval','git_publish','deployment'];
const check=(condition,reason)=>{if(!condition)throw new Error(reason)};
const safeText=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.isWellFormed()&&!/[\u0000-\u001f\u007f]/.test(value)&&value.trim()===value;
const exact=(value,keys,reason)=>check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)),reason);
const normalizeExecutionBindings=(values,task,reason)=>{check(task&&Array.isArray(task.dispatches)&&Array.isArray(values)&&[0,task.dispatches.length].includes(values.length),reason);
  let normalized;try{normalized=values.map(executionBindingContract)}catch{throw new Error(reason)}const ids=new Set(normalized.map(value=>value.dispatch_id));
  check(ids.size===normalized.length&&normalized.every(value=>{const item=task.dispatches.find(candidate=>candidate.dispatch_id===value.dispatch_id);
    return item&&item.role===value.role&&item.node_id===value.node_id&&item.model_id===value.model_id&&item.provider_id===value.provider_id}),reason);return normalized};

function inspect(value) {
  const seen=new Set();
  function visit(item) {
    if(item===null||typeof item==='boolean')return;
    if(typeof item==='string'){check(item.isWellFormed(),'INVALID_DISPATCH_TASK');return}
    if(typeof item==='number'){check(Number.isFinite(item),'INVALID_DISPATCH_TASK');return}
    check(typeof item==='object'&&!seen.has(item),'INVALID_DISPATCH_TASK');
    const array=Array.isArray(item);check(Object.getPrototypeOf(item)===(array?Array.prototype:Object.prototype),'INVALID_DISPATCH_TASK');seen.add(item);
    const descriptors=Object.getOwnPropertyDescriptors(item),names=Reflect.ownKeys(descriptors);check(names.every(name=>typeof name==='string'),'INVALID_DISPATCH_TASK');
    if(array){check(names.length===item.length+1,'INVALID_DISPATCH_TASK');for(let index=0;index<item.length;index++)check(Object.hasOwn(descriptors,String(index)),'INVALID_DISPATCH_TASK')}
    for(const name of names){if(array&&name==='length')continue;const descriptor=descriptors[name];check(!['__proto__','prototype','constructor'].includes(name)&&
      Object.hasOwn(descriptor,'value')&&descriptor.enumerable,'INVALID_DISPATCH_TASK');visit(descriptor.value)}seen.delete(item);
  }
  visit(value);check(Buffer.byteLength(canonical(value))<=256*1024,'DISPATCH_TASK_TOO_LARGE');return structuredClone(value);
}

const immutableDispatch=value=>({dispatch_id:value.dispatch_id,role:value.role,index:value.index,model_id:value.model_id,node_id:value.node_id,
  provider_id:value.provider_id,predecessor_dispatch_id:value.predecessor_dispatch_id});
const immutableTask=value=>({schema_version:value.schema_version,organization_id:value.organization_id,task_id:value.task_id,objective:value.objective,
  profile_revision:value.profile_revision,roles:value.roles,assignment_digest:value.assignment_digest,dispatch_epoch:value.dispatch_epoch,
  created_by:value.created_by,created_at:value.created_at,authority:value.authority,role_graph_digest:value.role_graph_digest,
  dispatches:value.dispatches.map(immutableDispatch)});

export const dispatchTaskDigest=task=>digest(immutableTask(inspect(task)));
const approvalDigestInput=approval=>Object.fromEntries(Object.entries(approval).filter(([key,value])=>
  !['consumed_at','activation_receipt'].includes(key)&&!(key==='recovery_digest'&&value===null)&&
  !(key==='model_execution'&&value===false)&&!(key==='execution_bindings'&&Array.isArray(value)&&value.length===0)));

export function createDispatchTask(input) {
  const value=inspect(input);exact(value,['organization_id','task_id','objective','profile_revision','roles','assignment','dispatch_epoch','created_by','now'],'INVALID_DISPATCH_TASK');
  check(/^org-[1-9][0-9]{0,31}$/.test(value.organization_id)&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.task_id)&&
    safeText(value.objective,2000)&&Number.isSafeInteger(value.profile_revision)&&value.profile_revision>=1&&Array.isArray(value.roles)&&
    value.roles.length>0&&value.roles.length<=REQUEST_ROLES.length&&new Set(value.roles).size===value.roles.length&&value.roles.every(role=>REQUEST_ROLES.includes(role))&&
    Number.isSafeInteger(value.dispatch_epoch)&&value.dispatch_epoch>=1&&/^[1-9][0-9]{0,31}$/.test(value.created_by)&&Number.isSafeInteger(value.now)&&value.now>=0,
  'INVALID_DISPATCH_TASK');
  const assignment=value.assignment;check(assignment?.status==='READY','ASSIGNMENT_NOT_READY');
  check(assignment.organization_id===value.organization_id&&assignment.task_id===value.task_id&&assignment.profile_revision===value.profile_revision&&HASH.test(assignment.decision_digest??''),
    'ASSIGNMENT_BINDING_MISMATCH');
  exact(assignment.authority,AUTHORITY_KEYS,'ASSIGNMENT_AUTHORITY_ESCALATION');
  check(AUTHORITY_KEYS.every(key=>assignment.authority[key]===false),'ASSIGNMENT_AUTHORITY_ESCALATION');
  const roles=REQUEST_ROLES.filter(role=>value.roles.includes(role)),ordered=['head',...roles],created_at=new Date(value.now).toISOString();
  const dispatches=ordered.map((role,index)=>{const source=role==='head'?assignment.head_assignment:assignment.assignments?.[role];
    check(source&&safeText(source.model_id)&&safeText(source.node_id)&&safeText(source.provider_id),'ASSIGNMENT_BINDING_MISMATCH');
    return {dispatch_id:`${value.task_id}:${role}`,role,index,model_id:source.model_id,node_id:source.node_id,provider_id:source.provider_id,
      predecessor_dispatch_id:index===0?null:`${value.task_id}:${ordered[index-1]}`,predecessor_result_digest:null,predecessor_evidence_digest:null,
      predecessor_artifact_id:null,status:index===0?'WAITING_APPROVAL':'WAITING_DEPENDENCY',attempt_id:null,recovery_reason:null}});
  const authority=Object.fromEntries(AUTHORITY_KEYS.map(key=>[key,false])),role_graph_digest=digest(dispatches.map(immutableDispatch));
  const task={schema_version:1,organization_id:value.organization_id,task_id:value.task_id,objective:value.objective,profile_revision:value.profile_revision,
    roles,assignment_digest:assignment.decision_digest,dispatch_epoch:value.dispatch_epoch,created_by:value.created_by,created_at,updated_at:created_at,
    status:'AWAITING_APPROVAL',authority,role_graph_digest,dispatches};
  return {...task,task_digest:dispatchTaskDigest(task)};
}

export function dispatchApproval(input) {
  const value=inspect(input),keys=['approval_id','task','approved_by','ttl_ms','now'];
  check(value&&Object.keys(value).length===keys.length+(Object.hasOwn(value,'execution_bindings')?1:0)&&keys.every(key=>Object.hasOwn(value,key)),
    'INVALID_DISPATCH_APPROVAL');const execution_bindings=normalizeExecutionBindings(value.execution_bindings??[],value.task,'INVALID_DISPATCH_APPROVAL');
  check(safeText(value.approval_id,128)&&/^[1-9][0-9]{0,31}$/.test(value.approved_by)&&Number.isSafeInteger(value.ttl_ms)&&
    value.ttl_ms>=1000&&value.ttl_ms<=3_600_000&&Number.isSafeInteger(value.now)&&value.now>=0&&value.task?.task_digest===dispatchTaskDigest(value.task),
  'INVALID_DISPATCH_APPROVAL');
  const approval={schema_version:1,approval_id:value.approval_id,organization_id:value.task.organization_id,task_id:value.task.task_id,
    task_digest:value.task.task_digest,role_graph_digest:value.task.role_graph_digest,assignment_digest:value.task.assignment_digest,
    profile_revision:value.task.profile_revision,dispatch_epoch:value.task.dispatch_epoch,approved_by:value.approved_by,issued_at:value.now,
    expires_at:value.now+value.ttl_ms,recovery_digest:null,model_execution:execution_bindings.length>0,execution_bindings,
    consumed_at:null,activation_receipt:null};
  return {...approval,approval_digest:digest(approvalDigestInput(approval))};
}

const immutableRecovery=value=>({schema_version:value.schema_version,recovery_id:value.recovery_id,organization_id:value.organization_id,
  task_id:value.task_id,dispatch_id:value.dispatch_id,role:value.role,attempt_id:value.attempt_id,task_digest:value.task_digest,
  role_graph_digest:value.role_graph_digest,assignment_digest:value.assignment_digest,profile_revision:value.profile_revision,
  previous_dispatch_epoch:value.previous_dispatch_epoch,target_dispatch_epoch:value.target_dispatch_epoch,recovery_reason:value.recovery_reason,
  disposition:value.disposition,evidence_digest:value.evidence_digest,verified_by:value.verified_by,verified_at:value.verified_at});

export const dispatchRecoveryDigest=recovery=>digest(immutableRecovery(inspect(recovery)));

export function dispatchRecoveryAssessment(input) {
  const value=inspect(input);exact(value,['recovery_id','task','attempt','disposition','evidence_digest','verified_by','target_dispatch_epoch','now'],
    'INVALID_DISPATCH_RECOVERY');
  const {task,attempt}=value,dispatch=task?.dispatches?.find(item=>item.dispatch_id===attempt?.dispatch_id);
  check(safeText(value.recovery_id,128)&&HASH.test(value.evidence_digest)&&/^[1-9][0-9]{0,31}$/.test(value.verified_by)&&
    Number.isSafeInteger(value.target_dispatch_epoch)&&Number.isSafeInteger(value.now)&&value.now>=0,'INVALID_DISPATCH_RECOVERY');
  check(task?.task_digest===dispatchTaskDigest(task)&&task.status==='RECOVERY_REQUIRED','RECOVERY_TASK_NOT_RECOVERABLE');
  check(attempt?.status==='RECOVERY_REQUIRED'&&safeText(attempt.attempt_id,128)&&attempt.organization_id===task.organization_id&&
    attempt.task_id===task.task_id&&attempt.dispatch_epoch===task.dispatch_epoch&&dispatch?.attempt_id===attempt.attempt_id&&
    dispatch.status==='RECOVERY_REQUIRED'&&dispatch.role===attempt.role&&dispatch.node_id===attempt.node_id&&
    dispatch.recovery_reason===attempt.recovery_reason&&safeText(attempt.recovery_reason,256),'RECOVERY_ATTEMPT_NOT_RECOVERABLE');
  check(value.disposition==='RETRY_CONFIRMED_TERMINATED','UNSUPPORTED_RECOVERY_DISPOSITION');
  check(value.target_dispatch_epoch>task.dispatch_epoch,'RECOVERY_EPOCH_NOT_ADVANCED');
  const recovery={schema_version:1,recovery_id:value.recovery_id,organization_id:task.organization_id,task_id:task.task_id,
    dispatch_id:dispatch.dispatch_id,role:dispatch.role,attempt_id:attempt.attempt_id,task_digest:task.task_digest,
    role_graph_digest:task.role_graph_digest,assignment_digest:task.assignment_digest,profile_revision:task.profile_revision,
    previous_dispatch_epoch:task.dispatch_epoch,target_dispatch_epoch:value.target_dispatch_epoch,recovery_reason:attempt.recovery_reason,
    disposition:value.disposition,evidence_digest:value.evidence_digest,verified_by:value.verified_by,verified_at:new Date(value.now).toISOString()};
  return {...recovery,recovery_digest:dispatchRecoveryDigest(recovery)};
}

export function prepareRecoveredDispatchTask(input) {
  const value=inspect(input);exact(value,['task','recovery','now'],'INVALID_DISPATCH_RECOVERY');const {task,recovery}=value;
  check(Number.isSafeInteger(value.now)&&value.now>=0&&task?.task_digest===dispatchTaskDigest(task)&&task.status==='RECOVERY_REQUIRED'&&
    recovery?.recovery_digest===dispatchRecoveryDigest(recovery)&&recovery.organization_id===task.organization_id&&recovery.task_id===task.task_id&&
    recovery.task_digest===task.task_digest&&recovery.role_graph_digest===task.role_graph_digest&&recovery.assignment_digest===task.assignment_digest&&
    recovery.profile_revision===task.profile_revision&&recovery.previous_dispatch_epoch===task.dispatch_epoch,'RECOVERY_BINDING_MISMATCH');
  const resumed=structuredClone(task),dispatch=resumed.dispatches.find(item=>item.dispatch_id===recovery.dispatch_id);
  check(dispatch?.attempt_id===recovery.attempt_id&&dispatch.status==='RECOVERY_REQUIRED','RECOVERY_BINDING_MISMATCH');
  resumed.dispatch_epoch=recovery.target_dispatch_epoch;resumed.status='AWAITING_RECOVERY_APPROVAL';resumed.updated_at=new Date(value.now).toISOString();
  dispatch.status='WAITING_RECOVERY_APPROVAL';dispatch.attempt_id=null;dispatch.recovery_reason=null;
  resumed.task_digest=dispatchTaskDigest(resumed);return resumed;
}

export function dispatchRecoveryApproval(input) {
  const value=inspect(input),keys=['approval_id','task','recovery','approved_by','ttl_ms','now'];
  check(value&&Object.keys(value).length===keys.length+(Object.hasOwn(value,'execution_bindings')?1:0)&&keys.every(key=>Object.hasOwn(value,key)),
    'INVALID_DISPATCH_RECOVERY_APPROVAL');const execution_bindings=normalizeExecutionBindings(value.execution_bindings??[],value.task,
      'INVALID_DISPATCH_RECOVERY_APPROVAL');
  check(safeText(value.approval_id,128)&&/^[1-9][0-9]{0,31}$/.test(value.approved_by)&&Number.isSafeInteger(value.ttl_ms)&&
    value.ttl_ms>=1000&&value.ttl_ms<=3_600_000&&Number.isSafeInteger(value.now)&&value.now>=0&&
    value.task?.task_digest===dispatchTaskDigest(value.task)&&value.task.status==='AWAITING_RECOVERY_APPROVAL'&&
    value.recovery?.recovery_digest===dispatchRecoveryDigest(value.recovery)&&value.recovery.organization_id===value.task.organization_id&&
    value.recovery.task_id===value.task.task_id&&value.recovery.target_dispatch_epoch===value.task.dispatch_epoch,
  'INVALID_DISPATCH_RECOVERY_APPROVAL');
  const approval={schema_version:1,approval_id:value.approval_id,organization_id:value.task.organization_id,task_id:value.task.task_id,
    task_digest:value.task.task_digest,role_graph_digest:value.task.role_graph_digest,assignment_digest:value.task.assignment_digest,
    profile_revision:value.task.profile_revision,dispatch_epoch:value.task.dispatch_epoch,approved_by:value.approved_by,issued_at:value.now,
    expires_at:value.now+value.ttl_ms,recovery_digest:value.recovery.recovery_digest,model_execution:execution_bindings.length>0,
    execution_bindings,consumed_at:null,activation_receipt:null};
  return {...approval,approval_digest:digest(approvalDigestInput(approval))};
}

export function dispatchPublicTask(task,attempts=[]) {
  const value=inspect(task),publicAttempts=inspect(attempts).map(item=>({attempt_id:item.attempt_id,dispatch_id:item.dispatch_id,role:item.role,
    node_id:item.node_id,status:item.status,event_sequence:item.event_sequence,lease_started_at:item.lease_started_at,lease_expires_at:item.lease_expires_at,
    result_digest:item.result_digest??null,evidence_digest:item.evidence_digest??null,recovery_reason:item.recovery_reason??null,
    execution_receipt:item.execution_receipt??null}));
  return {...structuredClone(value),attempts:publicAttempts};
}
