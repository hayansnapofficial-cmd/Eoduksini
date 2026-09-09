import { createStudioServer } from '../../studio/server.mjs';
import { subscriptionEntitlement } from '../../studio/plans.mjs';
import { createDispatchTask } from '../../studio/task-dispatch.mjs';

const port=Number(process.argv[2]??4319),organization={organization_id:'org-42',name:'Preview Workspace',role:'owner'};
const auth={configured:true,begin:()=>'',complete:async()=>{},logout:()=>'',isAdminId:()=>false,session:()=>({
  user:{github_id:'42',login:'preview',avatar_url:null},organization,organizations:[organization],
  entitlement:subscriptionEntitlement({status:'active',plan_id:'pro'}),admin:false
})};
const connections=[{connection_id:'pc-a',organization_id:'org-42',provider_id:'openai',display_name:'Customer OpenAI',secret_location:'customer_agent',
  status:'ready',agent_id:null,created_at:'2026-09-09T00:00:00.000Z',updated_at:'2026-09-09T00:00:00.000Z'}];
const models=[
  {model_id:'model-head',organization_id:'org-42',connection_id:'pc-a',provider_model_id:'gpt-head',display_name:'Head AI',role_capabilities:['head'],status:'active',created_at:'2026-09-09T00:00:00.000Z',updated_at:'2026-09-09T00:00:00.000Z'},
  {model_id:'model-code',organization_id:'org-42',connection_id:'pc-a',provider_model_id:'gpt-code',display_name:'Code AI',role_capabilities:['planner','coder'],status:'active',created_at:'2026-09-09T00:00:00.000Z',updated_at:'2026-09-09T00:00:00.000Z'},
  {model_id:'model-review',organization_id:'org-42',connection_id:'pc-a',provider_model_id:'gpt-review',display_name:'Review AI',role_capabilities:['reviewer','validator'],status:'active',created_at:'2026-09-09T00:00:00.000Z',updated_at:'2026-09-09T00:00:00.000Z'}
];
const node=(node_id,display_name,cpu_logical)=>({node_id,organization_id:'org-42',display_name,status:'active',agent_version:'0.1.0',os:'win32',arch:'x64',
  cpu_logical,memory_bytes:34359738368,gpu_status:'unavailable',gpu_devices:[],adapters:['openai'],last_seen_at:new Date().toISOString(),
  created_at:'2026-09-09T00:00:00.000Z',updated_at:'2026-09-09T00:00:00.000Z'});
const nodes=[node('node-a','Primary Node',16),node('node-b','Review Node',8)],profile={organization_id:'org-42',mode:'automatic',head_model_id:'model-head',
  assignments:{planner:null,coder:null,reviewer:null,validator:null},revision:1,created_at:'2026-09-09T00:00:00.000Z',updated_at:'2026-09-09T00:00:00.000Z'};
const previewAssignment={schema_version:1,organization_id:'org-42',task_id:'PREVIEW-RECOVERY',profile_revision:1,status:'READY',decision_digest:'a'.repeat(64),
  head_assignment:{model_id:'model-head',node_id:'node-a',provider_id:'openai'},assignments:{planner:{model_id:'model-code',node_id:'node-a',provider_id:'openai'},
    coder:{model_id:'model-code',node_id:'node-a',provider_id:'openai'},reviewer:{model_id:'model-review',node_id:'node-b',provider_id:'openai'},
    validator:{model_id:'model-review',node_id:'node-b',provider_id:'openai'}},authority:{model_execution:false,remote_worker_execution:false,
    repository_write:false,approval:false,git_publish:false,deployment:false}};
const recovery=createDispatchTask({organization_id:'org-42',task_id:'PREVIEW-RECOVERY',objective:'중단된 실행의 증거와 epoch를 검토합니다.',profile_revision:1,
  roles:['planner','coder','reviewer','validator'],assignment:previewAssignment,dispatch_epoch:3,created_by:'42',now:Date.parse('2026-09-09T01:00:00.000Z')});
recovery.status='RECOVERY_REQUIRED';recovery.dispatches[0].status='RECOVERY_REQUIRED';recovery.dispatches[0].recovery_reason='NODE_HEARTBEAT_UNCERTAIN';
for(const item of recovery.dispatches.slice(1))item.status='BLOCKED';let tasks=[{...recovery,attempts:[],approval_consumed:true}];
const store={providerConnections:()=>connections,models:()=>models,nodes:()=>nodes,orchestrationProfile:()=>profile,dispatchTasks:()=>structuredClone(tasks),
  createDispatchTask:input=>{const assignment={...previewAssignment,task_id:input.task_id},task=createDispatchTask({organization_id:input.organization_id,
    task_id:input.task_id,objective:input.objective,profile_revision:input.profile_revision,roles:input.roles,assignment,dispatch_epoch:1,
    created_by:input.created_by,now:Date.now()});
    const publicTask={...task,attempts:[],approval_consumed:false};tasks.push(publicTask);return {task:structuredClone(publicTask)}},
  approveDispatchTask:input=>{const task=tasks.find(value=>value.task_id===input.task_id);if(!task)throw new Error('DISPATCH_TASK_NOT_FOUND');
    task.status='QUEUED';task.dispatches[0].status='QUEUED';return {task:structuredClone(task),approval:{approval_id:input.approval_id,consumed_at:null}}}};
const server=createStudioServer({auth,store,origin:`http://127.0.0.1:${port}`});
server.listen(port,'127.0.0.1',()=>console.log(`Preview: http://127.0.0.1:${port}/settings`));
