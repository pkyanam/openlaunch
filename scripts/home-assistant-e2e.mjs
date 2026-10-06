/** Real HA acceptance test. Requires a private token file and a disposable Toggle helper. */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hub, emptyState } from "../packages/core/src/index.ts";
import { createDeviceCredentialDeriver } from "../packages/core/src/device-credentials.ts";
import { handle } from "../packages/http/src/index.ts";
import {
  setupHomeAssistant,
  runHomeAssistant,
} from "../packages/sdk/src/home-assistant-cli.ts";
import { HomeAssistant } from "../packages/sdk/src/home-assistant.ts";

const tokenPath = process.env.HA_TOKEN_FILE;
if (!tokenPath)
  throw Error(
    "Set HA_TOKEN_FILE to a private JSON file containing access_token. Never put the token in arguments.",
  );
if ((await stat(tokenPath)).mode & 0o077)
  throw Error("Token file must be private (chmod 600).");
const haToken = JSON.parse(await readFile(tokenPath, "utf8")).access_token;
const haUrl = process.env.HA_URL ?? "http://127.0.0.1:18123";
const entity = process.env.HA_TEST_ENTITY ?? "input_boolean.openlaunch_test";
if (!/^input_boolean\.openlaunch_test[a-z0-9_]*$/.test(entity))
  throw Error(
    "Use a disposable input_boolean.openlaunch_test helper, not a physical device.",
  );
const ha = new HomeAssistant(haUrl, haToken);
const snapshot = await ha.snapshot();
assert.ok(
  snapshot.states.some((s) => s.entity_id === entity),
  "Create the disposable test Toggle helper first.",
);
if (process.env.HA_TEST_SCRIPT)
  assert.ok(
    snapshot.states.some((s) => s.entity_id === process.env.HA_TEST_SCRIPT),
    "Configured test script discovered",
  );
const hub = new Hub(emptyState()),
  workspace = "a".repeat(64),
  owner = { id: "owner", owner: true };
