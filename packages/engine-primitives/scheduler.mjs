// Core-owned engine primitive.
import { isFreshControllerReceipt } from "./resource.mjs";
export function selectNode(requirements, nodes, now) {
    const eligible = nodes.filter((node) => {
        const healthy = node.healthState === 'ONLINE' || node.healthState === 'BUSY';
        return node.approvalState === 'APPROVED'
            && healthy
            && node.capabilities.includes(requirements.capability)
            && now - node.lastHeartbeatAt <= 30_000
            && isFreshControllerReceipt(node.resourceReceivedAt, now)
            && node.controllerConnected
            && node.freeDiskGiB >= 10
            && node.maxSlots > 0
            && node.currentSlots < Math.min(node.maxSlots, node.schedulableSlots ?? node.maxSlots);
    });
    eligible.sort((left, right) => {
        const utilizationDifference = left.currentSlots / left.maxSlots - right.currentSlots / right.maxSlots;
        if (utilizationDifference !== 0)
            return utilizationDifference;
        if (left.lastAssignedAt !== right.lastAssignedAt)
            return left.lastAssignedAt - right.lastAssignedAt;
        return left.id.localeCompare(right.id);
    });
    return eligible[0] ?? null;
}
