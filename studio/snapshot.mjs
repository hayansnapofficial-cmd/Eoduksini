import { status as controllerStatus, economics as controllerEconomics } from '../core/controller/controller.mjs';

const safeText=(value,fallback='UNKNOWN')=>typeof value==='string' && value.length>0?value.slice(0,160):fallback;
const safeNumber=value=>typeof value==='number' && Number.isFinite(value) && value>=0?value:null;
const countBy=(values,key)=>values.reduce((out,value)=>{const name=safeText(value[key]);out[name]=(out[name]??0)+1;return out;},{});

function publicMetering(record) {
  if(!record) return null;
  return {
    node_id:safeText(record.node_id),
    worker_started_at_utc:record.worker_started_at_utc??null,
    worker_finished_at_utc:record.worker_finished_at_utc??null,
    execution_duration_ms:safeNumber(record.execution_duration_ms),
    worker_cpu_seconds:record.worker_cpu_user_seconds===null || record.worker_cpu_system_seconds===null?null:
      safeNumber(record.worker_cpu_user_seconds+record.worker_cpu_system_seconds),
    worker_memory_peak_bytes:safeNumber(record.worker_memory_peak_bytes),
    model_usage_status:safeText(record.model_usage_status),
    model_input_tokens:safeNumber(record.model_input_tokens),
    model_output_tokens:safeNumber(record.model_output_tokens),
    routing_reason:safeText(record.routing_decision?.reason_code),
    chosen_provider_kind:safeText(record.routing_decision?.chosen_provider_kind),
    execution_status:safeText(record.execution_status),
    test_status:safeText(record.test_status),
    review_status:safeText(record.review_status),
    integration_status:safeText(record.integration_status),
    adoption_status:safeText(record.adoption_status),
    api_cost_status:safeText(record.api_cost_status),
    estimated_api_avoided_cost:safeNumber(record.estimated_api_avoided_cost),
    estimated_api_avoided_currency:record.estimated_api_avoided_currency??null,
    energy_status:safeText(record.energy_status),
    energy_kwh:safeNumber(record.energy_kwh),
    energy_cost:safeNumber(record.energy_cost),
    energy_currency:record.energy_currency??null,
    measurement_completeness:safeText(record.measurement_completeness)
  };
}

function publicAssessment(attemptId,entry) {
  const assessment=entry?.assessment??entry;
  return {
    attempt_id:attemptId,
    status:safeText(assessment?.status),
    compared_attempt_ids:Array.isArray(assessment?.compared_attempt_ids)?assessment.compared_attempt_ids.map(value=>safeText(value)):[],
    conflicts:Array.isArray(assessment?.conflicts)?assessment.conflicts.map(item=>({
      field:safeText(item.field),left:safeText(item.left),right:safeText(item.right),other_attempt_id:safeText(item.other_attempt_id)
    })):[],
    uncertainty:Array.isArray(assessment?.uncertainty)?assessment.uncertainty.map(item=>({
      subject:safeText(item.subject),reason:safeText(item.reason),confidence:safeNumber(item.confidence)
    })):[]
  };
}

export function unconfiguredSnapshot(now=Date.now()) {
  return {schema_version:1,generated_at:new Date(now).toISOString(),configured:false,
    controller:{status:'UNCONFIGURED',project_id:null,control_epoch:null,node_id:null,journal_seq:null,journal_bytes:null,
      owner_present:false,recovery_required:false,semantic_review_required:false},
    totals:{attempts:0,approvals:0,pending_attempts:0,observed_input_tokens:0,observed_output_tokens:0},
    status_counts:{},attempts:[],semantic_assessments:[],economics:null};
}

export function createStudioSnapshot(statusResult,economicsResult,now=Date.now()) {
  const state=statusResult?.state;
  if(!state) {
    const empty=unconfiguredSnapshot(now);
    empty.configured=true;empty.controller.status=safeText(statusResult?.status,'UNAVAILABLE');
    return empty;
  }
  const attempts=Object.entries(state.attempts??{}).map(([attempt_id,attempt])=>({
    attempt_id,task_id:state.approvals?.[attempt_id]?.request?.task?.task_id??attempt.metering?.task_id??null,
    status:safeText(attempt.status),reason:attempt.reason===null?null:safeText(attempt.reason),
    command_count:Array.isArray(attempt.command_results)?attempt.command_results.length:0,
    metering:publicMetering(attempt.metering)
  })).sort((left,right)=>left.attempt_id.localeCompare(right.attempt_id));
  const assessments=Object.entries(state.semantic_assessments??{}).map(([id,value])=>publicAssessment(id,value))
    .sort((left,right)=>left.attempt_id.localeCompare(right.attempt_id));
  const usage=economicsResult?.observed_model_usage;
  return {schema_version:1,generated_at:new Date(now).toISOString(),configured:true,
    controller:{status:safeText(statusResult.status),project_id:safeText(state.project?.project_id),control_epoch:safeNumber(state.control_epoch),
      node_id:safeText(state.policy?.quota?.nodeId),journal_seq:safeNumber(statusResult.seq),journal_bytes:safeNumber(statusResult.bytes),
      owner_present:Boolean(statusResult.owner_present),recovery_required:Boolean(state.recovery_required),
      semantic_review_required:Boolean(state.semantic_review_required)},
    totals:{attempts:attempts.length,approvals:Object.keys(state.approvals??{}).length,
      pending_attempts:attempts.filter(item=>['PREPARED','RUNNING'].includes(item.status)).length,
      observed_input_tokens:usage?.input_tokens??0,observed_output_tokens:usage?.output_tokens??0},
    status_counts:countBy(attempts,'status'),attempts,semantic_assessments:assessments,
    economics:economicsResult?{
      status:safeText(economicsResult.status),unique_task_count:safeNumber(economicsResult.unique_task_count),
      incomplete_attempt_count:safeNumber(economicsResult.incomplete_attempt_count),review_counts:economicsResult.review_counts??{},
      adoption_counts:economicsResult.adoption_counts??{},observed_model_usage:economicsResult.observed_model_usage??null,
      estimated_api_counterfactual:economicsResult.estimated_api_counterfactual??null,
      observed_energy:economicsResult.observed_energy??null,energy_cost:economicsResult.energy_cost??null
    }:null};
}

export function studioSnapshot(stateRoot,now=Date.now()) {
  return createStudioSnapshot(controllerStatus(stateRoot),controllerEconomics(stateRoot),now);
}
