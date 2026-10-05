import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Hub, Fault } from "../packages/core/src/index.ts";
import {
  roombaFunctions,
  roombaCapabilities,
} from "../packages/core/src/roomba.ts";
import { handle } from "../packages/http/src/index.ts";

const owner = { id: "owner", owner: true };
const agent = { id: "https://chatgpt.com/oauth/client.json", owner: false };
const manifest = {
  name: "software Roomba fixture",
  kind: "uno-r4-wifi",
  capabilities: ["device.health", ...roombaCapabilities],
  functions: roombaFunctions,
};
const args = {
  "device.health": {},
  "roomba.drive": { velocityMmS: 100, radiusMm: 0, durationMs: 300 },
  "roomba.drive_direct": { rightMmS: 100, leftMmS: -100, durationMs: 300 },
  "roomba.stop": {},
  "roomba.sensor.read": { packetId: 7 },
  "roomba.leds.set": { ledBits: 15, powerColor: 128, powerIntensity: 255 },
  "roomba.tone.play": { note: 72, duration: 16 },
  "roomba.song.play": { songId: 0 },
  "roomba.brushes.burst": {
    mainBrush: true,
    sideBrush: false,
    vacuum: false,
    durationMs: 300,
  },
  "roomba.resume_safe": {},
  "roomba.clean": { mode: "standard" },
  "roomba.dock": {},
  "roomba.pause": {},
};

