import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requestDigest } from '../core/controller/contracts.mjs';
import { createController } from '../core/controller/controller.mjs';
import { controllerMain } from '../core/controller/cli.mjs';
import { runCommandMetered } from '../core/controller/runner.mjs';
import { withStore } from '../core/controller/store.mjs';
import { initialMeteringRecord, meteringRecordContract, observedCommandMeasurement } from '../core/metering.mjs';
import { energyEventContract } from '../core/postrun.mjs';
import { isolatedEnvironment } from '../core/reuse.mjs';
import { makeFixture } from './helpers/controller-fixture.mjs';

const childFixture=fileURLToPath(new URL('./helpers/controller-runner-child.mjs',import.meta.url));
const approve=async(api,f,attempt_id,task=f.task)=>{
  const request=api.prepare(f.stateRoot,{attempt_id,task}),expected_digest=requestDigest(request);
  assert.equal((await api.approve(f.stateRoot,{request,expected_digest,approval_id:attempt_id+'-approval',ttl_ms:60000})).status,'APPROVED');
  return {request,expected_digest};
};

test('metered runner records observed lifecycle and explicit unavailable resource facts',async t=>{
  const f=makeFixture();t.after(f.cleanup);
  const transcript_path=join(f.root,'metering-fixture-output');
  const observed=await runCommandMetered({executable:process.execPath,argv:[childFixture,'success'],cwd:f.repo},{
    environment:isolatedEnvironment(),timeout_ms:2000,max_output_bytes:65536,transcript_path,onStarted:()=>{},
    node_id:'fixture-node',boot_id:null,command_index:0
  });
  assert.equal(observed.result.status,'SUCCEEDED');
  assert.equal(observed.measurement.node_id,'fixture-node');
  assert.match(observed.measurement.worker_started_at_utc,/Z$/);
  assert.match(observed.measurement.worker_finished_at_utc,/Z$/);
  assert.match(observed.measurement.monotonic_started_ns,/^\d+$/);
  assert.match(observed.measurement.monotonic_finished_ns,/^\d+$/);
  assert(observed.measurement.execution_duration_ms>=0);
  assert.equal(observed.measurement.worker_cpu_user_seconds,null);
  assert.equal(observed.measurement.worker_memory_peak_bytes,null);
  assert.deepEqual(observed.measurement.missing_reasons,
    ['BOOT_ID_NOT_OBSERVED','CHILD_CPU_TIME_NOT_OBSERVED','CHILD_MEMORY_PEAK_NOT_OBSERVED']);
});

test('Controller journals one truthful metering record through task completion',async t=>{
  const f=makeFixture(),api=createController();t.after(f.cleanup);api.init(f.stateRoot,f.repo,f.project,f.policy);
  const input=await approve(api,f,'metered-success');
  assert.equal((await api.run(f.stateRoot,input)).status,'SUCCEEDED');
  const record=api.status(f.stateRoot).state.attempts['metered-success'].metering;
  assert.equal(record.root_task_id,f.task.task_id);assert.equal(record.node_id,'fixture-node');
  assert.equal(record.retry_index,0);assert.equal(record.parent_attempt_id,null);
  assert.equal(record.routing_decision.reason_code,'DETERMINISTIC_TOOL_PREFERRED');
  assert.equal(record.execution_status,'SUCCEEDED');assert.equal(record.test_status,'PASS');
  assert.equal(record.review_status,'PENDING');assert.equal(record.adoption_status,'PENDING');
  assert.equal(record.model_usage_status,'NOT_APPLICABLE');
  assert.equal(record.model_input_tokens,null);assert.equal(record.model_output_tokens,null);
  assert.deepEqual(record.invocations,[]);
  assert.equal(record.estimated_api_avoided_cost,null);assert.equal(record.api_cost_status,'INCOMPLETE');
  assert.equal(record.energy_kwh,null);assert.equal(record.energy_cost,null);assert.equal(record.energy_status,'INCOMPLETE');
  assert.match(record.result_digest,/^[0-9a-f]{64}$/);assert.equal(record.command_measurements.length,1);
});

