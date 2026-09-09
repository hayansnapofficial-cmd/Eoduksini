import { createStudioServer } from '../../studio/server.mjs';
import { subscriptionEntitlement } from '../../studio/plans.mjs';

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
const store={providerConnections:()=>connections,models:()=>models,nodes:()=>nodes,orchestrationProfile:()=>profile};
const server=createStudioServer({auth,store,origin:`http://127.0.0.1:${port}`});
server.listen(port,'127.0.0.1',()=>console.log(`Preview: http://127.0.0.1:${port}/settings`));
