import { resolve } from 'node:path';
import { canonical, digest, harnessRevisionContract } from '../contracts.mjs';
import { baseline, drift, planTask } from '../project.mjs';
import { approvalContract, localTask, requestContract, requestDigest, resultContract } from './contracts.mjs';
import { checkApprovalTime, checkDispatch, localCapacity, prepareRequest } from './gates.mjs';
import { runCommandMetered as realRunCommand } from './runner.mjs';
import { initializeStore, readStore, withStore } from './store.mjs';
import { assessSemanticAdmission, requestSemanticFootprint } from '../semantic.mjs';
import { commandMeasurementContract, initialMeteringRecord, observedCommandMeasurement } from '../metering.mjs';
import { adoptionEventContract, costEventContract, createCostEvent, energyEventContract, reviewEventContract,
  samePostRunEvent } from '../postrun.mjs';
import { economicsSummary } from '../economics.mjs';

const check=(condition,reason)=>{if(!condition) throw new Error(reason);};
const pending=state=>Object.entries(state.attempts).filter(([,a])=>['PREPARED','RUNNING'].includes(a.status)).map(([id])=>id);
const reasonOf=error=>String(error.message??error).replace(/[\x00-\x1f]/g,' ').slice(0,2000)||'CONTROLLER_ERROR';
const receipt=(status,reason,attempt_id,execution_started=false,command_results=[])=>
  ({status,reason,attempt_id,execution_started,command_results:structuredClone(command_results)});

// Validate wrappers as well as contracts, before invoking any getters or toJSON.
function publicInput(value,keys) {
  const seen=new Set();
  function inspect(item) {
    if(item===null || typeof item==='boolean') return;
    if(typeof item==='string') {check(item.isWellFormed(),'INVALID_JSON_INPUT');return;}
    if(typeof item==='number') {check(Number.isFinite(item),'INVALID_JSON_INPUT');return;}
    check(typeof item==='object' && !seen.has(item),'INVALID_JSON_INPUT');
    const array=Array.isArray(item);
    check(Object.getPrototypeOf(item)===(array?Array.prototype:Object.prototype),'INVALID_JSON_INPUT');
    seen.add(item);
    const descriptors=Object.getOwnPropertyDescriptors(item),names=Reflect.ownKeys(descriptors);
    check(names.every(name=>typeof name==='string'),'INVALID_JSON_INPUT');
    if(array) {
      check(names.length===item.length+1,'INVALID_JSON_INPUT');
      for(let i=0;i<item.length;i++) check(Object.hasOwn(descriptors,String(i)),'INVALID_JSON_INPUT');
    }
    for(const name of names) {
      if(array && name==='length') continue;
      const descriptor=descriptors[name];
      check(name.isWellFormed() && !['__proto__','prototype','constructor'].includes(name) &&
        Object.hasOwn(descriptor,'value') && descriptor.enumerable,'INVALID_JSON_INPUT');
      inspect(descriptor.value);
    }
    seen.delete(item);
  }
  inspect(value);
  check(Buffer.byteLength(canonical(value))<=256*1024,'JSON_INPUT_TOO_LARGE');
  if(keys) check(value!==null && !Array.isArray(value) && typeof value==='object' &&
    Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key)),'INVALID_ARGUMENTS');
  return structuredClone(value);
}
function executionInput(input,keys) {
  const value=publicInput(input,keys),request=requestContract(value.request);
  check(typeof value.expected_digest==='string' && /^[0-9a-f]{64}$/.test(value.expected_digest),'INVALID_REQUEST_DIGEST');
  check(requestDigest(request)===value.expected_digest,'REQUEST_DIGEST_MISMATCH');
  return {...value,request};
}
function summary(meta) {
  const state=meta.state;
  const status=meta.owner_present?'OWNER_RECOVERY_REQUIRED':state.semantic_review_required?'MANUAL_DECISION_REQUIRED':
    state.recovery_required || pending(state).length?'RECOVERY_REQUIRED':'READY';
  return {status,...meta,evidence_sensitive:true};
}
function storageFailure(error) {
  const reason=reasonOf(error);
  if(reason==='OWNER_PRESENT' || reason.startsWith('OWNER_LOST')) return {status:'OWNER_RECOVERY_REQUIRED',reason};
  if(reason.startsWith('JOURNAL_CORRUPT')) return {status:'JOURNAL_CORRUPT',reason};
  return null;
}