test('failed work and its retry remain separate attempts under one root task',async t=>{
  const f=makeFixture({startCounter:true}),api=createController();t.after(f.cleanup);
  f.project.commands.unit.argv.push('fail');f.policy.commands.unit.prefix_argv=[];
  api.init(f.stateRoot,f.repo,f.project,f.policy);
  const first=await approve(api,f,'metered-failure');assert.equal((await api.run(f.stateRoot,first)).status,'FAILED');
  f.project.commands.unit.argv.pop();
  // The immutable initialized project still invokes the failing command; use a second failed attempt to prove retry lineage.
  const second=await approve(api,f,'metered-retry');assert.equal((await api.run(f.stateRoot,second)).status,'FAILED');
  const state=api.status(f.stateRoot).state;
  assert.equal(state.attempts['metered-failure'].metering.retry_index,0);
  assert.equal(state.attempts['metered-retry'].metering.retry_index,1);
  assert.equal(state.attempts['metered-retry'].metering.parent_attempt_id,'metered-failure');
  assert.equal(state.attempts['metered-retry'].metering.root_task_id,f.task.task_id);
  assert.equal(state.attempts['metered-retry'].metering.execution_status,'FAILED');
  assert.equal(state.attempts['metered-retry'].metering.test_status,'FAIL');
});

test('journal reducer rejects forged node attribution before execution',async t=>{
  const f=makeFixture(),api=createController();t.after(f.cleanup);api.init(f.stateRoot,f.repo,f.project,f.policy);
  const input=await approve(api,f,'forged-metering');
  await assert.rejects(withStore(f.stateRoot,session=>{
    const metering=initialMeteringRecord(session.state,input.request,
      session.state.approvals['forged-metering'].approval.issued_at);
    metering.node_id='different node';
    session.append('PREPARED',{attempt_id:'forged-metering',request_digest:input.expected_digest,
      reservation:{cpuThreads:1,memoryGiB:2,activeTasks:1},metering});
  }),/METERING_BINDING_MISMATCH/);
  assert.equal(Object.hasOwn(api.status(f.stateRoot).state.attempts,'forged-metering'),false);
});

test('recovery preserves an interrupted measurement as LOST instead of inventing completion',async t=>{
  const f=makeFixture(),api=createController();t.after(f.cleanup);api.init(f.stateRoot,f.repo,f.project,f.policy);
  const input=await approve(api,f,'interrupted-metering');
  await withStore(f.stateRoot,session=>{
    const metering=initialMeteringRecord(session.state,input.request,
      session.state.approvals['interrupted-metering'].approval.issued_at);
    session.append('PREPARED',{attempt_id:'interrupted-metering',request_digest:input.expected_digest,
      reservation:{cpuThreads:1,memoryGiB:2,activeTasks:1},metering});
    session.append('COMMAND_PREPARED',{attempt_id:'interrupted-metering',index:0});
    session.append('COMMAND_STARTED',{attempt_id:'interrupted-metering',index:0,pid:123,
      measurement:observedCommandMeasurement({command_index:0,node_id:'fixture-node',started_at:1000,started_ns:'1000000'})});
  });
  const recovered=await api.recover(f.stateRoot),record=recovered.state.attempts['interrupted-metering'].metering;
  assert.equal(record.execution_status,'LOST');assert.equal(record.test_status,'INCOMPLETE');
  assert.equal(record.worker_finished_at_utc,null);assert.equal(record.monotonic_finished_ns,null);
  assert.equal(record.execution_duration_ms,null);assert.equal(record.command_measurements.length,1);
  assert(record.missing_reasons.includes('WORKER_FINISH_NOT_OBSERVED'));
});

test('metering public contract rejects accessors without evaluating them',()=>{
  let evaluated=false;
  const hostile={};
  Object.defineProperty(hostile,'schema_version',{enumerable:true,get(){evaluated=true;return 1;}});
  assert.throws(()=>meteringRecordContract(hostile),/INVALID_JSON_INPUT/);
  assert.equal(evaluated,false);
});

