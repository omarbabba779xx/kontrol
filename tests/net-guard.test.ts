import assert from "node:assert/strict";
import { test } from "node:test";

test("SSRF guard blocks non-HTTPS, credentials and private targets", async () => {
  const { assertPublicHttpsUrl, isPrivateAddress } = await import("../src/lib/core/net-guard");
  for (const bad of ["http://example.com", "https://user:pw@example.com", "https://localhost/x", "https://127.0.0.1/", "https://10.1.2.3/", "https://169.254.169.254/latest/meta-data", "https://192.168.0.5/", "https://[::1]/", "https://db.internal/", "https://[fd00::1]/"]) {
    assert.throws(() => assertPublicHttpsUrl(bad), /./, bad);
  }
  assert.doesNotThrow(() => assertPublicHttpsUrl("https://eur-lex.europa.eu/eli/reg/2024/1689/oj"));
  assert.equal(isPrivateAddress("172.20.0.1"), true);
  assert.equal(isPrivateAddress("8.8.8.8"), false);
  assert.equal(isPrivateAddress("::ffff:10.0.0.1"), true);
});

test("special-purpose ranges are private in every spelling, and public addresses stay public", async () => {
  const { isPrivateAddress, assertPublicHttpsUrl } = await import("../src/lib/core/net-guard");
  const blocked = [
    "198.18.0.1", "198.19.255.254", "192.0.0.8", "192.0.2.10", "198.51.100.7", "203.0.113.9", "192.88.99.1", "255.255.255.255", "224.0.0.1",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:a00:1", "0:0:0:0:0:ffff:c0a8:101", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b::192.168.1.1",
    "64:ff9b:1::1", "2002:7f00:1::", "2002:a9fe:a9fe::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "100::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "::127.0.0.1", "not-an-ip",
  ];
  for (const address of blocked) assert.equal(isPrivateAddress(address), true, `${address} must be refused`);
  for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "198.20.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8", "64:ff9b::808:808", "2002:808:808::1"]) assert.equal(isPrivateAddress(address), false, `${address} is public`);
  for (const bad of ["https://[::ffff:7f00:1]/", "https://[64:ff9b::7f00:1]/", "https://198.18.0.1/", "https://2130706433/", "https://0x7f.1/", "https://[::1]/", "https://printer.home.arpa/"]) assert.throws(() => assertPublicHttpsUrl(bad), /./, bad);
});

test("the address checked is the address connected to: a host that resolves into private space is refused at connect time", async () => {
  const { publicOnlyLookup, safeFetch } = await import("../src/lib/core/net-guard");
  const outcome = await new Promise<{ error: Error | null; address?: unknown }>((resolve) => publicOnlyLookup("localhost", {}, (error, address) => resolve({ error, address })));
  assert.match(outcome.error?.message ?? "", /private network address/);
  await assert.rejects(safeFetch("http://example.com/"), /Only HTTPS/);
  await assert.rejects(safeFetch("https://127.0.0.1:1/"), /Private network/);
  await assert.rejects(safeFetch("https://user:pw@example.com/"), /credentials/);
});
