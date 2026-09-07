import { meteringRecordContract } from './metering.mjs';

const adoptionStatuses=['PENDING','ADOPTED','PARTIALLY_ADOPTED','REJECTED','REVERTED'];
const reviewStatuses=['PENDING','PASS','NEEDS_FIX','REJECTED','BLOCKED'];
const addCurrency=(target,currency,value)=>{target[currency]=(target[currency]??0)+value;};

export function economicsSummary(state) {
  if(!state || typeof state!=='object' || Array.isArray(state)) throw new Error('INVALID_CONTROLLER_STATE');
  const attempts=[];
  for(const [attempt_id,attempt] of Object.entries(state.attempts??{})) {
    if(!attempt.metering) continue;
    const record=meteringRecordContract(attempt.metering);
    attempts.push({attempt_id,task_id:record.task_id,retry_index:record.retry_index,execution_status:record.execution_status,
      review_status:record.review_status,adoption_status:record.adoption_status,api_cost_status:record.api_cost_status,
      energy_status:record.energy_status});
  }
  attempts.sort((left,right)=>left.attempt_id.localeCompare(right.attempt_id));
  const adoption=Object.fromEntries(adoptionStatuses.map(status=>[status,0]));
  const review=Object.fromEntries(reviewStatuses.map(status=>[status,0]));
  const apiCounterfactualMicros={},energyCostMicros={};
  let observedInputTokens=0,observedOutputTokens=0,tokenAttempts=0,energyKwh=0,energyAttempts=0,pricedApiAttempts=0,
    pricedEnergyAttempts=0;
  for(const item of attempts) {
    const record=state.attempts[item.attempt_id].metering;
    adoption[record.adoption_status]++;review[record.review_status]++;
    if(record.model_usage_status==='OBSERVED') {
      observedInputTokens+=record.model_input_tokens;observedOutputTokens+=record.model_output_tokens;tokenAttempts++;
    }
    if(record.api_cost_status==='ESTIMATED') {
      addCurrency(apiCounterfactualMicros,record.estimated_api_avoided_currency,record.cost_events.at(-1).estimated_cost_micros);
      pricedApiAttempts++;
    }
    if(record.energy_status==='OBSERVED') {energyKwh+=record.energy_kwh;energyAttempts++;}
    if(record.energy_cost!==null) {addCurrency(energyCostMicros,record.energy_currency,record.energy_events.at(-1).energy_cost_micros);pricedEnergyAttempts++;}
  }
  const incomplete=attempts.filter(item=>item.review_status==='PENDING' || item.adoption_status==='PENDING' ||
    item.api_cost_status==='INCOMPLETE' || item.energy_status==='INCOMPLETE').length;
  return {schema_version:1,status:incomplete?'INCOMPLETE':'COMPLETE',unique_task_count:new Set(attempts.map(item=>item.task_id)).size,
    attempt_count:attempts.length,review_counts:review,adoption_counts:adoption,
    observed_model_usage:tokenAttempts?{attempt_count:tokenAttempts,input_tokens:observedInputTokens,output_tokens:observedOutputTokens}:null,
    estimated_api_counterfactual:pricedApiAttempts?{attempt_count:pricedApiAttempts,micro_units_by_currency:apiCounterfactualMicros,
      by_currency:Object.fromEntries(Object.entries(apiCounterfactualMicros).map(([currency,micros])=>[currency,micros/1_000_000]))}:null,
    observed_energy:energyAttempts?{attempt_count:energyAttempts,kwh:energyKwh}:null,
    energy_cost:pricedEnergyAttempts?{attempt_count:pricedEnergyAttempts,micro_units_by_currency:energyCostMicros,
      by_currency:Object.fromEntries(Object.entries(energyCostMicros).map(([currency,micros])=>[currency,micros/1_000_000]))}:null,
    incomplete_attempt_count:incomplete,attempts};
}
