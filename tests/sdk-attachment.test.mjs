import test from "node:test";
import assert from "node:assert/strict";
import { Hub, emptyState, hash } from "../packages/core/src/index.ts";
import { createDeviceCredentialDeriver } from "../packages/core/src/device-credentials.ts";
import { handle } from "../packages/http/src/index.ts";
import { createClient, createDevice } from "../packages/sdk/src/index.ts";
const owner = { id: "owner", owner: true };
const workspace = "a".repeat(64);
const keys = JSON.stringify({ v1: "b".repeat(64), v2: "c".repeat(64) });
const manifest = {
  name: "custom board",
  kind: "custom.device",
  capabilities: ["device.health"],
};

test("one SDK token attaches a device safely and still needs a separate function grant", async () => {
  let hub = new Hub(emptyState());
  const credentials = createDeviceCredentialDeriver(keys);
  const fetch = async (input, init) =>
    handle(new Request(input, init), hub, async () => owner, {
      workspace,
      deviceCredentials: credentials,
    });
  const created = await fetch("https://bridge.test/v1/sdk-tokens", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "workbench", deviceLimit: 1 }),
  });
  assert.equal(created.status, 201);
  const connection = (await created.json()).data;
  assert.match(connection.token, /^ol_sdk_/);
  const requestId = crypto.randomUUID();
  const device = createDevice({
    url: "https://bridge.test",
    token: connection.token,
    fetch,
  });
  const identity = await device.attach(manifest, requestId);
  const saved = JSON.stringify(hub.state);
  assert(!saved.includes(connection.token));
  assert(!saved.includes(identity.token));
  assert(!saved.includes("b".repeat(64)));
  assert.equal(hub.state.enrollments.length, 1);
  assert.equal(hub.state.enrollments[0].used, true);
  assert.equal(
    hub.state.attachAttempts[0].expiresAt,
    hub.state.enrollments[0].expiresAt,
  );
  // Retry after persistence and key rotation returns the exact original identity.
  hub = new Hub(JSON.parse(saved));
  const rotated = createDeviceCredentialDeriver(keys, "v2");
  const principal = await hub.authenticateConnection(
    connection.token,
    workspace,
  );
  assert.deepEqual(
    await hub.attachDevice(principal, workspace, requestId, manifest, rotated),
    identity,
  );
  assert.equal(hub.state.devices.length, 1);
  assert.equal(hub.state.attachAttempts.length, 1);
  const agent = createClient({
    url: "https://bridge.test",
    token: connection.token,
    fetch,
  });
  assert.deepEqual(await agent.listDevices(), []);
  await assert.rejects(
    () =>
      agent.requestAction(identity.deviceId, {
        capability: "device.health",
        idempotencyKey: "denied",
      }),
    (e) => e.status === 403,
  );
  for (const path of ["/v1/grants", "/v1/sdk-tokens"]) {
    const denied = await fetch("https://bridge.test" + path, {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        path.endsWith("grants")
          ? {
              principal: principal.id,
              deviceId: identity.deviceId,
              capabilities: ["device.health"],
            }
          : { name: "escalation" },
      ),
    });
    assert.equal(denied.status, 403);
  }
  hub.grant(owner, principal.id, identity.deviceId, ["device.health"]);
  assert.equal((await agent.listDevices()).length, 1);
  assert(!("attachedConnectionId" in (await agent.listDevices())[0]));
  await device.nextAction();
  const action = await agent.requestAction(identity.deviceId, {
    capability: "device.health",
    idempotencyKey: "health",
  });
  assert.equal((await device.nextAction()).id, action.id);
  await device.submitResult(action.id, {
    status: "succeeded",
    result: { softwareFixture: true },
  });
  assert.equal((await agent.getAction(action.id)).status, "succeeded");
  const second = createDevice({
    url: "https://bridge.test",
    token: connection.token,
    fetch,
  });
  await assert.rejects(
    () => second.attach(manifest, crypto.randomUUID()),
    (e) => e.status === 429,
  );
  hub.revokeConnection(owner, connection.id);
  await assert.rejects(
    () => agent.listDevices(),
    (e) => e.status === 401,
  );
  // Revoking a bootstrap/agent token does not silently erase a paired device.
  assert.equal(await device.nextAction(), null);
  hub.revoke(owner, identity.deviceId);
  await assert.rejects(
    () => device.nextAction(),
    (e) => [401, 404].includes(e.status),
  );
});

