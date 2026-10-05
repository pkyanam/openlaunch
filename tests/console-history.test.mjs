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

test("owner export includes older receipts without altering duplicate protection", async () => {
  let now = 1700000000000;
  const hub = new Hub(emptyState(), () => now);
  const enrollment = await hub.enrollment(owner, "custom.device");
  const enrolled = await hub.enroll(enrollment.token, {
    name: "history fixture",
    kind: "custom.device",
    capabilities: ["device.health"],
  });
  for (let i = 0; i < 105; i++) {
    hub.request(
      owner,
      enrolled.deviceId,
      "device.health",
      {},
      `history-${i}`,
      60,
    );
    now++;
  }
  assert.equal(hub.history(owner).length, 100);
  const originalIds = hub.state.actions.map((a) => a.id);
  const response = await handle(
    new Request("https://bridge.test/v1/actions/export"),
    hub,
    async () => owner,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const exported = (await response.json()).data;
  assert.equal(exported.format, "openlaunch.actions.v1");
  assert.equal(exported.exportedAt, now);
  assert.equal(exported.actions.length, 105);
  assert.equal(exported.actions.at(-1).id, originalIds[0]);
  assert(
    exported.actions.every((a) => !("clientKey" in a) && !("fingerprint" in a)),
  );
  assert(!JSON.stringify(exported).includes(enrolled.token));
  assert.deepEqual(
    hub.state.actions.map((a) => a.id),
    originalIds,
  );
  assert.equal(
    hub.request(owner, enrolled.deviceId, "device.health", {}, "history-0", 60)
      .id,
    originalIds[0],
  );
  const denied = await handle(
    new Request("https://bridge.test/v1/actions/export"),
    hub,
    async () => agent,
  );
  assert.equal(denied.status, 403);
  const workspace = "a".repeat(64);
  const connection = await hub.createConnection(
    owner,
    workspace,
    "history reader",
    60,
    "read",
  );
  hub.grant(
    owner,
    connection.principal,
    enrolled.deviceId,
    ["device.health"],
    60,
  );
  const sdkDenied = await handle(
    new Request("https://bridge.test/v1/actions/export", {
      headers: { authorization: `Bearer ${connection.token}` },
    }),
    hub,
    async () => {
      throw Error("SDK token must not use owner resolver");
    },
    { workspace },
  );
  assert.equal(sdkDenied.status, 403);
});

test("downloading at the retention limit does not permit duplicate or new actions", async () => {
  const hub = new Hub(emptyState(), () => 1700000000000);
  const enrollment = await hub.enrollment(owner, "custom.device");
  const { deviceId } = await hub.enroll(enrollment.token, {
    name: "bounded fixture",
    kind: "custom.device",
    capabilities: ["device.health"],
  });
  const first = hub.request(
    owner,
    deviceId,
    "device.health",
    {},
    "original",
    60,
  );
  hub.state.actions = Array.from({ length: 5000 }, (_, i) =>
    i === 0
      ? first
      : {
          ...first,
          id: crypto.randomUUID(),
          clientKey: JSON.stringify([owner.id, `limit-${i}`]),
        },
  );
  assert.equal(hub.exportHistory(owner).actions.length, 5000);
  assert.equal(
    hub.request(owner, deviceId, "device.health", {}, "original", 60).id,
    first.id,
  );
  assert.throws(
    () => hub.request(owner, deviceId, "device.health", {}, "new", 60),
    (e) => e.status === 429 && e.message.includes("capacity"),
  );
  assert.equal(hub.state.actions.length, 5000);
});

test("settled history rolls over, preserving pending work and durable replay keys", async () => {
  let now = 1700000000000;
  const hub = new Hub(emptyState(), () => now);
  const enrollment = await hub.enrollment(owner, "custom.device");
  const { deviceId } = await hub.enroll(enrollment.token, {
    name: "retention fixture",
    kind: "custom.device",
    capabilities: ["device.health"],
  });
  const first = hub.request(owner, deviceId, "device.health", {}, "pruned", 1);
  hub.next(deviceId);
  hub.result(deviceId, first.id, "succeeded", { ok: true });
  hub.state.actions = Array.from({ length: 5000 }, (_, i) => ({
    ...first,
    id: i === 0 ? first.id : crypto.randomUUID(),
    clientKey: JSON.stringify([owner.id, i === 0 ? "pruned" : `settled-${i}`]),
  }));
  hub.state.actions[1].status = "unknown";
  const uncertainId = hub.state.actions[1].id;
  now += 1001;
  const next = hub.request(owner, deviceId, "device.health", {}, "new", 60);
  assert.equal(hub.state.actions.length, 5000);
  assert(hub.state.actions.some((row) => row.id === uncertainId && row.status === "unknown"));
  assert.equal(hub.state.actions.at(-1).id, next.id);
  assert(!hub.state.actions.some((row) => row.id === first.id));
  const restarted = new Hub(JSON.parse(JSON.stringify(hub.state)), () => now);
  assert.throws(
    () => restarted.request(owner, deviceId, "device.health", {}, "pruned", 1),
    (error) => error.code === "history_pruned" && error.status === 409,
  );
  assert.equal(
    restarted.request(owner, deviceId, "device.health", {}, "new", 60).id,
    next.id,
  );
  assert.throws(
    () => restarted.request(owner, deviceId, "device.health", {}, "new", 30),
    (error) => error.code === "conflict",
  );
  assert.equal(restarted.next(deviceId).id, next.id);
});

test("device and agent connections can exceed twenty without a plan-level cap", async () => {
  const hub = new Hub(emptyState());
  for (let i = 0; i < 21; i++) {
    const enrollment = await hub.enrollment(owner, "custom.device");
    await hub.enroll(enrollment.token, {
      name: `device-${i}`,
      kind: "custom.device",
      capabilities: ["device.health"],
    });
    await hub.createConnection(
      owner,
      "a".repeat(64),
      `agent-${i}`,
      86400,
      "act",
    );
  }
  assert.equal(hub.state.devices.length, 21);
  assert.equal(hub.state.agentConnections.length, 21);
});
