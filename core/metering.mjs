import { canonical, digest, validate } from './contracts.mjs';
import { adoptionEventContract, costEventContract, energyEventContract, reviewEventContract } from './postrun.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const INTEGER_STRING=/^(0|[1-9][0-9]*)$/;
const check=(condition,reason='INVALID_METERING_RECORD')=>{if(!condition) throw new Error(reason);};
const identifier=value=>typeof value==='string' && ID.test(value) && !['constructor','prototype','__proto__'].includes(value);
const nodeIdentifier=value=>typeof value==='string' && value.length>0 && value.length<=128 && value.isWellFormed() && !/[\x00-\x1f]/.test(value);
const sorted=values=>[...new Set(values)].sort();
const utc=milliseconds=>new Date(milliseconds).toISOString();

// Contracts are public helpers. Reject accessors, exotic prototypes and cycles
// before AJV or any local validation evaluates caller-controlled properties.
function inspect(value,seen=new Set()) {
  if(value===null || typeof value==='boolean') return;
  if(typeof value==='string') { check(value.isWellFormed(),'INVALID_JSON_INPUT'); return; }
  if(typeof value==='number') { check(Number.isFinite(value),'INVALID_JSON_INPUT'); return; }
  check(typeof value==='object' && !seen.has(value),'INVALID_JSON_INPUT');
  const array=Array.isArray(value);
  check(Object.getPrototypeOf(value)===(array?Array.prototype:Object.prototype),'INVALID_JSON_INPUT');
  seen.add(value);
  const descriptors=Object.getOwnPropertyDescriptors(value),keys=Reflect.ownKeys(descriptors);
  check(keys.every(key=>typeof key==='string'),'INVALID_JSON_INPUT');
  if(array) {
    check(keys.length===value.length+1,'INVALID_JSON_INPUT');
    for(let index=0;index<value.length;index++) check(Object.hasOwn(descriptors,String(index)),'INVALID_JSON_INPUT');
  }
  for(const key of keys) {
    if(array && key==='length') continue;
    check(key.isWellFormed() && !['constructor','prototype','__proto__'].includes(key),'INVALID_JSON_INPUT');
    const descriptor=descriptors[key];
    check(Object.hasOwn(descriptor,'value') && descriptor.enumerable,'INVALID_JSON_INPUT');
    inspect(descriptor.value,seen);
  }
  seen.delete(value);
}

function exact(value,keys,reason='INVALID_METERING_RECORD') {
  check(value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length &&
    keys.every(key=>Object.hasOwn(value,key)),reason);
}
function time(value) {
  return typeof value==='string' && value.length<=32 && new Date(value).toISOString()===value;
}
function nullableNumber(value) { return value===null || (typeof value==='number' && Number.isFinite(value) && value>=0); }
function nullableIntegerString(value) { return value===null || (typeof value==='string' && value.length<=32 && INTEGER_STRING.test(value)); }
function usageContract(status,input,output,reason) {
  if(status==='OBSERVED')
    return Number.isSafeInteger(input) && input>=0 && Number.isSafeInteger(output) && output>=0 && reason===null;
  return input===null && output===null && typeof reason==='string' && reason.length>0 && reason.length<=128;
}

const COMMAND_KEYS=['command_index','node_id','boot_id','worker_started_at_utc','worker_finished_at_utc','monotonic_started_ns',
  'monotonic_finished_ns','execution_duration_ms','worker_cpu_user_seconds','worker_cpu_system_seconds','worker_memory_peak_bytes',
  'measurement_scope','measurement_method','measurement_completeness','missing_reasons'];
const INVOCATION_KEYS=['invocation_id','provider_kind','provider_endpoint_ref','inference_node_id','model_name',
  'model_digest_or_revision','inference_location','prompt_eval_count','eval_count',
  'total_duration_ns','load_duration_ns','prompt_eval_duration_ns','eval_duration_ns','response_complete','usage_status',
  'usage_missing_reason'];

