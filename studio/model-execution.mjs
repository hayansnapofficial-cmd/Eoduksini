import { digest } from '../core/contracts.mjs';

const HASH=/^[0-9a-f]{64}$/,check=(condition,reason)=>{if(!condition)throw new Error(reason)};
const safe=(value,max=256)=>typeof value==='string'&&value.length>0&&value.length<=max&&value.isWellFormed()&&value.trim()===value&&
  !/[\u0000-\u001f\u007f]/.test(value);
const exact=(value,keys,reason)=>check(value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&
  keys.every(key=>Object.hasOwn(value,key)),reason);
const plainCopy=(input,keys,reason)=>{check(input&&typeof input==='object'&&!Array.isArray(input)&&Object.getPrototypeOf(input)===Object.prototype,reason);
  const descriptors=Object.getOwnPropertyDescriptors(input),names=Reflect.ownKeys(descriptors);check(names.length===keys.length&&names.every(name=>typeof name==='string'&&
    keys.includes(name)&&Object.hasOwn(descriptors[name],'value')&&descriptors[name].enumerable),reason);return structuredClone(input)};
const BINDING_KEYS=['dispatch_id','role','node_id','model_id','connection_id','provider_id','provider_model_id','config_digest','adapter_version'];
const RECEIPT_KEYS=['schema_version','organization_id','task_id','dispatch_id','attempt_id','dispatch_epoch','activation_receipt','binding','prompt_digest',
  'response_digest','model_revision','status','failure_reason','input_tokens','output_tokens','usage_status','started_at','finished_at'];

export function executionBindingContract(input) {
  const value=plainCopy(input,BINDING_KEYS,'INVALID_EXECUTION_BINDING');exact(value,BINDING_KEYS,'INVALID_EXECUTION_BINDING');
  check(BINDING_KEYS.filter(key=>!['config_digest'].includes(key)).every(key=>safe(value[key]))&&HASH.test(value.config_digest)&&
    ['head','planner','coder','reviewer','validator'].includes(value.role),'INVALID_EXECUTION_BINDING');return value;
}

export function buildExecutionBindings({task,models,connections}) {
  check(task&&Array.isArray(task.dispatches)&&Array.isArray(models)&&Array.isArray(connections),'INVALID_EXECUTION_BINDINGS');
  return task.dispatches.map(item=>{const model=models.find(value=>value.model_id===item.model_id);
    check(model?.organization_id===task.organization_id&&model.status==='active','EXECUTION_MODEL_BINDING_INVALID');
    const connection=connections.find(value=>value.connection_id===model.connection_id);
    check(connection?.organization_id===task.organization_id&&connection.provider_id===item.provider_id&&connection.status==='ready'&&
      connection.agent_id===item.node_id&&HASH.test(connection.config_digest??'')&&safe(connection.adapter_version,32),'EXECUTION_CONNECTION_NOT_READY');
    return executionBindingContract({dispatch_id:item.dispatch_id,role:item.role,node_id:item.node_id,model_id:item.model_id,
      connection_id:connection.connection_id,provider_id:item.provider_id,provider_model_id:model.provider_model_id,
      config_digest:connection.config_digest,adapter_version:connection.adapter_version})});
}

const PROMPT_KEYS=['organization_id','task_id','dispatch_id','role','objective','task_digest','role_graph_digest','assignment_digest','profile_revision',
  'dispatch_epoch','predecessor_result_digest','predecessor_evidence_digest'];
export function executionPrompt(envelope) {
  check(envelope&&PROMPT_KEYS.every(key=>Object.hasOwn(envelope,key)),'INVALID_EXECUTION_PROMPT');const value=Object.fromEntries(PROMPT_KEYS.map(key=>[key,envelope[key]]));
  check(PROMPT_KEYS.slice(0,8).every(key=>safe(value[key],key==='objective'?2000:256))&&Number.isSafeInteger(value.profile_revision)&&
    Number.isSafeInteger(value.dispatch_epoch)&&[value.predecessor_result_digest,value.predecessor_evidence_digest].every(item=>item===null||HASH.test(item)),
  'INVALID_EXECUTION_PROMPT');return JSON.stringify({instruction:'Complete only the assigned role. Return a bounded textual result.',...value});
}
export const executionPromptDigest=envelope=>digest(executionPrompt(envelope));

const receiptEvidence=value=>digest(Object.fromEntries(RECEIPT_KEYS.map(key=>[key,value[key]])));

export function executionReceiptContract(input) {
  const hasEvidence=input&&Object.hasOwn(input,'evidence_digest'),value=plainCopy(input,hasEvidence?[...RECEIPT_KEYS,'evidence_digest']:RECEIPT_KEYS,
    'INVALID_EXECUTION_RECEIPT');
  exact(value,hasEvidence?[...RECEIPT_KEYS,'evidence_digest']:RECEIPT_KEYS,'INVALID_EXECUTION_RECEIPT');
  check(value.schema_version===1&&safe(value.organization_id,64)&&safe(value.task_id,128)&&safe(value.dispatch_id,256)&&safe(value.attempt_id,128)&&
    Number.isSafeInteger(value.dispatch_epoch)&&value.dispatch_epoch>=1&&HASH.test(value.activation_receipt)&&HASH.test(value.prompt_digest)&&
    HASH.test(value.response_digest)&&(value.model_revision===null||safe(value.model_revision,256))&&['SUCCEEDED','FAILED'].includes(value.status)&&
    ['OBSERVED','MISSING'].includes(value.usage_status)&&
    safe(value.started_at,32)&&safe(value.finished_at,32)&&Number.isFinite(Date.parse(value.started_at))&&Number.isFinite(Date.parse(value.finished_at))&&
    Date.parse(value.finished_at)>=Date.parse(value.started_at),'INVALID_EXECUTION_RECEIPT');
  value.binding=executionBindingContract(value.binding);
  if(value.status==='SUCCEEDED')check(value.failure_reason===null&&value.model_revision!==null&&value.usage_status==='OBSERVED'&&Number.isSafeInteger(value.input_tokens)&&
    value.input_tokens>=0&&Number.isSafeInteger(value.output_tokens)&&value.output_tokens>=0,'INVALID_EXECUTION_RECEIPT');
  else check(safe(value.failure_reason,128)&&value.model_revision===null&&value.usage_status==='MISSING'&&value.input_tokens===null&&
    value.output_tokens===null,'INVALID_EXECUTION_RECEIPT');
  const evidence_digest=receiptEvidence(value);if(hasEvidence)check(value.evidence_digest===evidence_digest,'EXECUTION_EVIDENCE_MISMATCH');
  return {...value,evidence_digest};
}
