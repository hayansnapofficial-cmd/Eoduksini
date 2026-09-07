import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../../core/contracts.mjs';

const git=(root,args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const fixtureScope=write_paths=>({write_paths,symbols:[],api_routes:[],request_contracts:[],response_contracts:[],
  database_objects:[],migration_objects:[],rls_policies:[],environment_keys:[],generated_types:[],runtime_services:[]});

export function makeFixture({projectId='demo',startCounter=false}={}) {
  const root=mkdtempSync(join(tmpdir(),'eoduksini-controller-'));
  const repo=join(root,'repo'),stateRoot=join(root,'state');
  mkdirSync(repo); mkdirSync(join(repo,'scripts')); mkdirSync(join(repo,'other'));
  writeFileSync(join(repo,'.gitignore'),'fixture-output/\n');
  writeFileSync(join(repo,'scripts','fixture-test.mjs'),startCounter?[
    "import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';",
    "mkdirSync('fixture-output',{recursive:true});",
    "const count=existsSync('fixture-output/starts')?Number(readFileSync('fixture-output/starts','utf8')):0;",
    "writeFileSync('fixture-output/starts',String(count+1));",
    "console.log('fixture pass');",
    "if(process.argv[2]?.includes('fail')) process.exitCode=7;", ''
  ].join('\n'):"console.log('fixture pass');\n");
  writeFileSync(join(repo,'other','fixture.txt'),'independent semantic scope\n');
  git(repo,['init','-b','main']);
  git(repo,['config','user.name','Controller Fixture']);
  git(repo,['config','user.email','controller-fixture@example.invalid']);
  git(repo,['add','.']); git(repo,['commit','-m','fixture baseline']);
  const head=git(repo,['rev-parse','HEAD']);
  const project={schema_version:1,project_id:projectId,task_prefix:'DEMO-',
    repository:{url:'https://example.invalid/controller-fixture.git',reference_sha:head},
    commands:{unit:{argv:['node','scripts/fixture-test.mjs'],cwd:'.'}},
    watch_paths:['scripts/fixture-test.mjs'],schema_paths:[],schema_owner_role:'database-schema-owner',
    required_gates:{LOW:['worker','reviewer'],MEDIUM:['worker','reviewer'],HIGH:['worker','reviewer'],CRITICAL:['worker','reviewer']},
    harness_paths:[]};
  const task={task_id:'DEMO-LOCAL-001',milestone:'controller',base_sha:head,owner_role:'worker',worktree_id:'wt-local',
    goal:'Run the controlled fixture test.',in_scope_paths:['scripts/**'],out_of_scope_paths:[],
    acceptance_criteria:['Fixture test passes'],required_tests:['unit'],data_risk:'LOW',schema_change:false,
    dependencies:[],failure_tests:[],shared_file_leases:[],release_impact:'NONE'};
  const policy={schema_version:1,commands:{unit:{executable:process.execPath,prefix_argv:[],scope:fixtureScope(['scripts/**'])}},
    quota:{contractId:'CT-DEMO',nodeId:'fixture-node',baseCpuThreads:2,maxCpuThreads:4,baseMemoryGiB:4,maxMemoryGiB:8,
      maxConcurrentTasks:1,burstExpiresAt:2000,updatedAt:100},
    resources:{cpu_threads:1,memory_gib:2,allow_burst:false},
    limits:{timeout_ms:5000,max_output_bytes:65536,max_commands:1,approval_ttl_ms:60000},governor_locks:[]};
  return {root,repo,stateRoot,project,task,policy,head,cleanup:()=>rmSync(root,{recursive:true,force:true})};
}

export function requestFixture(fixture) {
  const repo=realpathSync.native(fixture.repo);
  return {schema_version:1,attempt_id:'ATTEMPT-1',repo_root:repo,project_id:fixture.project.project_id,
    project:structuredClone(fixture.project),task:structuredClone(fixture.task),
    baseline:{schema_version:1,project_id:fixture.project.project_id,adapter_digest:digest(fixture.project),head:fixture.head,
      hashes:{'scripts/fixture-test.mjs':'a'.repeat(64)}},
    policy_digest:digest(fixture.policy),control_epoch:1,
    commands:[{key:'unit',declared_argv:['node','scripts/fixture-test.mjs'],executable:process.execPath,
      executable_digest:'b'.repeat(64),argv:['scripts/fixture-test.mjs'],cwd:repo}],
    scope:fixtureScope(['scripts/**']),resources:{cpu_threads:1,memory_gib:2,allow_burst:false},
    semantic_footprint:{read_paths:['scripts/fixture-test.mjs'],write_paths:['scripts/**'],symbols:[],api_routes:[],
      request_contracts:[],response_contracts:[],database_objects:[],migration_objects:[],environment_keys:[],
      generated_types:[],runtime_services:[],dependencies:[],uncertainty:[]},
    limits:{timeout_ms:5000,max_output_bytes:65536,max_commands:1,approval_ttl_ms:60000},
    environment:{PATH:'fixture-path',LANG:'C.UTF-8'}};
}