export function invocationContract(value) {
  inspect(value);exact(value,INVOCATION_KEYS,'INVALID_MODEL_INVOCATION');
  check(identifier(value.invocation_id) && identifier(value.provider_kind) && identifier(value.provider_endpoint_ref) &&
    nodeIdentifier(value.inference_node_id) && typeof value.model_name==='string' &&
    value.model_name.length>0 && value.model_name.length<=128 && value.model_name.isWellFormed() &&
    typeof value.model_digest_or_revision==='string' && value.model_digest_or_revision.length>0 &&
    value.model_digest_or_revision.length<=128 && value.model_digest_or_revision.isWellFormed() &&
    ['LOCAL','REMOTE_PRIVATE','CLOUD','UNKNOWN'].includes(value.inference_location) &&
    nullableIntegerString(value.total_duration_ns) && nullableIntegerString(value.load_duration_ns) &&
    nullableIntegerString(value.prompt_eval_duration_ns) && nullableIntegerString(value.eval_duration_ns) &&
    typeof value.response_complete==='boolean' && usageContract(value.usage_status,value.prompt_eval_count,value.eval_count,
      value.usage_missing_reason) && (!value.response_complete || value.usage_status==='OBSERVED'),
  'INVALID_MODEL_INVOCATION');
  return structuredClone(value);
}

export function commandMeasurementContract(value) {
  inspect(value);
  exact(value,COMMAND_KEYS,'INVALID_COMMAND_MEASUREMENT');
  check(Number.isSafeInteger(value.command_index) && value.command_index>=0 && value.command_index<16 && nodeIdentifier(value.node_id) &&
    (value.boot_id===null || nodeIdentifier(value.boot_id)) && (value.worker_started_at_utc===null || time(value.worker_started_at_utc)) &&
    (value.worker_finished_at_utc===null || time(value.worker_finished_at_utc)) && nullableIntegerString(value.monotonic_started_ns) &&
    nullableIntegerString(value.monotonic_finished_ns) && nullableNumber(value.execution_duration_ms) &&
    nullableNumber(value.worker_cpu_user_seconds) && nullableNumber(value.worker_cpu_system_seconds) &&
    (value.worker_memory_peak_bytes===null || (Number.isSafeInteger(value.worker_memory_peak_bytes) && value.worker_memory_peak_bytes>=0)) &&
    ['DIRECT_CHILD','DIRECT_CHILD_TREE'].includes(value.measurement_scope) &&
    ['RUNNER_LIFECYCLE_ONLY','GNU_TIME_V1'].includes(value.measurement_method) &&
    ['PARTIAL','COMPLETE'].includes(value.measurement_completeness) && Array.isArray(value.missing_reasons) &&
    value.missing_reasons.every(reason=>typeof reason==='string' && reason.length>0 && reason.length<=128) &&
    canonical(sorted(value.missing_reasons))===canonical(value.missing_reasons),'INVALID_COMMAND_MEASUREMENT');
  check((value.worker_started_at_utc===null)===(value.monotonic_started_ns===null) &&
    (value.worker_finished_at_utc===null)===(value.monotonic_finished_ns===null) &&
    (value.execution_duration_ms===null)===(value.monotonic_started_ns===null || value.monotonic_finished_ns===null),
  'INVALID_COMMAND_MEASUREMENT');
  return structuredClone(value);
}

export function observedCommandMeasurement({command_index,node_id,boot_id=null,started_at=null,started_ns=null,
  finished_at=null,finished_ns=null}) {
  check(nodeIdentifier(node_id) && (boot_id===null || nodeIdentifier(boot_id)),'INVALID_METERING_IDENTITY');
  const missing=['CHILD_CPU_TIME_NOT_OBSERVED','CHILD_MEMORY_PEAK_NOT_OBSERVED'];
  if(boot_id===null) missing.push('BOOT_ID_NOT_OBSERVED');
  if(started_at===null || started_ns===null) missing.push('WORKER_START_NOT_OBSERVED');
  if(finished_at===null || finished_ns===null) missing.push('WORKER_FINISH_NOT_OBSERVED');
  let execution_duration_ms=null;
  if(started_ns!==null && finished_ns!==null) {
    const duration=BigInt(finished_ns)-BigInt(started_ns);
    check(duration>=0n,'INVALID_MONOTONIC_TIME'); execution_duration_ms=Number(duration)/1e6;
  }
  return commandMeasurementContract({command_index,node_id,boot_id,
    worker_started_at_utc:started_at===null?null:utc(started_at),worker_finished_at_utc:finished_at===null?null:utc(finished_at),
    monotonic_started_ns:started_ns,monotonic_finished_ns:finished_ns,execution_duration_ms,
    worker_cpu_user_seconds:null,worker_cpu_system_seconds:null,worker_memory_peak_bytes:null,
    measurement_scope:'DIRECT_CHILD',measurement_method:'RUNNER_LIFECYCLE_ONLY',measurement_completeness:'PARTIAL',
    missing_reasons:sorted(missing)});
}

