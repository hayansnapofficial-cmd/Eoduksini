import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController } from '../core/controller/controller.mjs';
import { digest } from '../core/contracts.mjs';
import { requestDigest } from '../core/controller/contracts.mjs';
import { runOllamaCommandMetered } from '../packages/runtime-adapters/providers/ollama.mjs';

if(process.platform!=='linux') throw new Error('M3_LINUX_REQUIRED');
const promptInput=process.argv[2],requestedParent=process.argv[3],nodeId=process.argv[4]??'m2';
const model=process.argv[5]??'qwen3.5:9b',endpoint=process.argv[6]??'http://127.0.0.1:11434';
if(!promptInput || !requestedParent || !isAbsolute(promptInput) || !isAbsolute(requestedParent) ||
  !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) throw new Error('M3_INVALID_ARGUMENTS');
const promptStat=lstatSync(promptInput);
if(!promptStat.isFile() || promptStat.isSymbolicLink() || promptStat.size<=0 || promptStat.size>64*1024 ||
  realpathSync(promptInput)!==resolve(promptInput)) throw new Error('M3_PROMPT_UNSAFE');
const parent=realpathSync(requestedParent),parentStat=lstatSync(parent);
if(!parentStat.isDirectory() || parentStat.isSymbolicLink() || (process.getuid?.()!==undefined && parentStat.uid!==process.getuid()) ||
  (parentStat.mode&0o077)!==0) throw new Error('M3_STATE_PARENT_UNSAFE');

const root=mkdtempSync(join(parent,'eoduksini-m3-result-')),repo=join(root,'repo'),stateRoot=join(root,'state');
const promptPath=join(repo,'task-prompt.md'),artifactPath=join(root,'artifact.md');
mkdirSync(repo);copyFileSync(promptInput,promptPath);
const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
git(['init','-b','main']);git(['config','user.name','Eoduksini M3 Result']);
git(['config','user.email','m3-result@example.invalid']);git(['add','.']);git(['commit','-m','M3 real-result input baseline']);
const head=git(['rev-parse','HEAD']);
const worker=fileURLToPath(new URL('../packages/runtime-adapters/providers/ollama-artifact-worker.mjs',import.meta.url));
const scope={write_paths:['task-prompt.md'],symbols:[],api_routes:[],request_contracts:[],response_contracts:[],database_objects:[],
  migration_objects:[],rls_policies:[],environment_keys:[],generated_types:[],runtime_services:[]};
const project={schema_version:1,project_id:'m3-real-result',task_prefix:'M3-',
  repository:{url:'https://example.invalid/eoduksini-m3-real-result.git',reference_sha:head},
  commands:{produce_artifact:{argv:['node',worker,'--endpoint',endpoint,'--model',model,'--invocation-id','M3-INVOCATION-1',
    '--node-id',nodeId,'--prompt-file',promptPath,'--artifact-file',artifactPath],cwd:'.'}},watch_paths:['task-prompt.md'],schema_paths:[],
  schema_owner_role:'database-schema-owner',required_gates:{LOW:['worker','reviewer'],MEDIUM:['worker','reviewer'],
    HIGH:['worker','reviewer'],CRITICAL:['worker','reviewer']},harness_paths:[]};
const task={task_id:'M3-REAL-RESULT-001',milestone:'metering-m3',base_sha:head,owner_role:'worker',worktree_id:'m3-isolated',
  goal:'Produce one useful project-generalization audit as an exact, metered local-model result.',in_scope_paths:['task-prompt.md'],
  out_of_scope_paths:[],acceptance_criteria:['Artifact answers every requested audit question and cites only supplied evidence'],
  required_tests:['produce_artifact'],data_risk:'LOW',schema_change:false,dependencies:[],failure_tests:[],shared_file_leases:[],release_impact:'NONE'};
const now=Date.now(),policy={schema_version:1,commands:{produce_artifact:{executable:process.execPath,prefix_argv:[],scope}},
  quota:{contractId:'CT-M3-RESULT',nodeId,baseCpuThreads:1,maxCpuThreads:2,baseMemoryGiB:2,maxMemoryGiB:4,
    maxConcurrentTasks:1,burstExpiresAt:now+3600000,updatedAt:now},resources:{cpu_threads:1,memory_gib:2,allow_burst:false},
  limits:{timeout_ms:60000,max_output_bytes:65536,max_commands:1,approval_ttl_ms:180000},governor_locks:[],
  routing:{reason_code:'VERIFIED_LOCAL_CAPABILITY',chosen_provider_kind:'LOCAL_MODEL_PROVIDER',decision_source:'M3_ACCEPTANCE_POLICY'},
  post_run_authority:{reviewer_ids:['independent-reviewer'],adoption_actor_ids:['repository-owner'],price_basis_ids:[],
    energy_source_ids:[],tariff_basis_ids:[]}};
const harness={schema_version:2,harness_id:'m3-result-harness',revision:1,parent_revision:null,project_id:project.project_id,
  activation_profile:'FOUNDATION_NOW',source_git_sha:head,task_graph_revision:1,
  architecture_digest:digest({architecture:'isolated-local-model-artifact'}),constraint_digest:digest({scope}),policy_digest:digest(policy),
  evidence_policy_digest:digest({artifact:'sha256',journal:'append-only'}),resource_policy_digest:digest(policy.resources),
  database_policy_digest:digest({database:'none'}),database_schema_head:'none',migration_head:'none',
  dependency_lock_digest:digest({dependencies:[]}),created_at:new Date(now).toISOString(),created_by:'local-controller-operator'};

const api=createController({runCommand:runOllamaCommandMetered});
api.init(stateRoot,repo,project,policy,harness);
const request=api.prepare(stateRoot,{attempt_id:'M3-ATTEMPT-1',task}),expected_digest=requestDigest(request);
const approval=await api.approve(stateRoot,{request,expected_digest,approval_id:'M3-APPROVAL-1',ttl_ms:180000});
if(approval.status!=='APPROVED') throw new Error('M3_APPROVAL_FAILED: '+approval.reason);
const result=await api.run(stateRoot,{request,expected_digest});
const record=api.status(stateRoot).state.attempts['M3-ATTEMPT-1'].metering;
if(result.status!=='SUCCEEDED' || record.result_digest===null || record.model_usage_status!=='OBSERVED' ||
  record.invocations.length!==1 || record.invocations[0].response_complete!==true) throw new Error('M3_RESULT_INCOMPLETE');
const artifact=readFileSync(artifactPath),artifactDigest=createHash('sha256').update(artifact).digest('hex');
const transcript=JSON.parse(readFileSync(result.command_results[0].transcript_path,'utf8'));
if(transcript.response_digest!==artifactDigest) throw new Error('M3_ARTIFACT_DIGEST_MISMATCH');
writeFileSync(join(root,'run-summary.json'),JSON.stringify({schema_version:1,status:'M3_RESULT_READY_FOR_REVIEW',state_root:stateRoot,
  evidence_root:join(stateRoot,'evidence'),artifact_path:artifactPath,artifact_digest:artifactDigest,result_digest:record.result_digest,
  task_id:task.task_id,attempt_id:'M3-ATTEMPT-1',record},null,2)+'\n',{encoding:'utf8',flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify({status:'M3_RESULT_READY_FOR_REVIEW',root,state_root:stateRoot,artifact_path:artifactPath,
  artifact_digest:artifactDigest,result_digest:record.result_digest,input_tokens:record.model_input_tokens,
  output_tokens:record.model_output_tokens},null,2)+'\n');
