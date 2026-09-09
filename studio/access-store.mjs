import { mkdirSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { digest as canonicalDigest } from '../core/contracts.mjs';
import { isPaidPlan, subscriptionEntitlement } from './plans.mjs';
import { isProviderId } from './provider-catalog.mjs';
import { createDispatchTask as buildDispatchTask, dispatchApproval, dispatchPublicTask, dispatchTaskDigest } from './task-dispatch.mjs';

const SUBSCRIPTION=new Set(['active','trialing','past_due','canceled','unpaid','incomplete','incomplete_expired','paused']);
const PROVIDERS=new Set(['payapp','stripe']);
const empty=()=>({schema_version:8,users:{},organizations:{},memberships:{},processed_webhook_ids:[],billing_requests:{},provider_connections:{},models:{},node_enrollments:{},nodes:{},orchestration_profiles:{},
  dispatch_epochs:{},dispatch_tasks:{},dispatch_approvals:{},dispatch_attempts:{},dispatch_idempotency:{}});
const validId=value=>typeof value==='string'&&/^[1-9][0-9]{0,31}$/.test(value);
const validOrganizationId=value=>typeof value==='string'&&/^org-[1-9][0-9]{0,31}$/.test(value);
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const validConnectionId=value=>typeof value==='string'&&new RegExp(`^pc-${uuid}$`).test(value);
const validModelId=value=>typeof value==='string'&&new RegExp(`^model-${uuid}$`).test(value);
const validEnrollmentId=value=>typeof value==='string'&&new RegExp(`^enrollment-${uuid}$`).test(value);
const validNodeId=value=>typeof value==='string'&&new RegExp(`^node-${uuid}$`).test(value);
const validAttemptId=value=>typeof value==='string'&&new RegExp(`^attempt-${uuid}$`).test(value);
const validHash=value=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);
const safeText=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.isWellFormed();
const safeModelReference=value=>safeText(value,256)&&!/[\u0000-\u001f\u007f]/.test(value)&&value.trim()===value;
const nullableText=(value,max=256)=>value===null||safeText(value,max);
const check=(condition,reason)=>{if(!condition)throw new Error(reason)};
const safeKey=(value,max=128)=>safeText(value,max)&&/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const objectCollection=(value,max)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length<=max;
const dispatchTaskKey=(organizationId,taskId)=>`${organizationId}:${taskId}`;
const dispatchApprovalKey=(organizationId,approvalId)=>`${organizationId}:${approvalId}`;
const idempotencyId=(scope,key)=>canonicalDigest({scope,key});
const validTime=value=>safeText(value,32)&&Number.isFinite(Date.parse(value));
const onlineAt=(node,now)=>node?.status==='active'&&validTime(node.last_seen_at)&&now>=Date.parse(node.last_seen_at)&&now-Date.parse(node.last_seen_at)<=90_000;
const attemptsForTask=(data,task)=>Object.values(data.dispatch_attempts).filter(attempt=>attempt.organization_id===task.organization_id&&attempt.task_id===task.task_id);
const approvalForTask=(data,task,{liveAt=null,consumed=null}={})=>Object.values(data.dispatch_approvals).filter(value=>value.organization_id===task.organization_id&&
  value.task_id===task.task_id&&(consumed===null||(consumed?value.consumed_at!==null:value.consumed_at===null))&&(liveAt===null||value.expires_at>liveAt))
  .sort((left,right)=>right.issued_at-left.issued_at)[0]??null;
const publicEnvelope=(task,item)=>({schema_version:1,organization_id:task.organization_id,task_id:task.task_id,dispatch_id:item.dispatch_id,
  role:item.role,objective:task.objective,model_id:item.model_id,node_id:item.node_id,provider_id:item.provider_id,task_digest:task.task_digest,
  role_graph_digest:task.role_graph_digest,assignment_digest:task.assignment_digest,profile_revision:task.profile_revision,dispatch_epoch:task.dispatch_epoch,
  predecessor_result_digest:item.predecessor_result_digest,predecessor_evidence_digest:item.predecessor_evidence_digest,authority:structuredClone(task.authority)});
function reconcileData(data,organizationId,now) {
  check(Number.isSafeInteger(now)&&now>=0,'INVALID_TIME');let fenced=false;
  for(const task of Object.values(data.dispatch_tasks).filter(value=>value.organization_id===organizationId)) {
    if(task.status==='QUEUED'&&task.dispatches[0].status==='QUEUED'&&!approvalForTask(data,task,{liveAt:now,consumed:false})){
      task.status='AWAITING_APPROVAL';task.dispatches[0].status='WAITING_APPROVAL';task.updated_at=new Date(now).toISOString()}
    if(task.status!=='ACTIVE')continue;
    const active=attemptsForTask(data,task).find(value=>['CLAIMED','RUNNING'].includes(value.status));if(!active)continue;
    const node=data.nodes[active.node_id],reason=active.lease_expires_at<=now?'LEASE_EXPIRED':!onlineAt(node,now)?'NODE_HEARTBEAT_LOST':null;
    if(!reason)continue;active.status='RECOVERY_REQUIRED';active.recovery_reason=reason;active.updated_at=new Date(now).toISOString();
    const dispatch=task.dispatches.find(value=>value.dispatch_id===active.dispatch_id);dispatch.status='RECOVERY_REQUIRED';dispatch.recovery_reason=reason;
    for(const item of task.dispatches)if(item.status==='WAITING_DEPENDENCY')item.status='BLOCKED';task.status='RECOVERY_REQUIRED';task.updated_at=active.updated_at;fenced=true;
  }
  if(fenced)data.dispatch_epochs[organizationId]++;
  return fenced;
}
const validateCapabilities=value=>check(value&&Object.keys(value).length===8&&safeText(value.agent_version,32)&&
  ['aix','darwin','freebsd','linux','openbsd','sunos','win32'].includes(value.os)&&safeText(value.arch,32)&&
  Number.isSafeInteger(value.cpu_logical)&&value.cpu_logical>=1&&value.cpu_logical<=4096&&Number.isSafeInteger(value.memory_bytes)&&
  value.memory_bytes>=1&&value.memory_bytes<=Number.MAX_SAFE_INTEGER&&['observed','unavailable'].includes(value.gpu_status)&&
  Array.isArray(value.gpu_devices)&&value.gpu_devices.length<=32&&value.gpu_devices.every(device=>device&&Object.keys(device).length===2&&
    safeText(device.name,128)&&(device.memory_bytes===null||(Number.isSafeInteger(device.memory_bytes)&&device.memory_bytes>=0)))&&
  Array.isArray(value.adapters)&&value.adapters.length<=32&&new Set(value.adapters).size===value.adapters.length&&value.adapters.every(isProviderId),
  'INVALID_NODE_CAPABILITIES');