export function attachCommandResources(measurement,{cpu_user_seconds,cpu_system_seconds,memory_peak_bytes}) {
  measurement=commandMeasurementContract(measurement);
  check(measurement.worker_started_at_utc!==null && measurement.worker_finished_at_utc!==null &&
    nullableNumber(cpu_user_seconds) && cpu_user_seconds!==null && nullableNumber(cpu_system_seconds) &&
    cpu_system_seconds!==null && Number.isSafeInteger(memory_peak_bytes) && memory_peak_bytes>=0,
  'INVALID_RESOURCE_MEASUREMENT');
  measurement.worker_cpu_user_seconds=cpu_user_seconds;
  measurement.worker_cpu_system_seconds=cpu_system_seconds;
  measurement.worker_memory_peak_bytes=memory_peak_bytes;
  measurement.measurement_scope='DIRECT_CHILD_TREE';
  measurement.measurement_method='GNU_TIME_V1';
  measurement.missing_reasons=measurement.missing_reasons.filter(reason=>
    !['CHILD_CPU_TIME_NOT_OBSERVED','CHILD_MEMORY_PEAK_NOT_OBSERVED'].includes(reason));
  measurement.measurement_completeness=measurement.missing_reasons.length?'PARTIAL':'COMPLETE';
  return commandMeasurementContract(measurement);
}

export function meteringRecordContract(value) {
  inspect(value);
  validate('metering-record',value);
  const copy=structuredClone(value);
  check(new Set(copy.invocations.map(item=>item.invocation_id)).size===copy.invocations.length,'INVALID_METERING_RECORD');
  copy.invocations=copy.invocations.map(invocationContract);
  check(usageContract(copy.model_usage_status,copy.model_input_tokens,copy.model_output_tokens,
    copy.model_usage_missing_reason),'INVALID_METERING_RECORD');
  copy.command_measurements=copy.command_measurements.map(commandMeasurementContract);
  if(Object.hasOwn(copy,'review_events')) copy.review_events=copy.review_events.map(reviewEventContract);
  if(Object.hasOwn(copy,'adoption_events')) copy.adoption_events=copy.adoption_events.map(adoptionEventContract);
  if(Object.hasOwn(copy,'cost_events')) copy.cost_events=copy.cost_events.map(costEventContract);
  if(Object.hasOwn(copy,'energy_events')) copy.energy_events=copy.energy_events.map(energyEventContract);
  for(const events of [copy.review_events??[],copy.adoption_events??[],copy.cost_events??[],copy.energy_events??[]])
    check(new Set(events.map(event=>event.event_id)).size===events.length,'INVALID_METERING_RECORD');
  const reviews=copy.review_events??[],adoptions=copy.adoption_events??[],costs=copy.cost_events??[],energies=copy.energy_events??[];
  const expectedReview=reviews.length?{PASS:'PASS',NEEDS_FIX:'NEEDS_FIX',REJECT:'REJECTED',BLOCKED:'BLOCKED'}
    [reviews.at(-1).review_result.verdict]:'PENDING';
  const expectedAdoption=adoptions.length?adoptions.at(-1).decision:'PENDING';
  check(copy.review_status===expectedReview && copy.adoption_status===expectedAdoption && costs.length<=1 && energies.length<=1,
    'INVALID_METERING_RECORD');
  if(costs.length) {
    const cost=costs[0],eligible=cost.price_basis.comparison_eligible;
    check(eligible?copy.api_cost_status==='ESTIMATED' && copy.estimated_api_avoided_currency===cost.price_basis.currency &&
      copy.estimated_api_avoided_cost===cost.estimated_cost_micros/1_000_000 && copy.api_cost_missing_reason===null:
      copy.api_cost_status==='NOT_COMPARABLE' && copy.estimated_api_avoided_cost===null &&
      copy.estimated_api_avoided_currency===null && copy.api_cost_missing_reason===cost.price_basis.missing_reason,
    'INVALID_METERING_RECORD');
  } else check(copy.api_cost_status==='INCOMPLETE' && copy.estimated_api_avoided_cost===null &&
    copy.estimated_api_avoided_currency===null && typeof copy.api_cost_missing_reason==='string','INVALID_METERING_RECORD');
  if(energies.length) {
    const energy=energies[0],priced=energy.tariff_basis_id!==null;
    check(copy.energy_status==='OBSERVED' && copy.energy_kwh===energy.allocated_energy_kwh &&
      (priced?copy.energy_cost===energy.energy_cost_micros/1_000_000 && copy.energy_currency===energy.tariff_currency &&
        copy.energy_missing_reason===null:copy.energy_cost===null && copy.energy_currency===null &&
        copy.energy_missing_reason==='NO_ENERGY_TARIFF'),'INVALID_METERING_RECORD');
  } else check(copy.energy_status==='INCOMPLETE' && copy.energy_kwh===null && copy.energy_cost===null &&
    copy.energy_currency===null && typeof copy.energy_missing_reason==='string','INVALID_METERING_RECORD');
  check(canonical(sorted(copy.missing_reasons))===canonical(copy.missing_reasons) &&
    copy.command_measurements.every((item,index)=>item.command_index===index),'INVALID_METERING_RECORD');
  return copy;
}

