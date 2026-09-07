import { normalizeTaskResourceRequest, normalizeContractNodeResourceQuota, decideResourceAdmission, decideGpuAdmission } from '../packages/engine-primitives/resource-quota.mjs';
import { selectNode } from '../packages/engine-primitives/scheduler.mjs';
import { minimalSubprocessEnvironment } from '../packages/engine-primitives/subprocess-env.mjs';
import { assertRequirementGraphIntegrity } from '../packages/engine-primitives/requirement-graph.mjs';
import { validateAllowedHttpsUrl, selectPublicAddress } from '../packages/engine-primitives/network-policy.mjs';

const record=value=>value!==null && typeof value==='object' && !Array.isArray(value) && Object.getPrototypeOf(value)===Object.prototype;
const integer=value=>Number.isSafeInteger(value) && value>=0;
const identifier=value=>typeof value==='string' && value.length>0 && value.length<=128 && !/[\x00-\x1f]/.test(value);
function exact(value,required,optional=[],reason='INVALID_REUSE_INPUT') {
  if(!record(value) || !required.every(key=>Object.hasOwn(value,key)) || !Object.keys(value).every(key=>[...required,...optional].includes(key))) throw new Error(reason);
}

export function resourcePlan(input) {
  const invalid=()=>{throw new Error('INVALID_RESOURCE_PLAN');};
  exact(input,['request','quota','contractUsage','nodeUsage','nodeCapacity','devices','leasedGpuIds','now'],[],'INVALID_RESOURCE_PLAN');
  if(!integer(input.now) || !Array.isArray(input.devices) || input.devices.length>128 || !Array.isArray(input.leasedGpuIds) ||
    !input.leasedGpuIds.every(identifier) || new Set(input.leasedGpuIds).size!==input.leasedGpuIds.length) invalid();
  for(const device of input.devices) {
    exact(device,['name','totalVramGiB','freeVramGiB'],['id','deviceIndex'],'INVALID_RESOURCE_PLAN');
    if(!identifier(device.name) || (device.id!==undefined && !identifier(device.id)) || (device.deviceIndex!==undefined && !integer(device.deviceIndex))) invalid();
    for(const value of [device.totalVramGiB,device.freeVramGiB]) if(value!==null && (!Number.isFinite(value) || value<0)) invalid();
    if(device.totalVramGiB!==null && device.freeVramGiB!==null && device.freeVramGiB>device.totalVramGiB) invalid();
  }
  for(const usage of [input.contractUsage,input.nodeUsage]) exact(usage,['cpuThreads','memoryGiB','activeTasks'],[],'INVALID_RESOURCE_PLAN');
  exact(input.nodeCapacity,['cpuThreads','memoryGiB','availableMemoryGiB'],[],'INVALID_RESOURCE_PLAN');
  const request=normalizeTaskResourceRequest(input.request);
  // Public planning never enables the inherited internal-only quota bypass.
  const allocation=decideResourceAdmission({request,quota:input.quota,contractUsage:input.contractUsage,nodeUsage:input.nodeUsage,nodeCapacity:input.nodeCapacity,now:input.now,legacyInternal:false});
  if(!allocation.granted) return {status:'BLOCKED',execution_authorized:false,allocation};
  const gpu=decideGpuAdmission({request,devices:input.devices,leasedGpuIds:input.leasedGpuIds});
  return {status:gpu.granted?'PLANNED':'BLOCKED',execution_authorized:false,allocation,gpu};
}

export const normalizeResourceRequest=value=>normalizeTaskResourceRequest(value);
export const normalizeResourceQuota=value=>normalizeContractNodeResourceQuota(value);

export function workerPlan(input) {
  exact(input,['capability','nodes','now']);
  if(!identifier(input.capability) || !integer(input.now) || !Array.isArray(input.nodes) || input.nodes.length>10000) throw new Error('INVALID_WORKER_PLAN');
  const ids=new Set();
  for(const node of input.nodes) {
    exact(node,['id','approvalState','healthState','capabilities','lastHeartbeatAt','resourceReceivedAt','controllerConnected','freeDiskGiB','currentSlots','maxSlots','lastAssignedAt'],['schedulableSlots']);
    if(!identifier(node.id) || ids.has(node.id) || !identifier(node.approvalState) || !identifier(node.healthState) ||
      !Array.isArray(node.capabilities) || !node.capabilities.every(identifier) || typeof node.controllerConnected!=='boolean' ||
      !Number.isFinite(node.freeDiskGiB) || node.freeDiskGiB<0 ||
      !['lastHeartbeatAt','resourceReceivedAt','currentSlots','maxSlots','lastAssignedAt'].every(key=>integer(node[key])) ||
      (node.schedulableSlots!==undefined && !integer(node.schedulableSlots))) throw new Error('INVALID_WORKER_PLAN');
    ids.add(node.id);
  }
  // The inherited selector checks freshness of controller receipts; reject future
  // heartbeats at this untrusted JSON boundary as well.
  const selected=selectNode({capability:input.capability},input.nodes.filter(n=>n.lastHeartbeatAt<=input.now),input.now);
  return {status:selected?'PLANNED':'BLOCKED',node_id:selected?.id??null,execution_authorized:false};
}

export function networkPlan(input) {
  exact(input,['url','allowedHosts','answers']);
  const target=validateAllowedHttpsUrl(input.url,input.allowedHosts);
  const address=selectPublicAddress(input.answers);
  return {status:'PLANNED',hostname:target.hostname,address,execution_authorized:false};
}

export function inspectRequirements(graph) {
  assertRequirementGraphIntegrity(graph);
  return {status:'INSPECTED',integrity_valid:true,authorization_verified:false,execution_authorized:false,
    requirement_graph_digest:graph.requirementGraphDigest,node_count:graph.nodes.length,order:graph.nodes.map(node=>node.id)};
}

export const isolatedEnvironment=()=>minimalSubprocessEnvironment();
