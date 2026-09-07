// Core-owned engine primitive.
import { createHash } from 'node:crypto';
export function leaseIsolationPolicyHash(taskId, policy, resourceLease) {
    const gpus = resourceLease?.gpus ?? [];
    const material = gpus.length > 0 ? { taskId, policy, gpus: gpus.map(({ id, deviceIndex, name, vramGiB }) => ({ id, deviceIndex, name, vramGiB })) } : { taskId, policy };
    return createHash('sha256').update(JSON.stringify(material)).digest('hex');
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function exactKeys(value, keys) {
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function positiveInteger(value, maximum) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}
function positiveFinite(value, maximum) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= maximum;
}
function nonnegativeFinite(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
export function normalizeTaskResourceRequest(value) {
    const light = (cpuThreads, memoryGiB, allowBurst) => ({
        workloadClass: 'LIGHT', cpuThreads, memoryGiB, gpuCount: 0, vramGiB: 0,
        estimatedSeconds: null, allowBurst,
    });
    if (value === undefined)
        return light(1, 2, false);
    if (isRecord(value) && exactKeys(value, ['cpu_threads', 'memory_gib', 'allow_burst'])
        && positiveInteger(value.cpu_threads, 4_096)
        && positiveFinite(value.memory_gib, 1_048_576)
        && typeof value.allow_burst === 'boolean') {
        return light(value.cpu_threads, value.memory_gib, value.allow_burst);
    }
    const keys = ['workload_class', 'cpu_threads', 'memory_gib', 'gpu_count', 'vram_gib', 'estimated_seconds', 'allow_burst'];
    if (!isRecord(value) || !exactKeys(value, keys)
        || !['LIGHT', 'CPU_HEAVY', 'GPU', 'CRUNCH'].includes(String(value.workload_class))
        || !positiveInteger(value.cpu_threads, 4_096)
        || !positiveFinite(value.memory_gib, 1_048_576)
        || !Number.isSafeInteger(value.gpu_count) || Number(value.gpu_count) < 0 || Number(value.gpu_count) > 16
        || !nonnegativeFinite(value.vram_gib) || Number(value.vram_gib) > 1_048_576
        || !(value.estimated_seconds === null || positiveInteger(value.estimated_seconds, 31_536_000))
        || typeof value.allow_burst !== 'boolean') {
        throw new Error('TASK_RESOURCE_REQUEST_INVALID');
    }
    const workloadClass = value.workload_class;
    const gpuCount = Number(value.gpu_count);
    const vramGiB = Number(value.vram_gib);
    if ((workloadClass === 'LIGHT' || workloadClass === 'CPU_HEAVY') && (gpuCount !== 0 || vramGiB !== 0)) {
        throw new Error('TASK_RESOURCE_REQUEST_INVALID');
    }
    if (workloadClass === 'GPU' && (gpuCount === 0 || vramGiB === 0)) {
        throw new Error('TASK_RESOURCE_REQUEST_INVALID');
    }
    if ((gpuCount === 0) !== (vramGiB === 0))
        throw new Error('TASK_RESOURCE_REQUEST_INVALID');
    return {
        workloadClass, cpuThreads: value.cpu_threads, memoryGiB: value.memory_gib,
        gpuCount, vramGiB, estimatedSeconds: value.estimated_seconds,
        allowBurst: value.allow_burst,
    };
}
export function decideGpuAdmission(input) {
    if (input.request.gpuCount === 0)
        return { granted: true, gpus: [], vramGiB: 0 };
    const identified = input.devices.filter((device) => typeof device.id === 'string' && device.id.length > 0 && typeof device.deviceIndex === 'number' && Number.isSafeInteger(device.deviceIndex) && device.deviceIndex >= 0);
    if (identified.length < input.request.gpuCount || new Set(identified.map((device) => device.id)).size !== identified.length || new Set(identified.map((device) => device.deviceIndex)).size !== identified.length) {
        return { granted: false, reason: 'NODE_GPU_IDENTITY_UNAVAILABLE' };
    }
    const leased = new Set(input.leasedGpuIds);
    const available = identified.filter((device) => !leased.has(device.id));
    if (available.length < input.request.gpuCount)
        return { granted: false, reason: 'NODE_GPU_LIMIT_REACHED' };
    const capable = available
        .filter((device) => device.freeVramGiB !== null && device.freeVramGiB >= input.request.vramGiB)
        .sort((left, right) => (right.freeVramGiB ?? 0) - (left.freeVramGiB ?? 0) || left.id.localeCompare(right.id));
    if (capable.length < input.request.gpuCount)
        return { granted: false, reason: 'NODE_VRAM_LIMIT_REACHED' };
    return {
        granted: true,
        gpus: capable.slice(0, input.request.gpuCount).map((device) => ({ id: device.id, deviceIndex: device.deviceIndex, name: device.name, vramGiB: input.request.vramGiB })),
        vramGiB: input.request.vramGiB,
    };
}
export function normalizeContractNodeResourceQuota(value) {
    const keys = ['contractId', 'nodeId', 'baseCpuThreads', 'maxCpuThreads', 'baseMemoryGiB', 'maxMemoryGiB', 'maxConcurrentTasks', 'burstExpiresAt', 'updatedAt'];
    if (!isRecord(value) || !exactKeys(value, keys)
        || typeof value.contractId !== 'string' || !/^CT-[A-Z0-9][A-Z0-9_-]{0,62}$/.test(value.contractId)
        || typeof value.nodeId !== 'string' || value.nodeId.length < 1 || value.nodeId.length > 128
        || !positiveInteger(value.baseCpuThreads, 4_096) || !positiveInteger(value.maxCpuThreads, 4_096)
        || !positiveFinite(value.baseMemoryGiB, 1_048_576) || !positiveFinite(value.maxMemoryGiB, 1_048_576)
        || !positiveInteger(value.maxConcurrentTasks, 10_000)
        || !(value.burstExpiresAt === null || (Number.isSafeInteger(value.burstExpiresAt) && Number(value.burstExpiresAt) >= 0))
        || !Number.isSafeInteger(value.updatedAt) || Number(value.updatedAt) < 0
        || Number(value.baseCpuThreads) > Number(value.maxCpuThreads)
        || Number(value.baseMemoryGiB) > Number(value.maxMemoryGiB)) {
        throw new Error('CONTRACT_NODE_RESOURCE_QUOTA_INVALID');
    }
    return {
        contractId: value.contractId,
        nodeId: value.nodeId,
        baseCpuThreads: value.baseCpuThreads,
        maxCpuThreads: value.maxCpuThreads,
        baseMemoryGiB: value.baseMemoryGiB,
        maxMemoryGiB: value.maxMemoryGiB,
        maxConcurrentTasks: value.maxConcurrentTasks,
        burstExpiresAt: value.burstExpiresAt,
        updatedAt: Number(value.updatedAt),
    };
}
function validUsage(value) {
    return nonnegativeFinite(value.cpuThreads) && nonnegativeFinite(value.memoryGiB)
        && Number.isSafeInteger(value.activeTasks) && value.activeTasks >= 0;
}
export function decideResourceAdmission(input) {
    const { request, contractUsage, nodeUsage, nodeCapacity } = input;
    if (!positiveInteger(request.cpuThreads, 4_096) || !positiveFinite(request.memoryGiB, 1_048_576)
        || typeof request.allowBurst !== 'boolean' || !validUsage(contractUsage) || !validUsage(nodeUsage)
        || !positiveInteger(nodeCapacity.cpuThreads, 4_096) || !positiveFinite(nodeCapacity.memoryGiB, 1_048_576)
        || !nonnegativeFinite(nodeCapacity.availableMemoryGiB)) {
        throw new Error('RESOURCE_ADMISSION_INPUT_INVALID');
    }
    if (nodeUsage.cpuThreads + request.cpuThreads > nodeCapacity.cpuThreads) {
        return { granted: false, reason: 'NODE_CPU_LIMIT_REACHED' };
    }
    if (nodeUsage.memoryGiB + request.memoryGiB > nodeCapacity.memoryGiB) {
        return { granted: false, reason: 'NODE_MEMORY_LIMIT_REACHED' };
    }
    if (request.memoryGiB > nodeCapacity.availableMemoryGiB) {
        return { granted: false, reason: 'NODE_MEMORY_PRESSURE' };
    }
    if (input.quota === null) {
        return input.legacyInternal
            ? { granted: true, tier: 'LEGACY_INTERNAL', cpuThreads: request.cpuThreads, memoryGiB: request.memoryGiB }
            : { granted: false, reason: 'CONTRACT_NODE_QUOTA_REQUIRED' };
    }
    const quota = normalizeContractNodeResourceQuota(input.quota);
    if (contractUsage.activeTasks >= quota.maxConcurrentTasks) {
        return { granted: false, reason: 'CONTRACT_CONCURRENCY_LIMIT' };
    }
    const nextCpu = contractUsage.cpuThreads + request.cpuThreads;
    const nextMemory = contractUsage.memoryGiB + request.memoryGiB;
    if (nextCpu <= quota.baseCpuThreads && nextMemory <= quota.baseMemoryGiB) {
        return { granted: true, tier: 'BASE', cpuThreads: request.cpuThreads, memoryGiB: request.memoryGiB };
    }
    if (!request.allowBurst)
        return { granted: false, reason: 'CONTRACT_BASE_LIMIT_REACHED' };
    if (quota.burstExpiresAt === null || quota.burstExpiresAt < input.now) {
        return { granted: false, reason: 'CONTRACT_BURST_UNAVAILABLE' };
    }
    if (nextCpu > quota.maxCpuThreads || nextMemory > quota.maxMemoryGiB) {
        return { granted: false, reason: 'CONTRACT_BURST_LIMIT_REACHED' };
    }
    return { granted: true, tier: 'BURST', cpuThreads: request.cpuThreads, memoryGiB: request.memoryGiB };
}
