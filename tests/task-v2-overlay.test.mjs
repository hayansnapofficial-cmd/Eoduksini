import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bindTaskV2, digest, harnessRevisionContract, LOCAL_TASK_AUTHORITY, overlayTaskV1, validate } from '../core/contracts.mjs';
import { createController } from '../core/controller/controller.mjs';
import { requestDigest } from '../core/controller/contracts.mjs';
import { initializeStore, readStore } from '../core/controller/store.mjs';
import { makeFixture } from './helpers/controller-fixture.mjs';

function revision(f,patch={}) {
  return {schema_version:2,harness_id:'demo-harness',revision:2,parent_revision:1,project_id:f.project.project_id,
    activation_profile:'FOUNDATION_NOW',source_git_sha:f.head,task_graph_revision:7,
    architecture_digest:'a'.repeat(64),constraint_digest:'b'.repeat(64),policy_digest:digest(f.policy),
    evidence_policy_digest:'c'.repeat(64),resource_policy_digest:'d'.repeat(64),database_policy_digest:'e'.repeat(64),
    database_schema_head:'schema-2026-09-06',migration_head:'migration-0042',dependency_lock_digest:'f'.repeat(64),
    created_at:'2026-09-06T00:00:00Z',created_by:'controller-admin',...patch};
}

function fixture(t) { const f=makeFixture(); t.after(f.cleanup); return f; }

test('Harness Revision is strict, immutable input with ordered ancestry',t=>{
  const f=fixture(t),value=revision(f);
  assert.deepEqual(harnessRevisionContract(value),value);
  assert.throws(()=>harnessRevisionContract({...value,unknown:true}),/INVALID_HARNESS_REVISION/);
  assert.throws(()=>harnessRevisionContract({...value,parent_revision:2}),/parent must precede/);
});

test('V1 promotes one way to an exactly revision-bound Task V2',async t=>{
  const f=fixture(t),harness=revision(f),task=overlayTaskV1(f.task,f.project,harness);
  assert.equal(task.schema_version,2);
  assert.equal(task.harness_revision_digest,digest(harness));
  assert.equal(task.task_graph_revision,harness.task_graph_revision);
  assert.equal(task.policy_digest,harness.policy_digest);
  assert.deepEqual(task.authority,LOCAL_TASK_AUTHORITY);
  assert.deepEqual(bindTaskV2(task,f.project,harness).task,task);
  assert.throws(()=>validate('task-v2',{...task,unknown:true}),/INVALID_TASK_V2/);
  assert.throws(()=>bindTaskV2({...task,harness_revision:3},f.project,harness),/TASK_V2_BINDING_MISMATCH/);
  assert.throws(()=>bindTaskV2({...task,authority:{...task.authority,git_publish:true}},f.project,harness),/INVALID_TASK_V2/);
  assert.throws(()=>overlayTaskV1({...f.task,base_sha:'0'.repeat(40)},f.project,harness),/STALE_TASK_BASE/);
  assert.equal(Object.hasOwn(await import('../core/contracts.mjs'),'downgradeTaskV2'),false);
});

test('Controller persists the revision, overlays V1, and rechecks native V2 through execution',async t=>{
  const f=fixture(t),harness=revision(f),api=createController();
  api.init(f.stateRoot,f.repo,f.project,f.policy,harness);
  assert.deepEqual(readStore(f.stateRoot).state.harness_revision,harness);
  const request=api.prepare(f.stateRoot,{attempt_id:'v2-attempt',task:f.task});
  assert.equal(request.schema_version,2);
  assert.deepEqual(request.harness_revision,harness);
  assert.deepEqual(request.task,overlayTaskV1(f.task,f.project,harness));
  assert.deepEqual(api.prepare(f.stateRoot,{attempt_id:'native-v2',task:request.task}).task,request.task);
  const expected_digest=requestDigest(request);
  assert.equal((await api.approve(f.stateRoot,{request,expected_digest,approval_id:'v2-approval',ttl_ms:60000})).status,'APPROVED');
  assert.equal((await api.run(f.stateRoot,{request,expected_digest})).status,'SUCCEEDED');
});

