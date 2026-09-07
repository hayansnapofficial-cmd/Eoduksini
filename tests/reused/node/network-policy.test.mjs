// Engine primitive regression test.
import assert from "node:assert/strict";
import test from "node:test";
import { NetworkPolicyError, selectPublicAddress, validateAllowedHttpsUrl, } from "../../../packages/engine-primitives/network-policy.mjs";
const allowedHosts = ["api.example.test"];
test("accepts only the normalized exact HTTPS host on port 443", () => {
    const target = validateAllowedHttpsUrl("https://API.EXAMPLE.TEST:443/v1/items?cursor=opaque", allowedHosts);
    assert.equal(target.hostname, "api.example.test");
    assert.equal(target.url.protocol, "https:");
    assert.equal(target.url.port, "");
});
for (const [name, url] of [
    ["HTTP", "http://api.example.test/v1"],
    ["userinfo", "https://user:password@api.example.test/v1"],
    ["empty userinfo delimiter", "https://@api.example.test/v1"],
    ["fragment", "https://api.example.test/v1#secret"],
    ["empty fragment delimiter", "https://api.example.test/v1#"],
    ["non-443 port", "https://api.example.test:444/v1"],
    ["arbitrary host", "https://attacker.example.test/v1"],
    ["suffix confusion", "https://api.example.test.attacker.test/v1"],
    ["IPv4 literal", "https://127.0.0.1/v1"],
    ["IPv6 literal", "https://[::1]/v1"],
]) {
    test(`rejects ${name} before DNS or transport`, () => {
        assert.throws(() => validateAllowedHttpsUrl(url, allowedHosts), NetworkPolicyError);
    });
}
for (const host of [
    "*.example.test",
    ".example.test",
    "api.example.test.attacker.test/path",
    "127.0.0.1",
    "[::1]",
    "api.example.test:443",
]) {
    test(`rejects malformed or non-host allowlist entry ${host}`, () => {
        assert.throws(() => validateAllowedHttpsUrl("https://api.example.test/v1", [host]), NetworkPolicyError);
    });
}
for (const [name, address, family] of [
    ["IPv4 unspecified", "0.0.0.0", 4],
    ["IPv4 private 10/8", "10.1.2.3", 4],
    ["IPv4 private 172.16/12", "172.31.255.254", 4],
    ["IPv4 private 192.168/16", "192.168.1.1", 4],
    ["IPv4 CGNAT", "100.64.1.2", 4],
    ["IPv4 loopback", "127.0.0.1", 4],
    ["IPv4 link-local", "169.254.169.254", 4],
    ["IPv4 metadata service", "168.63.129.16", 4],
    ["IPv4 documentation", "192.0.2.10", 4],
    ["IPv4 benchmarking", "198.18.0.1", 4],
    ["IPv4 multicast", "224.0.0.1", 4],
    ["IPv4 reserved", "240.0.0.1", 4],
    ["IPv6 unspecified", "::", 6],
    ["IPv6 loopback", "::1", 6],
    ["IPv6 ULA", "fd00::1", 6],
    ["IPv6 link-local", "fe80::1", 6],
    ["IPv6 multicast", "ff02::1", 6],
    ["IPv6 documentation", "2001:db8::1", 6],
    ["IPv6 reserved IETF assignment", "2001:0100::1", 6],
    ["IPv4-mapped private IPv6", "::ffff:10.0.0.1", 6],
    ["IPv6 6to4", "2002:c000:0201::1", 6],
    ["IPv6 Teredo", "2001:0000:4136:e378::1", 6],
    ["IPv6 NAT64 well-known", "64:ff9b::808:808", 6],
    ["IPv6 NAT64 local-use", "64:ff9b:1::1", 6],
    ["IPv6 documentation 3fff", "3fff::1", 6],
]) {
    test(`rejects ${name} DNS answers`, () => {
        assert.throws(() => selectPublicAddress([{ address, family }]), NetworkPolicyError);
    });
}
test("accepts public-unicast IPv4 and IPv6 answer sets and selects an approved answer", () => {
    const ipv4 = selectPublicAddress([
        { address: "8.8.8.8", family: 4 },
        { address: "1.1.1.1", family: 4 },
    ]);
    const ipv6 = selectPublicAddress([
        { address: "2606:4700:4700::1111", family: 6 },
        { address: "2001:4860:4860::8888", family: 6 },
    ]);
    assert.deepEqual(ipv4, { address: "8.8.8.8", family: 4 });
    assert.deepEqual(ipv6, { address: "2606:4700:4700::1111", family: 6 });
});
test("rejects empty, malformed, family-mismatched, or mixed public/private DNS sets", () => {
    for (const answers of [
        [],
        [{ address: "not-an-ip", family: 4 }],
        [{ address: "8.8.8.8", family: 6 }],
        [
            { address: "8.8.8.8", family: 4 },
            { address: "10.0.0.1", family: 4 },
        ],
    ]) {
        assert.throws(() => selectPublicAddress(answers), NetworkPolicyError);
    }
});
