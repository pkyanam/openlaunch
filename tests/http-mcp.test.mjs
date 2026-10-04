import test from "node:test";
import assert from "node:assert/strict";
import { Hub, Fault } from "../packages/core/src/index.ts";
import { handle } from "../packages/http/src/index.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const owner = { id: "owner", owner: true },
  agent = { id: "local-agent", owner: false };
const resolve = async (r) => {
  const t = r.headers.get("authorization");
  if (t === "Bearer owner-fixture") return owner;
  if (t === "Bearer agent-fixture") return agent;
  throw new Fault("unauthorized", 401, "fixture auth required");
};
test("invalid device routes return stable errors without resolving an agent", async () => {
  let resolutions = 0;
  const unavailable = async () => {
    resolutions++;
    throw new Error("Device request has no owner principal");
  };
  for (const [path, method, status, code] of [
    [
      "/v1/device/11111111-1111-4111-8111-111111111111/events/ticket",
      "POST",
      404,
      "not_found",
    ],
    ["/v1/device/enroll", "GET", 405, "method"],
  ]) {
    const response = await handle(
      new Request(`https://bridge.example${path}`, { method }),
      new Hub(),
      unavailable,
    );
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(resolutions, 0);
});
async function api(h, path, method = "GET", data, token = "owner-fixture") {
  return handle(
    new Request("http://127.0.0.1:8788" + path, {
      method,
      headers: {
        authorization: "Bearer " + token,
        "content-type": "application/json",
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    }),
    h,
    resolve,
  );
}
test("grant API accepts null ttlSeconds as until revoked and rejects other non-numeric values", async () => {
  const h = new Hub();
  const enrollment = (
    await (await api(h, "/v1/enrollments", "POST", { kind: "raspberry-pi-4" })).json()
  ).data;
  const enrolled = await api(h, "/v1/device/enroll", "POST", {
    token: enrollment.token,
    manifest: { name: "fixture", kind: "raspberry-pi-4", capabilities: ["device.health"] },
  });
  const { deviceId } = (await enrolled.json()).data;
  const response = await api(h, "/v1/grants", "POST", {
    principal: agent.id,
    deviceId,
    capabilities: ["device.health"],
    ttlSeconds: null,
  });
  assert.equal(response.status, 200);
  const listed = await api(h, "/v1/grants");
  assert.equal((await listed.json()).data[0].expiresAt, null);
  assert.equal(h.grants(owner)[0].expiresAt, null);
  const invalid = await api(h, "/v1/grants", "POST", {
    principal: agent.id,
    deviceId,
    capabilities: ["device.health"],
    ttlSeconds: "forever",
  });
  assert.equal(invalid.status, 400);
});
test("function catalog returns only granted device definitions and follows manifest revocation", async () => {
  const h = new Hub();
  const manifest = (name) => ({
    name,
    kind: "custom.device",
    capabilities: ["switch.set", "device.health", "led.set"],
    functions: [{
      name: "switch.set",
      title: "Set switch",
      description: "Set this device switch",
      access: "write",
      inputSchema: {
        type: "object",
        properties: { on: { type: "boolean" } },
        required: ["on"],
        additionalProperties: false,
      },
    }],
  });
  const enrollment = await h.enrollment(owner, "custom.device");
  const first = await h.enroll(enrollment.token, manifest("first"));
  const secondEnrollment = await h.enrollment(owner, "custom.device");
  const second = await h.enroll(secondEnrollment.token, manifest("second"));
  h.grant(owner, agent.id, first.deviceId, ["switch.set", "device.health"]);
  const response = await api(h, "/v1/functions", "GET", undefined, "agent-fixture");
  const functions = (await response.json()).data;
  assert.deepEqual(functions.map(({ deviceId, deviceName, kind, definition }) => ({
    deviceId, deviceName, kind, name: definition.name,
  })), [
    {
      deviceId: first.deviceId,
      deviceName: "first",
      kind: "custom.device",
      name: "switch.set",
    },
    {
      deviceId: first.deviceId,
      deviceName: "first",
      kind: "custom.device",
      name: "device.health",
    },
  ]);
  assert.equal(functions.some((row) => row.definition.name === "led.set"), false);
  assert.match(functions[0].guide, /Schema guide/);
  assert.equal(functions.some((row) => row.deviceId === second.deviceId), false);
  h.publishManifest(first.deviceId, {
    name: "first",
    kind: "custom.device",
    capabilities: ["device.health"],
  });
  assert.deepEqual(
    (await api(h, "/v1/functions", "GET", undefined, "agent-fixture").then((r) => r.json())).data,
    [],
  );
});
test("REST enrollment, MCP action, authenticated device receipt, revocation", async () => {
  const h = new Hub();
  const enrollment = (
    await (
      await api(h, "/v1/enrollments", "POST", { kind: "raspberry-pi-4" })
    ).json()
  ).data;
  const enrolled = await api(h, "/v1/device/enroll", "POST", {
    token: enrollment.token,
    manifest: {
      name: "fixture",
      kind: "raspberry-pi-4",
      capabilities: ["device.health", "led.set"],
    },
  });
  assert.equal(enrolled.status, 201);
  const d = (await enrolled.json()).data;
  await api(h, "/v1/grants", "POST", {
    principal: "local-agent",
    deviceId: d.deviceId,
    capabilities: ["led.set"],
    ttlSeconds: 60,
  });
  const client = new Client({ name: "test-client", version: "1.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1:8788/mcp"),
    {
      requestInit: { headers: { authorization: "Bearer agent-fixture" } },
      fetch: async (input, init) =>
        handle(new Request(input, init), h, resolve),
    },
  );
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 7);
  const generatedLed = listed.tools.find((tool) => tool.name.startsWith("device_"));
  assert(generatedLed);
  const denied = await client.callTool({
    name: "request_device_health",
    arguments: { deviceId: d.deviceId, idempotencyKey: "no-health" },
  });
  assert.equal(denied.isError, true);
  const requested = await client.callTool({
    name: "set_led",
    arguments: { deviceId: d.deviceId, on: true, idempotencyKey: "led-1" },
  });
  assert.notEqual(requested.isError, true);
  const action = requested.structuredContent.data;
  assert.equal(action.status, "queued");
  assert.equal(
    (await api(h, `/v1/device/${d.deviceId}/next`, "POST", {}, "wrong")).status,
    401,
  );
  const command = (
    await (
      await api(h, `/v1/device/${d.deviceId}/next`, "POST", {}, d.token)
    ).json()
  ).data;
  assert.equal(command.id, action.id);
  assert.equal(
    (
      await api(
        h,
        `/v1/device/${d.deviceId}/result`,
        "POST",
        { actionId: action.id, status: "succeeded", result: { on: true } },
        d.token,
      )
    ).status,
    200,
  );
  const result = await client.callTool({
    name: "get_action",
    arguments: { actionId: action.id },
  });
  assert.equal(result.structuredContent.data.status, "succeeded");
  const generated = await client.callTool({
    name: generatedLed.name,
    arguments: {
      arguments: { on: false },
      idempotencyKey: "led-generated",
    },
  });
  assert.equal(generated.structuredContent.data.capability, "led.set");
  await api(h, `/v1/devices/${d.deviceId}/revoke`, "POST", {});
  assert.equal(
    (await api(h, `/v1/device/${d.deviceId}/next`, "POST", {}, d.token)).status,
    404,
  );
  await client.close();
});
test("management is inaccessible to agent principal and missing auth", async () => {
  const h = new Hub();
  assert.equal(
    (
      await api(
        h,
        "/v1/enrollments",
        "POST",
        { kind: "raspberry-pi-4" },
        "agent-fixture",
      )
    ).status,
    403,
  );
  assert.equal((await api(h, "/v1/devices", "GET", null, "bad")).status, 401);
});
test("cross-origin writes and oversized data rejected", async () => {
  const h = new Hub();
  const req = new Request("http://127.0.0.1:8788/v1/enrollments", {
    method: "POST",
    headers: {
      origin: "https://evil.invalid",
      authorization: "Bearer owner-fixture",
    },
    body: "{}",
  });
  assert.equal((await handle(req, h, resolve)).status, 403);
  assert.equal(
    (await api(h, "/v1/enrollments", "POST", { kind: "x".repeat(17000) }))
      .status,
    413,
  );
});
