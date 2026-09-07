// Engine primitive regression test.
import { describe, expect, it } from 'vitest';
import { calculateCpuPercent, calculateMemory, calculateStorage } from "../../../packages/engine-primitives/resource.mjs";
describe('resource math', () => {
    it('calculates CPU use from proc-stat deltas rather than cumulative totals', () => {
        expect(calculateCpuPercent({ user: 100, nice: 0, system: 50, idle: 850, iowait: 0, irq: 0, softirq: 0, steal: 0 }, { user: 140, nice: 0, system: 70, idle: 890, iowait: 0, irq: 0, softirq: 0, steal: 0 })).toEqual({ usagePercent: 60, idlePercent: 40 });
    });
    it('derives used memory and storage without double-counting cache', () => {
        expect(calculateMemory(64, 18)).toEqual({ totalGiB: 64, usedGiB: 46, availableGiB: 18 });
        expect(calculateStorage(930, 807, true)).toEqual({ totalGiB: 930, usedGiB: 123, freeGiB: 807, writable: true });
    });
    it('rejects counters that move backwards or impossible capacities', () => {
        expect(() => calculateCpuPercent({ user: 10, nice: 0, system: 0, idle: 10, iowait: 0, irq: 0, softirq: 0, steal: 0 }, { user: 9, nice: 0, system: 0, idle: 10, iowait: 0, irq: 0, softirq: 0, steal: 0 })).toThrow('CPU_COUNTER_INVALID');
        expect(() => calculateMemory(8, 9)).toThrow('MEMORY_CAPACITY_INVALID');
    });
});
