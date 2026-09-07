// Core-owned engine primitive.
import { createHash } from "node:crypto";
function canonicalize(value, seen) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return value;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value)) {
            throw new TypeError("Canonical JSON cannot contain non-finite numbers");
        }
        return Object.is(value, -0) ? 0 : value;
    }
    if (Array.isArray(value)) {
        if (seen.has(value)) {
            throw new TypeError("Canonical JSON cannot contain cycles");
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
            throw new TypeError("Canonical JSON cannot contain symbol keys");
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        for (const [key, descriptor] of Object.entries(descriptors)) {
            if (key === "length") {
                if (!("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) {
                    throw new TypeError("Canonical JSON requires an intrinsic array length");
                }
                continue;
            }
            const index = Number(key);
            if (!Number.isSafeInteger(index) ||
                index < 0 ||
                String(index) !== key ||
                index >= value.length ||
                !descriptor.enumerable ||
                !("value" in descriptor) ||
                descriptor.get !== undefined ||
                descriptor.set !== undefined) {
                throw new TypeError(`Canonical JSON requires enumerable data properties at ${key}`);
            }
        }
        seen.add(value);
        const result = [];
        for (let index = 0; index < value.length; index += 1) {
            const descriptor = descriptors[String(index)];
            if (!descriptor || !("value" in descriptor)) {
                throw new TypeError(`Canonical JSON cannot contain sparse arrays at ${index}`);
            }
            result.push(canonicalize(descriptor.value, seen));
        }
        seen.delete(value);
        return result;
    }
    if (typeof value === "object") {
        if (seen.has(value)) {
            throw new TypeError("Canonical JSON cannot contain cycles");
        }
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) {
            throw new TypeError("Canonical JSON accepts only plain objects");
        }
        seen.add(value);
        if (Object.getOwnPropertySymbols(value).length > 0) {
            throw new TypeError("Canonical JSON cannot contain symbol keys");
        }
        const descriptors = Object.getOwnPropertyDescriptors(value);
        const result = Object.create(null);
        for (const key of Object.keys(descriptors).sort()) {
            const descriptor = descriptors[key];
            if (!descriptor.enumerable ||
                !("value" in descriptor) ||
                descriptor.get !== undefined ||
                descriptor.set !== undefined) {
                throw new TypeError(`Canonical JSON requires enumerable data properties at ${key}`);
            }
            const entry = descriptor.value;
            if (entry === undefined) {
                throw new TypeError(`Canonical JSON cannot contain undefined at ${key}`);
            }
            result[key] = canonicalize(entry, seen);
        }
        seen.delete(value);
        return result;
    }
    throw new TypeError(`Canonical JSON cannot contain ${typeof value}`);
}
export function canonicalStringify(value) {
    return JSON.stringify(canonicalize(value, new WeakSet()));
}
export function sha256Digest(value, domain = "content") {
    const hash = createHash("sha256");
    hash.update(`eoduksini-engine:${domain}\0`, "utf8");
    hash.update(value);
    return `sha256:${hash.digest("hex")}`;
}
export function digestCanonical(value, domain) {
    return sha256Digest(canonicalStringify(value), domain);
}
