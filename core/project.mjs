import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { bindTask, bindTaskV2, digest, projectContract, safePath, matches } from './contracts.mjs';
export function git(root,args) {
  return execFileSync('git',args,{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
}
export function repository(root) {
  const absolute = realpathSync.native(root);
  const top = realpathSync.native(git(absolute,['rev-parse','--show-toplevel']));
  if (relative(absolute,top) !== '') throw new Error('REPOSITORY_ROOT_REQUIRED: '+absolute+' != '+top);
  return absolute;
}
export function contained(root,path,{allowMissing=false}={}) {
  root=realpathSync(root);
  const target=resolve(root,path), rel=relative(root,target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('PATH_ESCAPE');
  let current=root;
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    current=join(current,part);
    if (!existsSync(current)) {
      try { if(lstatSync(current).isSymbolicLink()) throw new Error('SYMLINK_REJECTED'); }
      catch(error) { if(error.code !== 'ENOENT') throw error; }
      if(allowMissing) continue;
      throw new Error('PATH_MISSING: '+path);
    }
    if (lstatSync(current).isSymbolicLink()) throw new Error('SYMLINK_REJECTED');
  }
  return target;
}
export function loadProject(path) { return projectContract(JSON.parse(readFileSync(path,'utf8'))); }
export function baseline(root,project) {
  root=repository(root); project=projectContract(project);
  const hashes={};
  for(const path of project.watch_paths) {
    safePath(path); const full=contained(root,path,{allowMissing:true});
    hashes[path]=existsSync(full) ? createHash('sha256').update(readFileSync(full)).digest('hex') : null;
  }
  return {schema_version:1,project_id:project.project_id,adapter_digest:digest(project),head:git(root,['rev-parse','HEAD']),hashes};
}
export function drift(previous,current) {
  const changes=[];
  for(const key of ['project_id','adapter_digest','head']) if(previous[key]!==current[key]) changes.push(key);
  for(const path of new Set([...Object.keys(previous.hashes),...Object.keys(current.hashes)]))
    if(previous.hashes[path]!==current.hashes[path]) changes.push(path);
  return {status:changes.length?'REPOSITORY_DRIFT':'UNCHANGED',changes};
}
export function planTask(root,project,task,{harness_revision=null}={}) {
  const bound=task?.schema_version===2?bindTaskV2(task,project,harness_revision):bindTask(task,project);
  const snapshot=baseline(root,project);
  if(task.base_sha!==snapshot.head) throw new Error('REPOSITORY_DRIFT');
  if(git(root,['status','--porcelain','--untracked-files=all'])) throw new Error('DIRTY_WORKTREE');
  return {...bound,baseline:snapshot,required_gates:project.required_gates[task.data_risk],
    schema_lease_required:task.schema_change,
    commands:task.required_tests.map(name=>({name,...project.commands[name]})),
    status:'PLANNED',execution_authorized:false};
}
export function checkWrite(bound,project,file) {
  project=projectContract(project);
  if(bound.adapter_digest!==digest(project) || bound.project_id!==project.project_id) throw new Error('ADAPTER_DRIFT');
  bindTask(bound.task,project);
  safePath(file);
  if(bound.task.out_of_scope_paths.some(p=>matches(file,p)) || !bound.task.in_scope_paths.some(p=>matches(file,p))) throw new Error('OUT_OF_SCOPE');
  if(project.schema_paths.some(p=>matches(file,p))) {
    if(!bound.task.schema_change || bound.task.owner_role!==project.schema_owner_role) throw new Error('SCHEMA_OWNER_REQUIRED');
    return {allowed:false,reason:'SCHEMA_LEASE_REQUIRED'};
  }
  return {allowed:true};
}
