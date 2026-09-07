// Engine primitive regression test.
import { describe, expect, it } from 'vitest';
import { decideResourceAdmission, decideGpuAdmission, leaseIsolationPolicyHash, normalizeContractNodeResourceQuota, normalizeTaskResourceRequest, } from "../../../packages/engine-primitives/resource-quota.mjs";
const quota = {
    contractId: 'CT-CLIENT1',
    nodeId: 'node-40',
    baseCpuThreads: 8,
    maxCpuThreads: 16,
    baseMemoryGiB: 12,
    maxMemoryGiB: 24,
    maxConcurrentTasks: 2,
    burstExpiresAt: 2_000,
    updatedAt: 100,
};
function admission(overrides = {}) {
    return {
        request: { workloadClass: 'LIGHT', cpuThreads: 2, memoryGiB: 4, gpuCount: 0, vramGiB: 0, estimatedSeconds: null, allowBurst: false },
        quota,
        contractUsage: { cpuThreads: 0, memoryGiB: 0, activeTasks: 0 },
        nodeUsage: { cpuThreads: 0, memoryGiB: 0, activeTasks: 0 },
        nodeCapacity: { cpuThreads: 39, memoryGiB: 56, availableMemoryGiB: 48 },
        now: 1_000,
        legacyInternal: false,
        ...overrides,
    };
}
describe('contract node resource admission', () => {
    it('normalizes legacy task packets to one small non-burst reservation', () => {
        expect(normalizeTaskResourceRequest(undefined)).toEqual({
            workloadClass: 'LIGHT', cpuThreads: 1, memoryGiB: 2,
            gpuCount: 0, vramGiB: 0, estimatedSeconds: null, allowBurst: false,
        });
        expect(normalizeTaskResourceRequest({ cpu_threads: 2, memory_gib: 3, allow_burst: false })).toEqual({
            workloadClass: 'LIGHT', cpuThreads: 2, memoryGiB: 3,
            gpuCount: 0, vramGiB: 0, estimatedSeconds: null, allowBurst: false,
        });
    });
    it('normalizes explicit GPU and crunch resource requests', () => {
        expect(normalizeTaskResourceRequest({
            workload_class: 'GPU', cpu_threads: 4, memory_gib: 12,
            gpu_count: 1, vram_gib: 16, estimated_seconds: 600, allow_burst: true,
        })).toEqual({
            workloadClass: 'GPU', cpuThreads: 4, memoryGiB: 12,
            gpuCount: 1, vramGiB: 16, estimatedSeconds: 600, allowBurst: true,
        });
        expect(normalizeTaskResourceRequest({
            workload_class: 'CRUNCH', cpu_threads: 8, memory_gib: 24,
            gpu_count: 0, vram_gib: 0, estimated_seconds: null, allow_burst: false,
        })).toMatchObject({ workloadClass: 'CRUNCH', gpuCount: 0, vramGiB: 0 });
    });
    it('rejects GPU fields that contradict the workload class', () => {
        expect(() => normalizeTaskResourceRequest({
            workload_class: 'LIGHT', cpu_threads: 1, memory_gib: 2,
            gpu_count: 1, vram_gib: 8, estimated_seconds: 30, allow_burst: false,
        })).toThrow('TASK_RESOURCE_REQUEST_INVALID');
        expect(() => normalizeTaskResourceRequest({
            workload_class: 'GPU', cpu_threads: 1, memory_gib: 2,
            gpu_count: 0, vram_gib: 0, estimated_seconds: 30, allow_burst: false,
        })).toThrow('TASK_RESOURCE_REQUEST_INVALID');
    });
    it('rejects fractional CPU threads and non-finite memory', () => {
        expect(() => normalizeTaskResourceRequest({ cpu_threads: 1.5, memory_gib: 2, allow_burst: false })).toThrow('TASK_RESOURCE_REQUEST_INVALID');
        expect(() => normalizeTaskResourceRequest({ cpu_threads: 1, memory_gib: Number.POSITIVE_INFINITY, allow_burst: false })).toThrow('TASK_RESOURCE_REQUEST_INVALID');
    });
    it('normalizes a persisted quota and rejects inverted ceilings', () => {
        expect(normalizeContractNodeResourceQuota(quota)).toEqual(quota);
        expect(() => normalizeContractNodeResourceQuota({ ...quota, baseCpuThreads: 17 })).toThrow('CONTRACT_NODE_RESOURCE_QUOTA_INVALID');
    });
    it('grants work inside the normal contract allowance', () => {
        expect(decideResourceAdmission(admission())).toEqual({ granted: true, tier: 'BASE', cpuThreads: 2, memoryGiB: 4 });
    });
    it('requires an explicit quota for an external contract', () => {
        expect(decideResourceAdmission(admission({ quota: null }))).toEqual({ granted: false, reason: 'CONTRACT_NODE_QUOTA_REQUIRED' });
    });
    it('keeps internal legacy work compatible without a quota', () => {
        expect(decideResourceAdmission(admission({ quota: null, legacyInternal: true }))).toEqual({ granted: true, tier: 'LEGACY_INTERNAL', cpuThreads: 2, memoryGiB: 4 });
    });
    it('blocks new work at the contract concurrency ceiling', () => {
        expect(decideResourceAdmission(admission({ contractUsage: { cpuThreads: 2, memoryGiB: 4, activeTasks: 2 } }))).toEqual({ granted: false, reason: 'CONTRACT_CONCURRENCY_LIMIT' });
    });
    it('does not let a normal task cross the base allowance', () => {
        expect(decideResourceAdmission(admission({ contractUsage: { cpuThreads: 7, memoryGiB: 10, activeTasks: 1 } }))).toEqual({ granted: false, reason: 'CONTRACT_BASE_LIMIT_REACHED' });
    });
    it('grants spare capacity up to the burst ceiling during an active window', () => {
        expect(decideResourceAdmission(admission({
            request: { workloadClass: 'LIGHT', cpuThreads: 2, memoryGiB: 4, gpuCount: 0, vramGiB: 0, estimatedSeconds: null, allowBurst: true },
            contractUsage: { cpuThreads: 7, memoryGiB: 10, activeTasks: 1 },
            now: 2_000,
        }))).toEqual({ granted: true, tier: 'BURST', cpuThreads: 2, memoryGiB: 4 });
    });
    it('rejects burst after its window and above its hard ceiling', () => {
        expect(decideResourceAdmission(admission({
            request: { workloadClass: 'LIGHT', cpuThreads: 2, memoryGiB: 4, gpuCount: 0, vramGiB: 0, estimatedSeconds: null, allowBurst: true },
            contractUsage: { cpuThreads: 7, memoryGiB: 10, activeTasks: 1 },
            now: 2_001,
        }))).toEqual({ granted: false, reason: 'CONTRACT_BURST_UNAVAILABLE' });
        expect(decideResourceAdmission(admission({
            request: { workloadClass: 'LIGHT', cpuThreads: 2, memoryGiB: 4, gpuCount: 0, vramGiB: 0, estimatedSeconds: null, allowBurst: true },
            contractUsage: { cpuThreads: 15, memoryGiB: 21, activeTasks: 1 },
        }))).toEqual({ granted: false, reason: 'CONTRACT_BURST_LIMIT_REACHED' });
    });
    it('never exceeds total node reservations or current available memory', () => {
        expect(decideResourceAdmission(admission({ nodeUsage: { cpuThreads: 38, memoryGiB: 8, activeTasks: 3 } }))).toEqual({ granted: false, reason: 'NODE_CPU_LIMIT_REACHED' });
        expect(decideResourceAdmission(admission({ nodeUsage: { cpuThreads: 2, memoryGiB: 54, activeTasks: 3 } }))).toEqual({ granted: false, reason: 'NODE_MEMORY_LIMIT_REACHED' });
        expect(decideResourceAdmission(admission({ nodeCapacity: { cpuThreads: 39, memoryGiB: 56, availableMemoryGiB: 3 } }))).toEqual({ granted: false, reason: 'NODE_MEMORY_PRESSURE' });
    });
    it('reserves deterministic GPU devices with enough live VRAM', () => {
        expect(decideGpuAdmission({
            request: normalizeTaskResourceRequest({
                workload_class: 'GPU', cpu_threads: 2, memory_gib: 8,
                gpu_count: 2, vram_gib: 12, estimated_seconds: 300, allow_burst: false,
            }),
            devices: [
                { id: 'GPU-b', deviceIndex: 1, name: 'GPU-B', totalVramGiB: 24, freeVramGiB: 20 },
                { id: 'GPU-a', deviceIndex: 0, name: 'GPU-A', totalVramGiB: 24, freeVramGiB: 16 },
                { id: 'GPU-c', deviceIndex: 2, name: 'GPU-C', totalVramGiB: 12, freeVramGiB: 12 },
            ],
            leasedGpuIds: [],
        })).toEqual({ granted: true, gpus: [
                { id: 'GPU-b', deviceIndex: 1, name: 'GPU-B', vramGiB: 12 },
                { id: 'GPU-a', deviceIndex: 0, name: 'GPU-A', vramGiB: 12 },
            ], vramGiB: 12 });
    });
    it('distinguishes occupied GPU devices from insufficient live VRAM', () => {
        const request = normalizeTaskResourceRequest({
            workload_class: 'GPU', cpu_threads: 2, memory_gib: 8,
            gpu_count: 1, vram_gib: 16, estimated_seconds: null, allow_burst: false,
        });
        expect(decideGpuAdmission({
            request, devices: [{ id: 'GPU-a', deviceIndex: 0, name: 'GPU-A', totalVramGiB: 24, freeVramGiB: 20 }], leasedGpuIds: ['GPU-a'],
        })).toEqual({ granted: false, reason: 'NODE_GPU_LIMIT_REACHED' });
        expect(decideGpuAdmission({
            request, devices: [{ id: 'GPU-a', deviceIndex: 0, name: 'GPU-A', totalVramGiB: 24, freeVramGiB: 8 }], leasedGpuIds: [],
        })).toEqual({ granted: false, reason: 'NODE_VRAM_LIMIT_REACHED' });
    });
    it('keeps reservations stable when identical GPU model cardinality changes', () => {
        const request = normalizeTaskResourceRequest({
            workload_class: 'GPU', cpu_threads: 2, memory_gib: 8,
            gpu_count: 1, vram_gib: 12, estimated_seconds: 120, allow_burst: false,
        });
        const devices = [
            { id: 'GPU-uuid-a', deviceIndex: 0, name: 'RTX 4090', totalVramGiB: 24, freeVramGiB: 20 },
            { id: 'GPU-uuid-b', deviceIndex: 1, name: 'RTX 4090', totalVramGiB: 24, freeVramGiB: 18 },
        ];
        expect(decideGpuAdmission({ request, devices: [devices[0]], leasedGpuIds: [] })).toEqual({
            granted: true, gpus: [{ id: 'GPU-uuid-a', deviceIndex: 0, name: 'RTX 4090', vramGiB: 12 }], vramGiB: 12,
        });
        expect(decideGpuAdmission({ request, devices, leasedGpuIds: ['GPU-uuid-a'] })).toEqual({
            granted: true, gpus: [{ id: 'GPU-uuid-b', deviceIndex: 1, name: 'RTX 4090', vramGiB: 12 }], vramGiB: 12,
        });
    });
    it('fails closed when telemetry cannot provide stable GPU identity', () => {
        const request = normalizeTaskResourceRequest({ workload_class: 'GPU', cpu_threads: 1, memory_gib: 2, gpu_count: 1, vram_gib: 4, estimated_seconds: null, allow_burst: false });
        expect(decideGpuAdmission({ request, devices: [{ name: 'RTX', totalVramGiB: 8, freeVramGiB: 8 }], leasedGpuIds: [] })).toEqual({ granted: false, reason: 'NODE_GPU_IDENTITY_UNAVAILABLE' });
    });
    it('binds the reserved GPU mapping into the isolation policy hash', () => {
        const base = { taskId: 'PS-GPU', contractId: 'CT-A', nodeId: 'node', fencingToken: 1, cpuThreads: 1, memoryGiB: 2, workloadClass: 'GPU', vramGiB: 4, estimatedSeconds: null, tier: 'BASE', leasedAt: 1 };
        const first = { ...base, gpus: [{ id: 'GPU-a', deviceIndex: 0, name: 'RTX', vramGiB: 4 }] };
        const second = { ...base, gpus: [{ id: 'GPU-b', deviceIndex: 1, name: 'RTX', vramGiB: 4 }] };
        expect(leaseIsolationPolicyHash('PS-GPU', { networkRequirement: 'NONE' }, first)).not.toBe(leaseIsolationPolicyHash('PS-GPU', { networkRequirement: 'NONE' }, second));
    });
});
