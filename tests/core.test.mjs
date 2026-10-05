import test from "node:test";
import assert from "node:assert/strict";
import { Hub, emptyState } from "../packages/core/src/index.ts";
const owner = { id: "owner", owner: true },
  agent = { id: "agent", owner: false };
async function fixture() {
  let time = 1000;
  const h = new Hub(emptyState(), () => time);
  const e = await h.enrollment(owner, "raspberry-pi-4");
  const d = await h.enroll(e.token, {
    name: "test",
    kind: "raspberry-pi-4",
    capabilities: ["device.health", "led.set"],
  });
  return {
    h,
    d,
    setTime: (v) => {
      time = v;
    },
  };
}
test("enrollment single use and wrong board rejected", async () => {
  const h = new Hub();
  const e = await h.enrollment(owner, "raspberry-pi-4");
  await assert.rejects(
    h.enroll(e.token, {
      name: "x",
      kind: "uno-r4-wifi",
      capabilities: ["led.set"],
    }),
  );
  await h.enroll(e.token, {
    name: "x",
    kind: "raspberry-pi-4",
    capabilities: ["led.set"],
  });
  await assert.rejects(
    h.enroll(e.token, {
      name: "x",
      kind: "raspberry-pi-4",
      capabilities: ["led.set"],
    }),
  );
});
test("agent cannot create its own grant or enrollment", async () => {
  const { h, d } = await fixture();
  assert.throws(() => h.grant(agent, "agent", d.deviceId, ["led.set"]));
  await assert.rejects(h.enrollment(agent, "raspberry-pi-4"));
  assert.throws(() =>
    h.request(agent, d.deviceId, "led.set", { on: true }, "x"),
  );
});
test("permission, idempotency and acknowledgement lifecycle", async () => {
  const { h, d } = await fixture();
  h.grant(owner, "agent", d.deviceId, ["led.set"]);
  const a = h.request(agent, d.deviceId, "led.set", { on: true }, "key");
  assert.equal(a.status, "queued");
  assert.equal(
    h.request(agent, d.deviceId, "led.set", { on: true }, "key").id,
    a.id,
  );
  assert.throws(() =>
    h.request(agent, d.deviceId, "led.set", { on: false }, "key"),
  );
  assert.equal(h.next(d.deviceId).id, a.id);
  assert.equal(h.next(d.deviceId), null);
  h.result(d.deviceId, a.id, "succeeded", { on: true });
  assert.equal(h.get(agent, a.id).status, "succeeded");
});
test("until-revoked grant authorizes transport after time advances and revocation still cancels", async () => {
  const { h, d, setTime } = await fixture();
  h.grant(owner, "agent", d.deviceId, ["led.set"], null);
  assert.deepEqual(
    h.grants(owner).map((g) => g.expiresAt),
    [null],
  );
  setTime(90 * 24 * 60 * 60 * 1000);
  h.state.devices[0].lastSeen = 90 * 24 * 60 * 60 * 1000;
  const queued = h.request(
    agent,
    d.deviceId,
    "led.set",
    { on: true },
    "long-lived",
  );
  assert.equal(h.next(d.deviceId).id, queued.id);
  h.revokeGrant(owner, "agent", d.deviceId);
  assert.throws(() =>
    h.request(agent, d.deviceId, "led.set", { on: false }, "revoked"),
  );
});
test("queued expiry differs from ambiguous dispatched expiry", async () => {
  const { h, d, setTime } = await fixture();
  const a = h.request(owner, d.deviceId, "led.set", { on: true }, "a", 1);
  setTime(2000);
  assert.equal(h.get(owner, a.id).status, "expired");
  h.next(d.deviceId);
  const b = h.request(owner, d.deviceId, "led.set", { on: true }, "b", 1);
  h.next(d.deviceId);
  setTime(3000);
  assert.equal(h.get(owner, b.id).status, "unknown");
  assert.throws(() => h.result(d.deviceId, b.id, "succeeded", {}));
});
test("a saved receipt can be reconciled after TTL without admitting a late new outcome", async () => {
  const { h, d, setTime } = await fixture();
  const action = h.request(
    owner,
    d.deviceId,
    "device.health",
    {},
    "saved-receipt",
    1,
  );
  h.next(d.deviceId);
  const result = {
    physicalVerified: false,
    nested: { value: 2 },
    accepted: true,
  };
  h.result(d.deviceId, action.id, "succeeded", result);
  setTime(5000);
  assert.equal(
    h.result(d.deviceId, action.id, "succeeded", {
      accepted: true,
      nested: { value: 2 },
      physicalVerified: false,
    }).status,
    "succeeded",
  );
  assert.throws(() => h.result(d.deviceId, action.id, "failed", result));
  assert.throws(() =>
    h.result(d.deviceId, action.id, "succeeded", {
      ...result,
      accepted: false,
    }),
  );
  const unreported = h.request(
    owner,
    d.deviceId,
    "device.health",
    {},
    "unreported",
    1,
  );
  h.next(d.deviceId);
  setTime(10000);
  assert.throws(() => h.result(d.deviceId, unreported.id, "succeeded", result));
  assert.equal(h.get(owner, unreported.id).status, "unknown");
  h.revoke(owner, d.deviceId);
  assert.throws(() => h.result(d.deviceId, action.id, "succeeded", result));
});
test("revocation cancels queued commands and denies credentials", async () => {
  const { h, d } = await fixture();
  h.grant(owner, "agent", d.deviceId, ["led.set"]);
  const a = h.request(agent, d.deviceId, "led.set", { on: true }, "a");
  h.revokeGrant(owner, "agent", d.deviceId);
  assert.equal(a.status, "cancelled");
  await h.authenticateDevice(d.deviceId, d.token);
  h.revoke(owner, d.deviceId);
  await assert.rejects(h.authenticateDevice(d.deviceId, d.token));
});
test("read-only OAuth principal cannot write with a stored grant", async () => {
  const { h, d } = await fixture();
  h.grant(owner, "agent", d.deviceId, ["led.set"]);
  assert.throws(() =>
    h.request(
      { ...agent, readOnly: true },
      d.deviceId,
      "led.set",
      { on: true },
      "x",
    ),
  );
});
test("strict arguments and unsupported capabilities rejected", async () => {
  const { h, d } = await fixture();
  assert.throws(() =>
    h.request(owner, d.deviceId, "led.set", { on: true, pin: 22 }, "x"),
  );
  assert.throws(() =>
    h.request(owner, d.deviceId, "display.text", { text: "x" }, "y"),
  );
});
test("restart preserves undelivered versus received distinction", async () => {
  const { h, d } = await fixture();
  const a = h.request(owner, d.deviceId, "led.set", { on: true }, "x");
  h.next(d.deviceId);
  const reloaded = new Hub(JSON.parse(JSON.stringify(h.state)), () => 1100);
  assert.equal(reloaded.next(d.deviceId), null);
  assert.equal(reloaded.get(owner, a.id).status, "received");
});