test('Controller binds pre-execution local routing and aggregates provider final usage',async t=>{
  const f=makeFixture();t.after(f.cleanup);
  f.policy.routing={reason_code:'PILOT_EXPERIMENT',chosen_provider_kind:'LOCAL_MODEL_PROVIDER',
    decision_source:'M2_OPERATOR_POLICY'};
  const invocation={invocation_id:'INVOCATION-1',provider_kind:'OLLAMA',provider_endpoint_ref:'LOOPBACK_OLLAMA',
    inference_node_id:'fixture-node',model_name:'fixture-model',model_digest_or_revision:'a'.repeat(64),inference_location:'LOCAL',
    prompt_eval_count:3,eval_count:4,total_duration_ns:'100',load_duration_ns:'10',prompt_eval_duration_ns:'20',
    eval_duration_ns:'70',response_complete:true,usage_status:'OBSERVED',usage_missing_reason:null};
  const api=createController({runCommand:async(command,options)=>({...await runCommandMetered(command,options),invocations:[invocation]})});
  api.init(f.stateRoot,f.repo,f.project,f.policy);
  const input=await approve(api,f,'metered-provider');assert.equal((await api.run(f.stateRoot,input)).status,'SUCCEEDED');
  const record=api.status(f.stateRoot).state.attempts['metered-provider'].metering;
  assert.equal(record.routing_decision.reason_code,'PILOT_EXPERIMENT');
  assert.equal(record.routing_decision.chosen_provider_kind,'LOCAL_MODEL_PROVIDER');
  assert.equal(record.model_usage_status,'OBSERVED');assert.equal(record.model_usage_missing_reason,null);
  assert.equal(record.model_input_tokens,3);assert.equal(record.model_output_tokens,4);
  assert.deepEqual(record.invocations,[invocation]);assert(!record.missing_reasons.includes('NO_MODEL_INVOCATION'));
});

const reviewResult=(task_id,verdict='PASS')=>({task_id,reviewer_role:'reviewer',verdict,
  findings:verdict==='PASS'?[]:[{severity:'P2',summary:'fixture finding',evidence:'fixture evidence'}],
  evidence:['fixture independent command'],independent_commands:['npm test']});
const enablePostRun=f=>{f.policy.post_run_authority={reviewer_ids:['reviewer-1'],adoption_actor_ids:['owner-1'],
  price_basis_ids:['PRICE-1'],energy_source_ids:['SMART-PLUG-1'],tariff_basis_ids:['TARIFF-1']};};