export function initialMeteringRecord(state,request,decidedAt) {
  const prior=Object.entries(state.attempts).filter(([id])=>state.approvals[id]?.request.task.task_id===request.task.task_id);
  const parent_attempt_id=prior.length?prior.at(-1)[0]:null,node_id=state.policy.quota.nodeId;
  check(nodeIdentifier(node_id),'INVALID_METERING_NODE');
  return meteringRecordContract({schema_version:1,project_id:request.project_id,task_id:request.task.task_id,
    root_task_id:request.task.task_id,attempt_id:request.attempt_id,parent_attempt_id,retry_index:prior.length,node_id,boot_id:null,
    routing_decision:{...(state.policy.routing??{reason_code:'DETERMINISTIC_TOOL_PREFERRED',
      chosen_provider_kind:'DETERMINISTIC_TOOL',decision_source:'CONTROLLER_COMMAND_POLICY'}),decided_at:utc(decidedAt)},
    worker_started_at_utc:null,worker_finished_at_utc:null,
    monotonic_started_ns:null,monotonic_finished_ns:null,execution_duration_ms:null,worker_cpu_user_seconds:null,
    worker_cpu_system_seconds:null,worker_memory_peak_bytes:null,measurement_scope:'DIRECT_CHILD',
    measurement_method:'RUNNER_LIFECYCLE_ONLY',measurement_completeness:'PARTIAL',missing_reasons:sorted([
      'BOOT_ID_NOT_OBSERVED','CHILD_CPU_TIME_NOT_OBSERVED','CHILD_MEMORY_PEAK_NOT_OBSERVED','NO_ENERGY_SENSOR',
      'NO_ELIGIBLE_PRICED_COUNTERFACTUAL','NO_MODEL_INVOCATION','WORKER_FINISH_NOT_OBSERVED','WORKER_START_NOT_OBSERVED']),
    execution_status:'PENDING',test_status:'NOT_RUN',review_status:'PENDING',integration_status:'NOT_SUBMITTED',adoption_status:'PENDING',
    model_input_tokens:null,model_output_tokens:null,model_usage_status:'NOT_APPLICABLE',
    model_usage_missing_reason:'NO_MODEL_INVOCATION',estimated_api_avoided_cost:null,estimated_api_avoided_currency:null,
    api_cost_status:'INCOMPLETE',api_cost_missing_reason:'NO_ELIGIBLE_PRICED_COUNTERFACTUAL',energy_kwh:null,energy_cost:null,
    energy_currency:null,energy_status:'INCOMPLETE',energy_missing_reason:'NO_ENERGY_SENSOR',result_digest:null,invocations:[],
    command_measurements:[],review_events:[],adoption_events:[],cost_events:[],energy_events:[]});
}

