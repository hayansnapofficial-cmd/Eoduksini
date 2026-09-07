// Core-owned engine primitive.
import { canonicalStringify, digestCanonical } from "./canonical.mjs";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const REQUIREMENT_KINDS = new Set([
    "business",
    "functional",
    "data",
    "security",
    "operational",
    "approval",
]);
const REQUIREMENT_PRIORITIES = new Set([
    "mandatory",
    "preferred",
    "optional",
]);
const EVIDENCE_LANES = new Set([
    "operational",
    "contract-fixture",
]);
const INTERFACE_KINDS = new Set([
    "skill",
    "mcp-tool",
    "library",
    "cli",
    "http",
    "workflow",
]);
const PERMISSION_EFFECTS = new Set([
    "fs-read",
    "fs-write",
    "network-egress",
    "process-execute",
    "secret-use",
    "host-activate",
]);
const BILLING_PERIODS = new Set(["one-time", "monthly"]);
const APPROVAL_STAGES = new Set([
    "planning",
    "execution",
    "promotion",
]);
const GRAPH_DRAFT_FIELDS = new Set([
    "tenantId",
    "projectId",
    "revision",
    "objective",
    "selectorVocabularyDigest",
    "evidenceLane",
    "facts",
    "nodes",
    "constraints",
    "approvalIntents",
]);
const GRAPH_FIELDS = new Set([
    ...GRAPH_DRAFT_FIELDS,
    "schemaVersion",
    "requirementScopeDigest",
    "requirementGraphDigest",
]);
const FACT_FIELDS = new Set(["key", "value"]);
const NODE_FIELDS = new Set([
    "id",
    "kind",
    "priority",
    "dependsOn",
    "capabilitySelector",
    "requiredRuleIds",
    "acceptanceCriteria",
]);
const SELECTOR_FIELDS = new Set([
    "classes",
    "interfaceKinds",
    "requiredProtocols",
    "requiredRuntimes",
]);
const CONSTRAINT_FIELDS = new Set([
    "allowedLicenses",
    "deniedPermissions",
    "maximumTotalCostMicros",
    "costCurrency",
    "billingPeriod",
    "pricingMaxAgeDays",
    "requireKnownCost",
]);
const APPROVAL_FIELDS = new Set(["id", "target", "requiredBefore", "reason"]);
const RULE_WAIVER_FIELDS = new Set(["kind", "requirementNodeId", "ruleId"]);
const COST_APPROVAL_FIELDS = new Set([
    "kind",
    "currency",
    "billingPeriod",
    "thresholdMicros",
]);
const PERMISSION_APPROVAL_FIELDS = new Set([
    "kind",
    "requirementNodeId",
    "effect",
    "selector",
]);
const DATA_SHARING_FIELDS = new Set([
    "kind",
    "requirementNodeId",
    "dataClass",
    "destination",
]);
const PRODUCTION_APPROVAL_FIELDS = new Set(["kind", "requirementNodeId"]);
const AUTHORIZATION_DRAFT_FIELDS = new Set([
    "tenantId",
    "projectId",
    "requirementGraphDigest",
    "authorizerAuthorityId",
    "authorizedAt",
    "expiresAt",
    "authorityReceiptRef",
]);
const AUTHORIZATION_FIELDS = new Set([
    ...AUTHORIZATION_DRAFT_FIELDS,
    "schemaVersion",
    "authorizationDigest",
]);
const MAX_FACTS = 256;
const MAX_NODES = 256;
const MAX_DEPENDENCIES = 32;
const MAX_SHORT_TEXT = 128;
const MAX_OBJECTIVE_OR_CRITERION = 2_000;
const MAX_GENERIC_ARRAY = 8_192;
const MAX_GENERIC_DEPTH = 32;
const MAX_GENERIC_ENTRIES = 100_000;
export function compareCodePoints(left, right) {
    const leftPoints = Array.from(left, (value) => value.codePointAt(0));
    const rightPoints = Array.from(right, (value) => value.codePointAt(0));
    const length = Math.min(leftPoints.length, rightPoints.length);
    for (let index = 0; index < length; index += 1) {
        if (leftPoints[index] < rightPoints[index])
            return -1;
        if (leftPoints[index] > rightPoints[index])
            return 1;
    }
    if (leftPoints.length < rightPoints.length)
        return -1;
    if (leftPoints.length > rightPoints.length)
        return 1;
    return 0;
}
function assertSafeDataTree(value, label) {
    const active = new WeakSet();
    let entries = 0;
    const visit = (entry, path, depth) => {
        entries += 1;
        if (entries > MAX_GENERIC_ENTRIES) {
            throw new Error(`${label} exceeds the aggregate data bound`);
        }
        if (depth > MAX_GENERIC_DEPTH) {
            throw new Error(`${label} exceeds the maximum data depth`);
        }
        if (entry === null ||
            typeof entry === "string" ||
            typeof entry === "boolean" ||
            typeof entry === "number") {
            return;
        }
        if (typeof entry !== "object") {
            throw new Error(`${path} must contain only JSON-like data`);
        }
        if (active.has(entry))
            throw new Error(`${label} cannot contain cycles`);
        active.add(entry);
        if (Object.getOwnPropertySymbols(entry).length > 0) {
            throw new Error(`${path} cannot contain symbol keys`);
        }
        const descriptors = Object.getOwnPropertyDescriptors(entry);
        if (Array.isArray(entry)) {
            if (Object.getPrototypeOf(entry) !== Array.prototype) {
                throw new Error(`${path} must be an intrinsic array`);
            }
            if (entry.length > MAX_GENERIC_ARRAY) {
                throw new Error(`${path} exceeds the aggregate array bound`);
            }
            for (const [key, descriptor] of Object.entries(descriptors)) {
                if (key === "length")
                    continue;
                const index = Number(key);
                if (!Number.isSafeInteger(index) ||
                    index < 0 ||
                    String(index) !== key ||
                    index >= entry.length ||
                    !descriptor.enumerable ||
                    !("value" in descriptor) ||
                    descriptor.get !== undefined ||
                    descriptor.set !== undefined) {
                    throw new Error(`${path} requires enumerable array data properties`);
                }
            }
            for (let index = 0; index < entry.length; index += 1) {
                const descriptor = descriptors[String(index)];
                if (!descriptor || !("value" in descriptor)) {
                    throw new Error(`${path} cannot contain sparse arrays`);
                }
                visit(descriptor.value, `${path}[${index}]`, depth + 1);
            }
        }
        else {
            const prototype = Object.getPrototypeOf(entry);
            if (prototype !== Object.prototype && prototype !== null) {
                throw new Error(`${path} must be a plain object`);
            }
            for (const [key, descriptor] of Object.entries(descriptors)) {
                if (FORBIDDEN_KEYS.has(key)) {
                    throw new Error(`${path} contains a forbidden prototype-shaped key`);
                }
                if (!descriptor.enumerable ||
                    !("value" in descriptor) ||
                    descriptor.get !== undefined ||
                    descriptor.set !== undefined) {
                    throw new Error(`${path} requires enumerable data properties, not accessors`);
                }
                visit(descriptor.value, `${path}.${key}`, depth + 1);
            }
        }
        active.delete(entry);
    };
    visit(value, label, 0);
}
function assertClosedObject(value, allowed, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
            throw new Error(`${label} contains an unexpected field: ${key}`);
        }
    }
}
function assertArray(value, label) {
    if (!Array.isArray(value))
        throw new Error(`${label} must be an array`);
}
function codePointLength(value) {
    return Array.from(value).length;
}
function requireText(value, label, maximum = MAX_SHORT_TEXT) {
    if (typeof value !== "string")
        throw new Error(`${label} must be text`);
    const normalized = value.trim();
    if (!normalized)
        throw new Error(`${label} is required`);
    if (codePointLength(normalized) > maximum) {
        throw new Error(`${label} exceeds the ${maximum} character length bound`);
    }
    return normalized;
}
function requireIdentifier(value, label, maximum = MAX_SHORT_TEXT) {
    const normalized = requireText(value, label, maximum);
    if (FORBIDDEN_KEYS.has(normalized)) {
        throw new Error(`${label} cannot use a prototype-shaped identifier`);
    }
    return normalized;
}
function requireDigest(value, label) {
    if (typeof value !== "string" || !DIGEST_PATTERN.test(value)) {
        throw new Error(`${label} must be a SHA-256 digest`);
    }
    return value;
}
function requirePositiveInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return value;
}
function requireNonNegativeInteger(value, label) {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${label} must be a non-negative safe integer`);
    }
    return value;
}
function requireBoolean(value, label) {
    if (typeof value !== "boolean")
        throw new Error(`${label} must be boolean`);
    return value;
}
function normalizeStringSet(value, label, options = {}) {
    assertArray(value, label);
    if (options.maximumCount !== undefined && value.length > options.maximumCount) {
        throw new Error(`${label} exceeds the ${options.maximumCount} item bound`);
    }
    const normalized = value.map((entry) => requireIdentifier(entry, label, options.maximumLength));
    const seen = new Set();
    for (const entry of normalized) {
        if (seen.has(entry))
            throw new Error(`${label} contains a duplicate value: ${entry}`);
        seen.add(entry);
    }
    return normalized.sort(compareCodePoints);
}
function normalizeFacts(value) {
    assertArray(value, "Requirement facts");
    if (value.length > MAX_FACTS) {
        throw new Error(`Requirement facts exceed the ${MAX_FACTS} item bound`);
    }
    const facts = value.map((entry, index) => {
        assertClosedObject(entry, FACT_FIELDS, `Requirement fact ${index}`);
        const key = requireIdentifier(entry.key, `Requirement fact ${index} key`);
        const factValue = entry.value;
        if (typeof factValue !== "string" &&
            typeof factValue !== "number" &&
            typeof factValue !== "boolean") {
            throw new Error(`Requirement fact ${key} has an invalid value`);
        }
        if (typeof factValue === "number" &&
            (!Number.isFinite(factValue) ||
                (Number.isInteger(factValue) && !Number.isSafeInteger(factValue)))) {
            throw new Error(`Requirement fact ${key} must be finite; integer values must be safe integers`);
        }
        const normalizedValue = typeof factValue === "string"
            ? requireText(factValue, `Requirement fact ${key} value`, MAX_OBJECTIVE_OR_CRITERION)
            : Object.is(factValue, -0)
                ? 0
                : factValue;
        return { key, value: normalizedValue };
    });
    const keys = new Set();
    for (const fact of facts) {
        if (keys.has(fact.key)) {
            throw new Error(`Requirement facts contain a duplicate key: ${fact.key}`);
        }
        keys.add(fact.key);
    }
    return facts.sort((left, right) => compareCodePoints(left.key, right.key));
}
function normalizeSelector(value, label) {
    assertClosedObject(value, SELECTOR_FIELDS, label);
    const classes = normalizeStringSet(value.classes, `${label} classes`, {
        maximumCount: MAX_FACTS,
    });
    assertArray(value.interfaceKinds, `${label} interface kinds`);
    const interfaceKinds = normalizeStringSet(value.interfaceKinds, `${label} interface kinds`, { maximumCount: INTERFACE_KINDS.size });
    for (const kind of interfaceKinds) {
        if (!INTERFACE_KINDS.has(kind)) {
            throw new Error(`${label} contains an invalid interface kind: ${kind}`);
        }
    }
    const requiredProtocols = normalizeStringSet(value.requiredProtocols, `${label} required protocols`, { maximumCount: MAX_FACTS });
    const requiredRuntimes = normalizeStringSet(value.requiredRuntimes, `${label} required runtimes`, { maximumCount: MAX_FACTS });
    if (classes.length === 0 &&
        interfaceKinds.length === 0 &&
        requiredProtocols.length === 0 &&
        requiredRuntimes.length === 0) {
        throw new Error(`${label} must contain at least one selection criterion`);
    }
    return {
        classes,
        interfaceKinds: interfaceKinds,
        requiredProtocols,
        requiredRuntimes,
    };
}
function normalizeNodes(value) {
    assertArray(value, "Requirement nodes");
    if (value.length === 0)
        throw new Error("Requirement nodes are required");
    if (value.length > MAX_NODES) {
        throw new Error(`Requirement nodes exceed the ${MAX_NODES} item bound`);
    }
    const nodes = value.map((entry, index) => {
        assertClosedObject(entry, NODE_FIELDS, `Requirement node ${index}`);
        const id = requireIdentifier(entry.id, `Requirement node ${index} identifier`);
        if (!REQUIREMENT_KINDS.has(entry.kind)) {
            throw new Error(`Requirement node ${id} has an invalid kind`);
        }
        if (!REQUIREMENT_PRIORITIES.has(entry.priority)) {
            throw new Error(`Requirement node ${id} has an invalid priority`);
        }
        const dependsOn = normalizeStringSet(entry.dependsOn, `Requirement node ${id} dependencies`, { maximumCount: MAX_DEPENDENCIES });
        const requiredRuleIds = normalizeStringSet(entry.requiredRuleIds, `Requirement node ${id} required rule IDs`, { maximumCount: MAX_FACTS });
        assertArray(entry.acceptanceCriteria, `Requirement node ${id} acceptance criteria`);
        if (entry.acceptanceCriteria.length === 0) {
            throw new Error(`Requirement node ${id} acceptance criteria are required`);
        }
        const acceptanceCriteria = entry.acceptanceCriteria.map((criterion) => requireText(criterion, `Requirement node ${id} acceptance criterion`, MAX_OBJECTIVE_OR_CRITERION));
        if (new Set(acceptanceCriteria).size !== acceptanceCriteria.length) {
            throw new Error(`Requirement node ${id} contains duplicate acceptance criteria`);
        }
        acceptanceCriteria.sort(compareCodePoints);
        const capabilitySelector = entry.capabilitySelector === undefined
            ? undefined
            : normalizeSelector(entry.capabilitySelector, `Requirement node ${id} capability selector`);
        return {
            id,
            kind: entry.kind,
            priority: entry.priority,
            dependsOn,
            ...(capabilitySelector ? { capabilitySelector } : {}),
            requiredRuleIds,
            acceptanceCriteria,
        };
    });
    const byId = new Map();
    for (const node of nodes) {
        if (byId.has(node.id))
            throw new Error(`Duplicate requirement node ID: ${node.id}`);
        byId.set(node.id, node);
    }
    for (const node of nodes) {
        for (const dependency of node.dependsOn) {
            if (!byId.has(dependency)) {
                throw new Error(`Requirement node ${node.id} references a missing dependency: ${dependency}`);
            }
        }
    }
    const indegree = new Map();
    const dependents = new Map();
    for (const node of nodes) {
        indegree.set(node.id, node.dependsOn.length);
        for (const dependency of node.dependsOn) {
            const entries = dependents.get(dependency) ?? [];
            entries.push(node.id);
            dependents.set(dependency, entries);
        }
    }
    for (const entries of dependents.values())
        entries.sort(compareCodePoints);
    const ready = nodes
        .filter((node) => indegree.get(node.id) === 0)
        .map((node) => node.id)
        .sort(compareCodePoints);
    const ordered = [];
    while (ready.length > 0) {
        const id = ready.shift();
        ordered.push(byId.get(id));
        for (const dependent of dependents.get(id) ?? []) {
            const next = indegree.get(dependent) - 1;
            indegree.set(dependent, next);
            if (next === 0) {
                ready.push(dependent);
                ready.sort(compareCodePoints);
            }
        }
    }
    if (ordered.length !== nodes.length) {
        throw new Error("Requirement graph contains a dependency cycle");
    }
    if (!ordered.some((node) => node.priority === "mandatory" && node.capabilitySelector !== undefined)) {
        throw new Error("Broker-bound graph requires at least one mandatory capability selector");
    }
    return ordered;
}
function normalizeConstraints(value) {
    assertClosedObject(value, CONSTRAINT_FIELDS, "Requirement graph constraints");
    const allowedLicenses = normalizeStringSet(value.allowedLicenses, "Allowed licenses", { maximumCount: MAX_FACTS });
    const deniedPermissions = normalizeStringSet(value.deniedPermissions, "Denied permissions", { maximumCount: MAX_FACTS });
    const maximumTotalCostMicros = value.maximumTotalCostMicros === undefined
        ? undefined
        : requireNonNegativeInteger(value.maximumTotalCostMicros, "Maximum total cost micros");
    const costCurrency = value.costCurrency === undefined
        ? undefined
        : requireIdentifier(value.costCurrency, "Cost currency", 16);
    if (maximumTotalCostMicros !== undefined && costCurrency === undefined) {
        throw new Error("Cost currency is required when maximum total cost is set");
    }
    if (!BILLING_PERIODS.has(value.billingPeriod)) {
        throw new Error("Requirement graph billing period is invalid");
    }
    const pricingMaxAgeDays = requirePositiveInteger(value.pricingMaxAgeDays, "Pricing maximum age days");
    if (pricingMaxAgeDays > 3_650) {
        throw new Error("Pricing maximum age days cannot exceed 3650");
    }
    return {
        allowedLicenses,
        deniedPermissions,
        ...(maximumTotalCostMicros !== undefined ? { maximumTotalCostMicros } : {}),
        ...(costCurrency !== undefined ? { costCurrency } : {}),
        billingPeriod: value.billingPeriod,
        pricingMaxAgeDays,
        requireKnownCost: requireBoolean(value.requireKnownCost, "Require known cost"),
    };
}
function assertNodeTarget(nodeId, nodeIds, label) {
    const normalized = requireIdentifier(nodeId, `${label} requirement node ID`);
    if (!nodeIds.has(normalized)) {
        throw new Error(`${label} references a missing requirement node: ${normalized}`);
    }
    return normalized;
}
function normalizeApprovalTarget(value, nodeIds, constraints, label) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    const kind = value.kind;
    if (kind === "rule-waiver") {
        assertClosedObject(value, RULE_WAIVER_FIELDS, label);
        return {
            kind,
            requirementNodeId: assertNodeTarget(value.requirementNodeId, nodeIds, label),
            ruleId: requireIdentifier(value.ruleId, `${label} rule ID`),
        };
    }
    if (kind === "cost") {
        assertClosedObject(value, COST_APPROVAL_FIELDS, label);
        const currency = requireIdentifier(value.currency, `${label} currency`, 16);
        if (!BILLING_PERIODS.has(value.billingPeriod)) {
            throw new Error(`${label} billing period is invalid`);
        }
        if (constraints.costCurrency !== undefined && currency !== constraints.costCurrency) {
            throw new Error(`${label} currency does not match the graph cost currency`);
        }
        if (value.billingPeriod !== constraints.billingPeriod) {
            throw new Error(`${label} billing period does not match the graph constraint`);
        }
        return {
            kind,
            currency,
            billingPeriod: value.billingPeriod,
            thresholdMicros: requireNonNegativeInteger(value.thresholdMicros, `${label} threshold micros`),
        };
    }
    if (kind === "permission") {
        assertClosedObject(value, PERMISSION_APPROVAL_FIELDS, label);
        if (!PERMISSION_EFFECTS.has(value.effect)) {
            throw new Error(`${label} permission effect is invalid`);
        }
        return {
            kind,
            requirementNodeId: assertNodeTarget(value.requirementNodeId, nodeIds, label),
            effect: value.effect,
            selector: requireText(value.selector, `${label} permission selector`, MAX_OBJECTIVE_OR_CRITERION),
        };
    }
    if (kind === "data-sharing") {
        assertClosedObject(value, DATA_SHARING_FIELDS, label);
        return {
            kind,
            requirementNodeId: assertNodeTarget(value.requirementNodeId, nodeIds, label),
            dataClass: requireIdentifier(value.dataClass, `${label} data class`),
            destination: requireText(value.destination, `${label} destination`, MAX_OBJECTIVE_OR_CRITERION),
        };
    }
    if (kind === "production") {
        assertClosedObject(value, PRODUCTION_APPROVAL_FIELDS, label);
        return {
            kind,
            requirementNodeId: assertNodeTarget(value.requirementNodeId, nodeIds, label),
        };
    }
    throw new Error(`${label} kind is invalid`);
}
function normalizeApprovalIntents(value, nodes, constraints) {
    assertArray(value, "Approval intents");
    if (value.length > MAX_NODES) {
        throw new Error(`Approval intents exceed the ${MAX_NODES} item bound`);
    }
    const nodeIds = new Set(nodes.map((node) => node.id));
    const intents = value.map((entry, index) => {
        assertClosedObject(entry, APPROVAL_FIELDS, `Approval intent ${index}`);
        const id = requireIdentifier(entry.id, `Approval intent ${index} identifier`);
        if (!APPROVAL_STAGES.has(entry.requiredBefore)) {
            throw new Error(`Approval intent ${id} required-before stage is invalid`);
        }
        return {
            id,
            target: normalizeApprovalTarget(entry.target, nodeIds, constraints, `Approval intent ${id} target`),
            requiredBefore: entry.requiredBefore,
            reason: requireText(entry.reason, `Approval intent ${id} reason`, MAX_OBJECTIVE_OR_CRITERION),
        };
    });
    const ids = new Set();
    for (const intent of intents) {
        if (ids.has(intent.id))
            throw new Error(`Duplicate approval intent ID: ${intent.id}`);
        ids.add(intent.id);
    }
    return intents.sort((left, right) => compareCodePoints(left.id, right.id));
}
function validateContext(graph, context) {
    if (!context ||
        typeof context !== "object" ||
        !context.selectorVocabulary ||
        typeof context.selectorVocabulary !== "object") {
        throw new Error("Requirement graph validation context is invalid");
    }
    const contextDigest = requireDigest(context.selectorVocabulary.vocabularyDigest, "Selector vocabulary digest");
    if (graph.selectorVocabularyDigest !== contextDigest) {
        throw new Error("Requirement graph selector vocabulary digest does not match Canon");
    }
    const vocabularyClasses = normalizeStringSet(context.selectorVocabulary.classes, "Selector vocabulary classes", { maximumCount: MAX_FACTS });
    const vocabularyFactKeys = normalizeStringSet(context.selectorVocabulary.factKeys, "Selector vocabulary fact keys", { maximumCount: MAX_FACTS });
    const classSet = new Set(vocabularyClasses);
    const factKeySet = new Set(vocabularyFactKeys);
    for (const fact of graph.facts) {
        if (!factKeySet.has(fact.key)) {
            throw new Error(`Unknown requirement fact key in Canon vocabulary: ${fact.key}`);
        }
    }
    for (const node of graph.nodes) {
        for (const className of node.capabilitySelector?.classes ?? []) {
            if (!classSet.has(className)) {
                throw new Error(`Unknown capability class in Canon vocabulary: ${className}`);
            }
        }
    }
    const activeRuleIds = normalizeStringSet(context.activeRuleIds, "Active Canon rule IDs", { maximumCount: 1_024 });
    if (typeof context.ruleAppliesToRequirement !== "function") {
        throw new Error("Canon rule applicability verifier is required");
    }
    const activeSet = new Set(activeRuleIds);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const assertions = [];
    for (const node of graph.nodes) {
        for (const ruleId of node.requiredRuleIds) {
            assertions.push({ ruleId, node, label: `Requirement node ${node.id}` });
        }
    }
    for (const intent of graph.approvalIntents) {
        if (intent.target.kind === "rule-waiver") {
            assertions.push({
                ruleId: intent.target.ruleId,
                node: byId.get(intent.target.requirementNodeId),
                label: `Approval intent ${intent.id}`,
            });
        }
    }
    for (const assertion of assertions) {
        if (!activeSet.has(assertion.ruleId)) {
            throw new Error(`${assertion.label} references a rule that is not active in the effective Canon: ${assertion.ruleId}`);
        }
        if (!context.ruleAppliesToRequirement(assertion.ruleId, assertion.node, graph.facts)) {
            throw new Error(`${assertion.label} references a rule that does not apply to the requirement`);
        }
    }
}
function normalizeGraphDraft(input, context) {
    assertSafeDataTree(input, "Requirement graph");
    assertClosedObject(input, GRAPH_DRAFT_FIELDS, "Requirement graph draft");
    const tenantId = requireIdentifier(input.tenantId, "Requirement graph tenant ID");
    const projectId = requireIdentifier(input.projectId, "Requirement graph project ID");
    const revision = requirePositiveInteger(input.revision, "Requirement graph revision");
    const objective = requireText(input.objective, "Requirement graph objective", MAX_OBJECTIVE_OR_CRITERION);
    const selectorVocabularyDigest = requireDigest(input.selectorVocabularyDigest, "Requirement graph selector vocabulary digest");
    if (!EVIDENCE_LANES.has(input.evidenceLane)) {
        throw new Error("Requirement graph evidence lane is invalid");
    }
    const facts = normalizeFacts(input.facts);
    const nodes = normalizeNodes(input.nodes);
    const constraints = normalizeConstraints(input.constraints);
    const approvalIntents = normalizeApprovalIntents(input.approvalIntents, nodes, constraints);
    const normalized = {
        tenantId,
        projectId,
        revision,
        objective,
        selectorVocabularyDigest,
        evidenceLane: input.evidenceLane,
        facts,
        nodes,
        constraints,
        approvalIntents,
    };
    if (context)
        validateContext(normalized, context);
    return normalized;
}
function scopePayload(graph) {
    return {
        selectorVocabularyDigest: graph.selectorVocabularyDigest,
        evidenceLane: graph.evidenceLane,
        facts: graph.facts,
        nodes: graph.nodes
            .map(({ kind, priority, capabilitySelector, requiredRuleIds }) => ({
            kind,
            priority,
            ...(capabilitySelector ? { capabilitySelector } : {}),
            requiredRuleIds,
        }))
            .sort((left, right) => compareCodePoints(canonicalStringify(left), canonicalStringify(right))),
    };
}
export function finalizeRequirementGraph(input, context) {
    const normalized = normalizeGraphDraft(input, context);
    const requirementScopeDigest = digestCanonical(scopePayload(normalized), "requirement-scope-v1");
    const payload = {
        schemaVersion: "1",
        ...normalized,
        requirementScopeDigest,
    };
    return {
        ...payload,
        requirementGraphDigest: digestCanonical(payload, "requirement-graph-v1"),
    };
}
export function assertRequirementGraphIntegrity(graph, context) {
    assertSafeDataTree(graph, "Requirement graph record");
    assertClosedObject(graph, GRAPH_FIELDS, "Requirement graph record");
    if (graph.schemaVersion !== "1") {
        throw new Error("Requirement graph schema version is invalid");
    }
    requireDigest(graph.requirementScopeDigest, "Requirement scope digest");
    requireDigest(graph.requirementGraphDigest, "Requirement graph digest");
    const normalized = finalizeRequirementGraph({
        tenantId: graph.tenantId,
        projectId: graph.projectId,
        revision: graph.revision,
        objective: graph.objective,
        selectorVocabularyDigest: graph.selectorVocabularyDigest,
        evidenceLane: graph.evidenceLane,
        facts: graph.facts,
        nodes: graph.nodes,
        constraints: graph.constraints,
        approvalIntents: graph.approvalIntents,
    }, context);
    if (canonicalStringify(normalized) !== canonicalStringify(graph)) {
        throw new Error("Requirement graph digest or canonical integrity mismatch");
    }
}
function normalizeTimestamp(value, label) {
    if (typeof value !== "string") {
        throw new Error(`${label} must be an RFC 3339 date-time`);
    }
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
    if (!match)
        throw new Error(`${label} must be an RFC 3339 date-time`);
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4]);
    const minute = Number(match[5]);
    const second = Number(match[6]);
    const offsetHour = match[8] === "Z" ? 0 : Number(match[10]);
    const offsetMinute = match[8] === "Z" ? 0 : Number(match[11]);
    const daysInMonth = month >= 1 && month <= 12
        ? new Date(Date.UTC(year, month, 0)).getUTCDate()
        : 0;
    if (month < 1 ||
        month > 12 ||
        day < 1 ||
        day > daysInMonth ||
        hour > 23 ||
        minute > 59 ||
        second > 59 ||
        offsetHour > 23 ||
        offsetMinute > 59) {
        throw new Error(`${label} must be a valid RFC 3339 date-time`);
    }
    const instant = new Date(value);
    if (!Number.isFinite(instant.valueOf())) {
        throw new Error(`${label} must be a valid date-time`);
    }
    return instant.toISOString();
}
function normalizeAuthorizationDraft(input) {
    assertSafeDataTree(input, "Requirement graph authorization");
    assertClosedObject(input, AUTHORIZATION_DRAFT_FIELDS, "Requirement graph authorization draft");
    const authorizedAt = normalizeTimestamp(input.authorizedAt, "Requirement graph authorization authorizedAt");
    const expiresAt = input.expiresAt === undefined
        ? undefined
        : normalizeTimestamp(input.expiresAt, "Requirement graph authorization expiresAt");
    if (expiresAt !== undefined &&
        new Date(expiresAt).valueOf() <= new Date(authorizedAt).valueOf()) {
        throw new Error("Requirement graph authorization expiry must be after authorization");
    }
    return {
        tenantId: requireIdentifier(input.tenantId, "Authorization tenant ID"),
        projectId: requireIdentifier(input.projectId, "Authorization project ID"),
        requirementGraphDigest: requireDigest(input.requirementGraphDigest, "Authorization requirement graph digest"),
        authorizerAuthorityId: requireIdentifier(input.authorizerAuthorityId, "Authorization authority ID"),
        authorizedAt,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        authorityReceiptRef: requireDigest(input.authorityReceiptRef, "Authorization authority receipt reference"),
    };
}
export function finalizeRequirementGraphAuthorization(input) {
    const normalized = normalizeAuthorizationDraft(input);
    const payload = { schemaVersion: "1", ...normalized };
    return {
        ...payload,
        authorizationDigest: digestCanonical(payload, "requirement-graph-authorization-v1"),
    };
}
function assertAuthorizationRecordIntegrity(authorization) {
    assertSafeDataTree(authorization, "Requirement graph authorization record");
    assertClosedObject(authorization, AUTHORIZATION_FIELDS, "Requirement graph authorization record");
    if (authorization.schemaVersion !== "1") {
        throw new Error("Requirement graph authorization schema version is invalid");
    }
    requireDigest(authorization.authorizationDigest, "Requirement graph authorization digest");
    const normalized = finalizeRequirementGraphAuthorization({
        tenantId: authorization.tenantId,
        projectId: authorization.projectId,
        requirementGraphDigest: authorization.requirementGraphDigest,
        authorizerAuthorityId: authorization.authorizerAuthorityId,
        authorizedAt: authorization.authorizedAt,
        ...(authorization.expiresAt !== undefined
            ? { expiresAt: authorization.expiresAt }
            : {}),
        authorityReceiptRef: authorization.authorityReceiptRef,
    });
    if (canonicalStringify(normalized) !== canonicalStringify(authorization)) {
        throw new Error("Requirement graph authorization digest or integrity mismatch");
    }
    return normalized;
}
export function assertRequirementGraphAuthorizationIntegrity(authorization, graph, verification) {
    const normalized = assertAuthorizationRecordIntegrity(authorization);
    assertRequirementGraphIntegrity(graph);
    if (normalized.tenantId !== graph.tenantId) {
        throw new Error("Authorization tenant does not match the requirement graph");
    }
    if (normalized.projectId !== graph.projectId) {
        throw new Error("Authorization project does not match the requirement graph");
    }
    if (normalized.requirementGraphDigest !== graph.requirementGraphDigest) {
        throw new Error("Authorization graph digest binding does not match");
    }
    if (!verification || typeof verification !== "object") {
        throw new Error("Authorization verification context is required");
    }
    if (typeof verification.verifyAuthorityReceipt !== "function") {
        throw new Error("Authority receipt verifier is required");
    }
    const evaluatedAt = normalizeTimestamp(verification.evaluatedAt, "Authorization evaluatedAt");
    const evaluatedAtMs = new Date(evaluatedAt).valueOf();
    if (evaluatedAtMs < new Date(normalized.authorizedAt).valueOf()) {
        throw new Error("Requirement graph is not yet authorized at evaluatedAt");
    }
    if (normalized.expiresAt !== undefined &&
        evaluatedAtMs >= new Date(normalized.expiresAt).valueOf()) {
        throw new Error("Requirement graph authorization has expired");
    }
    if (!verification.verifyAuthorityReceipt(normalized)) {
        throw new Error("Requirement graph authority receipt verification failed");
    }
}
