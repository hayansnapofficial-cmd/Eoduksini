// Engine primitive regression test.
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStringify, digestCanonical } from "../../../packages/engine-primitives/canonical.mjs";
import { assertRequirementGraphAuthorizationIntegrity, assertRequirementGraphIntegrity, compareCodePoints, finalizeRequirementGraph, finalizeRequirementGraphAuthorization, } from "../../../packages/engine-primitives/requirement-graph.mjs";
const vocabularyDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const receiptRef = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
function draft() {
    return {
        tenantId: "tenant-a",
        projectId: "reservation-site",
        revision: 1,
        objective: "Build a reservation website.",
        selectorVocabularyDigest: vocabularyDigest,
        evidenceLane: "operational",
        facts: [
            { key: "surface.kind", value: "web" },
            { key: "data.transactional", value: true },
        ],
        nodes: [
            {
                id: "database",
                kind: "data",
                priority: "mandatory",
                dependsOn: ["objective"],
                capabilitySelector: {
                    classes: ["database.relational", "storage.transactional"],
                    interfaceKinds: ["library", "http"],
                    requiredProtocols: ["postgresql"],
                    requiredRuntimes: ["node"],
                },
                requiredRuleIds: ["data.integrity"],
                acceptanceCriteria: ["Concurrent reservations preserve integrity."],
            },
            {
                id: "objective",
                kind: "business",
                priority: "mandatory",
                dependsOn: [],
                requiredRuleIds: [],
                acceptanceCriteria: ["A customer can reserve an available slot."],
            },
        ],
        constraints: {
            allowedLicenses: ["MIT", "Apache-2.0"],
            deniedPermissions: ["secret-use"],
            maximumTotalCostMicros: 50_000_000,
            costCurrency: "USD",
            billingPeriod: "monthly",
            pricingMaxAgeDays: 30,
            requireKnownCost: true,
        },
        approvalIntents: [
            {
                id: "production-approval",
                target: { kind: "production", requirementNodeId: "database" },
                requiredBefore: "promotion",
                reason: "Production mutation needs an operator decision.",
            },
        ],
    };
}
function validationContext() {
    return {
        selectorVocabulary: {
            vocabularyDigest,
            classes: ["database.relational", "storage.transactional"],
            factKeys: ["data.transactional", "surface.kind"],
        },
        activeRuleIds: ["data.integrity"],
        ruleAppliesToRequirement: (ruleId, node) => ruleId === "data.integrity" && node.id === "database",
    };
}
function finalize(input = draft()) {
    return finalizeRequirementGraph(input, validationContext());
}
test("finalizer normalizes sets and uses code-point Kahn order", () => {
    const input = draft();
    input.nodes = [
        {
            id: "𐀀",
            kind: "functional",
            priority: "mandatory",
            dependsOn: [],
            capabilitySelector: {
                classes: ["storage.transactional", "database.relational"],
                interfaceKinds: ["library", "http"],
                requiredProtocols: ["postgresql"],
                requiredRuntimes: ["node"],
            },
            requiredRuleIds: [],
            acceptanceCriteria: ["second by code point"],
        },
        {
            id: "",
            kind: "functional",
            priority: "preferred",
            dependsOn: [],
            requiredRuleIds: [],
            acceptanceCriteria: ["first by code point"],
        },
    ];
    input.approvalIntents = [];
    input.facts.reverse();
    input.constraints.allowedLicenses.reverse();
    const graph = finalizeRequirementGraph(input, {
        ...validationContext(),
        activeRuleIds: [],
    });
    assert.equal(compareCodePoints("", "𐀀"), -1);
    assert.deepEqual(graph.nodes.map((node) => node.id), ["", "𐀀"]);
    assert.deepEqual(graph.facts.map((fact) => fact.key), [
        "data.transactional",
        "surface.kind",
    ]);
    assert.deepEqual(graph.constraints.allowedLicenses, ["Apache-2.0", "MIT"]);
    assert.deepEqual(graph.nodes[1].capabilitySelector, {
        classes: ["database.relational", "storage.transactional"],
        interfaceKinds: ["http", "library"],
        requiredProtocols: ["postgresql"],
        requiredRuntimes: ["node"],
    });
});
test("scope identity excludes prose, project, approval, and price while graph identity does not", () => {
    const first = finalize();
    const changed = draft();
    changed.projectId = "another-project";
    changed.objective = "Different prose objective.";
    changed.nodes[0].acceptanceCriteria = ["Different acceptance prose."];
    changed.constraints.maximumTotalCostMicros = 25_000_000;
    changed.approvalIntents[0].reason = "Different approval prose.";
    const second = finalize(changed);
    assert.equal(first.requirementScopeDigest, second.requirementScopeDigest);
    assert.notEqual(first.requirementGraphDigest, second.requirementGraphDigest);
});
test("scope digest is computed from the exact normalized semantic payload", () => {
    const graph = finalize();
    const scopeNodes = graph.nodes
        .map(({ kind, priority, capabilitySelector, requiredRuleIds }) => ({
        kind,
        priority,
        ...(capabilitySelector ? { capabilitySelector } : {}),
        requiredRuleIds,
    }))
        .sort((left, right) => compareCodePoints(canonicalStringify(left), canonicalStringify(right)));
    assert.equal(graph.requirementScopeDigest, digestCanonical({
        selectorVocabularyDigest: graph.selectorVocabularyDigest,
        evidenceLane: graph.evidenceLane,
        facts: graph.facts,
        nodes: scopeNodes,
    }, "requirement-scope-v1"));
});
test("integrity assertion rejects mutation instead of silently repairing it", () => {
    const graph = finalize();
    const mutated = structuredClone(graph);
    mutated.objective = "Caller changed the authorized objective.";
    assert.throws(() => assertRequirementGraphIntegrity(mutated, validationContext()), /digest|integrity|mutation/i);
});
test("graph validation rejects duplicate and missing edges and cycles", () => {
    const duplicate = draft();
    duplicate.nodes.push(structuredClone(duplicate.nodes[0]));
    assert.throws(() => finalizeRequirementGraph(duplicate), /duplicate.*node/i);
    const missing = draft();
    missing.nodes[0].dependsOn = ["missing"];
    assert.throws(() => finalizeRequirementGraph(missing), /missing|dependency/i);
    const cyclic = draft();
    cyclic.nodes[1].dependsOn = ["database"];
    assert.throws(() => finalizeRequirementGraph(cyclic), /cycle|cyclic/i);
});
test("broker-bound graph requires a mandatory capability selector", () => {
    const input = draft();
    delete input.nodes[0].capabilitySelector;
    assert.throws(() => finalizeRequirementGraph(input), /mandatory.*capability selector|selector.*mandatory/i);
});
test("context binding enforces exact vocabulary and active applicable rule assertions", () => {
    const unknownFact = draft();
    unknownFact.facts.push({ key: "caller.untrusted", value: true });
    assert.throws(() => finalizeRequirementGraph(unknownFact, validationContext()), /fact.*vocabulary|unknown.*fact/i);
    const unknownClass = draft();
    unknownClass.nodes[0].capabilitySelector.classes.push("database.magic");
    assert.throws(() => finalizeRequirementGraph(unknownClass, validationContext()), /class.*vocabulary|unknown.*class/i);
    const wrongDigest = draft();
    wrongDigest.selectorVocabularyDigest = receiptRef;
    assert.throws(() => finalizeRequirementGraph(wrongDigest, validationContext()), /vocabulary.*digest/i);
    assert.throws(() => finalizeRequirementGraph(draft(), {
        ...validationContext(),
        activeRuleIds: [],
    }), /active.*rule|rule.*active/i);
    assert.throws(() => finalizeRequirementGraph(draft(), {
        ...validationContext(),
        ruleAppliesToRequirement: () => false,
    }), /rule.*appl/i);
});
test("cost constraints use bounded exact units", () => {
    const missingCurrency = draft();
    delete missingCurrency.constraints.costCurrency;
    assert.throws(() => finalizeRequirementGraph(missingCurrency), /currency/i);
    for (const maximum of [-1, Number.MAX_SAFE_INTEGER + 1]) {
        const input = draft();
        input.constraints.maximumTotalCostMicros = maximum;
        assert.throws(() => finalizeRequirementGraph(input), /cost|safe integer|non-negative/i);
    }
    for (const age of [0, 3_651]) {
        const input = draft();
        input.constraints.pricingMaxAgeDays = age;
        assert.throws(() => finalizeRequirementGraph(input), /pricing|age|3650/i);
    }
});
test("approval intents bind to exact existing nodes and material targets", () => {
    const missingNode = draft();
    missingNode.approvalIntents[0].target = {
        kind: "production",
        requirementNodeId: "missing",
    };
    assert.throws(() => finalizeRequirementGraph(missingNode), /approval.*node|missing.*node/i);
    const invalidCost = draft();
    invalidCost.approvalIntents.push({
        id: "cost-approval",
        target: {
            kind: "cost",
            currency: "USD",
            billingPeriod: "monthly",
            thresholdMicros: -1,
        },
        requiredBefore: "planning",
        reason: "Cost threshold is material.",
    });
    assert.throws(() => finalizeRequirementGraph(invalidCost), /threshold|non-negative|safe integer/i);
    const invalidPermission = draft();
    invalidPermission.approvalIntents.push({
        id: "permission-approval",
        target: {
            kind: "permission",
            requirementNodeId: "database",
            effect: "root",
            selector: "*",
        },
        requiredBefore: "execution",
        reason: "Permission is material.",
    });
    assert.throws(() => finalizeRequirementGraph(invalidPermission), /permission.*effect|invalid.*effect/i);
});
test("closed validators reject undeclared, accessor, symbol, sparse, and prototype-shaped data", () => {
    const extra = { ...draft(), callerAuthority: true };
    assert.throws(() => finalizeRequirementGraph(extra), /unexpected|field|shape/i);
    const accessor = draft();
    Object.defineProperty(accessor, "objective", {
        enumerable: true,
        get: () => "must not be read",
    });
    assert.throws(() => finalizeRequirementGraph(accessor), /accessor|data propert/i);
    const symbol = draft();
    Object.defineProperty(symbol, Symbol("authority"), {
        enumerable: true,
        value: true,
    });
    assert.throws(() => finalizeRequirementGraph(symbol), /symbol/i);
    const sparse = draft();
    sparse.facts = new Array(1);
    assert.throws(() => finalizeRequirementGraph(sparse), /sparse/i);
    const prototypeKey = draft();
    Object.defineProperty(prototypeKey, "__proto__", {
        enumerable: true,
        configurable: true,
        writable: true,
        value: { authority: true },
    });
    assert.throws(() => finalizeRequirementGraph(prototypeKey), /prototype|forbidden.*key/i);
});
test("numeric facts allow finite fractions but reject unsafe integer identity", () => {
    const fractional = draft();
    fractional.facts[1].value = 0.5;
    const graph = finalize(fractional);
    assert.equal(graph.facts.find(({ key }) => key === "data.transactional")?.value, 0.5);
    const unsafeInteger = draft();
    unsafeInteger.facts[1].value = Number.MAX_SAFE_INTEGER + 1;
    assert.throws(() => finalize(unsafeInteger), /integer.*safe|safe integer/i);
});
test("graph bounds reject oversized facts, nodes, dependencies, identifiers, and criteria", () => {
    const tooManyFacts = draft();
    tooManyFacts.facts = Array.from({ length: 257 }, (_, index) => ({
        key: `fact-${index}`,
        value: true,
    }));
    assert.throws(() => finalizeRequirementGraph(tooManyFacts), /fact.*256|bound|limit/i);
    const tooManyNodes = draft();
    tooManyNodes.nodes = Array.from({ length: 257 }, (_, index) => ({
        id: `node-${index}`,
        kind: "functional",
        priority: index === 0 ? "mandatory" : "optional",
        dependsOn: [],
        ...(index === 0
            ? {
                capabilitySelector: {
                    classes: [],
                    interfaceKinds: ["library"],
                    requiredProtocols: [],
                    requiredRuntimes: [],
                },
            }
            : {}),
        requiredRuleIds: [],
        acceptanceCriteria: ["bounded"],
    }));
    assert.throws(() => finalizeRequirementGraph(tooManyNodes), /node.*256|bound|limit/i);
    const tooManyDependencies = draft();
    tooManyDependencies.nodes[0].dependsOn = Array.from({ length: 33 }, (_, index) => `node-${index}`);
    assert.throws(() => finalizeRequirementGraph(tooManyDependencies), /dependenc.*32|bound|limit/i);
    const longId = draft();
    longId.nodes[0].id = "x".repeat(129);
    assert.throws(() => finalizeRequirementGraph(longId), /identifier|128|length/i);
    const longCriterion = draft();
    longCriterion.nodes[0].acceptanceCriteria = ["x".repeat(2_001)];
    assert.throws(() => finalizeRequirementGraph(longCriterion), /criterion|2000|length/i);
});
function authorization(graph) {
    return finalizeRequirementGraphAuthorization({
        tenantId: graph.tenantId,
        projectId: graph.projectId,
        requirementGraphDigest: graph.requirementGraphDigest,
        authorizerAuthorityId: "operator-authority",
        authorizedAt: "2026-09-02T00:00:00.000Z",
        expiresAt: "2026-09-03T00:00:00.000Z",
        authorityReceiptRef: receiptRef,
    });
}
test("authorization finalizer binds the exact graph and rejects mutation", () => {
    const graph = finalize();
    const record = authorization(graph);
    assert.doesNotThrow(() => assertRequirementGraphAuthorizationIntegrity(record, graph, {
        evaluatedAt: "2026-09-02T12:00:00.000Z",
        verifyAuthorityReceipt: () => true,
    }));
    const mutated = structuredClone(record);
    mutated.authorizerAuthorityId = "caller-replaced-authority";
    assert.throws(() => assertRequirementGraphAuthorizationIntegrity(mutated, graph, {
        evaluatedAt: "2026-09-02T12:00:00.000Z",
        verifyAuthorityReceipt: () => true,
    }), /authorization.*digest|integrity|mutation/i);
    const otherGraph = finalize({ ...draft(), projectId: "other-project" });
    assert.throws(() => assertRequirementGraphAuthorizationIntegrity(record, otherGraph, {
        evaluatedAt: "2026-09-02T12:00:00.000Z",
        verifyAuthorityReceipt: () => true,
    }), /project|graph.*digest|binding/i);
});
test("authorization verifier enforces receipt, not-before, and exclusive expiry", () => {
    const graph = finalize();
    const record = authorization(graph);
    assert.throws(() => assertRequirementGraphAuthorizationIntegrity(record, graph, {
        evaluatedAt: "2026-09-01T23:59:59.999Z",
        verifyAuthorityReceipt: () => true,
    }), /not.*authorized|before|authorizedAt/i);
    assert.throws(() => assertRequirementGraphAuthorizationIntegrity(record, graph, {
        evaluatedAt: "2026-09-03T00:00:00.000Z",
        verifyAuthorityReceipt: () => true,
    }), /expired|expiresAt/i);
    assert.throws(() => assertRequirementGraphAuthorizationIntegrity(record, graph, {
        evaluatedAt: "2026-09-02T12:00:00.000Z",
        verifyAuthorityReceipt: () => false,
    }), /receipt|authority/i);
});
test("authorization timestamps are canonical and expiry must follow authorization", () => {
    const graph = finalize();
    const normalized = finalizeRequirementGraphAuthorization({
        tenantId: graph.tenantId,
        projectId: graph.projectId,
        requirementGraphDigest: graph.requirementGraphDigest,
        authorizerAuthorityId: "operator-authority",
        authorizedAt: "2026-09-02T09:00:00+09:00",
        authorityReceiptRef: receiptRef,
    });
    assert.equal(normalized.authorizedAt, "2026-09-02T00:00:00.000Z");
    assert.throws(() => finalizeRequirementGraphAuthorization({
        tenantId: graph.tenantId,
        projectId: graph.projectId,
        requirementGraphDigest: graph.requirementGraphDigest,
        authorizerAuthorityId: "operator-authority",
        authorizedAt: "2026-09-02T00:00:00.000Z",
        expiresAt: "2026-09-02T00:00:00.000Z",
        authorityReceiptRef: receiptRef,
    }), /expiry|expiresAt|after/i);
    assert.throws(() => finalizeRequirementGraphAuthorization({
        tenantId: graph.tenantId,
        projectId: graph.projectId,
        requirementGraphDigest: graph.requirementGraphDigest,
        authorizerAuthorityId: "operator-authority",
        authorizedAt: "2026-02-30T00:00:00.000Z",
        authorityReceiptRef: receiptRef,
    }), /valid.*date-time|RFC 3339/i);
});
test("finalized graph is a detached snapshot and deterministic across input order", () => {
    const input = draft();
    const first = finalize(input);
    input.objective = "mutated after finalization";
    input.nodes[0].acceptanceCriteria[0] = "mutated";
    assert.equal(first.objective, "Build a reservation website.");
    const reordered = draft();
    reordered.nodes.reverse();
    reordered.facts.reverse();
    reordered.constraints.allowedLicenses.reverse();
    const second = finalize(reordered);
    assert.deepEqual(second, first);
});
