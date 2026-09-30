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
