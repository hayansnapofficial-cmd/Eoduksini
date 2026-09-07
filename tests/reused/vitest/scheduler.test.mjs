// Engine primitive regression test.
import { describe, expect, it } from 'vitest';
import { selectNode } from "../../../packages/engine-primitives/scheduler.mjs";
const now = 1_787_999_999_000;
function node(id, overrides = {}) {
    return {
        id,
        approvalState: 'APPROVED',
        healthState: 'ONLINE',
        capabilities: ['development'],
        lastHeartbeatAt: now - 5_000,
        resourceReceivedAt: now - 5_000,
        controllerConnected: true,
        freeDiskGiB: 100,
        currentSlots: 0,
        maxSlots: 2,
        lastAssignedAt: now - 1_000,
        ...overrides,
    };
}
describe('scheduler rules', () => {
    it('never selects an incompatible, stale, full, low-disk, or draining node', () => {
        expect(selectNode({ capability: 'development' }, [
            node('design', { capabilities: ['design'] }),
            node('stale', { lastHeartbeatAt: now - 31_000 }),
            node('full', { currentSlots: 2 }),
            node('disk', { freeDiskGiB: 9.99 }),
            node('draining', { healthState: 'DRAINING' }),
        ], now)).toBeNull();
    });
    it('chooses lowest utilization and then oldest assignment', () => {
        const selected = selectNode({ capability: 'development' }, [
            node('half', { currentSlots: 1, maxSlots: 2 }),
            node('newer-idle', { currentSlots: 0, lastAssignedAt: now - 10_000 }),
            node('older-idle', { currentSlots: 0, lastAssignedAt: now - 20_000 }),
        ], now);
        expect(selected?.id).toBe('older-idle');
    });
    it('honors a headquarters schedulable-slot fence without changing durable max slots', () => {
        expect(selectNode({ capability: 'development' }, [node('headquarters', {
                maxSlots: 3,
                currentSlots: 1,
                schedulableSlots: 1,
            })], now)).toBeNull();
    });
    it('accepts an exact 30 second controller receipt and rejects stale or disconnected telemetry', () => {
        expect(selectNode({ capability: 'development' }, [node('boundary', {
                resourceReceivedAt: now - 30_000,
            })], now)?.id).toBe('boundary');
        expect(selectNode({ capability: 'development' }, [node('stale-resource', {
                resourceReceivedAt: now - 30_001,
                lastHeartbeatAt: now,
            })], now)).toBeNull();
        expect(selectNode({ capability: 'development' }, [node('future-resource', {
                resourceReceivedAt: now + 1,
                lastHeartbeatAt: now,
            })], now)).toBeNull();
        expect(selectNode({ capability: 'development' }, [node('disconnected', {
                resourceReceivedAt: now,
                controllerConnected: false,
            })], now)).toBeNull();
    });
});