// Only trusted in-process callers may substitute observations/runner. CLI has no dependency options.
export function createController({now=Date.now,capacity=localCapacity,runCommand=realRunCommand}={}) {
  const clock=()=>{const value=now();check(Number.isSafeInteger(value) && value>=0,'INVALID_TIME');return value;};
  const semanticPeers=(state,id,at)=>Object.entries(state.approvals).filter(([peerId,entry])=>peerId!==id &&
    entry.approval.expires_at>at && !Object.hasOwn(state.attempts,peerId)).map(([attempt_id,entry])=>
      ({attempt_id,semantic_footprint:requestSemanticFootprint(entry.request)}));
  function calculateAssessment(state,request,at) {
    return assessSemanticAdmission(request,semanticPeers(state,request.attempt_id,at));
  }
  function assessLegacyApproval(session,request,at) {
    const id=request.attempt_id,expected=requestDigest(request),recorded=session.state.semantic_assessments?.[id];
    if(recorded) {
      check(recorded.request_digest===expected,'REQUEST_DIGEST_MISMATCH');
      return recorded.assessment;
    }
    const assessment=calculateAssessment(session.state,request,at);
    session.append('SEMANTIC_ASSESSED',{request,assessed_at:at,assessment});
    return assessment;
  }
  function init(stateRoot,repoRoot,project,policy,harnessRevision=null) {
    project=publicInput(project);policy=publicInput(policy);
    let harness_revision;
    if(harnessRevision!==null) {
      harness_revision=harnessRevisionContract(publicInput(harnessRevision));
      const snapshot=baseline(resolve(repoRoot),project);
      check(harness_revision.activation_profile==='FOUNDATION_NOW' && harness_revision.project_id===project.project_id &&
        harness_revision.source_git_sha===snapshot.head && harness_revision.policy_digest===digest(policy),'INVALID_HARNESS_BINDING');
    }
    return {status:'INITIALIZED',...initializeStore(stateRoot,{repo_root:resolve(repoRoot),project,policy,
      ...(harness_revision?{harness_revision}:{})}),evidence_sensitive:true};
  }
  function prepare(stateRoot,input) {
    const args=publicInput(input,['attempt_id','task']);
    check(typeof args.attempt_id==='string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(args.attempt_id) &&
      !['constructor','prototype','__proto__'].includes(args.attempt_id),'INVALID_ATTEMPT_ID');
    const state=readStore(stateRoot).state;
    localTask(args.task,state.project,state.harness_revision??null);
    try {return prepareRequest(state,args);}
    catch(error) {return {status:'BLOCKED',reason:reasonOf(error),execution_authorized:false};}
  }
  async function approve(stateRoot,input) {
    const {request,expected_digest,approval_id,ttl_ms}=executionInput(input,['request','expected_digest','approval_id','ttl_ms']);
    check(Number.isSafeInteger(ttl_ms) && ttl_ms>0 && ttl_ms<=request.limits.approval_ttl_ms,'INVALID_APPROVAL_TTL');
    const issued_at=clock(),approval=approvalContract({approval_id,request_digest:expected_digest,
      issued_at,expires_at:issued_at+ttl_ms,control_epoch:request.control_epoch});
    try {
      return await withStore(stateRoot,session=>{
        const state=session.state;
        if(state.semantic_review_required) return {status:'BLOCKED',reason:'MANUAL_DECISION_REQUIRED'};
        if(state.recovery_required || pending(state).length) return {status:'BLOCKED',reason:'RECOVERY_REQUIRED'};
        let current;
        try {
          current=prepareRequest(state,{attempt_id:request.attempt_id,task:request.task});
          if(requestDigest(current)!==expected_digest) return {status:'BLOCKED',reason:'REQUEST_DRIFT'};
        } catch(error) {return {status:'BLOCKED',reason:reasonOf(error)};}
        const assessment=calculateAssessment(session.state,current,issued_at);
        if(assessment.status!=='NON_OVERLAPPING') {
          session.append('SEMANTIC_ASSESSED',{request,assessed_at:issued_at,assessment});
          return {status:'BLOCKED',reason:'MANUAL_DECISION_REQUIRED',assessment,control_epoch:session.state.control_epoch};
        }
        session.append('APPROVED',{request,approval,semantic_assessment:assessment});
        return {status:'APPROVED',attempt_id:request.attempt_id,approval};
      });
    } catch(error) {
      const failure=storageFailure(error);if(failure) return failure;throw error;
    }
  }
  async function run(stateRoot,input) {
    const {request,expected_digest}=executionInput(input,['request','expected_digest']);
    const id=request.attempt_id;
    let execution_started=false,command_results=[],consumed=false,lastTime;
    const observedTime=()=>{const value=clock();check(lastTime===undefined || value>=lastTime,'CLOCK_ROLLBACK');lastTime=value;return value;};
    try {
      return await withStore(stateRoot,async session=>{
        const state=session.state,attempt=state.attempts[id],entry=state.approvals[id];
        if(attempt) {
          check(attempt.request_digest===expected_digest,'REQUEST_DIGEST_MISMATCH');
          command_results=attempt.command_results;
          return receipt(attempt.status,attempt.reason,id,false,command_results);
        }
        if(entry) check(entry.approval.request_digest===expected_digest,'REQUEST_DIGEST_MISMATCH');
        if(state.semantic_review_required) return receipt('BLOCKED','MANUAL_DECISION_REQUIRED',id);
        if(state.recovery_required || pending(state).length) return receipt('BLOCKED','RECOVERY_REQUIRED',id);
        if(!entry) return receipt('BLOCKED','APPROVAL_NOT_RECORDED',id);
        const assessment=assessLegacyApproval(session,request,observedTime());
        if(assessment.status!=='NON_OVERLAPPING') return receipt('BLOCKED','MANUAL_DECISION_REQUIRED',id);
        let reservation;
        const checkTime=()=>{checkApprovalTime(request,entry.approval,observedTime());};
        try {
          ({reservation}=checkDispatch(session.state,request,entry.approval,{now:observedTime(),capacity:capacity()}));
          checkTime(); // Slow inspection must not consume an already unusable approval.
        }
        catch(error) {return receipt('BLOCKED',reasonOf(error),id);}
        try {
          const metering=initialMeteringRecord(session.state,request,entry.approval.issued_at);
          // A failed durable write may still have reached disk; never treat it as an unused approval.
          consumed=true;
          session.append('PREPARED',{attempt_id:id,request_digest:expected_digest,reservation,metering});
          const finish=(status,reason)=>{
            session.append('FINISHED',{attempt_id:id,status,reason});
            return receipt(status,reason,id,execution_started,command_results);
          };
          for(let index=0;index<request.commands.length;index++) {
            checkDispatch(session.state,request,entry.approval,{now:observedTime(),capacity:capacity(),existingReservation:true});
            session.append('COMMAND_PREPARED',{attempt_id:id,index});
            let startedMeasurement;
            const observed=await runCommand(request.commands[index],{
              environment:request.environment,...request.limits,transcript_path:session.evidencePath(id,index),
              node_id:session.state.policy.quota.nodeId,boot_id:null,command_index:index,
              beforeSpawn:checkTime, // After durable intent and runner evidence setup, synchronously at spawn.
              onStarted:(pid,measurement)=>{
                execution_started=true;
                startedMeasurement=commandMeasurementContract(measurement??observedCommandMeasurement({command_index:index,
                  node_id:session.state.policy.quota.nodeId,started_at:Date.now(),started_ns:process.hrtime.bigint().toString()}));
                session.append('COMMAND_STARTED',{attempt_id:id,index,pid,measurement:startedMeasurement});
              }
            });
            const wrapped=observed && typeof observed==='object' && Object.hasOwn(observed,'result') && Object.hasOwn(observed,'measurement');
            let result=resultContract(wrapped?observed.result:observed);
            const measurement=commandMeasurementContract(wrapped?observed.measurement:startedMeasurement??
              observedCommandMeasurement({command_index:index,node_id:session.state.policy.quota.nodeId}));
            const invocations=wrapped && Object.hasOwn(observed,'invocations')?observed.invocations:[];
            // Preserve the observed result even if the subsequent inspection or journal append fails.
            command_results.push(result);
            try {
              observedTime();
              if(result.close_observed) {
                const current=planTask(session.state.repo_root,session.state.project,request.task,
                  {harness_revision:session.state.harness_revision??null});
                check(drift(request.baseline,current.baseline).status==='UNCHANGED','REPOSITORY_DRIFT');
              }
            } catch(error) {
              result=resultContract({...result,status:'RECOVERY_REQUIRED',reason:reasonOf(error)});
              command_results[index]=result;
            }
            session.append('COMMAND_FINISHED',{attempt_id:id,index,result,measurement,invocations});
            if(result.status!=='SUCCEEDED') return finish(result.status,result.reason);
          }
          return finish('SUCCEEDED','COMMANDS_SUCCEEDED');
        } catch(error) {
          const reason=reasonOf(error);
          try {session.append('FINISHED',{attempt_id:id,status:'RECOVERY_REQUIRED',reason});} catch {}
          return receipt('RECOVERY_REQUIRED',reason,id,execution_started,command_results);
        }
      });
    } catch(error) {
      if(reasonOf(error)==='REQUEST_DIGEST_MISMATCH') throw error;
      const failure=storageFailure(error);
      if(consumed) return receipt('RECOVERY_REQUIRED',failure?.status??reasonOf(error),id,execution_started,command_results);
      if(failure) {
        // A failed ownership acquisition may still permit a read-only replay.
        let recorded;
        try {recorded=readStore(stateRoot).state.attempts[id];} catch {}
        if(recorded) {
          check(recorded.request_digest===expected_digest,'REQUEST_DIGEST_MISMATCH');
          return receipt(recorded.status,recorded.reason,id,false,recorded.command_results);
        }
        return receipt('BLOCKED',failure.status,id);
      }
      throw error;
    }
  }
  function status(stateRoot) {
    try {return summary(readStore(stateRoot));}
    catch(error) {const failure=storageFailure(error);if(failure) return failure;throw error;}
  }
  function economics(stateRoot) {
    try {return economicsSummary(readStore(stateRoot).state);}
    catch(error) {const failure=storageFailure(error);if(failure) return failure;throw error;}
  }
  async function recover(stateRoot) {
    try {
      await withStore(stateRoot,session=>{
        const attempt_ids=pending(session.state);
        if(attempt_ids.length) session.append('RECOVERED',{attempt_ids,reason:'INTERRUPTED_ATTEMPT'});
      });
      return status(stateRoot);
    } catch(error) {const failure=storageFailure(error);if(failure) return failure;throw error;}
  }
  const eventCollections=Object.freeze({REVIEW_RECORDED:'review_events',ADOPTION_RECORDED:'adoption_events',
    COST_RECORDED:'cost_events',ENERGY_RECORDED:'energy_events'});
  async function appendPostRun(stateRoot,type,event) {
    try {
      return await withStore(stateRoot,session=>{
        const key=eventCollections[type];check(key,'INVALID_POST_RUN_EVENT');
        let existing,existingKey;
        for(const attempt of Object.values(session.state.attempts)) {
          for(const candidateKey of Object.values(eventCollections)) {
            const found=attempt.metering?.[candidateKey]?.find(item=>item.event_id===event.event_id);
            if(found) {existing=found;existingKey=candidateKey;break;}
          }
          if(existing) break;
        }
        if(existing) {
          check(existingKey===key && samePostRunEvent(existing,event),'POST_RUN_EVENT_CONFLICT');
          return {status:'RECORDED',changed:false,attempt_id:event.attempt_id,event_id:event.event_id};
        }
        session.append(type,{event});
        return {status:'RECORDED',changed:true,attempt_id:event.attempt_id,event_id:event.event_id};
      });
    } catch(error) {const failure=storageFailure(error);if(failure) return failure;throw error;}
  }
  async function recordReview(stateRoot,input) {
    const value=publicInput(input,['event_id','attempt_id','result_digest','reviewer_id','producer_id','independent','reviewed_at','review_result']);
    return appendPostRun(stateRoot,'REVIEW_RECORDED',reviewEventContract(value));
  }
  async function recordAdoption(stateRoot,input) {
    const value=publicInput(input,['event_id','attempt_id','result_digest','actor_id','actor_kind','actor_role','authorization_id',
      'decision','scope_digest','decided_at']);
    return appendPostRun(stateRoot,'ADOPTION_RECORDED',adoptionEventContract(value));
  }
  async function recordCost(stateRoot,input) {
    const value=publicInput(input,['event_id','attempt_id','result_digest','recorded_at','price_basis']);
    const meta=readStore(stateRoot),attempt=meta.state.attempts[value.attempt_id];
    check(attempt?.metering,'UNKNOWN_METERED_ATTEMPT');
    const {recorded_at,...base}=value,event=createCostEvent(attempt.metering,base,Date.parse(recorded_at));costEventContract(event);
    return appendPostRun(stateRoot,'COST_RECORDED',event);
  }
  async function recordEnergy(stateRoot,input) {
    const value=publicInput(input,['event_id','attempt_id','result_digest','measurement_id','measurement_evidence_digest','source_id','source_kind',
      'interval_started_at','interval_finished_at','observed_energy_kwh','measurement_scope','allocation_method','allocation_ratio',
      'allocated_energy_kwh','tariff_basis_id','tariff_currency','tariff_micros_per_kwh','tariff_source_ref','tariff_effective_at',
      'tariff_retrieved_at','energy_cost_micros','recorded_at']);
    const event=energyEventContract(value);
    return appendPostRun(stateRoot,'ENERGY_RECORDED',event);
  }
  return {init,prepare,approve,run,status,economics,recover,recordReview,recordAdoption,recordCost,recordEnergy};
}

export const {init,prepare,approve,run,status,economics,recover,recordReview,recordAdoption,recordCost,recordEnergy}=createController();