test('Controller fails closed on missing or mismatched Harness Revision authority',t=>{
  const legacy=fixture(t),legacyApi=createController();
  legacyApi.init(legacy.stateRoot,legacy.repo,legacy.project,legacy.policy);
  const native=overlayTaskV1(legacy.task,legacy.project,revision(legacy));
  assert.throws(()=>legacyApi.prepare(legacy.stateRoot,{attempt_id:'no-revision',task:native}),/HARNESS_REVISION_REQUIRED/);

  for(const patch of [
    {source_git_sha:'0'.repeat(40)},
    {project_id:'other'},
    {policy_digest:'0'.repeat(64)},
    {activation_profile:'SECOND_PROJECT_GENERALIZATION'}
  ]) {
    const f=fixture(t),api=createController();
    assert.throws(()=>api.init(f.stateRoot,f.repo,f.project,f.policy,revision(f,patch)),/INVALID_HARNESS_BINDING/);
    assert.equal(existsSync(f.stateRoot),false);
  }

  const direct=fixture(t),directState=join(direct.root,'direct-state');
  assert.throws(()=>initializeStore(directState,{repo_root:direct.repo,project:direct.project,policy:direct.policy,
    harness_revision:revision(direct,{source_git_sha:'0'.repeat(40)})}),/INVALID_HARNESS_BINDING/);
  assert.equal(existsSync(directState),false);
});

test('CLI accepts the optional Harness Revision file and emits Task V2',t=>{
  const f=fixture(t),harness=revision(f),files={};
  for(const [name,value] of Object.entries({project:f.project,policy:f.policy,harness,task:f.task})) {
    files[name]=join(f.root,name+'.json'); writeFileSync(files[name],JSON.stringify(value));
  }
  const cli=resolve('core/cli.mjs');
  const run=(...args)=>spawnSync(process.execPath,[cli,'controller',...args],{encoding:'utf8',timeout:30000});
  const initialized=run('init',f.stateRoot,f.repo,files.project,files.policy,files.harness);
  assert.equal(initialized.status,0,initialized.stderr);
  assert.deepEqual(JSON.parse(initialized.stdout).state.harness_revision,harness);
  const prepared=run('prepare',f.stateRoot,files.task,'cli-v2');
  assert.equal(prepared.status,0,prepared.stderr);
  assert.equal(JSON.parse(prepared.stdout).schema_version,2);
});

test('Changed revision content and task authority cannot reuse an approved request digest',async t=>{
  const f=fixture(t),harness=revision(f),api=createController();
  api.init(f.stateRoot,f.repo,f.project,f.policy,harness);
  const request=api.prepare(f.stateRoot,{attempt_id:'bound-attempt',task:f.task}),expected_digest=requestDigest(request);
  const changedRevision={...request,harness_revision:{...harness,architecture_digest:'9'.repeat(64)}};
  await assert.rejects(()=>api.approve(f.stateRoot,{request:changedRevision,expected_digest:digest(changedRevision),approval_id:'changed',ttl_ms:60000}),/TASK_V2_BINDING_MISMATCH|REQUEST_HARNESS_MISMATCH/);
  const missingOverlay={...request,task:f.task};
  await assert.rejects(()=>api.approve(f.stateRoot,{request:missingOverlay,expected_digest:digest(missingOverlay),approval_id:'missing',ttl_ms:60000}),/INVALID_REQUEST/);
  const escalated={...request,task:{...request.task,authority:{...request.task.authority,database_mutation:true}}};
  await assert.rejects(()=>api.approve(f.stateRoot,{request:escalated,expected_digest:digest(escalated),approval_id:'escalated',ttl_ms:60000}),/INVALID_TASK_V2/);
  assert.notEqual(requestDigest(request),requestDigest({...request,attempt_id:'other-attempt'}));
  assert.equal(expected_digest,requestDigest(request));
});
