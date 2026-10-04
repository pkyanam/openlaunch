import test from "node:test";
import assert from "node:assert/strict";
import { publicOrigin, requestOrigin } from "../apps/local/src/origin.ts";
test("public origin requires bare HTTPS; no credential URLs or forwarded-host trust", () => {
  for (const value of [
    "http://example.com",
    "https://u:p@example.com",
    "https://example.com/path",
    "https://example.com/?x=y",
  ])
    assert.throws(() => publicOrigin(value));
  assert.equal(
    publicOrigin("https://devices.example.com/"),
    "https://devices.example.com",
  );
  assert.equal(requestOrigin("attacker.example", 8788), undefined);
  assert.equal(requestOrigin("127.0.0.1:9999", 8788), undefined);
  assert.equal(requestOrigin("127.0.0.1:8788", 8788), "http://127.0.0.1:8788");
  assert.equal(
    requestOrigin("devices.example.com", 8788, "https://devices.example.com"),
    "https://devices.example.com",
  );
  assert.equal(
    requestOrigin("127.0.0.1:8788", 8788, "https://devices.example.com"),
    "https://devices.example.com",
  );
});