async function fixture(principal = agent) {
  let now = Date.now();
  let hub = new Hub(undefined, () => now);
  const enrollment = await hub.enrollment(owner, manifest.kind);
  const device = await hub.enroll(enrollment.token, manifest);
  const resolve = async (request) => {
    if (request.headers.get("authorization") !== "Bearer fixture-agent")
      throw new Fault("unauthorized", 401, "Fixture agent required");
    return principal;
  };
  const api = (path, body, token = device.token) =>
    handle(
      new Request("https://bridge.example" + path, {
        method: "POST",
        headers: {
          authorization: "Bearer " + token,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
      hub,
      resolve,
    );
  const client = new Client({ name: "cached-tool-client", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://bridge.example/mcp"), {
      requestInit: { headers: { authorization: "Bearer fixture-agent" } },
      fetch: (input, init) => handle(new Request(input, init), hub, resolve),
    }),
  );
  const call = (name, arguments_ = {}) =>
    client.callTool({ name, arguments: arguments_ });
  const invoke = (capability, arguments_, idempotencyKey, ttlSeconds = 30) =>
    call("invoke_device_function", {
      deviceId: device.deviceId,
      capability,
      arguments: arguments_,
      idempotencyKey,
      ttlSeconds,
    });
  return {
    get hub() {
      return hub;
    },
    device,
    client,
    call,
    invoke,
    api,
    advance: (ms) => {
      now += ms;
    },
    restart: () => {
      hub = new Hub(JSON.parse(JSON.stringify(hub.state)), () => now);
    },
  };
}

test("cached MCP tools discover and invoke all Roomba functions granted after connection", async () => {
  const f = await fixture();
  try {
    // The host discovers once before any grant, then retains this tool list.
    const cached = await f.client.listTools();
    assert(!cached.tools.some(({ name }) => name.startsWith("device_")));
    for (const name of ["list_functions", "invoke_device_function"])
      assert(
        cached.tools.some((tool) => tool.name === name),
        name + " must exist before grants",
      );
    assert.deepEqual(
      (await f.call("list_functions")).structuredContent.data,
      [],
    );
    assert.deepEqual(
      (await f.call("list_functions", { deviceId: crypto.randomUUID() }))
        .structuredContent.data,
      [],
    );
    assert.equal(
      (await f.invoke("roomba.clean", args["roomba.clean"], "no-grant"))
        .isError,
      true,
    );
    f.hub.grant(
      owner,
      agent.id,
      f.device.deviceId,
      manifest.capabilities,
      null,
    );
    const rows = (
      await f.call("list_functions", { deviceId: f.device.deviceId })
    ).structuredContent.data;
    assert.deepEqual(
      rows.map((row) => row.definition.name),
      manifest.capabilities,
    );
    const rest = await handle(
      new Request("https://bridge.example/v1/functions", {
        headers: { authorization: "Bearer fixture-agent" },
      }),
      f.hub,
      async () => agent,
    );
    assert.deepEqual(rows, (await rest.json()).data);
    const clean = rows.find((row) => row.definition.name === "roomba.clean");
    assert.deepEqual(clean.definition.inputSchema.properties.mode.enum, [
      "standard",
      "spot",
      "max",
    ]);
    assert.match(clean.guide, /does not by itself verify physical state/);
    // No further tools/list call: each function uses the cached stable tool.
    for (const row of rows) {
      const capability = row.definition.name;
      const key = "cached:" + capability;
      const queued = await f.invoke(capability, args[capability], key);
      assert.notEqual(
        queued.isError,
        true,
        capability + JSON.stringify(queued),
      );
      const action = queued.structuredContent.data;
      assert.equal(action.status, "queued");
      assert.equal(
        (await f.invoke(capability, args[capability], key)).structuredContent
          .data.id,
        action.id,
      );
      const next = await f.api(`/v1/device/${f.device.deviceId}/next`, {});
      assert.equal(next.status, 200);
      const command = (await next.json()).data;
      assert.equal(command.id, action.id);
      assert.deepEqual(command.args, args[capability]);
      assert.equal(
        (
          await f
            .api(`/v1/device/${f.device.deviceId}/next`, {})
            .then((r) => r.json())
        ).data,
        null,
      );
      f.restart();
      assert.equal(
        (
          await f
            .api(`/v1/device/${f.device.deviceId}/next`, {})
            .then((r) => r.json())
        ).data,
        null,
      );
      const result = {
        simulated: true,
        physicalOperationVerified: false,
        capability,
      };
      assert.equal(
        (
          await f.api(`/v1/device/${f.device.deviceId}/result`, {
            actionId: action.id,
            status: "succeeded",
            result,
          })
        ).status,
        200,
      );
      const final = (await f.call("get_action", { actionId: action.id }))
        .structuredContent.data;
      assert.equal(final.status, "succeeded");
      assert.deepEqual(final.result, result);
    }
    assert.equal(f.hub.state.actions.length, manifest.capabilities.length);
  } finally {
    await f.client.close();
  }
});

test("stable MCP tools preserve separate setup credentials and revocable agent API access", async () => {
  const hub = new Hub();
  const workspace = "a".repeat(64);
  const enrollment = await hub.enrollment(owner, manifest.kind);
  const device = await hub.enroll(enrollment.token, manifest);
  const connection = await hub.createConnection(
    owner,
    workspace,
    "fixture agent",
    null,
    "act",
    undefined,
    "agent",
  );
  const clientFor = (token) => ({
    client: new Client({ name: "api-credential-test", version: "1" }),
    transport: new StreamableHTTPClientTransport(
      new URL("https://bridge.example/mcp"),
      {
        requestInit: { headers: { authorization: "Bearer " + token } },
        fetch: (input, init) =>
          handle(
            new Request(input, init),
            hub,
            async () => {
              throw new Fault(
                "unauthorized",
                401,
                "Owner credentials cannot authorize this agent",
              );
            },
            { workspace },
          ),
      },
    ),
  });
  const { client, transport } = clientFor(connection.token);
  await client.connect(transport);
  try {
    const call = (name, arguments_ = {}) =>
      client.callTool({ name, arguments: arguments_ });
    assert.deepEqual((await call("list_functions")).structuredContent.data, []);
    hub.grant(
      owner,
      connection.principal,
      device.deviceId,
      ["roomba.clean"],
      null,
    );
    const queued = await call("invoke_device_function", {
      deviceId: device.deviceId,
      capability: "roomba.clean",
      arguments: { mode: "standard" },
      idempotencyKey: "api-clean",
    });
    assert.equal(queued.structuredContent.data.status, "queued");
    hub.revokeConnection(owner, connection.id);
    await assert.rejects(
      call("list_functions"),
      /Agent connection expired or revoked/,
    );
    assert.equal(hub.state.actions[0].status, "cancelled");
  } finally {
    await client.close();
  }
  const setup = await hub.createConnection(
    owner,
    workspace,
    "fixture setup",
    600,
    "act",
    { canAttach: true, deviceLimit: 1 },
    "device-setup",
  );
  const setupClient = clientFor(setup.token);
  try {
    await assert.rejects(
      setupClient.client.connect(setupClient.transport),
      /Device setup tokens can only attach devices/,
    );
    assert.equal(
      hub.functionCatalog({
        id: setup.principal,
        owner: false,
        connectionPurpose: "device-setup",
      }).length,
      0,
    );
  } finally {
    await setupClient.client.close();
  }
});

test("stable invocation enforces live schemas, scope, expiry, revocation and manifest changes", async () => {
  const f = await fixture();
  try {
    f.hub.grant(owner, agent.id, f.device.deviceId, [
      "roomba.clean",
      "device.health",
    ]);
    for (const [capability, arguments_] of [
      ["roomba.clean", {}],
      ["roomba.clean", { mode: "invalid" }],
      ["roomba.clean", { mode: "standard", extra: true }],
      ["roomba.drive", args["roomba.drive"]],
      ["unknown.function", {}],
      ["roomba.clean", { mode: { nested: true } }],
    ])
      assert.equal(
        (
          await f.invoke(
            capability,
            arguments_,
            "invalid:" + JSON.stringify(arguments_),
          )
        ).isError,
        true,
      );
    assert.equal(
      (await f.invoke("roomba.clean", args["roomba.clean"], "ttl", 301))
        .isError,
      true,
    );
    assert.equal(f.hub.state.actions.length, 0);
    const queued = (
      await f.invoke("roomba.clean", args["roomba.clean"], "expires", 1)
    ).structuredContent.data;
    assert.equal(
      (await f.invoke("roomba.clean", { mode: "spot" }, "expires", 1)).isError,
      true,
    );
    f.advance(1001);
    assert.equal(
      (
        await f
          .api(`/v1/device/${f.device.deviceId}/next`, {})
          .then((r) => r.json())
      ).data,
      null,
    );
    assert.equal(
      (await f.call("get_action", { actionId: queued.id })).structuredContent
        .data.status,
      "expired",
    );
    const revoked = (
      await f.invoke("roomba.clean", args["roomba.clean"], "revoked")
    ).structuredContent.data;
    f.hub.revokeGrant(owner, agent.id, f.device.deviceId);
    assert.deepEqual(
      (await f.call("list_functions")).structuredContent.data,
      [],
    );
    assert.equal(
      (await f.invoke("roomba.clean", args["roomba.clean"], "revoked")).isError,
      true,
    );
    assert.equal(
      f.hub.state.actions.find((action) => action.id === revoked.id).status,
      "cancelled",
    );
    f.hub.grant(owner, agent.id, f.device.deviceId, ["roomba.clean"], 1);
    f.advance(1001);
    assert.equal(
      (await f.invoke("roomba.clean", args["roomba.clean"], "expired-grant"))
        .isError,
      true,
    );
    assert.deepEqual(
      (await f.call("list_functions")).structuredContent.data,
      [],
    );
    f.hub.grant(owner, agent.id, f.device.deviceId, ["roomba.clean"], null);
    f.hub.publishManifest(f.device.deviceId, {
      ...manifest,
      name: "changed manifest",
    });
    assert.equal(
      (await f.invoke("roomba.clean", args["roomba.clean"], "manifest-changed"))
        .isError,
      true,
    );
    assert.deepEqual(
      (await f.call("list_functions")).structuredContent.data,
      [],
    );
    f.hub.grant(owner, agent.id, f.device.deviceId, ["roomba.clean"], null);
    f.hub.revoke(owner, f.device.deviceId);
    assert.equal(
      (await f.invoke("roomba.clean", args["roomba.clean"], "device-revoked"))
        .isError,
      true,
    );
  } finally {
    await f.client.close();
  }
  const readOnly = await fixture({ ...agent, readOnly: true });
  try {
    readOnly.hub.grant(
      owner,
      agent.id,
      readOnly.device.deviceId,
      manifest.capabilities,
      null,
    );
    assert.deepEqual(
      (await readOnly.call("list_functions")).structuredContent.data.map(
        (row) => row.definition.name,
      ),
      ["device.health", "roomba.sensor.read"],
    );
    assert.equal(
      (await readOnly.invoke("roomba.clean", args["roomba.clean"], "read-only"))
        .isError,
      true,
    );
    assert.notEqual(
      (await readOnly.invoke("device.health", {}, "read-health")).isError,
      true,
    );
  } finally {
    await readOnly.client.close();
  }
});
