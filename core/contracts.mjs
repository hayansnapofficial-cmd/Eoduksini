import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
const ajv = new Ajv2020({allErrors:true, strict:true});
addFormats(ajv);
const validators = new Map();
export function validate(kind, value) {
  if (!['project','task','task-v2','harness-revision','semantic-footprint','metering-record','work-result','handoff','review-result','release-packet'].includes(kind)) throw new Error('UNKNOWN_CONTRACT');
  if (!validators.has(kind)) validators.set(kind, ajv.compile(JSON.parse(readFileSync(new URL('./schemas/'+kind+'.schema.json', import.meta.url),'utf8'))));
  const check = validators.get(kind);
  if (!check(value)) throw new Error('INVALID_'+kind.toUpperCase().replaceAll('-','_')+': '+ajv.errorsText(check.errors));
  return value;
}
export function canonical(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  throw new Error('NON_JSON_VALUE');
}
export const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
export function safePath(value, {glob=false, dot=false}={}) {
  if (dot && value === '.') return value;
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /[:\x00-\x1f]/.test(value)) throw new Error('UNSAFE_PATH');
  if (value.split('/').some(p=>!p || p==='.' || p==='..' || ['.git','.eoduksini'].includes(p.toLowerCase()) || /[. ]$/.test(p))) throw new Error('UNSAFE_PATH');
  if ((!glob && /[*?\[\]{}]/.test(value)) || /[?\[\]{}]/.test(value)) throw new Error('UNSUPPORTED_PATH_PATTERN');
  return value;
}
export function matches(file, pattern) {
  safePath(file); safePath(pattern,{glob:true});
  if (process.platform === 'win32') { file=file.toLowerCase(); pattern=pattern.toLowerCase(); }
  const escaped = pattern.split('**').map(part=>part.split('*').map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[^/]*')).join('.*');
  return new RegExp('^'+escaped+'$').test(file) || (!pattern.includes('*') && file.startsWith(pattern+'/'));
}
export function projectContract(value) {
  validate('project',value);
  for (const p of value.watch_paths) safePath(p);
  for (const p of value.schema_paths) safePath(p,{glob:true});
  for (const p of value.harness_paths) safePath(p);
  for (const c of Object.values(value.commands)) {
    safePath(c.cwd,{dot:true});
    if (c.argv.some(s=>s.includes('\0'))) throw new Error('INVALID_COMMAND');
  }
  for (const gates of Object.values(value.required_gates)) {
    if (!gates.includes('worker') || !gates.includes('reviewer')) throw new Error('INDEPENDENT_REVIEW_REQUIRED');
  }
  return structuredClone(value);
}
export function bindTask(task, project) {
  project = projectContract(project);
  validate('task',task);
  if (!task.task_id.startsWith(project.task_prefix)) throw new Error('TASK_PROJECT_MISMATCH');
  if (task.dependencies?.some(id=>!id.startsWith(project.task_prefix))) throw new Error('DEPENDENCY_PROJECT_MISMATCH');
  for (const p of [...task.in_scope_paths,...task.out_of_scope_paths]) safePath(p,{glob:true});
  for (const command of task.required_tests) if (!Object.hasOwn(project.commands, command)) throw new Error('UNDECLARED_TEST_COMMAND: '+command);
  if (task.schema_change && task.owner_role !== project.schema_owner_role) throw new Error('SCHEMA_OWNER_REQUIRED');
  return {schema_version:1,project_id:project.project_id,adapter_digest:digest(project),task:structuredClone(task)};
}

export const LOCAL_TASK_AUTHORITY=Object.freeze({
  controller_approval_required:true,
  local_process_execution:true,
  model_execution:false,
  remote_worker_execution:false,
  git_publish:false,
  database_mutation:false,
  deployment:false,
  production_mutation:false
});

export function harnessRevisionContract(value) {
  validate('harness-revision',value);
  if(value.parent_revision!==null && value.parent_revision>=value.revision) throw new Error('INVALID_HARNESS_REVISION: parent must precede revision');
  return structuredClone(value);
}

function v1Fields(task) {
  const fields=['task_id','milestone','base_sha','owner_role','worktree_id','goal','in_scope_paths','out_of_scope_paths',
    'dependencies','acceptance_criteria','required_tests','failure_tests','security_considerations','data_risk','schema_change',
    'shared_file_leases','release_impact'];
  return Object.fromEntries(fields.filter(key=>Object.hasOwn(task,key)).map(key=>[key,structuredClone(task[key])]));
}

export function overlayTaskV1(task,project,revision) {
  const bound=bindTask(task,project),harness=harnessRevisionContract(revision);
  if(harness.project_id!==bound.project_id) throw new Error('HARNESS_PROJECT_MISMATCH');
  if(task.base_sha!==harness.source_git_sha) throw new Error('STALE_TASK_BASE');
  const overlaid={schema_version:2,...v1Fields(task),project_id:bound.project_id,harness_revision:harness.revision,
    harness_revision_digest:digest(harness),task_graph_revision:harness.task_graph_revision,
    database_schema_head:harness.database_schema_head,migration_head:harness.migration_head,
    policy_digest:harness.policy_digest,dependency_lock_digest:harness.dependency_lock_digest,
    authority:structuredClone(LOCAL_TASK_AUTHORITY)};
  validate('task-v2',overlaid);
  return overlaid;
}

export function bindTaskV2(task,project,revision) {
  project=projectContract(project); const harness=harnessRevisionContract(revision);
  validate('task-v2',task);
  const v1=v1Fields(task),bound=bindTask(v1,project),expected=overlayTaskV1(v1,project,harness);
  if(canonical(task)!==canonical(expected)) throw new Error('TASK_V2_BINDING_MISMATCH');
  return {schema_version:2,project_id:project.project_id,adapter_digest:bound.adapter_digest,
    harness_revision_digest:digest(harness),task:structuredClone(task)};
}
