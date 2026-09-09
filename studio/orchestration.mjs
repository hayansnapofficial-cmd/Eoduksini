import { createHash } from 'node:crypto';

const ROLES=Object.freeze(['planner','coder','reviewer','validator']);
const taskId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const check=(condition,reason)=>{if(!condition)throw new Error(reason)};
const compareText=(left,right)=>left<right?-1:left>right?1:0;
const canonical=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?
  Object.fromEntries(Object.entries(item).sort(([left],[right])=>compareText(left,right))):item);
const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
const online=(node,now)=>node.status==='active'&&node.last_seen_at!==null&&now-Date.parse(node.last_seen_at)<=90_000&&now>=Date.parse(node.last_seen_at);

function candidates(role,{organizationId,connections,models,nodes,now}) {
  const connectionById=new Map(connections.filter(value=>value.organization_id===organizationId&&value.status!=='disabled')
    .map(value=>[value.connection_id,value]));
  const out=[];
  for(const model of models) {
    if(model.organization_id!==organizationId||model.status!=='active'||
      (!model.role_capabilities.includes(role)&&!model.role_capabilities.includes('general')))continue;
    const connection=connectionById.get(model.connection_id);if(!connection)continue;
    for(const node of nodes)if(node.organization_id===organizationId&&online(node,now)&&node.adapters.includes(connection.provider_id))out.push({
      model_id:model.model_id,node_id:node.node_id,provider_id:connection.provider_id,
      capability:model.role_capabilities.includes(role)?'exact':'general',cpu_logical:node.cpu_logical,memory_bytes:node.memory_bytes,
      node_last_seen_at:node.last_seen_at
    });
  }
  return out.sort((left,right)=>(left.capability==='exact'?0:1)-(right.capability==='exact'?0:1)||
    right.cpu_logical-left.cpu_logical||right.memory_bytes-left.memory_bytes||compareText(left.model_id,right.model_id)||compareText(left.node_id,right.node_id));
}

const assignment=(value,source)=>value?{model_id:value.model_id,node_id:value.node_id,provider_id:value.provider_id,source,
  reason_codes:[value.capability==='exact'?'ROLE_CAPABILITY_EXACT':'GENERAL_CAPABILITY_FALLBACK','NODE_ONLINE','ADAPTER_AVAILABLE'],
  evidence:{node_last_seen_at:value.node_last_seen_at,cpu_logical:value.cpu_logical,memory_bytes:value.memory_bytes}}:null;

export function resolveOrchestrationAssignment({organization_id,task_id,expected_profile_revision,roles,profile,connections,models,nodes,now=Date.now()}) {
  check(typeof organization_id==='string'&&organization_id.length<=64&&taskId(task_id)&&Number.isSafeInteger(expected_profile_revision)&&expected_profile_revision>=1&&
    Array.isArray(roles)&&roles.length>0&&roles.length<=ROLES.length&&new Set(roles).size===roles.length&&roles.every(role=>ROLES.includes(role))&&
    Number.isSafeInteger(now)&&now>=0,'INVALID_ORCHESTRATION_ASSIGNMENT');
  check(profile?.organization_id===organization_id,'ORCHESTRATION_PROFILE_REQUIRED');
  check(profile.revision===expected_profile_revision,'ORCHESTRATION_PROFILE_CHANGED');
  const context={organizationId:organization_id,connections,models,nodes,now},issues=[],resolved={};
  const headCandidates=candidates('head',{...context,models:models.map(model=>model.model_id===profile.head_model_id?
    {...model,role_capabilities:[...new Set([...model.role_capabilities,'head'])]}:{...model,role_capabilities:[]})});
  const head=assignment(headCandidates[0]??null,'profile_head');
  if(!head)issues.push({code:'HEAD_MODEL_UNAVAILABLE',role:'head'});
  for(const role of roles) {
    const available=candidates(role,context);let chosen=null,source=profile.mode;
    if(profile.mode==='manual') {
      const fixed=profile.assignments[role];chosen=available.find(value=>value.model_id===fixed?.model_id&&value.node_id===fixed?.node_id)??null;
      if(!fixed)issues.push({code:'MANUAL_ASSIGNMENT_REQUIRED',role});
      else if(!chosen)issues.push({code:'MANUAL_ASSIGNMENT_UNAVAILABLE',role});
    } else {
      chosen=available[0]??null;
      if(!chosen)issues.push({code:'NO_ELIGIBLE_ASSIGNMENT',role});
    }
    resolved[role]=assignment(chosen,source);
  }
  const coder=resolved.coder;
  for(const role of ['reviewer','validator'])if(resolved[role]&&coder&&
    (resolved[role].model_id===coder.model_id||resolved[role].node_id===coder.node_id)) {
    if(profile.mode==='automatic') {
      const alternative=candidates(role,context).find(value=>value.model_id!==coder.model_id&&value.node_id!==coder.node_id);
      if(alternative)resolved[role]=assignment(alternative,'automatic');
      else {resolved[role]=null;issues.push({code:'INDEPENDENT_ASSIGNMENT_REQUIRED',role})}
    } else {resolved[role]=null;issues.push({code:'INDEPENDENT_ASSIGNMENT_REQUIRED',role})}
  }
  const decision={schema_version:1,organization_id,task_id,profile_revision:profile.revision,mode:profile.mode,head_assignment:head,
    assignments:resolved,status:issues.length?'MANUAL_REVIEW_REQUIRED':'READY',issues,
    optimization_limits:['COST_POLICY_NOT_CONFIGURED','PRIVACY_POLICY_NOT_CONFIGURED'],
    authority:{model_execution:false,remote_worker_execution:false,repository_write:false,approval:false,git_publish:false,deployment:false}};
  return {...decision,decision_digest:digest(decision),evaluated_at:new Date(now).toISOString()};
}

export const orchestrationRoles=ROLES;