const credentials = createDeviceCredentialDeriver(
  JSON.stringify({ v1: randomBytes(32).toString("hex") }),
);
const setup = await hub.createConnection(
  owner,
  workspace,
  "Local HA acceptance",
  600,
  "act",
  { canAttach: true, deviceLimit: 1, gatewayDeviceLimit: 2000 },
  "device-setup",
);
const connection = await hub.createConnection(
  owner,
  workspace,
  "Acceptance agent",
  600,
  "act",
  { canAttach: false, deviceLimit: 0 },
  "agent",
);
let origin;
const server = createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const response = await handle(
      new Request(origin + req.url, {
        method: req.method,
        headers: req.headers,
        ...(!["GET", "HEAD"].includes(req.method)
          ? { body: Buffer.concat(chunks) }
          : {}),
      }),
      hub,
      async () => ({ id: "invalid", owner: false }),
      { workspace, deviceCredentials: credentials },
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    res.writeHead(500).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
origin = "http://127.0.0.1:" + server.address().port;
const directory = await mkdtemp(join(tmpdir(), "openlaunch-ha-live-"));
const controller = new AbortController();
let runner;
let client;
try {
  const identity = await setupHomeAssistant({
    directory,
    url: origin,
    haUrl,
    haToken,
    sdkToken: setup.token,
  });
  runner = runHomeAssistant({
    directory,
    signal: controller.signal,
    events: false,
    pollMs: 20,
    refreshMs: 1000,
  });
  for (
    let n = 0;
    n < 600 &&
    (!hub.list(owner).some((d) => d.id === identity.deviceId && d.online) ||
      !hub.state.devices.some(
        (d) =>
          d.gatewayId === identity.deviceId &&
          d.kind === "home-assistant.entity" &&
          d.name ===
            snapshot.states.find((s) => s.entity_id === entity).attributes
              .friendly_name,
      ));
    n++
  )
    await new Promise((r) => setTimeout(r, 25));
  const local = new HomeAssistant(haUrl, haToken);
  const { discoverHA } = await import("../packages/sdk/src/home-assistant.ts");
  const key = discoverHA(snapshot).find((c) => c.entityId === entity).key;
  const child = hub.state.devices.find((d) => d.gatewayKey === key);
  assert.ok(child, "Real entity discovered");
  assert.equal(
    hub.list(owner).find((d) => d.id === child.id)?.online,
    true,
    "Complete HA inventory is online before invocation",
  );
  // New agent connections are delegated an all-devices operator policy: the
  // linked inventory is covered without any per-device grant.
  const agentPrincipal = { id: connection.principal, owner: false };
  const connectionPolicy = hub.state.accessPolicies.find(
    (policy) => policy.principal === connection.principal,
  );
  assert.ok(connectionPolicy, "New connection carries a live access policy");
  assert.equal(connectionPolicy.mode, "all");
  assert.ok(
    hub.list(agentPrincipal).some((d) => d.id === child.id),
    "All-mode policy delegation covers the linked inventory",
  );
  assert.ok(
    hub.functionCatalog(agentPrincipal).some((f) => f.deviceId === child.id),
    "All-mode policy exposes the child functions without grants",
  );
  // Opt-out exclusions deny a device without touching grants.
  hub.setAccessPolicy(owner, {
    principal: connection.principal,
    mode: "all",
    excludedDevices: [child.id],
    excludedFunctions: [],
    role: "operator",
    expiresAt: connectionPolicy.expiresAt,
  });
  assert.ok(
    !hub.list(agentPrincipal).some((d) => d.id === child.id),
    "Policy exclusions deny opted-out devices",
  );
  assert.ok(
    !hub.functionCatalog(agentPrincipal).some((f) => f.deviceId === child.id),
    "Policy exclusions hide opted-out functions",
  );
  // Selected mode restores the historical grant-only regime for the
  // remaining acceptance steps.
  hub.setAccessPolicy(owner, {
    principal: connection.principal,
    mode: "selected",
    excludedDevices: [],
    excludedFunctions: [],
    role: "operator",
    expiresAt: connectionPolicy.expiresAt,
  });
  assert.equal(hub.list(agentPrincipal).length, 0, "No implicit grants");
  hub.grant(
    owner,
    connection.principal,
    child.id,
    ["ha.entity.read", "ha.input_boolean.turn_on", "ha.input_boolean.turn_off"],
    3600,
  );
  client = new Client({
    name: "openlaunch-real-ha-acceptance",
    version: "1.0.0",
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + connection.token } },
    }),
  );
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "invoke_device_function"));
  const decode = (r) => {
    assert.equal(r.isError, undefined, JSON.stringify(r));
    const value =
      r.structuredContent ??
      JSON.parse(r.content.find((c) => c.type === "text").text);
    return value.data ?? value;
  };
  const devices = decode(
    await client.callTool({ name: "list_devices", arguments: {} }),
  );
  assert.ok(JSON.stringify(devices).includes(child.id));
  const functions = decode(
    await client.callTool({
      name: "list_functions",
      arguments: { deviceId: child.id },
    }),
  );
  assert.ok(JSON.stringify(functions).includes("ha.input_boolean.turn_on"));
  const results = [];
  async function invoke(capability, key, targetDeviceId = child.id) {
    const queued = decode(
      await client.callTool({
        name: "invoke_device_function",
        arguments: {
          deviceId: targetDeviceId,
          capability,
          arguments: { data: {} },
          idempotencyKey: key,
          ttlSeconds: 30,
        },
      }),
    );
    let receipt;
    for (let n = 0; n < 200; n++) {
      receipt = decode(
        await client.callTool({
          name: "get_action",
          arguments: { actionId: queued.id },
        }),
      );
      if (!["queued", "received", "executing"].includes(receipt.status)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(receipt.status, "succeeded", JSON.stringify(receipt));
    results.push({
      capability,
      status: receipt.status,
      result: receipt.result,
    });
    return { queued, receipt };
  }
  const on = await invoke("ha.input_boolean.turn_on", "ha-real-on");
  assert.equal(on.receipt.result.observedState.state, "on");
  const retry = decode(
    await client.callTool({
      name: "invoke_device_function",
      arguments: {
        deviceId: child.id,
        capability: "ha.input_boolean.turn_on",
        arguments: { data: {} },
        idempotencyKey: "ha-real-on",
        ttlSeconds: 30,
      },
    }),
  );
  assert.equal(retry.id, on.queued.id);
  const off = await invoke("ha.input_boolean.turn_off", "ha-real-off");
  assert.equal(off.receipt.result.observedState.state, "off");
  const scriptKey = discoverHA(snapshot).find(
    (c) => c.entityId === "script.openlaunch_test_script",
  )?.key;
  if (scriptKey) {
    const script = hub.state.devices.find((d) => d.gatewayKey === scriptKey);
    assert.ok(script);
    hub.grant(owner, connection.principal, script.id, [
      "ha.script.openlaunch_test_script",
    ]);
    const receipt = await invoke(
      "ha.script.openlaunch_test_script",
      "ha-real-script",
      script.id,
    );
    assert.equal(receipt.receipt.result.acceptedBy, "home-assistant");
    assert.equal(
      (await local.snapshot()).states.find((s) => s.entity_id === entity).state,
      "on",
    );
    await invoke("ha.input_boolean.turn_off", "ha-off-after-script");
  }
  const readQueued = decode(
    await client.callTool({
      name: "invoke_device_function",
      arguments: {
        deviceId: child.id,
        capability: "ha.entity.read",
        arguments: {},
        idempotencyKey: "ha-real-read",
        ttlSeconds: 30,
      },
    }),
  );
  let read;
  for (let n = 0; n < 200; n++) {
    read = decode(
      await client.callTool({
        name: "get_action",
        arguments: { actionId: readQueued.id },
      }),
    );
    if (read.status === "succeeded") break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(read.result.state, "off");
  results.push({
    capability: "ha.entity.read",
    status: read.status,
    result: read.result,
  });
  assert.equal(
    (await local.snapshot()).states.find((s) => s.entity_id === entity).state,
    "off",
  );
  console.log(
    JSON.stringify(
      {
        verified:
          "real Home Assistant → openlaunch HTTP → MCP → local gateway → HA service and state",
        haVersion: snapshot.version,
        registryAvailable: snapshot.registryAvailable,
        registeredDevices: snapshot.devices?.length ?? 0,
        entities: snapshot.states.length,
        services: Object.values(snapshot.services).reduce(
          (n, s) => n + Object.keys(s).length,
          0,
        ),
        linkedDevices: hub.state.devices.length - 1,
        idempotentRetry: true,
        physicalHardwareTested: false,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  controller.abort();
  if (runner) await runner;
  await client?.close();
  await new Promise((r) => server.close(r));
  await rm(directory, { recursive: true, force: true });
}