function aggregate(record) {
  const measurements=record.command_measurements,first=measurements.find(item=>item.worker_started_at_utc!==null),
    last=[...measurements].reverse().find(item=>item.worker_finished_at_utc!==null);
  record.worker_started_at_utc=first?.worker_started_at_utc??null;
  record.monotonic_started_ns=first?.monotonic_started_ns??null;
  record.worker_finished_at_utc=last?.worker_finished_at_utc??null;
  record.monotonic_finished_ns=last?.monotonic_finished_ns??null;
  record.boot_id=measurements.every(item=>item.boot_id===measurements[0]?.boot_id)?measurements[0]?.boot_id??null:null;
  record.execution_duration_ms=record.monotonic_started_ns!==null && record.monotonic_finished_ns!==null?
    Number(BigInt(record.monotonic_finished_ns)-BigInt(record.monotonic_started_ns))/1e6:null;
  const completeResources=measurements.length>0 && measurements.every(item=>item.worker_cpu_user_seconds!==null &&
    item.worker_cpu_system_seconds!==null && item.worker_memory_peak_bytes!==null);
  record.worker_cpu_user_seconds=completeResources?measurements.reduce((sum,item)=>sum+item.worker_cpu_user_seconds,0):null;
  record.worker_cpu_system_seconds=completeResources?measurements.reduce((sum,item)=>sum+item.worker_cpu_system_seconds,0):null;
  record.worker_memory_peak_bytes=completeResources?Math.max(...measurements.map(item=>item.worker_memory_peak_bytes)):null;
  const scopes=new Set(measurements.map(item=>item.measurement_scope)),methods=new Set(measurements.map(item=>item.measurement_method));
  if(measurements.length) {
    record.measurement_scope=scopes.size===1?measurements[0].measurement_scope:'MIXED';
    record.measurement_method=methods.size===1?measurements[0].measurement_method:'MIXED';
  }
  const fixed=[...(record.energy_missing_reason?[record.energy_missing_reason]:[]),
    ...(record.api_cost_missing_reason?[record.api_cost_missing_reason]:[]),
    ...(record.invocations.length?['INFERENCE_SERVER_RESOURCE_NOT_ATTRIBUTED']:['NO_MODEL_INVOCATION'])];
  record.missing_reasons=sorted([...fixed,...measurements.flatMap(item=>item.missing_reasons)]);
  return meteringRecordContract(record);
}

function appendUnique(record,key,event,contract) {
  record=meteringRecordContract(record);event=contract(event);
  const events=record[key]??[],existing=events.find(item=>item.event_id===event.event_id);
  if(existing) {
    check(canonical(existing)===canonical(event),'POST_RUN_EVENT_CONFLICT');
    return {record,changed:false};
  }
  check(events.length<64,'TOO_MANY_POST_RUN_EVENTS');
  record[key]=[...events,event];
  return {record,changed:true};
}

export function attachReviewEvent(record,event) {
  let result=appendUnique(record,'review_events',event,reviewEventContract);record=result.record;
  if(!result.changed) return result;
  check(event.attempt_id===record.attempt_id && event.result_digest===record.result_digest &&
    event.review_result.task_id===record.task_id,'POST_RUN_BINDING_MISMATCH');
  record.review_status={PASS:'PASS',NEEDS_FIX:'NEEDS_FIX',REJECT:'REJECTED',BLOCKED:'BLOCKED'}[event.review_result.verdict];
  return {record:meteringRecordContract(record),changed:true};
}

export function attachAdoptionEvent(record,event) {
  let result=appendUnique(record,'adoption_events',event,adoptionEventContract);record=result.record;
  if(!result.changed) return result;
  check(event.attempt_id===record.attempt_id && event.result_digest===record.result_digest,'POST_RUN_BINDING_MISMATCH');
  record.adoption_status=event.decision;
  return {record:meteringRecordContract(record),changed:true};
}