function migrate(data) {
  if(data?.schema_version===1){const users={};
    for(const [id,user] of Object.entries(data.users??{}))users[id]={github_id:user.github_id,login:user.login,avatar_url:user.avatar_url??null,
      billing_provider:user.stripe_subscription_id||user.stripe_customer_id?'stripe':null,billing_customer_id:user.stripe_customer_id??null,
      billing_subscription_id:user.stripe_subscription_id??null,subscription_status:user.subscription_status??null,
      current_period_end:user.current_period_end??null,updated_at:user.updated_at};
    data={schema_version:2,users,processed_webhook_ids:data.processed_webhook_ids??[],billing_requests:{}}}
  if(data?.schema_version===2){const users={};
    for(const [id,user] of Object.entries(data.users??{}))users[id]={...user,plan_id:['active','trialing'].includes(user.subscription_status)?'core':null};
    const billing_requests={};for(const [id,request] of Object.entries(data.billing_requests??{}))billing_requests[id]={...request,plan_id:'core'};
    data={...data,schema_version:3,users,billing_requests}}
  if(data?.schema_version===3){const organizations={},memberships={};
    for(const user of Object.values(data.users??{})){const organization_id=`org-${user.github_id}`,now=user.updated_at;
      organizations[organization_id]={organization_id,name:`${user.login} Workspace`,slug:`github-${user.github_id}`,created_at:now,updated_at:now};
      memberships[`${organization_id}:${user.github_id}`]={organization_id,github_id:user.github_id,role:'owner',created_at:now}}
    data={...data,schema_version:4,organizations,memberships}}
  if(data?.schema_version===4)data={...data,schema_version:5,provider_connections:{},models:{}};
  if(data?.schema_version===5)data={...data,schema_version:6,node_enrollments:{},nodes:{}};
  if(data?.schema_version===6)data={...data,schema_version:7,orchestration_profiles:{}};
  if(data?.schema_version===7)data={...data,schema_version:8,dispatch_epochs:Object.fromEntries(Object.keys(data.organizations??{}).map(id=>[id,1])),
    dispatch_tasks:{},dispatch_approvals:{},dispatch_attempts:{},dispatch_idempotency:{}};
  return data;
}

