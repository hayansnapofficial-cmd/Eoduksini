import { canonical, digest, validate } from './contracts.mjs';

const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH=/^[0-9a-f]{64}$/;
const check=(condition,reason)=>{if(!condition) throw new Error(reason);};
const identifier=value=>typeof value==='string' && ID.test(value) && !['constructor','prototype','__proto__'].includes(value);
const hash=value=>typeof value==='string' && HASH.test(value);
const nonnegative=value=>Number.isSafeInteger(value) && value>=0;
const text=value=>typeof value==='string' && value.length>0 && value.length<=512 && value.isWellFormed() && !/[\x00-\x1f]/.test(value);
const time=value=>typeof value==='string' && value.length<=32 && new Date(value).toISOString()===value;

function inspect(value,seen=new Set()) {
  if(value===null || typeof value==='boolean') return;
  if(typeof value==='string') {check(value.isWellFormed(),'INVALID_JSON_INPUT');return;}
  if(typeof value==='number') {check(Number.isFinite(value),'INVALID_JSON_INPUT');return;}
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
    const descriptor=descriptors[key];
    check(key.isWellFormed() && !['constructor','prototype','__proto__'].includes(key) &&
      Object.hasOwn(descriptor,'value') && descriptor.enumerable,'INVALID_JSON_INPUT');
    inspect(descriptor.value,seen);
  }
  seen.delete(value);
}
function exact(value,keys,reason) {
  check(value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===keys.length &&
    keys.every(key=>Object.hasOwn(value,key)),reason);
}

const REVIEW_KEYS=['event_id','attempt_id','result_digest','reviewer_id','producer_id','independent','reviewed_at','review_result'];
export function reviewEventContract(value) {
  inspect(value);exact(value,REVIEW_KEYS,'INVALID_REVIEW_EVENT');
  validate('review-result',value.review_result);
  check(identifier(value.event_id) && identifier(value.attempt_id) && hash(value.result_digest) &&
    identifier(value.reviewer_id) && identifier(value.producer_id) && value.independent===true &&
    value.reviewer_id!==value.producer_id && time(value.reviewed_at), 'INVALID_REVIEW_EVENT');
  return structuredClone(value);
}

const ADOPTION_KEYS=['event_id','attempt_id','result_digest','actor_id','actor_kind','actor_role','authorization_id',
  'decision','scope_digest','decided_at'];
export function adoptionEventContract(value) {
  inspect(value);exact(value,ADOPTION_KEYS,'INVALID_ADOPTION_EVENT');
  check(identifier(value.event_id) && identifier(value.attempt_id) && hash(value.result_digest) && identifier(value.actor_id) &&
    value.actor_kind==='HUMAN' && ['OWNER','DELEGATED_OPERATOR'].includes(value.actor_role) && identifier(value.authorization_id) &&
    ['ADOPTED','PARTIALLY_ADOPTED','REJECTED','REVERTED'].includes(value.decision) &&
    (value.scope_digest===null || hash(value.scope_digest)) && (value.decision==='PARTIALLY_ADOPTED')===(value.scope_digest!==null) &&
    time(value.decided_at),'INVALID_ADOPTION_EVENT');
  return structuredClone(value);
}

const BASIS_KEYS=['basis_id','provider_kind','model_name','model_revision','currency','input_micros_per_million_tokens',
  'output_micros_per_million_tokens','source_ref','effective_at','retrieved_at','comparison_eligible','missing_reason'];
export function priceBasisContract(value) {
  inspect(value);exact(value,BASIS_KEYS,'INVALID_PRICE_BASIS');
  check(identifier(value.basis_id) && identifier(value.provider_kind) && text(value.model_name) && text(value.model_revision) &&
    typeof value.currency==='string' && /^[A-Z]{3}$/.test(value.currency) &&
    nonnegative(value.input_micros_per_million_tokens) && nonnegative(value.output_micros_per_million_tokens) &&
    text(value.source_ref) && time(value.effective_at) && time(value.retrieved_at) && typeof value.comparison_eligible==='boolean' &&
    (value.comparison_eligible?value.missing_reason===null:text(value.missing_reason)),'INVALID_PRICE_BASIS');
  return structuredClone(value);
}

const COST_KEYS=['event_id','attempt_id','result_digest','recorded_at','price_basis','input_tokens','output_tokens',
  'rounding_method','estimated_cost_micros'];
export function costEventContract(value) {
  inspect(value);exact(value,COST_KEYS,'INVALID_COST_EVENT');
  const basis=priceBasisContract(value.price_basis);
  check(identifier(value.event_id) && identifier(value.attempt_id) && hash(value.result_digest) && time(value.recorded_at) &&
    (value.input_tokens===null || nonnegative(value.input_tokens)) && (value.output_tokens===null || nonnegative(value.output_tokens)) &&
    value.rounding_method==='CEILING_TO_MICRO_UNIT' &&
    (value.estimated_cost_micros===null || nonnegative(value.estimated_cost_micros)),'INVALID_COST_EVENT');
  if(basis.comparison_eligible) {
    check(value.input_tokens!==null && value.output_tokens!==null,'INVALID_COST_EVENT');
    const numerator=BigInt(value.input_tokens)*BigInt(basis.input_micros_per_million_tokens)+
      BigInt(value.output_tokens)*BigInt(basis.output_micros_per_million_tokens);
    const estimate=Number((numerator+999999n)/1000000n);
    check(Number.isSafeInteger(estimate) && value.estimated_cost_micros===estimate,'INVALID_COST_EVENT');
  } else check(value.input_tokens===null && value.output_tokens===null && value.estimated_cost_micros===null,'INVALID_COST_EVENT');
  return structuredClone(value);
}

