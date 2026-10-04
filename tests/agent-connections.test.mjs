import test from "node:test";
import assert from "node:assert/strict";
import { Hub, emptyState, agentTokenPurpose } from "../packages/core/src/index.ts";
import { createDeviceCredentialDeriver } from "../packages/core/src/device-credentials.ts";
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
test("explicit setup and agent tokens have separate purposes and endpoints", async () => {
  const hub = new Hub(emptyState());
  const fetch = async (input, init) =>
    handle(new Request(input, init), hub, async () => owner, {
      workspace,
      deviceCredentials: createDeviceCredentialDeriver(JSON.stringify({ v1: "b".repeat(64) })),
    });
  const setupResponse = await fetch("https://bridge.test/v1/device-setup-tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "sensor setup" }),
  });
  assert.equal(setupResponse.status, 201);
  const setup = (await setupResponse.json()).data;
  assert.equal(setup.purpose, "device-setup");
  assert.match(setup.token, /^ol_sdk_/);
  assert.equal(agentTokenPurpose(setup.token), "device-setup");
  assert.ok(setup.expiresAt - Date.now() <= 600000);
  assert.equal(setup.deviceLimit, 1);
  const listedSetup = await fetch("https://bridge.test/v1/device-setup-tokens");
  assert.equal((await listedSetup.json()).data[0].id, setup.id);

  const agentResponse = await fetch("https://bridge.test/v1/agent-connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "health agent" }),
  });
  assert.equal(agentResponse.status, 201);
  const agentConnection = (await agentResponse.json()).data;
  assert.equal(agentConnection.purpose, "agent");
  assert.match(agentConnection.token, /^ol_agent_/);
  assert.equal(agentTokenPurpose(agentConnection.token), "agent");
  assert.equal(agentConnection.canAttach, false);
  assert.ok(agentConnection.expiresAt > Date.now());
  const perpetualResponse = await fetch("https://bridge.test/v1/agent-connections", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "perpetual agent", ttlSeconds: null }),
  });
  assert.equal(perpetualResponse.status, 201);
  const perpetual = (await perpetualResponse.json()).data;
  assert.equal(perpetual.expiresAt, null);
  const invalidSetup = await fetch("https://bridge.test/v1/device-setup-tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "invalid setup", ttlSeconds: null }),
  });
  assert.equal(invalidSetup.status, 400);
  const setupOnly = await fetch("https://bridge.test/v1/devices", {
    headers: { authorization: `Bearer ${setup.token}` },
  });
  assert.equal(setupOnly.status, 403);
  const cannotAttach = await fetch("https://bridge.test/v1/sdk/devices", {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentConnection.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ requestId: crypto.randomUUID(), manifest: { name: "x" } }),
  });
  assert.equal(cannotAttach.status, 403);
  const enrollment = await hub.enrollment(owner, "custom.device");
  const device = await hub.enroll(enrollment.token, {
    name: "sensor",
    kind: "custom.device",
    capabilities: ["device.health"],
  });
  assert.throws(
    () => hub.grant(owner, setup.principal, device.deviceId, ["device.health"]),
    (error) => error.status === 403,
  );
  const revoked = await fetch(`https://bridge.test/v1/device-setup-tokens/${setup.id}/revoke`, {
    method: "POST",
  });
  assert.equal(revoked.status, 200);
  assert.equal((await fetch("https://bridge.test/v1/device-setup-tokens").then((r) => r.json())).data.length, 0);
});
test("until-revoked agent connections survive time passage and still revoke", async () => {
  let now = 1000;
  const hub = new Hub(emptyState(), () => now);
  const perpetual = await hub.createConnection(
    owner,
    workspace,
    "perpetual",
    null,
    "act",
    { canAttach: false, deviceLimit: 0 },
    "agent",
  );
  const finite = await hub.createConnection(
    owner,
    workspace,
    "finite",
    60,
    "act",
    { canAttach: false, deviceLimit: 0 },
    "agent",
  );
  now = 10 * 365 * 24 * 60 * 60 * 1000;
  assert.equal(
    (await hub.authenticateConnection(perpetual.token, workspace)).connectionPurpose,
    "agent",
  );
  await assert.rejects(() => hub.authenticateConnection(finite.token, workspace));
  assert.deepEqual(hub.connections(owner).map((entry) => entry.id), [perpetual.id]);
  hub.revokeConnection(owner, perpetual.id);
  await assert.rejects(() => hub.authenticateConnection(perpetual.token, workspace));
});
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
