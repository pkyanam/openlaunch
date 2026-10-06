import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { Miniflare } from "miniflare";

// Exercise the built Durable Object in workerd with disposable local storage.
// Trusted principals model the edge-to-object boundary; Clerk auth has separate tests.
const directory = mkdtempSync(join(tmpdir(), "openlaunch-cloud-storage-"));
chmodSync(directory, 0o700);
const workspace = "a".repeat(64);
const owner = { id: "storage-owner", owner: true };
const keys = JSON.stringify({ v1: randomBytes(32).toString("hex") });
const bundle = resolve(
  "apps/cloud/.cloudflare/output/v0/workers/default/bundle/index.js",
);
const built = JSON.parse(
  readFileSync(
    resolve(
      "apps/cloud/.cloudflare/output/v0/workers/default/worker.config.json",
    ),
    "utf8",
  ),
);
const name = "openlaunch-storage-acceptance";
const options = {
  resourcePersistencePath: join(directory, "resources"),
  isolatedResourcePersistencePath: join(directory, "isolated"),
  telemetry: { enabled: false },
  workers: [
    {
      config: {
        name,
        compatibilityDate: built.compatibilityDate,
        ...(built.compatibilityFlags
          ? { compatibilityFlags: built.compatibilityFlags }
          : {}),
        exports: built.exports,
        manifest: {
          mainModule: "index.js",
          modulesRoot: dirname(bundle),
          modules: {
            "index.js": { type: "esm", contents: readFileSync(bundle, "utf8") },
          },
        },
        env: {
          HUBS: {
            type: "durable-object",
            worker: name,
            exportName: "WorkspaceHub",
          },
          DEVICE_CREDENTIAL_KEYS: { type: "text", value: keys },
          DEVICE_CREDENTIAL_KEY_VERSION: { type: "text", value: "v1" },
        },
      },
    },
  ],
};
let worker;
async function object() {
  worker = new Miniflare(options);
  const namespace = await worker.getDurableObjectNamespace("HUBS");
  return namespace.get(namespace.idFromName(workspace));
}
async function api(stub, path, method = "GET", body, credential) {
  const response = await stub.fetch(`https://www.openlaunch.dev${path}`, {
    method,
    headers: {
      "x-openlaunch-workspace": workspace,
      "x-openlaunch-principal": JSON.stringify(owner),
      "content-type": "application/json",
      ...(credential ? { authorization: `Bearer ${credential}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(
    response.status >= 200 && response.status < 300,
    true,
    `${path}: HTTP ${response.status}`,
  );
  return (await response.json()).data;
}
try {
  let stub = await object();
  const connection = await api(stub, "/v1/device-setup-tokens", "POST", {
    name: "storage fixture",
    ttlSeconds: 600,
    deviceLimit: 1,
  });
  const request = {
    requestId: crypto.randomUUID(),
    manifest: {
      name: "storage fixture",
      kind: "custom.device",
      capabilities: ["device.health"],
    },
  };
  const paired = await api(
    stub,
    "/v1/sdk/devices",
    "POST",
    request,
    connection.token,
  );
  assert.deepEqual(
    await api(stub, "/v1/sdk/devices", "POST", request, connection.token),
    paired,
  );
  const agentConnection = await api(stub, "/v1/agent-connections", "POST", {
    name: "storage fixture agent",
    ttlSeconds: 600,
    access: "act",
  });
  await api(stub, "/v1/grants", "POST", {
    principal: agentConnection.principal,
    deviceId: paired.deviceId,
    capabilities: ["device.health"],
    ttlSeconds: 3600,
  });
  const actionRequest = {
    capability: "device.health",
    arguments: {},
    ttlSeconds: 60,
    idempotencyKey: "survives-restart",
  };
  const action = await api(
    stub,
    `/v1/devices/${paired.deviceId}/actions`,
    "POST",
    actionRequest,
    agentConnection.token,
  );
  assert.equal(action.status, "queued");
  await worker.dispose();
  worker = undefined;
  stub = await object();
  assert.equal(
    (
      await api(
        stub,
        `/v1/devices/${paired.deviceId}/actions`,
        "POST",
        actionRequest,
        agentConnection.token,
      )
    ).id,
    action.id,
  );
  assert.equal(
    (
      await api(
        stub,
        `/v1/device/${paired.deviceId}/next`,
        "POST",
        {},
        paired.token,
      )
    ).id,
    action.id,
  );
  // Real hibernation auto-responses must refresh presence while HTTPS polling
  // is paused for longer than the 45-second online window (e.g. apt install).
  async function eventSocket() {
    const ticket = await api(
      stub,
      `/v1/device/${paired.deviceId}/events-ticket`,
      "POST",
      {},
      paired.token,
    );
    const upgrade = await stub.fetch(
      `https://www.openlaunch.dev/v1/device/${paired.deviceId}/events?workspace=${workspace}`,
      {
        headers: {
          "x-openlaunch-workspace": workspace,
          upgrade: "websocket",
          "sec-websocket-protocol": `openlaunch.device.v1, ticket.${ticket.ticket}`,
        },
      },
    );
    assert.equal(upgrade.status, 101);
    const socket = upgrade.webSocket;
    socket.accept();
    return socket;
  }
  let socket = await eventSocket();
  let pongs = 0;
  socket.addEventListener("message", (event) => {
    if (event.data === "openlaunch.pong") pongs++;
  });
  socket.send("openlaunch.ping");
  const ping = setInterval(() => socket.send("openlaunch.ping"), 5_000);
  try {
    await new Promise((resolve) => setTimeout(resolve, 47_000));
    assert(pongs >= 8, "workerd did not send automatic pong replies");
    const inventory = await api(stub, "/v1/devices");
    assert.equal(
      inventory[0].online,
      true,
      "busy device falsely reported offline after 45 seconds",
    );
    assert(inventory[0].lastSeen > action.createdAt + 40_000);
    const waiting = await api(
      stub,
      `/v1/devices/${paired.deviceId}/actions`,
      "POST",
      { ...actionRequest, idempotencyKey: "queued-while-busy" },
      agentConnection.token,
    );
    assert.equal(waiting.status, "queued");
    const active = await api(stub, `/v1/actions/${action.id}`);
    assert.equal(
      active.status,
      "received",
      "presence must not complete or replay an action",
    );
    await api(
      stub,
      `/v1/actions/${waiting.id}/cancel`,
      "POST",
      {},
      agentConnection.token,
    );
  } finally {
    clearInterval(ping);
    socket.close();
  }
  socket = await eventSocket(); // Replacement session uses a fresh one-use ticket.
  socket.send("openlaunch.ping");
  const presence = await api(
    stub,
    `/v1/device/${paired.deviceId}/heartbeat`,
    "POST",
    {},
    paired.token,
  );
  assert(presence.lastSeen >= action.createdAt);
  const result = await api(
    stub,
    `/v1/device/${paired.deviceId}/result`,
    "POST",
    {
      actionId: action.id,
      status: "succeeded",
      result: { softwareFixture: true },
    },
    paired.token,
  );
  assert.equal(result.status, "succeeded");
  const history = await api(stub, "/v1/actions/export");
  assert.equal(history.actions.length, 2);
  assert.deepEqual(history.actions.find((a) => a.id === action.id).result, {
    softwareFixture: true,
  });
  await api(stub, `/v1/devices/${paired.deviceId}/revoke`, "POST", {});
  assert.deepEqual(await api(stub, "/v1/devices"), []);
  socket.close();
  async function deniedDeviceRoutes(target) {
    const headers = {
      "x-openlaunch-workspace": workspace,
      authorization: `Bearer ${paired.token}`,
      "content-type": "application/json",
    };
    const next = await target.fetch(
      `https://www.openlaunch.dev/v1/device/${paired.deviceId}/next`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(next.status, 404);
    const heartbeat = await target.fetch(
      `https://www.openlaunch.dev/v1/device/${paired.deviceId}/heartbeat`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(heartbeat.status, 404);
    const upgrade = await target.fetch(
      `https://www.openlaunch.dev/v1/device/${paired.deviceId}/events`,
      {
        headers: {
          ...headers,
          upgrade: "websocket",
          "sec-websocket-protocol": `openlaunch.device.v1, ticket.${"c".repeat(64)}`,
        },
      },
    );
    assert.equal(upgrade.status, 401);
    const ticket = await target.fetch(
      `https://www.openlaunch.dev/v1/device/${paired.deviceId}/events-ticket`,
      { method: "POST", headers, body: "{}" },
    );
    assert.equal(ticket.status, 404);
  }
  await deniedDeviceRoutes(stub);
  await worker.dispose();
  worker = undefined;
  stub = await object();
  await deniedDeviceRoutes(stub);
  // A gateway shares the durable queue and notification channel with its children.
  const gatewaySetup = await api(stub, "/v1/device-setup-tokens", "POST", {
    name: "HA gateway acceptance",
    gatewayDeviceLimit: 2000,
  });
  const gateway = await api(
    stub,
    "/v1/sdk/devices",
    "POST",
    {
      requestId: crypto.randomUUID(),
      manifest: {
        name: "HA gateway",
        kind: "gateway.home-assistant",
        capabilities: ["device.health"],
      },
    },
    gatewaySetup.token,
  );
  const [child] = await api(
    stub,
    `/v1/device/${gateway.deviceId}/children`,
    "POST",
    {
      children: [
        {
          key: "entity:test",
          manifest: {
            name: "HA test entity",
            kind: "home-assistant.entity",
            capabilities: ["device.health"],
          },
        },
      ],
    },
    gateway.token,
  );
  assert.ok(child.deviceId);
  await api(
    stub,
    `/v1/device/${gateway.deviceId}/children/status`,
    "POST",
    { online: true, keys: ["entity:test"] },
    gateway.token,
  );
  await api(stub, `/v1/devices/${gateway.deviceId}/gateway-grants`, "POST", {
    principal: agentConnection.principal,
    mode: "read",
  });
  const ticket = await api(
    stub,
    `/v1/device/${gateway.deviceId}/events-ticket`,
    "POST",
    {},
    gateway.token,
  );
  const upgrade = await stub.fetch(
    `https://www.openlaunch.dev/v1/device/${gateway.deviceId}/events?workspace=${workspace}`,
    {
      headers: {
        "x-openlaunch-workspace": workspace,
        upgrade: "websocket",
        "sec-websocket-protocol": `openlaunch.device.v1, ticket.${ticket.ticket}`,
      },
    },
  );
  assert.equal(upgrade.status, 101);
  const gatewaySocket = upgrade.webSocket;
  gatewaySocket.accept();
  const hint = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Error("Child action did not wake its gateway")),
      2000,
    );
    gatewaySocket.addEventListener("message", (event) => {
      if (event.data === '{"type":"work"}') {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  const childAction = await api(
    stub,
    `/v1/devices/${child.deviceId}/actions`,
    "POST",
    {
      capability: "device.health",
      arguments: {},
      idempotencyKey: "gateway-child-health",
      ttlSeconds: 30,
    },
    agentConnection.token,
  );
  await hint;
  assert.equal(
    (
      await api(
        stub,
        `/v1/device/${gateway.deviceId}/next`,
        "POST",
        {},
        gateway.token,
      )
    ).deviceId,
    child.deviceId,
  );
  await api(
    stub,
    `/v1/device/${gateway.deviceId}/result`,
    "POST",
    {
      actionId: childAction.id,
      status: "succeeded",
      result: {
        source: "software HA gateway fixture",
        physicalVerified: false,
      },
    },
    gateway.token,
  );
  gatewaySocket.close();
  await worker.dispose();
  worker = undefined;
  stub = await object();
  const reloaded = await api(stub, "/v1/devices");
  assert.equal(
    reloaded.find((d) => d.id === child.deviceId).gatewayId,
    gateway.deviceId,
  );
  assert.equal(
    (await api(stub, `/v1/actions/${childAction.id}`)).status,
    "succeeded",
  );
  const duplicate = await api(
    stub,
    `/v1/device/${gateway.deviceId}/children`,
    "POST",
    {
      children: [
        {
          key: "entity:test",
          manifest: {
            name: "HA test entity",
            kind: "home-assistant.entity",
            capabilities: ["device.health"],
          },
        },
      ],
    },
    gateway.token,
  );
  assert.equal(duplicate[0].deviceId, child.deviceId);
  assert.equal(duplicate[0].grantsRevoked, false);
  const keys = Array.from(
    { length: 2000 },
    (_, n) => "k" + String(n).padStart(191, "0"),
  );
  assert.ok(Buffer.byteLength(JSON.stringify({ online: true, keys })) > 65536);
  await api(
    stub,
    `/v1/device/${gateway.deviceId}/children/status`,
    "POST",
    { online: true, keys: ["entity:test", ...keys.slice(0, 1999)] },
    gateway.token,
  );
  await api(stub, `/v1/devices/${gateway.deviceId}/revoke`, "POST", {});
  assert.deepEqual(await api(stub, "/v1/devices"), []);
  console.log(
    "PASS: workerd SQLite attachment, restart, idempotency, grants, outcome, busy presence, socket reconnect, export, gateway child dispatch/wake/restart/large reconciliation and revocation",
  );
} finally {
  if (worker) await worker.dispose();
  rmSync(directory, { recursive: true, force: true });
}