test('post-run review and human adoption bind exact result and replay idempotently',async t=>{
  const f=makeFixture(),api=createController();enablePostRun(f);t.after(f.cleanup);api.init(f.stateRoot,f.repo,f.project,f.policy);
  const input=await approve(api,f,'postrun-review');assert.equal((await api.run(f.stateRoot,input)).status,'SUCCEEDED');
  const initial=api.status(f.stateRoot).state.attempts['postrun-review'].metering,digest=initial.result_digest;
  const reviewedAt=new Date(Date.parse(initial.worker_finished_at_utc)+1000).toISOString();
  const adoptedAt=new Date(Date.parse(initial.worker_finished_at_utc)+2000).toISOString();
  const adoption={event_id:'ADOPTION-1',attempt_id:'postrun-review',result_digest:digest,actor_id:'owner-1',
    actor_kind:'HUMAN',actor_role:'OWNER',authorization_id:'owner-decision-1',decision:'ADOPTED',scope_digest:null,
    decided_at:adoptedAt};
  await assert.rejects(api.recordAdoption(f.stateRoot,adoption),/ADOPTION_GATE_NOT_MET/);
  await assert.rejects(api.recordReview(f.stateRoot,{event_id:'REVIEW-SAME',attempt_id:'postrun-review',result_digest:digest,
    reviewer_id:'worker-1',producer_id:'worker-1',independent:true,reviewed_at:reviewedAt,
    review_result:reviewResult(f.task.task_id)}),/INVALID_REVIEW_EVENT/);
  const review={event_id:'REVIEW-1',attempt_id:'postrun-review',result_digest:digest,reviewer_id:'reviewer-1',
    producer_id:'worker-1',independent:true,reviewed_at:reviewedAt,review_result:reviewResult(f.task.task_id)};
  await assert.rejects(api.recordReview(f.stateRoot,{...review,event_id:'REVIEW-UNAUTHORIZED',reviewer_id:'reviewer-2'}),
    /UNAUTHORIZED_REVIEWER/);
  assert.deepEqual(await api.recordReview(f.stateRoot,review),
    {status:'RECORDED',changed:true,attempt_id:'postrun-review',event_id:'REVIEW-1'});
  assert.equal((await api.recordReview(f.stateRoot,review)).changed,false);
  await assert.rejects(api.recordReview(f.stateRoot,{...review,review_result:reviewResult(f.task.task_id,'REJECT')}),
    /POST_RUN_EVENT_CONFLICT/);
  await assert.rejects(api.recordAdoption(f.stateRoot,{...adoption,actor_kind:'AGENT'}),/INVALID_ADOPTION_EVENT/);
  assert.equal((await api.recordAdoption(f.stateRoot,adoption)).changed,true);
  assert.equal((await api.recordAdoption(f.stateRoot,adoption)).changed,false);
  const record=api.status(f.stateRoot).state.attempts['postrun-review'].metering;
  assert.equal(record.review_status,'PASS');assert.equal(record.adoption_status,'ADOPTED');
  assert.equal(record.review_events.length,1);assert.equal(record.adoption_events.length,1);
  await assert.rejects(api.recordReview(f.stateRoot,{...review,event_id:'REVIEW-WRONG',result_digest:'f'.repeat(64)}),
    /POST_RUN_BINDING_MISMATCH/);
});

test('counterfactual token price is versioned, rounded and never counted twice',async t=>{
  const f=makeFixture();enablePostRun(f);t.after(f.cleanup);
  const invocation={invocation_id:'COST-INVOCATION',provider_kind:'LOCAL_PROVIDER',provider_endpoint_ref:'LOCAL_ENDPOINT',
    inference_node_id:'fixture-node',model_name:'local-model',model_digest_or_revision:'a'.repeat(64),inference_location:'LOCAL',
    prompt_eval_count:3,eval_count:4,total_duration_ns:'100',load_duration_ns:'10',prompt_eval_duration_ns:'20',
    eval_duration_ns:'70',response_complete:true,usage_status:'OBSERVED',usage_missing_reason:null};
  const api=createController({runCommand:async(command,options)=>({...await runCommandMetered(command,options),invocations:[invocation]})});
  api.init(f.stateRoot,f.repo,f.project,f.policy);const input=await approve(api,f,'postrun-cost');
  assert.equal((await api.run(f.stateRoot,input)).status,'SUCCEEDED');
  const initial=api.status(f.stateRoot).state.attempts['postrun-cost'].metering,result_digest=initial.result_digest;
  const finished=Date.parse(initial.worker_finished_at_utc),recordedAt=new Date(finished+2000).toISOString();
  const cost={event_id:'COST-1',attempt_id:'postrun-cost',result_digest,recorded_at:recordedAt,
    price_basis:{basis_id:'PRICE-1',provider_kind:'PAID_API',model_name:'counterfactual-model',model_revision:'2026-09',
      currency:'USD',input_micros_per_million_tokens:100000,output_micros_per_million_tokens:300000,
      source_ref:'approved-price-snapshot-sha256',effective_at:new Date(finished-2000).toISOString(),
      retrieved_at:new Date(finished+1000).toISOString(),comparison_eligible:true,missing_reason:null}};
  await assert.rejects(api.recordCost(f.stateRoot,{...cost,event_id:'COST-UNAUTHORIZED',
    price_basis:{...cost.price_basis,basis_id:'PRICE-OTHER'}}),/UNAUTHORIZED_PRICE_BASIS/);
  assert.equal((await api.recordCost(f.stateRoot,cost)).changed,true);
  assert.equal((await api.recordCost(f.stateRoot,cost)).changed,false);
  const record=api.status(f.stateRoot).state.attempts['postrun-cost'].metering;
  assert.equal(record.cost_events[0].estimated_cost_micros,2);
  assert.equal(record.estimated_api_avoided_cost,0.000002);assert.equal(record.estimated_api_avoided_currency,'USD');
  assert.equal(record.api_cost_status,'ESTIMATED');assert.equal(record.api_cost_missing_reason,null);
  const summary=api.economics(f.stateRoot);
  assert.equal(summary.status,'INCOMPLETE');assert.equal(summary.unique_task_count,1);assert.equal(summary.attempt_count,1);
  assert.deepEqual(summary.observed_model_usage,{attempt_count:1,input_tokens:3,output_tokens:4});
  assert.deepEqual(summary.estimated_api_counterfactual,
    {attempt_count:1,micro_units_by_currency:{USD:2},by_currency:{USD:0.000002}});
  assert.equal(summary.observed_energy,null);assert.equal(summary.energy_cost,null);
  await assert.rejects(api.recordCost(f.stateRoot,{...cost,event_id:'COST-2'}),/POST_RUN_BINDING_MISMATCH/);
});