export function createCostEvent(record,input,recordedAt) {
  inspect(input);exact(input,['event_id','attempt_id','result_digest','price_basis'],'INVALID_COST_EVENT');
  const basis=priceBasisContract(input.price_basis),observed=record.model_usage_status==='OBSERVED';
  check(!basis.comparison_eligible || observed,'MODEL_USAGE_REQUIRED_FOR_COST');
  const inputTokens=basis.comparison_eligible?record.model_input_tokens:null;
  const outputTokens=basis.comparison_eligible?record.model_output_tokens:null;
  let estimate=null;
  if(basis.comparison_eligible) {
    const numerator=BigInt(inputTokens)*BigInt(basis.input_micros_per_million_tokens)+
      BigInt(outputTokens)*BigInt(basis.output_micros_per_million_tokens);
    const rounded=(numerator+999999n)/1000000n;
    check(rounded<=BigInt(Number.MAX_SAFE_INTEGER),'COST_OVERFLOW');estimate=Number(rounded);
  }
  return costEventContract({...input,recorded_at:new Date(recordedAt).toISOString(),price_basis:basis,input_tokens:inputTokens,
    output_tokens:outputTokens,rounding_method:'CEILING_TO_MICRO_UNIT',estimated_cost_micros:estimate});
}

const ENERGY_KEYS=['event_id','attempt_id','result_digest','measurement_id','measurement_evidence_digest','source_id','source_kind','interval_started_at',
  'interval_finished_at','observed_energy_kwh','measurement_scope','allocation_method','allocation_ratio','allocated_energy_kwh',
  'tariff_basis_id','tariff_currency','tariff_micros_per_kwh','tariff_source_ref','tariff_effective_at','tariff_retrieved_at',
  'energy_cost_micros','recorded_at'];
export function energyEventContract(value) {
  inspect(value);exact(value,ENERGY_KEYS,'INVALID_ENERGY_EVENT');
  check(identifier(value.event_id) && identifier(value.attempt_id) && hash(value.result_digest) && identifier(value.measurement_id) &&
    hash(value.measurement_evidence_digest) &&
    identifier(value.source_id) && ['RAPL','SMART_PLUG','EXTERNAL_METER'].includes(value.source_kind) &&
    time(value.interval_started_at) && time(value.interval_finished_at) &&
    Date.parse(value.interval_finished_at)>=Date.parse(value.interval_started_at) &&
    typeof value.observed_energy_kwh==='number' && value.observed_energy_kwh>=0 &&
    ['TASK','NODE_INTERVAL','COMPONENT_INTERVAL'].includes(value.measurement_scope) &&
    ['DIRECT','PROPORTIONAL'].includes(value.allocation_method) && typeof value.allocation_ratio==='number' &&
    value.allocation_ratio>0 && value.allocation_ratio<=1 &&
    (value.measurement_scope!=='TASK' || (value.allocation_method==='DIRECT' && value.allocation_ratio===1)) &&
    (value.allocation_method!=='DIRECT' || value.allocation_ratio===1) &&
    typeof value.allocated_energy_kwh==='number' && value.allocated_energy_kwh>=0 &&
    Math.abs(value.allocated_energy_kwh-value.observed_energy_kwh*value.allocation_ratio)<=1e-12 &&
    time(value.recorded_at),'INVALID_ENERGY_EVENT');
  const hasTariff=value.tariff_basis_id!==null;
  check(hasTariff===(value.tariff_currency!==null && value.tariff_micros_per_kwh!==null && value.tariff_source_ref!==null &&
    value.tariff_effective_at!==null && value.tariff_retrieved_at!==null && value.energy_cost_micros!==null),
    'INVALID_ENERGY_EVENT');
  if(hasTariff) {
    check(identifier(value.tariff_basis_id) && /^[A-Z]{3}$/.test(value.tariff_currency) &&
      nonnegative(value.tariff_micros_per_kwh) && text(value.tariff_source_ref) && time(value.tariff_effective_at) &&
      time(value.tariff_retrieved_at) && nonnegative(value.energy_cost_micros) &&
      value.energy_cost_micros===Math.ceil(value.allocated_energy_kwh*value.tariff_micros_per_kwh),'INVALID_ENERGY_EVENT');
  } else check(value.tariff_currency===null && value.tariff_micros_per_kwh===null && value.tariff_source_ref===null &&
    value.tariff_effective_at===null && value.tariff_retrieved_at===null && value.energy_cost_micros===null,'INVALID_ENERGY_EVENT');
  return structuredClone(value);
}

export function postRunEventDigest(value) { inspect(value);return digest(value); }
export function samePostRunEvent(left,right) { return canonical(left)===canonical(right); }