export function attachCostEvent(record,event) {
  let result=appendUnique(record,'cost_events',event,costEventContract);record=result.record;
  if(!result.changed) return result;
  check(event.attempt_id===record.attempt_id && event.result_digest===record.result_digest &&
    (record.cost_events?.length??0)===1,'POST_RUN_BINDING_MISMATCH');
  if(event.price_basis.comparison_eligible) {
    record.estimated_api_avoided_cost=event.estimated_cost_micros/1_000_000;
    record.estimated_api_avoided_currency=event.price_basis.currency;
    record.api_cost_status='ESTIMATED';record.api_cost_missing_reason=null;
  } else {
    record.estimated_api_avoided_cost=null;record.estimated_api_avoided_currency=null;
    record.api_cost_status='NOT_COMPARABLE';record.api_cost_missing_reason=event.price_basis.missing_reason;
  }
  return {record:aggregate(record),changed:true};
}

export function attachEnergyEvent(record,event) {
  let result=appendUnique(record,'energy_events',event,energyEventContract);record=result.record;
  if(!result.changed) return result;
  check(event.attempt_id===record.attempt_id && event.result_digest===record.result_digest &&
    (record.energy_events?.length??0)===1,'POST_RUN_BINDING_MISMATCH');
  record.energy_kwh=event.allocated_energy_kwh;record.energy_status='OBSERVED';
  if(event.tariff_basis_id===null) {
    record.energy_cost=null;record.energy_currency=null;record.energy_missing_reason='NO_ENERGY_TARIFF';
  } else {
    record.energy_cost=event.energy_cost_micros/1_000_000;record.energy_currency=event.tariff_currency;
    record.energy_missing_reason=null;
  }
  return {record:aggregate(record),changed:true};
}

export function appendInvocations(record,invocations) {
  record=meteringRecordContract(record);inspect(invocations);
  check(Array.isArray(invocations) && record.invocations.length+invocations.length<=256,'INVALID_METERING_RECORD');
  record.invocations.push(...structuredClone(invocations));
  meteringRecordContract(record);
  if(record.invocations.some(item=>item.usage_status==='MISSING')) {
    record.model_input_tokens=null;record.model_output_tokens=null;record.model_usage_status='MISSING';
    record.model_usage_missing_reason='INCOMPLETE_PROVIDER_USAGE';
  } else if(record.invocations.length) {
    record.model_input_tokens=record.invocations.reduce((sum,item)=>sum+item.prompt_eval_count,0);
    record.model_output_tokens=record.invocations.reduce((sum,item)=>sum+item.eval_count,0);
    record.model_usage_status='OBSERVED';record.model_usage_missing_reason=null;
  }
  return aggregate(record);
}

export function appendCommandMeasurement(record,measurement) {
  record=meteringRecordContract(record);measurement=commandMeasurementContract(measurement);
  check(measurement.node_id===record.node_id && measurement.command_index===record.command_measurements.length,
    'METERING_BINDING_MISMATCH');
  record.command_measurements.push(measurement);record.execution_status='RUNNING';
  return aggregate(record);
}

export function replaceCommandMeasurement(record,measurement) {
  record=meteringRecordContract(record);measurement=commandMeasurementContract(measurement);
  const current=record.command_measurements.at(-1);
  check(current && measurement.node_id===record.node_id && measurement.command_index===current.command_index &&
    measurement.worker_started_at_utc===current.worker_started_at_utc && measurement.monotonic_started_ns===current.monotonic_started_ns,
  'METERING_BINDING_MISMATCH');
  record.command_measurements[current.command_index]=measurement;
  return aggregate(record);
}

export function finishMeteringRecord(record,status,commandResults) {
  record=meteringRecordContract(record);
  check(Array.isArray(commandResults) && (status==='RECOVERY_REQUIRED'?commandResults.length<=record.command_measurements.length:
    commandResults.length===record.command_measurements.length),'METERING_RESULT_MISMATCH');
  const mapped={SUCCEEDED:['SUCCEEDED','PASS'],FAILED:['FAILED','FAIL'],RECOVERY_REQUIRED:['LOST','INCOMPLETE']}[status];
  check(mapped,'INVALID_METERING_STATUS');
  record.execution_status=mapped[0];record.test_status=mapped[1];record.result_digest=digest(commandResults);
  return aggregate(record);
}