function validate(input) {
  const data=migrate(input);
  check(data&&Object.keys(data).length===16&&data.schema_version===8&&data.users&&typeof data.users==='object'&&!Array.isArray(data.users)&&
    Object.keys(data.users).length<=10_000&&data.billing_requests&&typeof data.billing_requests==='object'&&!Array.isArray(data.billing_requests)&&
    Object.keys(data.billing_requests).length<=10_000&&data.organizations&&typeof data.organizations==='object'&&!Array.isArray(data.organizations)&&
    Object.keys(data.organizations).length<=10_000&&data.memberships&&typeof data.memberships==='object'&&!Array.isArray(data.memberships)&&
    Object.keys(data.memberships).length<=50_000&&data.provider_connections&&typeof data.provider_connections==='object'&&!Array.isArray(data.provider_connections)&&
    Object.keys(data.provider_connections).length<=50_000&&data.models&&typeof data.models==='object'&&!Array.isArray(data.models)&&
    Object.keys(data.models).length<=100_000&&data.node_enrollments&&typeof data.node_enrollments==='object'&&!Array.isArray(data.node_enrollments)&&
    Object.keys(data.node_enrollments).length<=50_000&&data.nodes&&typeof data.nodes==='object'&&!Array.isArray(data.nodes)&&Object.keys(data.nodes).length<=50_000&&
    data.orchestration_profiles&&typeof data.orchestration_profiles==='object'&&!Array.isArray(data.orchestration_profiles)&&Object.keys(data.orchestration_profiles).length<=10_000&&
    objectCollection(data.dispatch_epochs,10_000)&&objectCollection(data.dispatch_tasks,50_000)&&objectCollection(data.dispatch_approvals,50_000)&&
    objectCollection(data.dispatch_attempts,50_000)&&objectCollection(data.dispatch_idempotency,50_000),
    'INVALID_ACCESS_STORE');
  check(Array.isArray(data.processed_webhook_ids)&&data.processed_webhook_ids.length<=1000&&
    data.processed_webhook_ids.every(id=>safeText(id,256))&&new Set(data.processed_webhook_ids).size===data.processed_webhook_ids.length,
    'INVALID_ACCESS_STORE');
  for(const [id,user] of Object.entries(data.users))check(validId(id)&&user&&Object.keys(user).length===10&&user.github_id===id&&safeText(user.login,128)&&
    nullableText(user.avatar_url,512)&&(user.billing_provider===null||PROVIDERS.has(user.billing_provider))&&nullableText(user.billing_customer_id,128)&&
    nullableText(user.billing_subscription_id,128)&&(user.subscription_status===null||SUBSCRIPTION.has(user.subscription_status))&&
    (user.plan_id===null||isPaidPlan(user.plan_id))&&(!['active','trialing'].includes(user.subscription_status)||isPaidPlan(user.plan_id))&&
    (user.current_period_end===null||(Number.isSafeInteger(user.current_period_end)&&user.current_period_end>=0))&&
    safeText(user.updated_at,32),
  'INVALID_ACCESS_STORE');
  for(const [id,request] of Object.entries(data.billing_requests))check(safeText(id,128)&&request&&Object.keys(request).length===9&&
    request.request_id===id&&validId(request.github_id)&&PROVIDERS.has(request.provider)&&Number.isSafeInteger(request.expected_price)&&
    request.expected_price>=0&&isPaidPlan(request.plan_id)&&nullableText(request.subscription_id,128)&&['pending','active','past_due','canceled'].includes(request.status)&&
    safeText(request.created_at,32)&&safeText(request.updated_at,32),'INVALID_ACCESS_STORE');
  for(const [id,organization] of Object.entries(data.organizations))check(validOrganizationId(id)&&organization&&Object.keys(organization).length===5&&
    organization.organization_id===id&&safeText(organization.name,128)&&safeText(organization.slug,128)&&
    /^github-[1-9][0-9]{0,31}$/.test(organization.slug)&&safeText(organization.created_at,32)&&safeText(organization.updated_at,32),'INVALID_ACCESS_STORE');
  for(const [id,membership] of Object.entries(data.memberships))check(membership&&Object.keys(membership).length===4&&
    id===`${membership.organization_id}:${membership.github_id}`&&validOrganizationId(membership.organization_id)&&validId(membership.github_id)&&
    data.organizations[membership.organization_id]&&data.users[membership.github_id]&&['owner','admin','member'].includes(membership.role)&&
    safeText(membership.created_at,32),'INVALID_ACCESS_STORE');
  for(const [id,connection] of Object.entries(data.provider_connections))check(connection&&Object.keys(connection).length===9&&
    id===connection.connection_id&&validConnectionId(id)&&validOrganizationId(connection.organization_id)&&data.organizations[connection.organization_id]&&
    isProviderId(connection.provider_id)&&safeText(connection.display_name,128)&&connection.secret_location==='customer_agent'&&
    ['pending_agent','ready','disabled'].includes(connection.status)&&nullableText(connection.agent_id,128)&&
    safeText(connection.created_at,32)&&safeText(connection.updated_at,32),'INVALID_ACCESS_STORE');
  for(const [id,model] of Object.entries(data.models)){const connection=data.provider_connections[model?.connection_id];check(model&&Object.keys(model).length===9&&
    id===model.model_id&&validModelId(id)&&validOrganizationId(model.organization_id)&&data.organizations[model.organization_id]&&
    connection?.organization_id===model.organization_id&&safeModelReference(model.provider_model_id)&&safeText(model.display_name,128)&&
    Array.isArray(model.role_capabilities)&&model.role_capabilities.length<=8&&new Set(model.role_capabilities).size===model.role_capabilities.length&&
    model.role_capabilities.every(value=>['head','planner','coder','reviewer','validator','general'].includes(value))&&
    ['active','disabled'].includes(model.status)&&safeText(model.created_at,32)&&safeText(model.updated_at,32),'INVALID_ACCESS_STORE')}
  for(const [id,enrollment] of Object.entries(data.node_enrollments))check(enrollment&&Object.keys(enrollment).length===9&&id===enrollment.enrollment_id&&
    validEnrollmentId(id)&&validOrganizationId(enrollment.organization_id)&&data.organizations[enrollment.organization_id]&&safeText(enrollment.display_name,128)&&
    validHash(enrollment.token_hash)&&['pending','consumed'].includes(enrollment.status)&&Number.isSafeInteger(enrollment.expires_at)&&enrollment.expires_at>=0&&
    safeText(enrollment.created_at,32)&&nullableText(enrollment.consumed_at,32)&&(enrollment.node_id===null||validNodeId(enrollment.node_id)),
    'INVALID_ACCESS_STORE');
  for(const [id,node] of Object.entries(data.nodes))check(node&&Object.keys(node).length===16&&id===node.node_id&&validNodeId(id)&&
    validOrganizationId(node.organization_id)&&data.organizations[node.organization_id]&&safeText(node.display_name,128)&&validHash(node.credential_hash)&&
    ['active','revoked'].includes(node.status)&&safeText(node.agent_version,32)&&['aix','darwin','freebsd','linux','openbsd','sunos','win32'].includes(node.os)&&
    safeText(node.arch,32)&&Number.isSafeInteger(node.cpu_logical)&&node.cpu_logical>=1&&node.cpu_logical<=4096&&
    Number.isSafeInteger(node.memory_bytes)&&node.memory_bytes>=1&&node.memory_bytes<=Number.MAX_SAFE_INTEGER&&
    ['observed','unavailable'].includes(node.gpu_status)&&Array.isArray(node.gpu_devices)&&node.gpu_devices.length<=32&&node.gpu_devices.every(device=>
      device&&Object.keys(device).length===2&&safeText(device.name,128)&&(device.memory_bytes===null||(Number.isSafeInteger(device.memory_bytes)&&device.memory_bytes>=0)))&&
    Array.isArray(node.adapters)&&node.adapters.length<=32&&new Set(node.adapters).size===node.adapters.length&&node.adapters.every(isProviderId)&&
    nullableText(node.last_seen_at,32)&&safeText(node.created_at,32)&&safeText(node.updated_at,32),'INVALID_ACCESS_STORE');
  for(const [id,profile] of Object.entries(data.orchestration_profiles)){const head=data.models[profile?.head_model_id];check(profile&&Object.keys(profile).length===7&&
    id===profile.organization_id&&validOrganizationId(id)&&data.organizations[id]&&['automatic','manual'].includes(profile.mode)&&
    head?.organization_id===id&&head.status==='active'&&(head.role_capabilities.includes('head')||head.role_capabilities.includes('general'))&&
    profile.assignments&&typeof profile.assignments==='object'&&!Array.isArray(profile.assignments)&&Object.keys(profile.assignments).length===4&&['planner','coder','reviewer','validator'].every(role=>Object.hasOwn(profile.assignments,role))&&
    Number.isSafeInteger(profile.revision)&&profile.revision>=1&&safeText(profile.created_at,32)&&safeText(profile.updated_at,32),'INVALID_ACCESS_STORE');
    for(const role of ['planner','coder','reviewer','validator']){const assignment=profile.assignments[role];if(profile.mode==='automatic')check(assignment===null,'INVALID_ACCESS_STORE');
      else if(assignment!==null){const model=data.models[assignment?.model_id],node=data.nodes[assignment?.node_id],connection=data.provider_connections[model?.connection_id];
        check(assignment&&Object.keys(assignment).length===2&&model?.organization_id===id&&model.status==='active'&&
          (model.role_capabilities.includes(role)||model.role_capabilities.includes('general'))&&node?.organization_id===id&&node.status==='active'&&
          node.adapters.includes(connection?.provider_id),'INVALID_ACCESS_STORE')}}}
  check(Object.keys(data.dispatch_epochs).length===Object.keys(data.organizations).length,'INVALID_ACCESS_STORE');
  for(const [id,epoch] of Object.entries(data.dispatch_epochs))check(data.organizations[id]&&Number.isSafeInteger(epoch)&&epoch>=1,'INVALID_ACCESS_STORE');
  for(const [id,task] of Object.entries(data.dispatch_tasks)){check(task&&Object.keys(task).length===16&&id===dispatchTaskKey(task.organization_id,task.task_id)&&
    data.organizations[task.organization_id]&&dispatchTaskDigest(task)===task.task_digest&&task.dispatch_epoch<=data.dispatch_epochs[task.organization_id]&&
    ['AWAITING_APPROVAL','QUEUED','ACTIVE','SUCCEEDED','FAILED','RECOVERY_REQUIRED'].includes(task.status)&&Array.isArray(task.dispatches)&&
    task.dispatches.length>=2&&task.dispatches.length<=5,'INVALID_ACCESS_STORE');
    for(const [index,item] of task.dispatches.entries())check(item&&Object.keys(item).length===12&&item.dispatch_id===`${task.task_id}:${item.role}`&&item.index===index&&
      ['head','planner','coder','reviewer','validator'].includes(item.role)&&data.models[item.model_id]?.organization_id===task.organization_id&&
      data.nodes[item.node_id]?.organization_id===task.organization_id&&isProviderId(item.provider_id)&&
      (index===0?item.predecessor_dispatch_id===null:item.predecessor_dispatch_id===task.dispatches[index-1].dispatch_id)&&
      (item.predecessor_result_digest===null||validHash(item.predecessor_result_digest))&&
      (item.predecessor_evidence_digest===null||validHash(item.predecessor_evidence_digest))&&
      ['WAITING_APPROVAL','WAITING_DEPENDENCY','QUEUED','CLAIMED','RUNNING','SUCCEEDED','FAILED','RECOVERY_REQUIRED','BLOCKED'].includes(item.status)&&
      (item.attempt_id===null||safeKey(item.attempt_id))&&nullableText(item.recovery_reason,256),'INVALID_ACCESS_STORE')}
  for(const [id,approval] of Object.entries(data.dispatch_approvals)){const task=data.dispatch_tasks[dispatchTaskKey(approval?.organization_id,approval?.task_id)];
    check(approval&&Object.keys(approval).length===15&&id===dispatchApprovalKey(approval.organization_id,approval.approval_id)&&task&&
      approval.task_digest===task.task_digest&&approval.role_graph_digest===task.role_graph_digest&&approval.assignment_digest===task.assignment_digest&&
      approval.profile_revision===task.profile_revision&&approval.dispatch_epoch===task.dispatch_epoch&&validId(approval.approved_by)&&
      Number.isSafeInteger(approval.issued_at)&&Number.isSafeInteger(approval.expires_at)&&approval.expires_at>approval.issued_at&&
      (approval.consumed_at===null||Number.isSafeInteger(approval.consumed_at))&&(approval.activation_receipt===null||validHash(approval.activation_receipt))&&
      ((approval.consumed_at===null)===(approval.activation_receipt===null))&&validHash(approval.approval_digest),
    'INVALID_ACCESS_STORE')}
  for(const [id,attempt] of Object.entries(data.dispatch_attempts)){const task=data.dispatch_tasks[dispatchTaskKey(attempt?.organization_id,attempt?.task_id)],
    item=task?.dispatches.find(value=>value.dispatch_id===attempt?.dispatch_id),approval=data.dispatch_approvals[dispatchApprovalKey(attempt?.organization_id,attempt?.approval_id)];
    check(attempt&&Object.keys(attempt).length===22&&id===attempt.attempt_id&&validAttemptId(id)&&task&&item&&item.role===attempt.role&&
      item.node_id===attempt.node_id&&approval&&attempt.approval_digest===approval.approval_digest&&attempt.activation_receipt===approval.activation_receipt&&
      attempt.dispatch_epoch===task.dispatch_epoch&&['CLAIMED','RUNNING','SUCCEEDED','FAILED','RECOVERY_REQUIRED'].includes(attempt.status)&&
      Number.isSafeInteger(attempt.event_sequence)&&attempt.event_sequence>=0&&Number.isSafeInteger(attempt.lease_started_at)&&
      Number.isSafeInteger(attempt.lease_expires_at)&&attempt.lease_expires_at>attempt.lease_started_at&&
      (attempt.observed_started_at===null||validTime(attempt.observed_started_at))&&(attempt.observed_finished_at===null||validTime(attempt.observed_finished_at))&&
      (attempt.result_digest===null||validHash(attempt.result_digest))&&(attempt.evidence_digest===null||validHash(attempt.evidence_digest))&&
      nullableText(attempt.recovery_reason,256)&&validTime(attempt.created_at)&&validTime(attempt.updated_at)&&item.attempt_id===attempt.attempt_id,
    'INVALID_ACCESS_STORE')}
  for(const [id,entry] of Object.entries(data.dispatch_idempotency))check(validHash(id)&&entry&&Object.keys(entry).length===4&&safeText(entry.scope,160)&&
    safeKey(entry.key)&&validHash(entry.request_digest)&&entry.response&&typeof entry.response==='object'&&!Array.isArray(entry.response)&&
    Buffer.byteLength(JSON.stringify(entry.response))<=256*1024,'INVALID_ACCESS_STORE');
  return structuredClone(data);
}

