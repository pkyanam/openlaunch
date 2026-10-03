import test from "node:test";
import assert from "node:assert/strict";
import { isExpired } from "../packages/protocol/src/index.ts";
import { permits } from "../packages/authorization/src/index.ts";
const grant = {
  subject: "user-a",
  deviceId: "device-a",
  capability: "display.show",
  expiresAt: 100,
  revoked: false,
};
test("grant applies only to its principal/device/capability", () => {
  assert.equal(permits(grant, "user-a", "device-a", "display.show", 99), true);
  for (const args of [
    ["user-b", "device-a", "display.show"],
    ["user-a", "device-b", "display.show"],
    ["user-a", "device-a", "sensor.read"],
  ])
    assert.equal(permits(grant, ...args, 99), false);
});
test("expired/revoked grants fail closed", () => {
  assert.equal(
    permits(grant, "user-a", "device-a", "display.show", 100),
    false,
  );
  assert.equal(
    permits(
      { ...grant, revoked: true },
      "user-a",
      "device-a",
      "display.show",
      1,
    ),
    false,
  );
});
test("command expiry includes boundary", () => {
  assert.equal(isExpired({ expiresAt: 100 }, 100), true);
  assert.equal(isExpired({ expiresAt: 100 }, 99), false);
});
