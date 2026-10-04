import test from "node:test";
import assert from "node:assert/strict";
import { Hub, emptyState } from "../packages/core/src/index.ts";
import { handle } from "../packages/http/src/index.ts";
import { createClient, createDevice } from "../packages/sdk/src/index.ts";
const owner = { id: "owner", owner: true };
const workspace = "a".repeat(64);
const schema = {
  type: "object",
  properties: { on: { type: "boolean" } },
  required: ["on"],
  additionalProperties: false,
};
test("generic device SDK and agent connection share grants, receipts and revocation", async () => {
  const hub = new Hub(emptyState());
  const fetch = async (input, init) =>
    handle(new Request(input, init), hub, async () => owner, { workspace });
  const enrollment = await hub.enrollment(owner, "custom.device");
  const adapter = createDevice({
    url: "https://bridge.test",
    workspace,
    fetch,
  });
  const identity = await adapter.enroll({
    token: enrollment.token,
    manifest: {
      name: "Custom fixture",
      kind: "custom.device",
      capabilities: ["switch.set"],
      functions: [
        {
          name: "switch.set",
          title: "Set switch",
          description: "Set this adapter's switch",
          access: "write",
          inputSchema: schema,
        },
      ],
    },
  });
  const connection = await hub.createConnection(owner, workspace, "Test app");
  assert.equal(JSON.stringify(hub.state).includes(connection.token), false);
  assert.equal(
    JSON.stringify(hub.connections(owner)).includes("tokenHash"),
    false,
  );
  const agent = createClient({
    url: "https://bridge.test",
    token: connection.token,
    fetch,
  });
  assert.deepEqual(await agent.listDevices(), []);
  await assert.rejects(
    agent.requestAction(identity.deviceId, {
      capability: "switch.set",
      arguments: { on: true },
      idempotencyKey: "before-grant",
    }),
    (e) => e.status === 403,
  );
  const ownerEndpoint = await fetch(
    "https://bridge.test/v1/agent-connections",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Escalation" }),
    },
  );
  assert.equal(ownerEndpoint.status, 403);
  hub.grant(owner, connection.principal, identity.deviceId, ["switch.set"]);
  const action = await agent.requestAction(identity.deviceId, {
    capability: "switch.set",
    arguments: { on: true },
    idempotencyKey: "after-grant",
  });
  assert.equal(action.status, "queued");
  const received = await adapter.nextAction();
  assert.equal(received.id, action.id);
  await adapter.submitResult(action.id, {
    status: "succeeded",
    result: { simulated: true, on: true },
  });
  assert.equal((await agent.getAction(action.id)).status, "succeeded");
  hub.revokeConnection(owner, connection.id);
  await assert.rejects(agent.listDevices(), (e) => e.status === 401);
  await assert.rejects(
    hub.authenticateConnection(connection.token, "b".repeat(64)),
  );
});
test("connection access, expiry and owner boundaries cannot be bypassed", async () => {
  let now = 1000;
  const hub = new Hub(emptyState(), () => now);
  const enrollment = await hub.enrollment(owner, "custom.sensor");
  const device = await hub.enroll(enrollment.token, {
    name: "Fixture",
    kind: "custom.sensor",
    capabilities: ["led.set"],
  });
  const connection = await hub.createConnection(
    owner,
    workspace,
    "Read only",
    60,
    "read",
  );
  const principal = await hub.authenticateConnection(
    connection.token,
    workspace,
  );
  assert.equal(principal.owner, false);
  assert.equal(principal.readOnly, true);
  hub.grant(owner, principal.id, device.deviceId, ["led.set"]);
  assert.throws(() =>
    hub.request(
      principal,
      device.deviceId,
      "led.set",
      { on: true },
      "no-write",
    ),
  );
  await assert.rejects(
    hub.createConnection(principal, workspace, "Self approved"),
  );
  assert.throws(() => hub.connections(principal));
  now = 61000;
  await assert.rejects(hub.authenticateConnection(connection.token, workspace));
  await assert.rejects(
    hub.authenticateConnection(connection.token.slice(0, -1) + "x", workspace),
  );
});
test("publishing functions clears previous grants and cancels stale requests", async () => {
  const hub = new Hub(emptyState());
  const e = await hub.enrollment(owner, "custom.device");
  const manifest = {
    name: "Adapter",
    kind: "custom.device",
    capabilities: ["led.set"],
  };
  const d = await hub.enroll(e.token, manifest);
  const connection = await hub.createConnection(owner, workspace, "App");
  const agent = await hub.authenticateConnection(connection.token, workspace);
  hub.grant(owner, agent.id, d.deviceId, ["led.set"]);
  const queued = hub.request(
    agent,
    d.deviceId,
    "led.set",
    { on: true },
    "before-publish",
  );
  assert.deepEqual(hub.publishManifest(d.deviceId, manifest), {
    ok: true,
    grantsRevoked: false,
  });
  assert.equal(hub.list(agent).length, 1);
  const next = {
    ...manifest,
    capabilities: ["switch.set"],
    functions: [
      {
        name: "switch.set",
        title: "Switch",
        description: "Set a switch",
        access: "write",
        inputSchema: schema,
      },
    ],
  };
  assert.deepEqual(hub.publishManifest(d.deviceId, next), {
    ok: true,
    grantsRevoked: true,
  });
  assert.equal(queued.status, "cancelled");
  assert.equal(hub.list(agent).length, 0);
  assert.throws(() =>
    hub.request(agent, d.deviceId, "switch.set", { on: true }, "no-new-grant"),
  );
  assert.throws(() =>
    hub.publishManifest(d.deviceId, { ...next, kind: "custom.other" }),
  );
  const fetch = async (input, init) =>
    handle(new Request(input, init), hub, async () => owner, { workspace });
  const adapter = createDevice({
    url: "https://bridge.test",
    workspace,
    deviceId: d.deviceId,
    credential: d.token,
    fetch,
  });
  assert.deepEqual(await adapter.publishManifest(next), {
    ok: true,
    grantsRevoked: false,
  });
});
test("an expired SDK connection cannot dispatch its queued action", async () => {
  let now = 1000;
  const hub = new Hub(emptyState(), () => now);
  const e = await hub.enrollment(owner, "custom.device");
  const d = await hub.enroll(e.token, {
    name: "Fixture",
    kind: "custom.device",
    capabilities: ["device.health"],
  });
  const c = await hub.createConnection(
    owner,
    workspace,
    "Short connection",
    60,
  );
  const p = await hub.authenticateConnection(c.token, workspace);
  hub.grant(owner, p.id, d.deviceId, ["device.health"]);
  const action = hub.request(p, d.deviceId, "device.health", {}, "expiry", 120);
  now = 61000;
  assert.equal(hub.next(d.deviceId), null);
  assert.equal(action.status, "cancelled");
});
