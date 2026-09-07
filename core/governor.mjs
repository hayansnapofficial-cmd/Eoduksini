import { digest, safePath } from './contracts.mjs';
const fields=['write_paths','symbols','api_routes','request_contracts','response_contracts','database_objects','migration_objects','rls_policies','environment_keys','generated_types','runtime_services'];
function check(condition,reason) { if(!condition) throw new Error(reason); }
function exact(value,keys) { check(value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(k=>keys.includes(k)) && keys.every(k=>Object.hasOwn(value,k)),'INVALID_CONTRACT'); }
function identifier(value) { return typeof value==='string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value); }
const hash = v=>typeof v==='string' && /^[0-9a-f]{64}$/.test(v);
const positive = v=>Number.isSafeInteger(v) && v>0;
function freeze(value) { if(value && typeof value==='object') { for(const v of Object.values(value)) freeze(v); Object.freeze(value); } return value; }
export function scope(value) {
  check(value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).every(k=>fields.includes(k)),'INVALID_SCOPE');
  const out={};
  for(const field of fields) {
    const values=value[field]??[];
    check(Array.isArray(values) && values.every(v=>typeof v==='string' && v.length>0 && !/[\x00-\x1f]/.test(v)),'INVALID_SCOPE');
    if(field==='write_paths') values.forEach(v=>safePath(v,{glob:true}));
    out[field]=[...new Set(values)].sort();
  }
  check(Object.values(out).some(v=>v.length),'EMPTY_SCOPE');
  return out;
}
export function scopeOverlap(left,right) {
  left=scope(left); right=scope(right);
  const hits=[];
  for(const field of fields) {
    for(const a of left[field]) for(const b of right[field]) {
      if(field!=='write_paths') { if(a===b) hits.push(field+':'+a); continue; }
      // Conservative for globs: same literal-prefix region is held for review.
      const ap=a.split('*')[0].replace(/\/$/,''), bp=b.split('*')[0].replace(/\/$/,'');
      if(ap===bp || !ap || !bp || ap.startsWith(bp+'/') || bp.startsWith(ap+'/') ||
        (a.includes('*') && bp.startsWith(ap)) || (b.includes('*') && ap.startsWith(bp)))
        hits.push(field+':'+a+' ~ '+b);
    }
  }
  return [...new Set(hits)].sort();
}
export function baselineContract(value) {
  exact(value,['git_sha','harness_revision','task_graph_revision','migration_head','dependency_lock_digest','api_contract_digest','policy_digest','control_epoch']);
  check(/^[0-9a-f]{40}$/.test(value.git_sha) && positive(value.harness_revision) && positive(value.task_graph_revision) &&
    positive(value.control_epoch) && typeof value.migration_head==='string' && value.migration_head.length>0 &&
    hash(value.dependency_lock_digest) && hash(value.api_contract_digest) && hash(value.policy_digest),'INVALID_BASELINE');
  return structuredClone(value);
}
export function issueLock({lockId,projectId,provider,approvedProviders,baseline,scope:requested,now,ttlMs,heartbeatMs,activeLocks=[]}) {
  check(identifier(lockId) && identifier(projectId) && identifier(provider),'INVALID_LOCK_IDENTITY');
  check(Array.isArray(approvedProviders) && approvedProviders.includes(provider),'GOVERNOR_PROVIDER_NOT_APPROVED');
  check(Number.isSafeInteger(now) && positive(ttlMs) && positive(heartbeatMs) && ttlMs>heartbeatMs,'INVALID_LEASE');
  const lockedScope=scope(requested), canonical=baselineContract(baseline);
  for(const lock of activeLocks) {
    check(lock.lock_id!==lockId,'LOCK_ID_REUSED');
    if(lock.project_id===projectId && lock.status!=='UNLOCKED')
      check(!scopeOverlap(lock.scope,lockedScope).length,'SCOPE_ALREADY_LOCKED');
  }
  return freeze({lock_id:lockId,project_id:projectId,owner_role:'HIGH_ASSURANCE_GOVERNOR',provider_binding:provider,
    baseline:canonical,baseline_digest:digest(canonical),scope:lockedScope,issued_at:now,expires_at:now+ttlMs,
    heartbeat_interval_ms:heartbeatMs,last_heartbeat_at:now,status:'GOVERNOR_LOCKED'});
}
export function lockState(lock,now) {
  check(Number.isSafeInteger(now) && now>=lock.issued_at,'INVALID_TIME');
  if(lock.status==='UNLOCKED') return 'UNLOCKED';
  if(lock.status==='LOCK_RECOVERY') return 'LOCK_RECOVERY';
  if(now>=lock.expires_at) return 'LOCK_EXPIRED';
  if(now-lock.last_heartbeat_at>lock.heartbeat_interval_ms) return 'LOCK_HEARTBEAT_LOST';
  return lock.status;
}
export function writerGate(locks,{projectId,scope:requested,now}) {
  requested=scope(requested);
  check(identifier(projectId) && Number.isSafeInteger(now),'INVALID_WRITER_REQUEST');
  const blocked=locks.filter(lock=>lock.project_id===projectId && lockState(lock,now)!=='UNLOCKED' && scopeOverlap(lock.scope,requested).length);
  return {allowed:blocked.length===0,locks:blocked.map(lock=>({lock_id:lock.lock_id,state:lockState(lock,now)}))};
}
export function heartbeat(lock,{provider,controlEpoch,now,ttlMs}) {
  check(lockState(lock,now)==='GOVERNOR_LOCKED','LOCK_RECOVERY_REQUIRED');
  check(provider===lock.provider_binding,'PROVIDER_LOCKED');
  check(controlEpoch===lock.baseline.control_epoch,'STALE_CONTROL_EPOCH');
  check(now>=lock.last_heartbeat_at && positive(ttlMs) && ttlMs>lock.heartbeat_interval_ms,'INVALID_LEASE');
  return freeze({...lock,last_heartbeat_at:now,expires_at:now+ttlMs});
}
export function providerFailed(lock) { return freeze({...lock,status:'LOCK_RECOVERY'}); }
export function validateDecision(lock,decision,{canonical,now}) {
  check(lockState(lock,now)==='GOVERNOR_LOCKED','LOCK_RECOVERY_REQUIRED');
  exact(decision,['decision_id','lock_id','provider_binding','control_epoch','baseline_digest','task_actions','required_tests','evidence_ids']);
  check(identifier(decision.decision_id) && decision.lock_id===lock.lock_id,'DECISION_LOCK_MISMATCH');
  check(decision.provider_binding===lock.provider_binding,'PROVIDER_LOCKED');
  check(decision.control_epoch===lock.baseline.control_epoch && decision.control_epoch===canonical.control_epoch,'STALE_GOVERNOR_DECISION');
  check(digest(baselineContract(canonical))===lock.baseline_digest && decision.baseline_digest===lock.baseline_digest,'BASELINE_DRIFT');
  check(Array.isArray(decision.task_actions),'INVALID_ACTION');
  for(const action of decision.task_actions) {
    exact(action,['task_id','action']);
    check(identifier(action.task_id) && ['KEEP','REVIEW','REBASE','CANCEL','RESTART','NEW','BLOCK','RETEST'].includes(action.action),'INVALID_ACTION');
  }
  check(new Set(decision.task_actions.map(a=>a.task_id)).size===decision.task_actions.length,'DUPLICATE_TASK_ACTION');
  for(const values of [decision.required_tests,decision.evidence_ids])
    check(Array.isArray(values) && values.length>0 && values.every(identifier),'EVIDENCE_REQUIRED');
  return freeze(structuredClone(decision));
}
export function unlock(lock,decision,{canonical,now,verification}) {
  validateDecision(lock,decision,{canonical,now});
  exact(verification,['decision_digest','verifier_id','independent','tests','evidence_ids']);
  check(verification.decision_digest===digest(decision) && identifier(verification.verifier_id) &&
    verification.independent===true,'INDEPENDENT_VERIFICATION_REQUIRED');
  check(Array.isArray(verification.tests) && decision.required_tests.every(name=>
    verification.tests.some(t=>t.name===name && t.result==='PASS')),'REVERIFICATION_REQUIRED');
  check(Array.isArray(verification.evidence_ids) && verification.evidence_ids.length>0 &&
    verification.evidence_ids.every(identifier),'EVIDENCE_REQUIRED');
  return freeze({...lock,status:'UNLOCKED',decision_digest:digest(decision),verification_digest:digest(verification)});
}
// These are deterministic controller contracts. Transport identity, durable storage,
// checkpoint acknowledgement and process isolation belong to a future runtime.
