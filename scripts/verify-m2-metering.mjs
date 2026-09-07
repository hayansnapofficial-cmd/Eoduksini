import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from '../core/controller/controller.mjs';
import { requestDigest } from '../core/controller/contracts.mjs';
import { runOllamaCommandMetered } from '../packages/runtime-adapters/providers/ollama.mjs';

if(process.platform!=='linux') throw new Error('M2_LINUX_REQUIRED');
const nodeId=process.argv[2]??'m2',model=process.argv[3]??'qwen3.5:9b',endpoint=process.argv[4]??'http://127.0.0.1:11434';
if(nodeId!=='m2') throw new Error('M2_NODE_ID_REQUIRED');
const worker=fileURLToPath(new URL('../packages/runtime-adapters/providers/ollama-worker.mjs',import.meta.url));
const requestedParent=process.argv[5];
let root;
if(requestedParent===undefined) root=mkdtempSync(join(tmpdir(),'eoduksini-m2-metering-'));
else {
  if(!isAbsolute(requestedParent)) throw new Error('M2_STATE_PARENT_MUST_BE_ABSOLUTE');
  const parent=realpathSync(requestedParent),parentStat=lstatSync(parent);
  if(!parentStat.isDirectory() || parentStat.isSymbolicLink() ||
    (process.getuid?.()!==undefined && parentStat.uid!==process.getuid()) || (parentStat.mode&0o077)!==0)
    throw new Error('M2_STATE_PARENT_UNSAFE');
  root=mkdtempSync(join(parent,'eoduksini-m2-metering-'));
}
const repo=join(root,'repo'),stateRoot=join(root,'state');
mkdirSync(repo);writeFileSync(join(repo,'m2-task.txt'),'M2 isolated metering probe\n');
const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git(['init','-b','main']);git(['config','user.name','Eoduksini M2 Probe']);
git(['config','user.email','m2-probe@example.invalid']);git(['add','.']);git(['commit','-m','M2 isolated probe baseline']);
const head=git(['rev-parse','HEAD']),scope={write_paths:['m2-task.txt'],symbols:[],api_routes:[],request_contracts:[],
  response_contracts:[],database_objects:[],migration_objects:[],rls_policies:[],environment_keys:[],generated_types:[],runtime_services:[]};
const project={schema_version:1,project_id:'m2-metering',task_prefix:'M2-',
  repository:{url:'https://example.invalid/eoduksini-m2-metering.git',reference_sha:head},
  commands:{ollama_probe:{argv:['node',worker,'--endpoint',endpoint,'--model',model,'--invocation-id','M2-INVOCATION-1',
    '--node-id','m2'],cwd:'.'}},
  watch_paths:['m2-task.txt'],schema_paths:[],schema_owner_role:'database-schema-owner',
  required_gates:{LOW:['worker','reviewer'],MEDIUM:['worker','reviewer'],HIGH:['worker','reviewer'],CRITICAL:['worker','reviewer']},
  harness_paths:[]};
const task={task_id:'M2-METERING-001',milestone:'metering-m2',base_sha:head,owner_role:'worker',worktree_id:'m2-isolated',
  goal:'Verify one isolated local model invocation is durably metered.',in_scope_paths:['m2-task.txt'],out_of_scope_paths:[],
  acceptance_criteria:['Observed resource and provider usage is journaled'],required_tests:['ollama_probe'],data_risk:'LOW',
  schema_change:false,dependencies:[],failure_tests:[],shared_file_leases:[],release_impact:'NONE'};
const now=Date.now(),policy={schema_version:1,commands:{ollama_probe:{executable:process.execPath,prefix_argv:[],scope}},
  quota:{contractId:'CT-M2-METERING',nodeId:'m2',baseCpuThreads:1,maxCpuThreads:2,baseMemoryGiB:2,maxMemoryGiB:4,
    maxConcurrentTasks:1,burstExpiresAt:now+3600000,updatedAt:now},resources:{cpu_threads:1,memory_gib:2,allow_burst:false},
  limits:{timeout_ms:60000,max_output_bytes:65536,max_commands:1,approval_ttl_ms:180000},governor_locks:[],
  routing:{reason_code:'PILOT_EXPERIMENT',chosen_provider_kind:'LOCAL_MODEL_PROVIDER',decision_source:'M2_OPERATOR_POLICY'}};

const api=createController({runCommand:runOllamaCommandMetered});
api.init(stateRoot,repo,project,policy);
const request=api.prepare(stateRoot,{attempt_id:'M2-ATTEMPT-1',task}),expected_digest=requestDigest(request);
const approval=await api.approve(stateRoot,{request,expected_digest,approval_id:'M2-APPROVAL-1',ttl_ms:180000});
if(approval.status!=='APPROVED') throw new Error('M2_APPROVAL_FAILED: '+approval.reason);
const result=await api.run(stateRoot,{request,expected_digest});
const record=api.status(stateRoot).state.attempts['M2-ATTEMPT-1'].metering;
const complete=result.status==='SUCCEEDED' && record.node_id==='m2' && record.boot_id!==null &&
  typeof record.worker_cpu_user_seconds==='number' && typeof record.worker_cpu_system_seconds==='number' &&
  Number.isSafeInteger(record.worker_memory_peak_bytes) && record.worker_memory_peak_bytes>0 &&
  record.model_usage_status==='OBSERVED' && Number.isSafeInteger(record.model_input_tokens) &&
  Number.isSafeInteger(record.model_output_tokens) && record.invocations.length===1 && record.invocations[0].response_complete===true;
if(!complete) throw new Error('M2_METERING_INCOMPLETE');
process.stdout.write(JSON.stringify({status:'M2_METERING_VERIFIED',state_root:stateRoot,evidence_root:join(stateRoot,'evidence'),
  record},null,2)+'\n');