export function createAccessStore(root) {
  check(isAbsolute(root)&&resolve(root)===root,'ACCESS_ROOT_MUST_BE_ABSOLUTE');
  const parent=lstatSync(dirname(root),{throwIfNoEntry:false});check(parent?.isDirectory()&&!parent.isSymbolicLink(),'UNSAFE_ACCESS_PARENT');
  const existing=lstatSync(root,{throwIfNoEntry:false});
  if(existing)check(existing.isDirectory()&&!existing.isSymbolicLink(),'UNSAFE_ACCESS_ROOT');else mkdirSync(root,{mode:0o700});
  const file=join(root,'access.json'),stored=lstatSync(file,{throwIfNoEntry:false});
  if(stored)check(stored.isFile()&&!stored.isSymbolicLink(),'UNSAFE_ACCESS_FILE');
  else writeFileSync(file,JSON.stringify(empty(),null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});
  const raw=()=>{check(lstatSync(file).size<=8*1024*1024,'ACCESS_STORE_TOO_LARGE');return JSON.parse(readFileSync(file,'utf8'))};
  const save=data=>{data=validate(data);const temporary=join(root,`.access-${randomUUID()}.tmp`);
    writeFileSync(temporary,JSON.stringify(data,null,2)+'\n',{encoding:'utf8',mode:0o600,flag:'wx'});renameSync(temporary,file)};
  if(raw().schema_version!==8)save(migrate(raw()));
  const load=()=>validate(raw());let queue=Promise.resolve();
  const update=operation=>{const result=queue.then(()=>{const data=load(),value=operation(data);save(data);return value});queue=result.catch(()=>{});return result};
  const roleEvent=(kind,input)=>update(data=>{const {node_id,dispatch_id,attempt_id,expected_epoch,event_sequence,idempotency_key,now}=input,
    node=data.nodes[node_id];check(node,'INVALID_DISPATCH_NODE');check(safeKey(idempotency_key),'INVALID_DISPATCH_IDEMPOTENCY_KEY');
    check(safeKey(dispatch_id),'INVALID_DISPATCH_ID');check(validAttemptId(attempt_id),'INVALID_DISPATCH_ATTEMPT');
    check(Number.isSafeInteger(expected_epoch)&&Number.isSafeInteger(event_sequence)&&Number.isSafeInteger(now)&&now>=0,'INVALID_DISPATCH_EVENT');
    reconcileData(data,node.organization_id,now);check(data.dispatch_epochs[node.organization_id]===expected_epoch,'DISPATCH_EPOCH_CHANGED');
    const request=Object.fromEntries(Object.entries(input).filter(([key])=>key!=='now')),request_digest=canonicalDigest(request),scope=`${node_id}:${kind}`,
      id=idempotencyId(scope,idempotency_key),prior=data.dispatch_idempotency[id];
    if(prior){check(prior.scope===scope&&prior.key===idempotency_key&&prior.request_digest===request_digest,'IDEMPOTENCY_CONFLICT');return structuredClone(prior.response)}
    const attempt=data.dispatch_attempts[attempt_id],task=attempt&&data.dispatch_tasks[dispatchTaskKey(attempt.organization_id,attempt.task_id)],
      item=task?.dispatches.find(value=>value.dispatch_id===dispatch_id);check(attempt&&task&&item&&attempt.node_id===node_id&&attempt.dispatch_id===dispatch_id,
      'DISPATCH_EVENT_NOT_FOUND');check(attempt.dispatch_epoch===expected_epoch&&task.dispatch_epoch===expected_epoch,'DISPATCH_EPOCH_CHANGED');
    check(event_sequence===attempt.event_sequence+1,'DISPATCH_EVENT_SEQUENCE_MISMATCH');check(now<attempt.lease_expires_at,'DISPATCH_LEASE_EXPIRED');
    const timestamp=new Date(now).toISOString();
    if(kind==='started'){check(attempt.status==='CLAIMED'&&validTime(input.observed_started_at),'DISPATCH_EVENT_ORDER');attempt.status='RUNNING';
      item.status='RUNNING';attempt.observed_started_at=input.observed_started_at;attempt.lease_expires_at=now+120_000}
    else if(kind==='progress'){check(attempt.status==='RUNNING'&&validTime(input.observed_at),'DISPATCH_EVENT_ORDER');attempt.lease_expires_at=now+120_000}
    else {check(kind==='finished'&&attempt.status==='RUNNING'&&['SUCCEEDED','FAILED'].includes(input.status)&&validHash(input.result_digest)&&
      validHash(input.evidence_digest)&&validTime(input.observed_finished_at),'DISPATCH_EVENT_ORDER');attempt.status=input.status;item.status=input.status;
      attempt.observed_finished_at=input.observed_finished_at;attempt.result_digest=input.result_digest;attempt.evidence_digest=input.evidence_digest;
      if(input.status==='SUCCEEDED'){const next=task.dispatches[item.index+1];if(next){next.predecessor_result_digest=input.result_digest;
          next.predecessor_evidence_digest=input.evidence_digest;next.status='QUEUED'}else task.status='SUCCEEDED'}
      else {task.status='FAILED';for(const later of task.dispatches)if(later.status==='WAITING_DEPENDENCY')later.status='BLOCKED'}}
    attempt.event_sequence=event_sequence;attempt.updated_at=timestamp;task.updated_at=timestamp;
    const response={task:dispatchPublicTask(task,attemptsForTask(data,task)),attempt:structuredClone(attempt)};
    data.dispatch_idempotency[id]={scope,key:idempotency_key,request_digest,response:structuredClone(response)};return response});
  return {
    user:id=>load().users[String(id)]??null,users:()=>Object.values(load().users).map(value=>structuredClone(value)),
    organizations:()=>Object.values(load().organizations).map(value=>structuredClone(value)),
    organizationsForUser(id){const data=load(),githubId=String(id);return Object.values(data.memberships).filter(value=>value.github_id===githubId)
      .map(value=>({...structuredClone(data.organizations[value.organization_id]),role:value.role})).sort((left,right)=>left.organization_id.localeCompare(right.organization_id))},
    providerConnections(organizationId){const data=load();check(validOrganizationId(organizationId)&&data.organizations[organizationId],'UNKNOWN_ORGANIZATION');
      return Object.values(data.provider_connections).filter(value=>value.organization_id===organizationId).map(value=>structuredClone(value))
        .sort((left,right)=>left.created_at.localeCompare(right.created_at)||left.connection_id.localeCompare(right.connection_id))},
    models(organizationId){const data=load();check(validOrganizationId(organizationId)&&data.organizations[organizationId],'UNKNOWN_ORGANIZATION');
      return Object.values(data.models).filter(value=>value.organization_id===organizationId).map(value=>structuredClone(value))
        .sort((left,right)=>left.created_at.localeCompare(right.created_at)||left.model_id.localeCompare(right.model_id))},
    nodes(organizationId){const data=load();check(validOrganizationId(organizationId)&&data.organizations[organizationId],'UNKNOWN_ORGANIZATION');
      return Object.values(data.nodes).filter(value=>value.organization_id===organizationId).map(({credential_hash:_,...value})=>structuredClone(value))
        .sort((left,right)=>left.created_at.localeCompare(right.created_at)||left.node_id.localeCompare(right.node_id))},
    authenticateNode(credential){const data=load();check(safeText(credential,64)&&credential.startsWith('agt_'),'INVALID_AGENT_CREDENTIAL');
      const hashed=createHash('sha256').update(credential).digest('hex'),node=Object.values(data.nodes).find(value=>{const left=Buffer.from(value.credential_hash,'hex'),
        right=Buffer.from(hashed,'hex');return left.length===right.length&&timingSafeEqual(left,right)});check(node&&node.status==='active','INVALID_AGENT_CREDENTIAL');
      const {credential_hash:_,...publicValue}=node;return structuredClone(publicValue)},
    orchestrationProfile(organizationId){const data=load();check(validOrganizationId(organizationId)&&data.organizations[organizationId],'UNKNOWN_ORGANIZATION');
      return data.orchestration_profiles[organizationId]?structuredClone(data.orchestration_profiles[organizationId]):null},
    dispatchEpoch(organizationId){const data=load();check(validOrganizationId(organizationId)&&data.organizations[organizationId],'UNKNOWN_ORGANIZATION');
      return data.dispatch_epochs[organizationId]},
    dispatchTasks(organizationId,now=Date.now()){return update(data=>{check(validOrganizationId(organizationId)&&data.organizations[organizationId],'UNKNOWN_ORGANIZATION');
      reconcileData(data,organizationId,now);return Object.values(data.dispatch_tasks).filter(task=>task.organization_id===organizationId)
        .sort((left,right)=>left.created_at.localeCompare(right.created_at)||left.task_id.localeCompare(right.task_id)).map(task=>{
          const approval=approvalForTask(data,task);return {...dispatchPublicTask(task,attemptsForTask(data,task)),approval_consumed:Boolean(approval?.consumed_at)}})})},
    createDispatchTask({organization_id,task_id,objective,profile_revision,roles,assignment,created_by,idempotency_key,now=Date.now()}){return update(data=>{
      check(validOrganizationId(organization_id)&&data.organizations[organization_id]&&safeKey(idempotency_key),'INVALID_DISPATCH_TASK');
      const request_digest=canonicalDigest({organization_id,task_id,objective,profile_revision,roles,assignment,created_by}),scope=`${organization_id}:create`,key=idempotencyId(scope,idempotency_key),prior=data.dispatch_idempotency[key];
      if(prior){check(prior.scope===scope&&prior.key===idempotency_key&&prior.request_digest===request_digest,'IDEMPOTENCY_CONFLICT');return structuredClone(prior.response)}
      check(data.orchestration_profiles[organization_id]?.revision===profile_revision,'ORCHESTRATION_PROFILE_CHANGED');
      const task=buildDispatchTask({organization_id,task_id,objective,profile_revision,roles,assignment,dispatch_epoch:data.dispatch_epochs[organization_id],created_by,now});
      const taskKey=dispatchTaskKey(organization_id,task_id);check(!data.dispatch_tasks[taskKey],'DISPATCH_TASK_ALREADY_EXISTS');data.dispatch_tasks[taskKey]=task;
      const response={task:dispatchPublicTask(task)};data.dispatch_idempotency[key]={scope,key:idempotency_key,request_digest,response:structuredClone(response)};return response})},
    approveDispatchTask({organization_id,task_id,expected_task_digest,approval_id,approved_by,ttl_ms,idempotency_key,now=Date.now()}){return update(data=>{
      check(validOrganizationId(organization_id)&&data.organizations[organization_id]&&safeKey(idempotency_key),'INVALID_DISPATCH_APPROVAL');
      const request_digest=canonicalDigest({organization_id,task_id,expected_task_digest,approval_id,approved_by,ttl_ms}),scope=`${organization_id}:approve`,key=idempotencyId(scope,idempotency_key),prior=data.dispatch_idempotency[key];
      if(prior){check(prior.scope===scope&&prior.key===idempotency_key&&prior.request_digest===request_digest,'IDEMPOTENCY_CONFLICT');return structuredClone(prior.response)}
      const task=data.dispatch_tasks[dispatchTaskKey(organization_id,task_id)];check(task,'DISPATCH_TASK_NOT_FOUND');check(task.task_digest===expected_task_digest,'TASK_DIGEST_MISMATCH');
      check(task.status==='AWAITING_APPROVAL','DISPATCH_TASK_NOT_APPROVABLE');check(data.orchestration_profiles[organization_id]?.revision===task.profile_revision,
        'ORCHESTRATION_PROFILE_CHANGED');check(data.dispatch_epochs[organization_id]===task.dispatch_epoch,'DISPATCH_EPOCH_CHANGED');
      const approval=dispatchApproval({approval_id,task,approved_by,ttl_ms,now}),approvalKey=dispatchApprovalKey(organization_id,approval_id);
      check(!data.dispatch_approvals[approvalKey],'DISPATCH_APPROVAL_ALREADY_EXISTS');data.dispatch_approvals[approvalKey]=approval;
      task.status='QUEUED';task.dispatches[0].status='QUEUED';task.updated_at=new Date(now).toISOString();
      const response={task:dispatchPublicTask(task),approval:structuredClone(approval)};data.dispatch_idempotency[key]={scope,key:idempotency_key,request_digest,response:structuredClone(response)};return response})},
    claimDispatch({node_id,idempotency_key,now=Date.now()}){return update(data=>{const node=data.nodes[node_id];check(node&&safeKey(idempotency_key)&&
      Number.isSafeInteger(now)&&now>=0,'INVALID_DISPATCH_CLAIM');reconcileData(data,node.organization_id,now);check(onlineAt(node,now),'NODE_UNAVAILABLE');
      const request_digest=canonicalDigest({node_id}),scope=`${node_id}:claim`,id=idempotencyId(scope,idempotency_key),prior=data.dispatch_idempotency[id];
      if(prior){check(prior.scope===scope&&prior.key===idempotency_key&&prior.request_digest===request_digest,'IDEMPOTENCY_CONFLICT');
        check(prior.response.attempt.dispatch_epoch===data.dispatch_epochs[node.organization_id],'DISPATCH_EPOCH_CHANGED');return structuredClone(prior.response)}
      const candidates=Object.values(data.dispatch_tasks).filter(task=>task.organization_id===node.organization_id&&['QUEUED','ACTIVE'].includes(task.status))
        .flatMap(task=>task.dispatches.filter(item=>item.status==='QUEUED'&&item.node_id===node_id).map(item=>({task,item})))
        .sort((left,right)=>left.task.created_at.localeCompare(right.task.created_at)||left.item.index-right.item.index);
      check(candidates.length>0,'NO_ELIGIBLE_DISPATCH');const {task,item}=candidates[0];check(task.dispatch_epoch===data.dispatch_epochs[node.organization_id],
        'DISPATCH_EPOCH_CHANGED');check(data.orchestration_profiles[node.organization_id]?.revision===task.profile_revision,'ORCHESTRATION_PROFILE_CHANGED');
      let approval=approvalForTask(data,task,{consumed:item.role!=='head'});check(approval,'DISPATCH_APPROVAL_NOT_FOUND');
      if(item.role==='head'){check(approval.expires_at>now,'DISPATCH_APPROVAL_EXPIRED');approval.consumed_at=now;approval.activation_receipt=canonicalDigest({
        approval_digest:approval.approval_digest,consumed_at:now,node_id,dispatch_id:item.dispatch_id,dispatch_epoch:task.dispatch_epoch});task.status='ACTIVE'}
      check(approval.activation_receipt,'DISPATCH_APPROVAL_NOT_CONSUMED');const attempt_id=`attempt-${randomUUID()}`,timestamp=new Date(now).toISOString();
      const attempt={schema_version:1,attempt_id,organization_id:task.organization_id,task_id:task.task_id,dispatch_id:item.dispatch_id,role:item.role,node_id,
        approval_id:approval.approval_id,approval_digest:approval.approval_digest,activation_receipt:approval.activation_receipt,dispatch_epoch:task.dispatch_epoch,
        status:'CLAIMED',event_sequence:0,lease_started_at:now,lease_expires_at:now+120_000,observed_started_at:null,observed_finished_at:null,
        result_digest:null,evidence_digest:null,recovery_reason:null,created_at:timestamp,updated_at:timestamp};
      data.dispatch_attempts[attempt_id]=attempt;item.attempt_id=attempt_id;item.status='CLAIMED';task.updated_at=timestamp;
      const response={envelope:publicEnvelope(task,item),attempt:structuredClone(attempt),activation_receipt:approval.activation_receipt};
      data.dispatch_idempotency[id]={scope,key:idempotency_key,request_digest,response:structuredClone(response)};return response})},
    startDispatch(input){return roleEvent('started',{...input,now:input.now??Date.now()})},
    progressDispatch(input){return roleEvent('progress',{...input,now:input.now??Date.now()})},
    finishDispatch(input){return roleEvent('finished',{...input,now:input.now??Date.now()})},
    reconcileDispatches({organization_id,now=Date.now()}){return update(data=>{check(validOrganizationId(organization_id)&&data.organizations[organization_id],
      'UNKNOWN_ORGANIZATION');reconcileData(data,organization_id,now);return {organization_id,dispatch_epoch:data.dispatch_epochs[organization_id]}})},
    saveOrchestrationProfile({organization_id,mode,head_model_id,assignments}){return update(data=>{check(validOrganizationId(organization_id)&&
      data.organizations[organization_id]&&['automatic','manual'].includes(mode)&&assignments&&typeof assignments==='object'&&!Array.isArray(assignments)&&Object.keys(assignments).length===4&&
      ['planner','coder','reviewer','validator'].every(role=>Object.hasOwn(assignments,role)),'INVALID_ORCHESTRATION_PROFILE');
      const head=data.models[head_model_id];check(head?.organization_id===organization_id&&head.status==='active'&&
        (head.role_capabilities.includes('head')||head.role_capabilities.includes('general')),'INVALID_ORCHESTRATION_PROFILE');
      const normalized={};for(const role of ['planner','coder','reviewer','validator']){const assignment=assignments[role];
        if(mode==='automatic'){check(assignment===null,'INVALID_ORCHESTRATION_PROFILE');normalized[role]=null;continue}
        if(assignment===null){normalized[role]=null;continue}const model=data.models[assignment?.model_id],node=data.nodes[assignment?.node_id],connection=data.provider_connections[model?.connection_id];
        check(assignment&&Object.keys(assignment).length===2&&model?.organization_id===organization_id&&model.status==='active'&&
          (model.role_capabilities.includes(role)||model.role_capabilities.includes('general'))&&node?.organization_id===organization_id&&
          node.status==='active'&&node.adapters.includes(connection?.provider_id),'INVALID_ORCHESTRATION_PROFILE');normalized[role]={model_id:model.model_id,node_id:node.node_id}}
      const prior=data.orchestration_profiles[organization_id],now=new Date().toISOString();data.orchestration_profiles[organization_id]={organization_id,mode,
        head_model_id,assignments:normalized,revision:(prior?.revision??0)+1,created_at:prior?.created_at??now,updated_at:now};
      return structuredClone(data.orchestration_profiles[organization_id])})},
    createNodeEnrollment({organization_id,display_name,now=Date.now()}){return update(data=>{check(validOrganizationId(organization_id)&&
      data.organizations[organization_id]&&safeText(display_name,128)&&display_name.trim()===display_name&&Number.isSafeInteger(now)&&now>=0,'INVALID_NODE_ENROLLMENT');
      const enrollment_id=`enrollment-${randomUUID()}`,token=`enr_${randomBytes(32).toString('base64url')}`,created_at=new Date(now).toISOString();
      data.node_enrollments[enrollment_id]={enrollment_id,organization_id,display_name,token_hash:createHash('sha256').update(token).digest('hex'),status:'pending',
        expires_at:Math.floor(now/1000)+600,created_at,consumed_at:null,node_id:null};const {token_hash:_,...enrollment}=data.node_enrollments[enrollment_id];
      return {token,enrollment:structuredClone(enrollment)}})},
    enrollNode({token,capabilities,now=Date.now()}){return update(data=>{check(safeText(token,64)&&token.startsWith('enr_')&&Number.isSafeInteger(now)&&now>=0,
      'INVALID_ENROLLMENT_TOKEN');const digest=createHash('sha256').update(token).digest('hex'),enrollment=Object.values(data.node_enrollments).find(value=>{
        const left=Buffer.from(value.token_hash,'hex'),right=Buffer.from(digest,'hex');return left.length===right.length&&timingSafeEqual(left,right)});
      check(enrollment&&enrollment.status==='pending'&&enrollment.expires_at>Math.floor(now/1000),'INVALID_ENROLLMENT_TOKEN');validateCapabilities(capabilities);
      const node_id=`node-${randomUUID()}`,credential=`agt_${randomBytes(32).toString('base64url')}`,timestamp=new Date(now).toISOString();
      data.nodes[node_id]={node_id,organization_id:enrollment.organization_id,display_name:enrollment.display_name,
        credential_hash:createHash('sha256').update(credential).digest('hex'),status:'active',...structuredClone(capabilities),last_seen_at:timestamp,
        created_at:timestamp,updated_at:timestamp};enrollment.status='consumed';enrollment.consumed_at=timestamp;enrollment.node_id=node_id;
      const {credential_hash:_,...node}=data.nodes[node_id];return {credential,node:structuredClone(node)}})},
    heartbeatNode({credential,capabilities,now=Date.now()}){return update(data=>{check(safeText(credential,64)&&credential.startsWith('agt_')&&
      Number.isSafeInteger(now)&&now>=0,'INVALID_AGENT_CREDENTIAL');const digest=createHash('sha256').update(credential).digest('hex'),node=Object.values(data.nodes).find(value=>{
        const left=Buffer.from(value.credential_hash,'hex'),right=Buffer.from(digest,'hex');return left.length===right.length&&timingSafeEqual(left,right)});
      check(node&&node.status==='active','INVALID_AGENT_CREDENTIAL');validateCapabilities(capabilities);Object.assign(node,structuredClone(capabilities));
      node.last_seen_at=new Date(now).toISOString();node.updated_at=node.last_seen_at;const {credential_hash:_,...publicNode}=node;return structuredClone(publicNode)})},
    createProviderConnection({organization_id,provider_id,display_name}){return update(data=>{check(validOrganizationId(organization_id)&&
      data.organizations[organization_id]&&isProviderId(provider_id)&&safeText(display_name,128)&&display_name.trim()===display_name,'INVALID_PROVIDER_CONNECTION');
      const existing=Object.values(data.provider_connections).find(value=>value.organization_id===organization_id&&value.provider_id===provider_id&&
        value.display_name.toLocaleLowerCase('en-US')===display_name.toLocaleLowerCase('en-US'));
      if(existing)return {changed:false,connection:structuredClone(existing)};const now=new Date().toISOString(),connection_id=`pc-${randomUUID()}`;
      data.provider_connections[connection_id]={connection_id,organization_id,provider_id,display_name,secret_location:'customer_agent',
        status:'pending_agent',agent_id:null,created_at:now,updated_at:now};return {changed:true,connection:structuredClone(data.provider_connections[connection_id])}})},
    createModel({organization_id,connection_id,provider_model_id,display_name,role_capabilities}){return update(data=>{const connection=data.provider_connections[connection_id];
      check(validOrganizationId(organization_id)&&connection?.organization_id===organization_id&&safeModelReference(provider_model_id)&&
        safeText(display_name,128)&&display_name.trim()===display_name&&Array.isArray(role_capabilities)&&role_capabilities.length>0&&role_capabilities.length<=8&&
        new Set(role_capabilities).size===role_capabilities.length&&role_capabilities.every(value=>['head','planner','coder','reviewer','validator','general'].includes(value)),
      'INVALID_MODEL');const existing=Object.values(data.models).find(value=>value.organization_id===organization_id&&value.connection_id===connection_id&&
        value.provider_model_id===provider_model_id);if(existing){check(existing.display_name===display_name&&
          JSON.stringify(existing.role_capabilities)===JSON.stringify(role_capabilities),'MODEL_ALREADY_EXISTS');return {changed:false,model:structuredClone(existing)}}
      const now=new Date().toISOString(),model_id=`model-${randomUUID()}`;data.models[model_id]={model_id,organization_id,connection_id,provider_model_id,
        display_name,role_capabilities,status:'active',created_at:now,updated_at:now};return {changed:true,model:structuredClone(data.models[model_id])}})},
    billingRequest:id=>load().billing_requests[String(id)]??null,
    upsertIdentity(identity){return update(data=>{const id=String(identity.github_id),prior=data.users[id];check(validId(id)&&safeText(identity.login,128),'INVALID_GITHUB_IDENTITY');
      data.users[id]={github_id:id,login:identity.login,avatar_url:identity.avatar_url??null,billing_provider:prior?.billing_provider??null,
        billing_customer_id:prior?.billing_customer_id??null,billing_subscription_id:prior?.billing_subscription_id??null,
        subscription_status:prior?.subscription_status??null,current_period_end:prior?.current_period_end??null,updated_at:new Date().toISOString(),
        plan_id:prior?.plan_id??null};
      const organization_id=`org-${id}`,membership_id=`${organization_id}:${id}`;if(!data.organizations[organization_id]){
        const now=data.users[id].updated_at;data.organizations[organization_id]={organization_id,name:`${identity.login} Workspace`,slug:`github-${id}`,created_at:now,updated_at:now}}
      if(!data.dispatch_epochs[organization_id])data.dispatch_epochs[organization_id]=1;
      if(!data.memberships[membership_id])data.memberships[membership_id]={organization_id,github_id:id,role:'owner',created_at:data.users[id].updated_at};
      return structuredClone(data.users[id])})},
    createBillingRequest(request){return update(data=>{check(safeText(request.request_id,128)&&validId(String(request.github_id))&&
      PROVIDERS.has(request.provider)&&Number.isSafeInteger(request.expected_price)&&request.expected_price>=0&&isPaidPlan(request.plan_id)&&
      data.users[String(request.github_id)]&&
      !data.billing_requests[request.request_id],'INVALID_BILLING_REQUEST');const now=new Date().toISOString();
      data.billing_requests[request.request_id]={request_id:request.request_id,github_id:String(request.github_id),provider:request.provider,
        expected_price:request.expected_price,plan_id:request.plan_id,subscription_id:null,status:'pending',created_at:now,updated_at:now};
      return structuredClone(data.billing_requests[request.request_id])})},
    attachBillingSubscription({request_id,subscription_id}){return update(data=>{const request=data.billing_requests[request_id];
      check(request&&safeText(subscription_id,128)&&(request.subscription_id===null||request.subscription_id===subscription_id),'INVALID_BILLING_REQUEST');
      request.subscription_id=subscription_id;request.updated_at=new Date().toISOString();return structuredClone(request)})},
    applySubscription({event_id,provider,github_id,customer_id,subscription_id,status,current_period_end,plan_id,request_id=null}){return update(data=>{
      check(safeText(event_id,256)&&PROVIDERS.has(provider)&&validId(String(github_id))&&nullableText(customer_id,128)&&safeText(subscription_id,128)&&
        SUBSCRIPTION.has(status)&&isPaidPlan(plan_id)&&(current_period_end===null||(Number.isSafeInteger(current_period_end)&&current_period_end>=0)),
      'INVALID_SUBSCRIPTION_EVENT');
      if(data.processed_webhook_ids.includes(event_id))return {changed:false};const user=data.users[String(github_id)];check(user,'UNKNOWN_SUBSCRIPTION_USER');
      if(request_id!==null){const request=data.billing_requests[request_id];check(request&&request.github_id===String(github_id)&&request.provider===provider&&
        request.plan_id===plan_id&&(request.subscription_id===null||request.subscription_id===subscription_id),'INVALID_BILLING_REQUEST');request.subscription_id=subscription_id;
        request.status=status;request.updated_at=new Date().toISOString()}
      user.billing_provider=provider;user.billing_customer_id=customer_id;user.billing_subscription_id=subscription_id;
      user.subscription_status=status;user.current_period_end=current_period_end;user.plan_id=plan_id;user.updated_at=new Date().toISOString();
      data.processed_webhook_ids.push(event_id);data.processed_webhook_ids=data.processed_webhook_ids.slice(-1000);return {changed:true}})},
    entitlement(id){const user=load().users[String(id)];return subscriptionEntitlement({status:user?.subscription_status??'none',
      plan_id:user?.plan_id??null,current_period_end:user?.current_period_end??null})}
  };
}
