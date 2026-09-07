// Core-owned engine primitive.
export function isFreshControllerReceipt(receivedAt, now) {
    const age = now - receivedAt;
    return age >= 0 && age <= 30_000;
}
export function calculateCpuPercent(previous, current) {
    const keys = Object.keys(previous);
    const deltas = Object.fromEntries(keys.map((key) => [key, current[key] - previous[key]]));
    if (Object.values(deltas).some((value) => value < 0))
        throw new Error('CPU_COUNTER_INVALID');
    const total = Object.values(deltas).reduce((sum, value) => sum + value, 0);
    if (total <= 0)
        return { usagePercent: 0, idlePercent: 100 };
    const idle = (deltas.idle + deltas.iowait) / total * 100;
    return { usagePercent: Math.round((100 - idle) * 10) / 10, idlePercent: Math.round(idle * 10) / 10 };
}
function oneDecimal(value) {
    return Math.round(value * 10) / 10;
}
export function calculateMemory(totalGiB, availableGiB) {
    if (!Number.isFinite(totalGiB) || !Number.isFinite(availableGiB) || totalGiB < 0 || availableGiB < 0 || availableGiB > totalGiB) {
        throw new Error('MEMORY_CAPACITY_INVALID');
    }
    return { totalGiB: oneDecimal(totalGiB), usedGiB: oneDecimal(totalGiB - availableGiB), availableGiB: oneDecimal(availableGiB) };
}
export function calculateStorage(totalGiB, freeGiB, writable) {
    if (!Number.isFinite(totalGiB) || !Number.isFinite(freeGiB) || totalGiB < 0 || freeGiB < 0 || freeGiB > totalGiB) {
        throw new Error('STORAGE_CAPACITY_INVALID');
    }
    return { totalGiB: oneDecimal(totalGiB), usedGiB: oneDecimal(totalGiB - freeGiB), freeGiB: oneDecimal(freeGiB), writable };
}
