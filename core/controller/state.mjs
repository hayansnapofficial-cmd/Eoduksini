import { isAbsolute } from 'node:path';
import { canonical, digest, harnessRevisionContract, projectContract } from '../contracts.mjs';
import { approvalContract, replayPolicyContract, requestContract, requestDigest, resultContract } from './contracts.mjs';
import { assessSemanticAdmission, requestSemanticFootprint, semanticAssessmentContract } from '../semantic.mjs';
import { appendCommandMeasurement, appendInvocations, commandMeasurementContract, finishMeteringRecord, initialMeteringRecord,
  invocationContract, meteringRecordContract, replaceCommandMeasurement, attachReviewEvent, attachAdoptionEvent,
  attachCostEvent, attachEnergyEvent } from '../metering.mjs';
import { adoptionEventContract, costEventContract, energyEventContract, reviewEventContract } from '../postrun.mjs';

const MAX_EVENT_BYTES=256*1024;
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HASH=/^[0-9a-f]{64}$/;
const positive=value=>Number.isSafeInteger(value) && value>0;
const index=value=>Number.isSafeInteger(value) && value>=0 && value<16;
const identifier=value=>typeof value==='string' && ID.test(value) && !['constructor','prototype','__proto__'].includes(value);
const text=value=>typeof value==='string' && value.length>0 && !/[\x00-\x1f]/.test(value);
const same=(left,right)=>canonical(left)===canonical(right);
const check=(condition,reason='INVALID_TRANSITION')=>{ if(!condition) throw new Error(reason); };
const incomplete=attempt=>['PREPARED','RUNNING'].includes(attempt.status);

// Inspect descriptors before evaluating any public object property, including toJSON.
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
    for(let i=0;i<value.length;i++) check(Object.hasOwn(descriptors,String(i)),'INVALID_JSON_INPUT');
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
function exact(value,keys) {
  check(value!==null && typeof value==='object' && !Array.isArray(value) &&
    Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key)),'INVALID_EVENT');
}