test("legacy connections never gain attachment permission; retries cannot change or replay expired enrollment", async () => {
  let now = 1700000000000;
  const hub = new Hub(emptyState(), () => now);
  const credentials = createDeviceCredentialDeriver(keys);
  const old = await hub.createConnection(owner, workspace, "legacy");
  // Reconstruct an existing ol_agent token and hash to exercise migration support.
  const legacyToken = old.token.replace("ol_sdk_", "ol_agent_");
  hub.state.agentConnections[0].tokenHash = await hash(legacyToken);
  delete hub.state.agentConnections[0].canAttach;
  delete hub.state.agentConnections[0].deviceLimit;
  const oldPrincipal = await hub.authenticateConnection(legacyToken, workspace);
  await assert.rejects(
    () =>
      hub.attachDevice(
        oldPrincipal,
        workspace,
        crypto.randomUUID(),
        manifest,
        credentials,
      ),
    (e) => e.status === 403,
  );
  const token = await hub.createConnection(
    owner,
    workspace,
    "new",
    86400,
    "act",
    { canAttach: true, deviceLimit: 2 },
  );
  const principal = await hub.authenticateConnection(token.token, workspace);
  const id = crypto.randomUUID();
  await hub.attachDevice(principal, workspace, id, manifest, credentials);
  await assert.rejects(
    () =>
      hub.attachDevice(
        principal,
        workspace,
        id,
        { ...manifest, name: "different" },
        credentials,
      ),
    (e) => e.status === 409,
  );
  now += 600001;
  await assert.rejects(
    () => hub.attachDevice(principal, workspace, id, manifest, credentials),
    (e) => e.code === "attachment_expired",
  );
  assert.equal(hub.state.devices.length, 1);
  await assert.rejects(
    () => hub.authenticateConnection(token.token, "d".repeat(64)),
    (e) => e.status === 401,
  );
});

test("credential keyrings reject malformed configuration and separate workspace identities", async () => {
  for (const config of [
    undefined,
    "{}",
    "[]",
    "null",
    JSON.stringify({ v1: "weak" }),
    JSON.stringify({ ["x".repeat(17)]: "b".repeat(64) }),
  ])
    assert.equal(createDeviceCredentialDeriver(config), undefined);
  const credentials = createDeviceCredentialDeriver(keys);
  assert.notEqual(
    await credentials.derive("v1", "workspace:a"),
    await credentials.derive("v1", "workspace:b"),
  );
  await assert.rejects(() => credentials.derive("missing", "context"));
});

test("attachment retry fails closed when its credential key is removed or replaced", async () => {
  const hub = new Hub(emptyState());
  const created = await hub.createConnection(
    owner,
    workspace,
    "rotation",
    86400,
    "act",
    { canAttach: true, deviceLimit: 1 },
  );
  const principal = await hub.authenticateConnection(created.token, workspace);
  const requestId = crypto.randomUUID();
  const identity = await hub.attachDevice(
    principal,
    workspace,
    requestId,
    manifest,
    createDeviceCredentialDeriver(keys),
  );
  for (const changed of [
    JSON.stringify({ v2: "c".repeat(64) }),
    JSON.stringify({ v1: "d".repeat(64) }),
  ]) {
    await assert.rejects(
      () =>
        hub.attachDevice(
          principal,
          workspace,
          requestId,
          manifest,
          createDeviceCredentialDeriver(
            changed,
            changed.includes("v2") ? "v2" : "v1",
          ),
        ),
      (e) => e.status === 503,
    );
    assert.equal(hub.state.devices.length, 1);
  }
  assert.equal(
    (await hub.authenticateDevice(identity.deviceId, identity.token)).id,
    identity.deviceId,
  );
});

test("HTTP body limits apply to streamed UTF-8 bytes without Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(" ".repeat(16385)));
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request("https://bridge.test/v1/sdk-tokens", {
    method: "POST",
    body: stream,
    duplex: "half",
  });
  const hub = new Hub(emptyState());
  const response = await handle(request, hub, async () => owner, { workspace });
  assert.equal(response.status, 413);
  assert.equal(cancelled, true);
  assert.equal(hub.state.agentConnections.length, 0);
});
