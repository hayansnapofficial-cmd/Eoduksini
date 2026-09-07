import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if(process.argv.length!==3) throw new Error('Usage: node scripts/controller-smoke.mjs <packaged-core-cli-path>');
// Resolve the caller's relative bundle path BEFORE executing from the owned temp cwd.
const cliPath=resolve(process.argv[2]);
const {requestDigest}=await import(new URL('./controller/contracts.mjs',pathToFileURL(cliPath)));
const root=mkdtempSync(join(tmpdir(),'eoduksini-packaged-smoke-')),repo=join(root,'repo'),state=join(root,'state');
const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const jsonFile=(name,value)=>{const path=join(root,name+'.json');writeFileSync(path,JSON.stringify(value));return path;};
const cli=(...args)=>{
  const child=spawnSync(process.execPath,[cliPath,'controller',...args],{cwd:root,encoding:'utf8',windowsHide:true,timeout:30000});
  assert.ifError(child.error);assert.equal(child.status,0,child.stdout+child.stderr);
  return JSON.parse(child.stdout);
};
try {
  mkdirSync(repo);mkdirSync(join(repo,'scripts'));
  writeFileSync(join(repo,'.gitignore'),'fixture-output/\n');
  writeFileSync(join(repo,'scripts/fixture-test.mjs'),[
    "import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "mkdirSync('fixture-output',{recursive:true});",
    "const count=existsSync('fixture-output/starts')?Number(readFileSync('fixture-output/starts','utf8')):0;",
    "writeFileSync('fixture-output/starts',String(count+1));",
    "console.log('packaged fixture passed');",''
  ].join('\n'));
  git(['init','-b','main']);git(['config','user.name','Packaged Controller Fixture']);
  git(['config','user.email','packaged-fixture@example.invalid']);git(['add','.']);git(['commit','-m','fixture baseline']);
  const head=git(['rev-parse','HEAD']);
  const project={schema_version:1,project_id:'packaged-fixture',task_prefix:'DEMO-',
    repository:{url:'https://example.invalid/packaged-fixture.git',reference_sha:head},
    commands:{unit:{argv:['node','scripts/fixture-test.mjs'],cwd:'.'}},watch_paths:['scripts/fixture-test.mjs'],
    schema_paths:[],schema_owner_role:'database-schema-owner',harness_paths:[],
    required_gates:{LOW:['worker','reviewer'],MEDIUM:['worker','reviewer'],HIGH:['worker','reviewer'],CRITICAL:['worker','reviewer']}};
  const task={task_id:'DEMO-PACKAGED-001',milestone:'fixture',base_sha:head,owner_role:'worker',worktree_id:'wt-packaged',
    goal:'Run an independent packaged Controller fixture.',in_scope_paths:['scripts/**'],out_of_scope_paths:[],
    acceptance_criteria:['Fixture succeeds once'],required_tests:['unit'],data_risk:'LOW',schema_change:false,
    dependencies:[],failure_tests:[],shared_file_leases:[],release_impact:'NONE'};
  const scope={write_paths:['scripts/**'],symbols:[],api_routes:[],request_contracts:[],response_contracts:[],
    database_objects:[],migration_objects:[],rls_policies:[],environment_keys:[],generated_types:[],runtime_services:[]};
  const policy={schema_version:1,commands:{unit:{executable:process.execPath,prefix_argv:[],scope}},
    quota:{contractId:'CT-PACKAGED',nodeId:'fixture-node',baseCpuThreads:2,maxCpuThreads:2,baseMemoryGiB:1,maxMemoryGiB:1,
      maxConcurrentTasks:1,burstExpiresAt:2000,updatedAt:100},
    resources:{cpu_threads:1,memory_gib:0.01,allow_burst:false},
    limits:{timeout_ms:5000,max_output_bytes:65536,max_commands:1,approval_ttl_ms:60000},governor_locks:[]};
  assert.equal(cli('init',state,repo,jsonFile('project',project),jsonFile('policy',policy)).status,'INITIALIZED');
  const request=cli('prepare',state,jsonFile('task',task),'packaged-attempt');
  const marker=join(repo,'fixture-output/starts'),requestFile=jsonFile('request',request),hash=requestDigest(request);
  assert.equal(existsSync(marker),false);
  assert.equal(cli('approve',state,requestFile,hash,'packaged-approval','60000').status,'APPROVED');
  assert.equal(existsSync(marker),false);
  const result=cli('run',state,requestFile,hash);
  assert.equal(result.status,'SUCCEEDED');assert.equal(result.execution_started,true);
  assert.equal(result.command_results.length,1);assert.equal(result.command_results[0].close_observed,true);
  assert.equal(readFileSync(marker,'utf8'),'1');
  const replay=cli('run',state,requestFile,hash);
  assert.equal(replay.status,'SUCCEEDED');assert.equal(replay.execution_started,false);
  assert.deepEqual(replay.command_results,result.command_results);assert.equal(readFileSync(marker,'utf8'),'1');
  const journal=readFileSync(join(state,'events.jsonl'),'utf8'),status=cli('status',state);
  assert.equal(status.status,'READY');assert.equal(status.state.reservation,null);
  assert.equal(status.state.attempts['packaged-attempt'].status,'SUCCEEDED');
  assert.equal(readFileSync(join(state,'events.jsonl'),'utf8'),journal);
  const manifestPath=resolve(dirname(cliPath),'../artifact-manifest.json');
  const artifact=JSON.parse(readFileSync(manifestPath,'utf8'));
  console.log(JSON.stringify({status:'PACKAGED_CONTROLLER_SMOKE_PASSED',platform:process.platform,
    cli:cliPath,artifact_digest:artifact.artifact_digest,launch_count:1,replay_execution_started:false},null,2));
} finally {rmSync(root,{recursive:true,force:true});} // Only the directory allocated above.
