import test from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../packages/core/src/index.ts";
import { handle } from "../packages/http/src/index.ts";
import {
  MCP_VERSION,
  MCP_SUPPORTED_VERSIONS,
} from "../packages/mcp/src/http-2026.ts";
import { functionToolName } from "../packages/mcp/src/index.ts";
import {
  roombaCapabilities,
  roombaFunctions,
} from "../packages/core/src/roomba.ts";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
const schema = JSON.parse(
  readFileSync(new URL("./fixtures/mcp-2026/schema.json", import.meta.url)),
);
const ajv = new Ajv2020({ strict: false, validateFormats: false });
ajv.addSchema(schema, "mcp-2026");
const validators = new Map();
function conforms(name, value) {
  if (!validators.has(name))
    validators.set(name, ajv.compile({ $ref: `mcp-2026#/$defs/${name}` }));
  const validate = validators.get(name);
  assert(validate(value), `${name}: ${JSON.stringify(validate.errors)}`);
}
const owner = { id: "owner", owner: true };
const agent = { id: "custom-client", owner: false };
const meta = {
  "io.modelcontextprotocol/protocolVersion": MCP_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": {
    name: "Executor fixture",
    version: "1",
  },
};
async function fixture(p = agent) {
  let now = Date.now();
  const hub = new Hub(undefined, () => now);
  const enrollment = await hub.enrollment(owner, "uno-r4-wifi");
  const device = await hub.enroll(enrollment.token, {
    name: "Roomba software fixture",
    kind: "uno-r4-wifi",
    capabilities: ["device.health", ...roombaCapabilities],
    functions: roombaFunctions,
  });
  let id = 0;
  const request = (method, params = {}, headers = {}, overrides = {}) => {
    const message = {
      jsonrpc: "2.0",
      id: ++id,
      method,
      params: { ...params, _meta: { ...meta, ...params._meta } },
      ...overrides,
    };
    return handle(
      new Request("https://bridge.test/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version":
            message.params?._meta?.[
              "io.modelcontextprotocol/protocolVersion"
            ] ?? MCP_VERSION,
          "mcp-method": method,
          ...(method === "tools/call" ? { "mcp-name": params.name ?? "" } : {}),
          ...headers,
        },
        body: JSON.stringify(message),
      }),
      hub,
      async () => p,
    );
  };
  const call = async (name, args = {}) =>
    await (await request("tools/call", { name, arguments: args })).json();
  return {
    hub,
    device,
    request,
    call,
    advance: (ms) => {
      now += ms;
    },
  };
}
test("July 2026 discovery and tools are independently callable without initialize and keep live grants", async () => {
  const f = await fixture();
  const discover = await (await f.request("server/discover")).json();
  conforms("DiscoverResultResponse", discover);
  assert.equal(discover.result.resultType, "complete");
  assert.deepEqual(discover.result.supportedVersions, MCP_SUPPORTED_VERSIONS);
  assert.deepEqual(discover.result.capabilities, { tools: {} });
  assert.equal(
    discover.result._meta["io.modelcontextprotocol/serverInfo"].name,
    "openlaunch",
  );
  const listed = await (await f.request("tools/list")).json();
  conforms("ListToolsResultResponse", listed);
  assert.equal(listed.result.tools.length, 26);
  assert.equal(
    listed.result.tools[0].inputSchema.$schema,
    "https://json-schema.org/draft/2020-12/schema",
  );
  assert.deepEqual(
    (await f.call("list_devices")).result.structuredContent.data,
    [],
  );
  f.hub.grant(
    owner,
    agent.id,
    f.device.deviceId,
    ["device.health", ...roombaCapabilities],
    null,
  );
  const functions = (await f.call("list_functions")).result.structuredContent
    .data;
  assert.equal(functions.length, 13);
  const args = {
    "device.health": {},
    "roomba.drive": { velocityMmS: 100, radiusMm: 0, durationMs: 300 },
    "roomba.stop": {},
    "roomba.sensor.read": { packetId: 35 },
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
    "roomba.drive_direct": { rightMmS: 100, leftMmS: -100, durationMs: 300 },
    "roomba.clean": { mode: "standard" },
    "roomba.dock": {},
    "roomba.pause": {},
  };
  for (const row of functions) {
    const parameters = {
      deviceId: f.device.deviceId,
      capability: row.definition.name,
      arguments: args[row.definition.name],
      idempotencyKey: row.definition.name,
    };
    const firstResponse = await f.call("invoke_device_function", parameters);
    conforms("CallToolResultResponse", firstResponse);
    const first = firstResponse.result.structuredContent.data;
    const retry = (await f.call("invoke_device_function", parameters)).result
      .structuredContent.data;
    assert.equal(first.id, retry.id);
    assert.equal(first.status, "queued");
    const delivered = f.hub.next(f.device.deviceId);
    assert.equal(delivered.id, first.id);
    f.hub.result(f.device.deviceId, delivered.id, "succeeded", {
      fixture: true,
      physicalVerified: false,
    });
    const receipt = (await f.call("get_action", { actionId: first.id })).result;
    assert.equal(receipt.structuredContent.data.status, "succeeded");
    assert.equal(receipt.structuredContent.data.result.physicalVerified, false);
  }
  const customName = functionToolName(f.device.deviceId, "roomba.clean");
  assert(
    (await (await f.request("tools/list")).json()).result.tools.some(
      (tool) => tool.name === customName,
    ),
  );
  assert.equal(
    (
      await f.call(customName, {
        arguments: { mode: "spot" },
        idempotencyKey: "direct",
      })
    ).result.structuredContent.data.status,
    "queued",
  );
  f.hub.revokeGrant(owner, agent.id, f.device.deviceId);
  assert.equal(
    (
      await f.call(customName, {
        arguments: { mode: "spot" },
        idempotencyKey: "direct",
      })
    ).error.code,
    -32602,
  );
  assert.equal(
    (
      await f.call("invoke_device_function", {
        deviceId: f.device.deviceId,
        capability: "roomba.clean",
        arguments: { mode: "standard" },
        idempotencyKey: "ungranted",
      })
    ).result.isError,
    true,
  );
});
test("MCP 2026 rejects malformed metadata, versions, headers and unsupported methods with normative error codes", async () => {
  const f = await fixture();
  for (const [method, params, headers, overrides, status, code] of [
    ["server/discover", {}, { "mcp-method": "tools/list" }, {}, 400, -32020],
    [
      "server/discover",
      {},
      { "mcp-protocol-version": "2025-11-25" },
      {},
      400,
      -32020,
    ],
    [
      "server/discover",
      { _meta: { "io.modelcontextprotocol/protocolVersion": "2099-01-01" } },
      {},
      {},
      400,
      -32022,
    ],
    ["server/discover", {}, {}, { params: {} }, 400, -32602],
    [
      "server/discover",
      { _meta: { "io.modelcontextprotocol/clientCapabilities": null } },
      {},
      {},
      400,
      -32602,
    ],
    [
      "server/discover",
      {
        _meta: {
          "io.modelcontextprotocol/clientCapabilities": { sampling: "invalid" },
        },
      },
      {},
      {},
      400,
      -32602,
    ],
    [
      "server/discover",
      { _meta: { "io.modelcontextprotocol/logLevel": "invalid" } },
      {},
      {},
      400,
      -32602,
    ],
    [
      "server/discover",
      { _meta: { progressToken: null } },
      {},
      {},
      400,
      -32602,
    ],
    ["server/discover", {}, {}, { id: null }, 400, -32600],
    ["server/discover", {}, { "content-type": "text/plain" }, {}, 415, -32600],
    ["server/discover", {}, { accept: "application/json" }, {}, 406, -32600],
    ["unknown/method", {}, {}, {}, 404, -32601],
    [
      "tools/call",
      { name: "list_devices" },
      { "mcp-name": "set_led" },
      {},
      400,
      -32020,
    ],
    [
      "tools/call",
      { name: "list_devices" },
      { "mcp-name": "=?base64?%%%?=" },
      {},
      400,
      -32020,
    ],
    [
      "tools/call",
      { name: "list_devices", arguments: [] },
      {},
      {},
      400,
      -32602,
    ],
    ["tools/call", { name: "missing" }, {}, {}, 400, -32602],
    [
      "tools/call",
      { name: "\ufeffmissing" },
      {
        "mcp-name":
          "=?base64?" + Buffer.from("\ufeffmissing").toString("base64") + "?=",
      },
      {},
      400,
      -32602,
    ],
  ]) {
    const response = await f.request(method, params, headers, overrides);
    assert.equal(
      response.status,
      status,
      JSON.stringify({ method, headers, params }),
    );
    const payload = await response.json();
    conforms("JSONRPCErrorResponse", payload);
    assert.equal(payload.error.code, code);
    if (code === -32022)
      assert.deepEqual(payload.error.data, {
        supported: MCP_SUPPORTED_VERSIONS,
        requested: "2099-01-01",
      });
  }
  const encoded = await f.request(
    "tools/call",
    { name: "list_devices" },
    {
      "mcp-name":
        "=?base64?" + Buffer.from("list_devices").toString("base64") + "?=",
    },
  );
  assert.equal(encoded.status, 200);
  assert.equal((await encoded.json()).result.resultType, "complete");
  assert.equal(
    (
      await f.request(
        "server/discover",
        {},
        { origin: "https://untrusted.test" },
      )
    ).status,
    403,
  );
  for (const method of ["GET", "DELETE"]) {
    const response = await handle(
      new Request("https://bridge.test/mcp", { method }),
      f.hub,
      async () => agent,
    );
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST");
  }
  const malformed = await handle(
    new Request("https://bridge.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_VERSION,
      },
      body: "{",
    }),
    f.hub,
    async () => agent,
  );
  assert.equal((await malformed.json()).error.code, -32700);
});
test("MCP 2026 read scope yields an actionable OAuth challenge, expiry survives reconnect and metadata never authorizes a client", async () => {
  const f = await fixture({ ...agent, readOnly: true });
  f.hub.grant(
    owner,
    agent.id,
    f.device.deviceId,
    ["device.health", "roomba.clean"],
    null,
  );
  const response = await f.request("tools/call", {
    name: "invoke_device_function",
    arguments: {
      deviceId: f.device.deviceId,
      capability: "roomba.clean",
      arguments: { mode: "standard" },
      idempotencyKey: "scope",
    },
    _meta: { "io.modelcontextprotocol/clientCapabilities": { owner: true } },
  });
  assert.equal(response.status, 403);
  assert.match(
    response.headers.get("www-authenticate"),
    /error="insufficient_scope"/,
  );
  assert.match(response.headers.get("www-authenticate"), /openlaunch:act/);
  assert.equal(f.hub.state.actions.length, 0);
  const action = (
    await f.call("invoke_device_function", {
      deviceId: f.device.deviceId,
      capability: "device.health",
      arguments: {},
      idempotencyKey: "offline",
      ttlSeconds: 1,
    })
  ).result.structuredContent.data;
  f.advance(1001);
  const restored = new Hub(
    structuredClone(f.hub.state),
    () => action.expiresAt + 1,
  );
  assert.equal(restored.next(f.device.deviceId), null);
  assert.equal(restored.get(agent, action.id).status, "expired");
});
