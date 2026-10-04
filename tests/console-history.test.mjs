import test from "node:test";
import assert from "node:assert/strict";
import { Hub, emptyState } from "../packages/core/src/index.ts";
import { handle } from "../packages/http/src/index.ts";
const owner = { id: "owner", owner: true };
const agent = { id: "agent", owner: false };
test("portal history and saved grants are owner-only and retain truthful expiry states", async () => {
  let now = 1700000000000;
  const hub = new Hub(emptyState(), () => now);
  const enrollment = await hub.enrollment(owner, "custom.device");
  const { deviceId } = await hub.enroll(enrollment.token, {
    name: "fixture",
    kind: "custom.device",
    capabilities: ["device.health"],
  });
  hub.grant(owner, agent.id, deviceId, ["device.health"], 60);
  const queued = hub.request(owner, deviceId, "device.health", {}, "queued", 1);
  now += 1;
  const received = hub.request(
    owner,
    deviceId,
    "device.health",
    {},
    "received",
    1,
  );
  assert.equal(hub.next(deviceId).id, queued.id);
  // First action was delivered; the second remains queued.
  now += 1001;
  const response = await handle(
    new Request("https://bridge.test/v1/actions"),
    hub,
    async () => owner,
  );
  assert.equal(response.status, 200);
  const history = (await response.json()).data;
  assert.deepEqual(
    history.map((a) => a.id),
    [received.id, queued.id],
  );
  assert.equal(history[0].status, "expired");
  assert.equal(history[1].status, "unknown");
  assert(history.every((a) => !("clientKey" in a)));
  const grants = await handle(
    new Request("https://bridge.test/v1/grants"),
    hub,
    async () => owner,
  );
  assert.deepEqual((await grants.json()).data[0].capabilities, [
    "device.health",
  ]);
  for (const route of ["actions", "grants"]) {
    const denied = await handle(
      new Request("https://bridge.test/v1/" + route),
      hub,
      async () => agent,
    );
    assert.equal(denied.status, 403);
  }
  now += 60000;
  assert.deepEqual(hub.grants(owner), []);
});
