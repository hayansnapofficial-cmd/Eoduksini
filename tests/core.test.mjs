import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate, projectContract, bindTask, digest, safePath, matches } from '../core/contracts.mjs';
import { git, repository, baseline, drift, planTask, checkWrite } from '../core/project.mjs';
import { install } from '../core/install.mjs';
const read=p=>JSON.parse(readFileSync(new URL(p,import.meta.url),'utf8'));
const demo=read('../adapters/demo/project.json');
function fixture() {
  const root=mkdtempSync(join(tmpdir(),'eoduksini-core-'));
  git(root,['init','-b','main']); git(root,['config','user.name','Fixture']); git(root,['config','user.email','fixture@example.invalid']);
  writeFileSync(join(root,'README.md'),'initial\n'); git(root,['add','.']); git(root,['commit','-m','fixture']);
  return root;
}
function task(project,head='a'.repeat(40)) { return {task_id:project.task_prefix+'TEST-001',milestone:'first',
  base_sha:head,owner_role:'worker',worktree_id:'wt-test',goal:'Preserve existing observable behavior.',
  in_scope_paths:['src/**'],out_of_scope_paths:['src/private/**'],acceptance_criteria:['Tests pass'],
  required_tests:[Object.keys(project.commands)[0]],data_risk:'HIGH',schema_change:false}; }
test('an adapter uses the project-neutral core contracts and planning code',()=>{
    const root=fixture(),t=task(demo,git(root,['rev-parse','HEAD']));
    const plan=planTask(root,demo,t);
    assert.equal(plan.status,'PLANNED'); assert.equal(plan.execution_authorized,false);
    assert.deepEqual(plan.required_gates,demo.required_gates.HIGH);
    assert.equal(plan.adapter_digest,digest(demo));
    const b=bindTask(t,demo);
    assert.deepEqual(checkWrite(b,demo,'src/feature.js'),{allowed:true});
    assert.throws(()=>checkWrite(b,demo,'src/private/key.js'),/OUT_OF_SCOPE/);
});
test('v1 task schema keeps fields and risk rules while accepting project-neutral IDs',()=>{
  const original=task(demo);
  assert.doesNotThrow(()=>validate('task',original));
  assert.doesNotThrow(()=>validate('task',{...original,task_id:'OTHER-SLICE-001'}));
  assert.throws(()=>validate('task',{...original,extra:true}),/INVALID_TASK/);
  assert.throws(()=>validate('task',{...original,base_sha:'main'}),/INVALID_TASK/);
});
test('project mismatch, undeclared commands, unknown fields and missing reviewer fail closed',()=>{
  const other={...demo,project_id:'other',task_prefix:'OTHER-'};
  assert.throws(()=>bindTask(task(demo),other),/TASK_PROJECT_MISMATCH/);
  assert.throws(()=>bindTask({...task(demo),required_tests:['curl untrusted.invalid']},demo),/UNDECLARED/);
  assert.throws(()=>projectContract({...demo,credentials:'forbidden'}),/INVALID_PROJECT/);
  assert.throws(()=>projectContract({...demo,required_gates:{...demo.required_gates,LOW:['worker','auditor']}}),/REVIEW_REQUIRED/);
});
test('schema writes require owner and a separate lease gate',()=>{
  const project={...demo,schema_paths:['schema/**']};
  const t={...task(project),in_scope_paths:['schema/**']};
  assert.throws(()=>checkWrite(bindTask(t,project),project,'schema/001.sql'),/SCHEMA_OWNER_REQUIRED/);
  const owner={...t,schema_change:true,owner_role:project.schema_owner_role};
  assert.deepEqual(checkWrite(bindTask(owner,project),project,'schema/001.sql'),{allowed:false,reason:'SCHEMA_LEASE_REQUIRED'});
});
test('unsafe paths cannot become task scopes or adapter commands',()=>{
  for(const p of ['../outside','/tmp','C:/escape','src/../../bad','src\\bad','.git/config','src//file','src/CON:bad','src/../x','.eoduksini/project.json'])
    assert.throws(()=>safePath(p));
  assert.throws(()=>projectContract({...demo,commands:{test:{argv:['node'],cwd:'../escape'}}}),/UNSAFE_PATH/);
  assert.equal(matches('lib/file.test.js','lib/*.test.js'),true);
  assert.equal(matches('lib/fileXtestXjs','lib/*.test.js'),false);
});
test('drift detects uncommitted watched-file changes and adapter changes',()=>{
  const root=fixture(),p={...demo,watch_paths:['README.md']},before=baseline(root,p);
  assert.equal(drift(before,baseline(root,p)).status,'UNCHANGED');
  writeFileSync(join(root,'README.md'),'changed\n');
  assert.deepEqual(drift(before,baseline(root,p)).changes,['README.md']);
  assert.throws(()=>planTask(root,p,task(p)),/REPOSITORY_DRIFT/);
  assert.throws(()=>checkWrite(bindTask(task(p),p),{...p,watch_paths:[]},'src/a.js'),/ADAPTER_DRIFT/);
});
test('installer is idempotent and preserves existing user instructions',()=>{
  const root=fixture();
  writeFileSync(join(root,'AGENTS.md'),'user instructions');
  assert.equal(install(root,demo).status,'INSTALLED');
  assert.equal(install(root,demo).status,'UNCHANGED');
  assert.equal(readFileSync(join(root,'AGENTS.md'),'utf8'),'user instructions');
  assert.throws(()=>install(root,{...demo,project_id:'other',task_prefix:'OTHER-'}),/ALREADY_REGISTERED/);
  assert.deepEqual(JSON.parse(readFileSync(join(root,'.eoduksini/project.json'),'utf8')),demo);
});
test('installer rejects directory symlinks and leaves their targets untouched',()=>{
  const root=fixture(),outside=mkdtempSync(join(tmpdir(),'eoduksini-outside-'));
  symlinkSync(outside,join(root,'.eoduksini'),process.platform==='win32'?'junction':'dir');
  assert.throws(()=>install(root,demo),/SYMLINK_REJECTED/);
});
test('canonical digest does not depend on object insertion order',()=>{
  assert.equal(digest({b:2,a:{z:1,y:0}}),digest({a:{y:0,z:1},b:2}));
  assert.throws(()=>digest({value:undefined}),/NON_JSON/);
});
test('planning rejects dirty code even when HEAD still matches',()=>{
  const root=fixture(),t=task(demo,git(root,['rev-parse','HEAD']));
  writeFileSync(join(root,'unreviewed.js'),'changed');
  assert.throws(()=>planTask(root,demo,t),/DIRTY_WORKTREE/);
});
test('repository root comparison accepts Windows case variants and rejects a subdirectory',()=>{
  const root=fixture();
  assert.doesNotThrow(()=>repository(process.platform==='win32'?root.toLowerCase():root));
  const nested=join(root,'nested');
  mkdirSync(nested);
  assert.throws(()=>repository(nested),/REPOSITORY_ROOT_REQUIRED/);
});
test('CLI rejects unknown commands without executing adapter commands',()=>{
  const script=new URL('../core/cli.mjs',import.meta.url);
  const result=spawnSync(process.execPath,[fileURLToPath(script),'execute'],{encoding:'utf8'});
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/Usage: eoduksini/);
});
