// Engine primitive regression test.
import assert from "node:assert/strict";
import test from "node:test";
import { canonicalStringify } from "../../../packages/engine-primitives/canonical.mjs";
test("canonical JSON preserves prototype-shaped own data keys", () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":"data","prototype":"data"}');
    assert.equal(canonicalStringify(value), '{"__proto__":{"polluted":true},"constructor":"data","prototype":"data"}');
    assert.equal({}.polluted, undefined);
});
test("canonical JSON rejects accessor and sparse array inputs", () => {
    const accessor = Object.create(null);
    Object.defineProperty(accessor, "value", {
        enumerable: true,
        get: () => "must not be read",
    });
    assert.throws(() => canonicalStringify(accessor), /enumerable data properties/);
    assert.throws(() => canonicalStringify([, "value"]), /sparse arrays/);
});