// Also used before store hashing; hash-chain integrity is checked by reduce/readStore.
export function eventContract(input) {
  inspect(input);
  check(Buffer.byteLength(canonical(input))+1<=MAX_EVENT_BYTES,'JSON_INPUT_TOO_LARGE');
  exact(input,['schema_version','seq','prev_digest','control_epoch','type','payload','digest']);
  check(input.schema_version===1 && positive(input.seq) && positive(input.control_epoch) &&
    (input.prev_digest===null || (typeof input.prev_digest==='string' && HASH.test(input.prev_digest))) &&
    typeof input.digest==='string' && HASH.test(input.digest),'INVALID_EVENT');
  const fields={INIT:['repo_root','project','policy',...(Object.hasOwn(input.payload??{},'harness_revision')?['harness_revision']:[])],
    APPROVED:['request','approval',...(Object.hasOwn(input.payload??{},'semantic_assessment')?['semantic_assessment']:[])],
    SEMANTIC_ASSESSED:['request','assessed_at','assessment'],
    PREPARED:['attempt_id','request_digest','reservation',...(Object.hasOwn(input.payload??{},'metering')?['metering']:[])],
    COMMAND_PREPARED:['attempt_id','index'],
    COMMAND_STARTED:['attempt_id','index','pid',...(Object.hasOwn(input.payload??{},'measurement')?['measurement']:[])],
    COMMAND_FINISHED:['attempt_id','index','result',...(Object.hasOwn(input.payload??{},'measurement')?['measurement']:[]),
      ...(Object.hasOwn(input.payload??{},'invocations')?['invocations']:[])],
    FINISHED:['attempt_id','status','reason'],RECOVERED:['attempt_ids','reason'],
    REVIEW_RECORDED:['event'],ADOPTION_RECORDED:['event'],COST_RECORDED:['event'],ENERGY_RECORDED:['event']};
  check(typeof input.type==='string' && Object.hasOwn(fields,input.type),'INVALID_EVENT_TYPE');
  exact(input.payload,fields[input.type]);
  const p=input.payload;
  if(Object.hasOwn(p,'attempt_id')) check(identifier(p.attempt_id),'INVALID_EVENT');
  if(Object.hasOwn(p,'index')) check(index(p.index),'INVALID_EVENT');
  if(Object.hasOwn(p,'reason')) check(text(p.reason),'INVALID_EVENT');
  switch(input.type) {
    case 'INIT':
      check(typeof p.repo_root==='string' && isAbsolute(p.repo_root),'INVALID_EVENT');
      projectContract(p.project); replayPolicyContract(p.policy);
      if(Object.hasOwn(p,'harness_revision')) {
        const revision=harnessRevisionContract(p.harness_revision);
        check(revision.project_id===p.project.project_id && revision.policy_digest===digest(p.policy) &&
          revision.activation_profile==='FOUNDATION_NOW','INVALID_HARNESS_BINDING');
      }
      break;
    case 'APPROVED':
      requestContract(p.request); approvalContract(p.approval);
      if(Object.hasOwn(p,'semantic_assessment'))
        check(semanticAssessmentContract(p.semantic_assessment).status==='NON_OVERLAPPING','INVALID_EVENT');
      break;
    case 'SEMANTIC_ASSESSED':
      requestContract(p.request); check(Number.isSafeInteger(p.assessed_at) && p.assessed_at>=0,'INVALID_EVENT');
      semanticAssessmentContract(p.assessment); break;
    case 'PREPARED':
      check(typeof p.request_digest==='string' && HASH.test(p.request_digest),'INVALID_EVENT');
      exact(p.reservation,['cpuThreads','memoryGiB','activeTasks']);
      check(positive(p.reservation.cpuThreads) && typeof p.reservation.memoryGiB==='number' &&
        p.reservation.memoryGiB>0 && p.reservation.activeTasks===1,'INVALID_RESERVATION');
      if(Object.hasOwn(p,'metering')) meteringRecordContract(p.metering); break;
    case 'COMMAND_STARTED':
      check(positive(p.pid),'INVALID_EVENT');
      if(Object.hasOwn(p,'measurement')) commandMeasurementContract(p.measurement); break;
    case 'COMMAND_FINISHED':
      resultContract(p.result);
      if(Object.hasOwn(p,'measurement')) commandMeasurementContract(p.measurement);
      if(Object.hasOwn(p,'invocations')) {
        check(Array.isArray(p.invocations) && p.invocations.length<=256,'INVALID_EVENT');
        p.invocations.map(invocationContract);
      }
      break;
    case 'FINISHED': check(['SUCCEEDED','FAILED','RECOVERY_REQUIRED'].includes(p.status),'INVALID_EVENT'); break;
    case 'RECOVERED': check(Array.isArray(p.attempt_ids) && p.attempt_ids.length>0 && p.attempt_ids.every(identifier) &&
      new Set(p.attempt_ids).size===p.attempt_ids.length,'INVALID_EVENT'); break;
    case 'REVIEW_RECORDED': reviewEventContract(p.event); break;
    case 'ADOPTION_RECORDED': adoptionEventContract(p.event); break;
    case 'COST_RECORDED': costEventContract(p.event); break;
    case 'ENERGY_RECORDED': energyEventContract(p.event); break;
  }
  return structuredClone(input);
}

export const initialState=()=>null;