test('observed node-window energy preserves allocation and optional tariff evidence',async t=>{
  const f=makeFixture(),api=createController();enablePostRun(f);t.after(f.cleanup);api.init(f.stateRoot,f.repo,f.project,f.policy);
  const input=await approve(api,f,'postrun-energy');assert.equal((await api.run(f.stateRoot,input)).status,'SUCCEEDED');
  const initial=api.status(f.stateRoot).state.attempts['postrun-energy'].metering,result_digest=initial.result_digest;
  const intervalStarted=new Date(Date.parse(initial.worker_started_at_utc)-1000).toISOString();
  const intervalFinished=new Date(Date.parse(initial.worker_finished_at_utc)+1000).toISOString();
  const energyRecorded=new Date(Date.parse(initial.worker_finished_at_utc)+2000).toISOString();
  const energy={event_id:'ENERGY-1',attempt_id:'postrun-energy',result_digest,measurement_id:'METER-READING-1',
    measurement_evidence_digest:'e'.repeat(64),
    source_id:'SMART-PLUG-1',source_kind:'SMART_PLUG',interval_started_at:intervalStarted,
    interval_finished_at:intervalFinished,observed_energy_kwh:0.2,measurement_scope:'NODE_INTERVAL',
    allocation_method:'PROPORTIONAL',allocation_ratio:0.25,allocated_energy_kwh:0.05,tariff_basis_id:'TARIFF-1',
    tariff_currency:'KRW',tariff_micros_per_kwh:200000000,tariff_source_ref:'approved-tariff-snapshot-sha256',
    tariff_effective_at:new Date(Date.parse(initial.worker_finished_at_utc)-2000).toISOString(),
    tariff_retrieved_at:new Date(Date.parse(initial.worker_finished_at_utc)+1000).toISOString(),energy_cost_micros:10000000,
    recorded_at:energyRecorded};
  await assert.rejects(api.recordEnergy(f.stateRoot,{...energy,event_id:'ENERGY-UNAUTHORIZED',source_id:'OTHER-METER'}),
    /UNAUTHORIZED_ENERGY_EVIDENCE/);
  assert.equal((await api.recordEnergy(f.stateRoot,energy)).changed,true);
  assert.equal((await api.recordEnergy(f.stateRoot,energy)).changed,false);
  const record=api.status(f.stateRoot).state.attempts['postrun-energy'].metering;
  assert.equal(record.energy_kwh,0.05);assert.equal(record.energy_cost,10);assert.equal(record.energy_currency,'KRW');
  assert.equal(record.energy_status,'OBSERVED');assert.equal(record.energy_missing_reason,null);
  assert(!record.missing_reasons.includes('NO_ENERGY_SENSOR'));
  assert.deepEqual(api.economics(f.stateRoot).observed_energy,{attempt_count:1,kwh:0.05});
  assert.deepEqual(api.economics(f.stateRoot).energy_cost,
    {attempt_count:1,micro_units_by_currency:{KRW:10000000},by_currency:{KRW:10}});
  await assert.rejects(api.recordEnergy(f.stateRoot,{...energy,event_id:'ENERGY-BAD',allocated_energy_kwh:0.06}),
    /INVALID_ENERGY_EVENT/);
  const unpriced={...energy,event_id:'ENERGY-UNPRICED',tariff_basis_id:null,tariff_currency:null,
    tariff_micros_per_kwh:null,tariff_source_ref:null,tariff_effective_at:null,tariff_retrieved_at:null,energy_cost_micros:null};
  assert.equal(energyEventContract(unpriced).tariff_basis_id,null);
  assert.throws(()=>energyEventContract({...unpriced,tariff_currency:'KRW'}),/INVALID_ENERGY_EVENT/);
});

