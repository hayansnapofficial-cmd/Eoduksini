// Core-owned engine primitive.
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
export class NetworkPolicyError extends Error {
    code = "network-policy";
    constructor(message = "Network destination rejected by policy") {
        super(message);
        this.name = "NetworkPolicyError";
    }
}
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
function reject() {
    throw new NetworkPolicyError();
}
function normalizeHostname(value) {
    if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
        return reject();
    }
    if (/[/\\@:#*\[\]\u0000-\u0020\u007f]/u.test(value)) {
        return reject();
    }
    const hostname = domainToASCII(value).toLowerCase();
    if (hostname.length === 0
        || hostname.length > 253
        || hostname.startsWith(".")
        || hostname.endsWith(".")
        || isIP(hostname) !== 0) {
        return reject();
    }
    const labels = hostname.split(".");
    if (labels.length < 2 || labels.some((label) => !DNS_LABEL.test(label))) {
        return reject();
    }
    return hostname;
}
function hasForbiddenEmptyUrlSyntax(rawUrl) {
    if (rawUrl.includes("#")) {
        return true;
    }
    const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/iu.exec(rawUrl)?.[1];
    return authority?.includes("@") === true;
}
export function validateAllowedHttpsUrl(rawUrl, allowedHosts) {
    if (typeof rawUrl !== "string"
        || rawUrl.length === 0
        || rawUrl !== rawUrl.trim()
        || /[\\\u0000-\u001f\u007f]/u.test(rawUrl)
        || hasForbiddenEmptyUrlSyntax(rawUrl)
        || !Array.isArray(allowedHosts)
        || allowedHosts.length === 0) {
        return reject();
    }
    let url;
    try {
        url = new URL(rawUrl);
    }
    catch {
        return reject();
    }
    if (url.protocol !== "https:"
        || url.username !== ""
        || url.password !== ""
        || url.hash !== ""
        || (url.port !== "" && url.port !== "443")
        || isIP(url.hostname.replace(/^\[|\]$/gu, "")) !== 0) {
        return reject();
    }
    const hostname = normalizeHostname(url.hostname);
    const normalizedAllowedHosts = new Set(allowedHosts.map(normalizeHostname));
    if (!normalizedAllowedHosts.has(hostname)) {
        return reject();
    }
    return Object.freeze({ url, hostname });
}
function parseIpv4(address) {
    const parts = address.split(".");
    if (parts.length !== 4) {
        return undefined;
    }
    let value = 0;
    for (const part of parts) {
        if (!/^(?:0|[1-9][0-9]{0,2})$/u.test(part)) {
            return undefined;
        }
        const octet = Number(part);
        if (octet > 255) {
            return undefined;
        }
        value = (value * 256) + octet;
    }
    return value;
}
function ipv4InCidr(value, base, prefixLength) {
    const blockSize = 2 ** (32 - prefixLength);
    return Math.floor(value / blockSize) === Math.floor(base / blockSize);
}
const blockedIpv4Cidrs = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
];
const metadataIpv4 = new Set([
    "100.100.100.200",
    "168.63.129.16",
    "169.254.169.253",
    "169.254.169.254",
    "169.254.170.2",
    "169.254.170.23",
]);
function isPublicIpv4(address) {
    const value = parseIpv4(address);
    if (value === undefined || metadataIpv4.has(address)) {
        return false;
    }
    return !blockedIpv4Cidrs.some(([base, prefixLength]) => {
        const baseValue = parseIpv4(base);
        return baseValue !== undefined && ipv4InCidr(value, baseValue, prefixLength);
    });
}
function parseIpv6(address) {
    if (address.includes("%") || address.indexOf("::") !== address.lastIndexOf("::")) {
        return undefined;
    }
    let normalized = address.toLowerCase();
    if (normalized.includes(".")) {
        const lastColon = normalized.lastIndexOf(":");
        if (lastColon < 0) {
            return undefined;
        }
        const ipv4 = parseIpv4(normalized.slice(lastColon + 1));
        if (ipv4 === undefined) {
            return undefined;
        }
        normalized = `${normalized.slice(0, lastColon)}:${(ipv4 >>> 16).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
    }
    const compressed = normalized.includes("::");
    const [leftText, rightText = ""] = normalized.split("::");
    const left = leftText === "" ? [] : leftText.split(":");
    const right = rightText === "" ? [] : rightText.split(":");
    if (left.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))
        || right.some((part) => !/^[0-9a-f]{1,4}$/u.test(part))
        || (!compressed && left.length !== 8)
        || (compressed && left.length + right.length >= 8)) {
        return undefined;
    }
    const groups = compressed
        ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right]
        : left;
    if (groups.length !== 8) {
        return undefined;
    }
    let value = 0n;
    for (const group of groups) {
        value = (value << 16n) | BigInt(`0x${group}`);
    }
    return value;
}
function ipv6InCidr(value, base, prefixLength) {
    const baseValue = parseIpv6(base);
    if (baseValue === undefined) {
        throw new Error("Invalid internal IPv6 CIDR");
    }
    const shift = BigInt(128 - prefixLength);
    return (value >> shift) === (baseValue >> shift);
}
const blockedGlobalIpv6Cidrs = [
    ["2001::", 23],
    ["2001:0000::", 32],
    ["2001:0002::", 48],
    ["2001:0010::", 28],
    ["2001:0020::", 28],
    ["2001:0db8::", 32],
    ["2002::", 16],
    ["3fff::", 20],
];
function isPublicIpv6(address) {
    const value = parseIpv6(address);
    if (value === undefined) {
        return false;
    }
    if (ipv6InCidr(value, "::ffff:0:0", 96)) {
        const ipv4 = Number(value & 0xffffffffn);
        const dotted = [24, 16, 8, 0]
            .map((shift) => String((ipv4 >>> shift) & 0xff))
            .join(".");
        return isPublicIpv4(dotted);
    }
    if (!ipv6InCidr(value, "2000::", 3)) {
        return false;
    }
    return !blockedGlobalIpv6Cidrs.some(([base, prefixLength]) => ipv6InCidr(value, base, prefixLength));
}
function isPublicAddress(address, family) {
    if (isIP(address) !== family) {
        return false;
    }
    return family === 4 ? isPublicIpv4(address) : isPublicIpv6(address);
}
export function selectPublicAddress(answers) {
    if (!Array.isArray(answers) || answers.length === 0) {
        return reject();
    }
    const checked = [];
    for (const answer of answers) {
        if (typeof answer !== "object"
            || answer === null
            || typeof answer.address !== "string"
            || (answer.family !== 4 && answer.family !== 6)
            || !isPublicAddress(answer.address, answer.family)) {
            return reject();
        }
        checked.push({ address: answer.address, family: answer.family });
    }
    return Object.freeze(checked[0]);
}