export function reduce(state,input) {
  const event=eventContract(input),{digest:claimed,...body}=event;
  check(claimed===digest(body),'INVALID_EVENT_DIGEST');
  const {type,payload:p,control_epoch:epoch}=event;
  if(state===null) {
    check(type==='INIT' && event.seq===1 && event.prev_digest===null && epoch===1,'INVALID_INIT');
    return {repo_root:p.repo_root,project:projectContract(p.project),policy:replayPolicyContract(p.policy),
      ...(Object.hasOwn(p,'harness_revision')?{harness_revision:harnessRevisionContract(p.harness_revision)}:{}),control_epoch:1,
      approvals:{},attempts:{},semantic_assessments:{},reservation:null,recovery_required:false,semantic_review_required:false};
  }
  const semanticFence=type==='SEMANTIC_ASSESSED' && p.assessment.status!=='NON_OVERLAPPING';
  check(epoch===state.control_epoch+((type==='RECOVERED' || semanticFence)?1:0),'INVALID_EPOCH');
  check(type!=='INIT');
  const next=structuredClone(state);
  const semanticPeers=(request,at)=>Object.entries(next.approvals).filter(([peerId,entry])=>
    peerId!==request.attempt_id && entry.approval.expires_at>at && !Object.hasOwn(next.attempts,peerId)).map(([attempt_id,entry])=>
      ({attempt_id,semantic_footprint:requestSemanticFootprint(entry.request)}));
  if(type==='SEMANTIC_ASSESSED') {
    const request=requestContract(p.request),id=request.attempt_id,assessment=semanticAssessmentContract(p.assessment);
    check(!Object.hasOwn(next.semantic_assessments,id) && !Object.hasOwn(next.attempts,id),'DUPLICATE_SEMANTIC_ASSESSMENT');
    check(request.repo_root===state.repo_root && same(request.project,state.project) && request.policy_digest===digest(state.policy) &&
      request.control_epoch===state.control_epoch,'SEMANTIC_BINDING_MISMATCH');
    const expected=assessSemanticAdmission(request,semanticPeers(request,p.assessed_at));
    check(same(expected,assessment),'SEMANTIC_ASSESSMENT_MISMATCH');
    const existing=next.approvals[id];
    if(assessment.status==='NON_OVERLAPPING')
      check(existing && requestDigest(existing.request)===requestDigest(request),'SEMANTIC_BINDING_MISMATCH');
    else if(existing) check(requestDigest(existing.request)===requestDigest(request),'SEMANTIC_BINDING_MISMATCH');
    next.semantic_assessments[id]={request_digest:requestDigest(request),assessment};
    if(semanticFence) { next.control_epoch=epoch; next.semantic_review_required=true; }
    return next;
  }
  if(type==='APPROVED') {
    const request=requestContract(p.request),approval=approvalContract(p.approval),id=request.attempt_id;
    check(identifier(id),'INVALID_ATTEMPT_ID');
    check(!Object.hasOwn(next.approvals,id) && !Object.hasOwn(next.attempts,id) && !Object.hasOwn(next.semantic_assessments,id) &&
      !Object.values(next.approvals).some(entry=>entry.approval.approval_id===approval.approval_id),'DUPLICATE_APPROVAL');
    check(request.repo_root===state.repo_root && same(request.project,state.project) &&
      request.policy_digest===digest(state.policy) && approval.request_digest===requestDigest(request) &&
      request.control_epoch===epoch && approval.control_epoch===epoch,'APPROVAL_BINDING_MISMATCH');
    check((state.harness_revision===undefined && request.schema_version===1) ||
      (state.harness_revision!==undefined && request.schema_version===2 && same(request.harness_revision,state.harness_revision)),
    'APPROVAL_BINDING_MISMATCH');
    check(approval.expires_at-approval.issued_at<=state.policy.limits.approval_ttl_ms,'APPROVAL_BINDING_MISMATCH');
    if(Object.hasOwn(p,'semantic_assessment')) {
      const assessment=semanticAssessmentContract(p.semantic_assessment);
      const expected=assessSemanticAdmission(request,semanticPeers(request,approval.issued_at));
      check(same(expected,assessment),'SEMANTIC_ASSESSMENT_MISMATCH');
      next.semantic_assessments[id]={request_digest:requestDigest(request),assessment};
    }
    next.approvals[id]={request,approval}; return next;
  }
  if(type==='RECOVERED') {
    const pending=Object.entries(next.attempts).filter(([,attempt])=>incomplete(attempt)).map(([id])=>id).sort();
    check(pending.length>0 && same([...p.attempt_ids].sort(),pending));
    for(const id of pending) {
      next.attempts[id].status='RECOVERY_REQUIRED'; next.attempts[id].reason=p.reason;
      if(next.attempts[id].metering)
        next.attempts[id].metering=finishMeteringRecord(next.attempts[id].metering,'RECOVERY_REQUIRED',next.attempts[id].command_results);
    }
    next.control_epoch=epoch; next.recovery_required=true; return next;
  }
  if(['REVIEW_RECORDED','ADOPTION_RECORDED','COST_RECORDED','ENERGY_RECORDED'].includes(type)) {
    const event=p.event,id=event.attempt_id,attempt=next.attempts[id];
    check(attempt && !incomplete(attempt) && attempt.metering && attempt.metering.result_digest===event.result_digest,
      'POST_RUN_BINDING_MISMATCH');
    const metering=attempt.metering,finishedAt=Date.parse(metering.worker_finished_at_utc??'');
    check(Number.isFinite(finishedAt),'POST_RUN_BINDING_MISMATCH');
    const authority=next.policy.post_run_authority;
    check(authority,'POST_RUN_AUTHORITY_REQUIRED');
    let applied;
    if(type==='REVIEW_RECORDED') {
      check(authority.reviewer_ids.includes(event.reviewer_id),'UNAUTHORIZED_REVIEWER');
      check(Date.parse(event.reviewed_at)>=finishedAt,'POST_RUN_TIME_MISMATCH');
      applied=attachReviewEvent(attempt.metering,event);
    }
    else if(type==='ADOPTION_RECORDED') {
      check(authority.adoption_actor_ids.includes(event.actor_id),'UNAUTHORIZED_ADOPTION_ACTOR');
      const lastReview=attempt.metering.review_events?.at(-1);
      check(Date.parse(event.decided_at)>=finishedAt && (!lastReview || Date.parse(event.decided_at)>=Date.parse(lastReview.reviewed_at)),
        'POST_RUN_TIME_MISMATCH');
      if(['ADOPTED','PARTIALLY_ADOPTED'].includes(event.decision))
        check(attempt.status==='SUCCEEDED' && attempt.metering.review_status==='PASS','ADOPTION_GATE_NOT_MET');
      if(event.decision==='REVERTED')
        check(['ADOPTED','PARTIALLY_ADOPTED'].includes(attempt.metering.adoption_status),'INVALID_ADOPTION_TRANSITION');
      applied=attachAdoptionEvent(attempt.metering,event);
    } else if(type==='COST_RECORDED') {
      check(authority.price_basis_ids.includes(event.price_basis.basis_id),'UNAUTHORIZED_PRICE_BASIS');
      check(Date.parse(event.recorded_at)>=finishedAt && Date.parse(event.recorded_at)>=Date.parse(event.price_basis.retrieved_at) &&
        Date.parse(event.recorded_at)>=Date.parse(event.price_basis.effective_at),'POST_RUN_TIME_MISMATCH');
      applied=attachCostEvent(attempt.metering,event);
    } else {
      check(authority.energy_source_ids.includes(event.source_id) &&
        (event.tariff_basis_id===null || authority.tariff_basis_ids.includes(event.tariff_basis_id)),
      'UNAUTHORIZED_ENERGY_EVIDENCE');
      check(Date.parse(event.recorded_at)>=Date.parse(event.interval_finished_at) &&
        Date.parse(event.interval_started_at)<=Date.parse(metering.worker_started_at_utc) &&
        Date.parse(event.interval_finished_at)>=finishedAt &&
        (event.tariff_basis_id===null || (Date.parse(event.recorded_at)>=Date.parse(event.tariff_effective_at) &&
          Date.parse(event.recorded_at)>=Date.parse(event.tariff_retrieved_at))),'POST_RUN_TIME_MISMATCH');
      applied=attachEnergyEvent(attempt.metering,event);
    }
    attempt.metering=applied.record;
    return next;
  }
  const id=p.attempt_id,entry=next.approvals[id];
  check(entry,'UNKNOWN_ATTEMPT');
  if(type==='PREPARED') {
    check(!Object.hasOwn(next.attempts,id),'ATTEMPT_ALREADY_PREPARED');
    check(!next.recovery_required && next.reservation===null);
    check(entry.request.control_epoch===epoch && entry.approval.control_epoch===epoch,'INVALID_EPOCH');
    check(p.request_digest===entry.approval.request_digest,'REQUEST_DIGEST_MISMATCH');
    check(p.reservation.cpuThreads===entry.request.resources.cpu_threads &&
      p.reservation.memoryGiB===entry.request.resources.memory_gib,'INVALID_RESERVATION');
    let metering;
    if(Object.hasOwn(p,'metering')) {
      metering=meteringRecordContract(p.metering);
      const expected=initialMeteringRecord(state,entry.request,entry.approval.issued_at);
      const normalized={...metering,review_events:metering.review_events??[],adoption_events:metering.adoption_events??[],
        cost_events:metering.cost_events??[],energy_events:metering.energy_events??[]};
      check(same(normalized,expected),'METERING_BINDING_MISMATCH');
    }
    next.attempts[id]={request_digest:p.request_digest,status:'PREPARED',next_index:0,active_index:null,command_results:[],reason:null,
      ...(metering?{metering}: {})};
    next.reservation=p.reservation; return next;
  }
  const attempt=next.attempts[id];
  check(attempt && incomplete(attempt) && next.reservation!==null && !next.recovery_required);
  const count=entry.request.commands.length,last=attempt.command_results.at(-1);
  if(type==='COMMAND_PREPARED') {
    check(p.index===attempt.next_index && p.index<count && attempt.active_index===null && (!last || last.status==='SUCCEEDED'));
    attempt.active_index=p.index; attempt.status='PREPARED';
  } else if(type==='COMMAND_STARTED') {
    check(attempt.status==='PREPARED' && attempt.active_index===p.index && p.index===attempt.next_index);
    check(Boolean(attempt.metering)===Object.hasOwn(p,'measurement'),'METERING_BINDING_MISMATCH');
    if(attempt.metering) {
      const measurement=commandMeasurementContract(p.measurement);
      check(measurement.worker_started_at_utc!==null && measurement.worker_finished_at_utc===null,'METERING_BINDING_MISMATCH');
      attempt.metering=appendCommandMeasurement(attempt.metering,measurement);
    }
    attempt.status='RUNNING';
  } else if(type==='COMMAND_FINISHED') {
    check(attempt.active_index===p.index && p.index===attempt.next_index &&
      (attempt.status==='RUNNING' || p.result.status==='RECOVERY_REQUIRED'));
    check(Boolean(attempt.metering)===Object.hasOwn(p,'measurement'),'METERING_BINDING_MISMATCH');
    if(attempt.metering) {
      const measurement=commandMeasurementContract(p.measurement);
      attempt.metering=attempt.metering.command_measurements.length===p.index?
        appendCommandMeasurement(attempt.metering,measurement):replaceCommandMeasurement(attempt.metering,measurement);
      attempt.metering=appendInvocations(attempt.metering,p.invocations??[]);
    }
    if(p.result.status==='FAILED') check(p.result.signal===null && p.result.exit_code!==null && p.result.exit_code!==0);
    attempt.command_results.push(p.result); attempt.next_index++; attempt.active_index=null;
  } else if(type==='FINISHED') {
    if(p.status==='SUCCEEDED') check(count>0 && attempt.active_index===null && attempt.next_index===count &&
      attempt.command_results.length===count && attempt.command_results.every(result=>result.status==='SUCCEEDED'));
    if(p.status==='FAILED') check(attempt.active_index===null && last?.status==='FAILED');
    attempt.status=p.status; attempt.reason=p.reason;
    if(attempt.metering) attempt.metering=finishMeteringRecord(attempt.metering,p.status,attempt.command_results);
    if(p.status==='RECOVERY_REQUIRED') next.recovery_required=true;
    else next.reservation=null;
  } else check(false);
  return next;
}