test('legacy M2 metering records without M3 event arrays remain valid',async t=>{
  const f=makeFixture(),api=createController();t.after(f.cleanup);api.init(f.stateRoot,f.repo,f.project,f.policy);
  const input=await approve(api,f,'legacy-metering-shape');
  const record=initialMeteringRecord(api.status(f.stateRoot).state,input.request,
    api.status(f.stateRoot).state.approvals['legacy-metering-shape'].approval.issued_at);
  delete record.review_events;delete record.adoption_events;delete record.cost_events;delete record.energy_events;
  assert.equal(meteringRecordContract(record).review_status,'PENDING');
  assert.throws(()=>meteringRecordContract({...record,review_status:'PASS'}),/INVALID_METERING_RECORD/);
  await withStore(f.stateRoot,session=>session.append('PREPARED',{attempt_id:'legacy-metering-shape',
    request_digest:input.expected_digest,reservation:{cpuThreads:input.request.resources.cpu_threads,
      memoryGiB:input.request.resources.memory_gib,activeTasks:1},metering:record}));
  const replayed=api.status(f.stateRoot).state.attempts['legacy-metering-shape'].metering;
  assert.equal(Object.hasOwn(replayed,'review_events'),false);assert.equal(replayed.review_status,'PENDING');
});

test('post-run evidence is refused when immutable policy has no authority list',async t=>{
  const f=makeFixture(),api=createController();t.after(f.cleanup);api.init(f.stateRoot,f.repo,f.project,f.policy);
  const input=await approve(api,f,'postrun-no-authority');assert.equal((await api.run(f.stateRoot,input)).status,'SUCCEEDED');
  const record=api.status(f.stateRoot).state.attempts['postrun-no-authority'].metering;
  await assert.rejects(api.recordReview(f.stateRoot,{event_id:'REVIEW-NO-AUTH',attempt_id:'postrun-no-authority',
    result_digest:record.result_digest,reviewer_id:'reviewer-1',producer_id:'worker-1',independent:true,
    reviewed_at:new Date(Date.parse(record.worker_finished_at_utc)+1000).toISOString(),review_result:reviewResult(f.task.task_id)}),
  /POST_RUN_AUTHORITY_REQUIRED/);
});

test('M3 CLI records a bounded review file and exposes read-only economics',async t=>{
  const f=makeFixture(),api=createController();enablePostRun(f);t.after(f.cleanup);api.init(f.stateRoot,f.repo,f.project,f.policy);
  const input=await approve(api,f,'postrun-cli');assert.equal((await api.run(f.stateRoot,input)).status,'SUCCEEDED');
  const record=api.status(f.stateRoot).state.attempts['postrun-cli'].metering,path=join(f.root,'review-event.json');
  writeFileSync(path,JSON.stringify({event_id:'REVIEW-CLI',attempt_id:'postrun-cli',result_digest:record.result_digest,
    reviewer_id:'reviewer-1',producer_id:'worker-1',independent:true,
    reviewed_at:new Date(Date.parse(record.worker_finished_at_utc)+1000).toISOString(),review_result:reviewResult(f.task.task_id)}));
  assert.equal((await controllerMain(['review',f.stateRoot,path])).status,'RECORDED');
  const summary=await controllerMain(['economics',f.stateRoot]);
  assert.equal(summary.review_counts.PASS,1);assert.equal(summary.adoption_counts.PENDING,1);
});
